#!/bin/bash
# dev/deploy/hub.sh: the hub deploy from this machine, without GitHub Actions; the same steps as
# .github/workflows/deploy.yml. README.md "Deploy without CI".
#
#   dev/deploy/hub.sh [--dry-run] [--allow-unpushed] [--skip-config]
#
# test:hub + quick fuzz (+ hub-rs/contract.sh with the Rust image) -> docker build of $DOCKERFILE (COMMIT = HEAD, from `git archive HEAD`) -> docker save | ssh docker load ->
# apns.env and admin config -> online SQLite backup -> restart -> https://hub.trommi.com/healthz reports HEAD, else the
# previous image is started again and the script fails -> admin page check.
#
# SSH: root@trommi-hub.tail276436.ts.net port 2222 (OpenSSH) through the 1Password agent, StrictHostKeyChecking=yes
# (the host keys must already be in ~/.ssh/known_hosts). Secrets come from a local file outside the repository,
# never from GitHub: $TROMMI_DEPLOY_ENV, default ~/.config/trommi/deploy/hub.env (mode 0600), shell assignments:
#   APNS_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'   the .p8, newlines as \n (one line)
#   APNS_KEY_ID=...  APNS_TEAM_ID=...  APNS_TOPIC=...                         as the hub environment variables
#   ADMIN_LOGINS=...  ADMIN_PASSWORD_HASH=...                                 as variable / secret in GitHub
#   PREVIEW_ORIGINS=...                                                       optional (default as in the workflow)
# Every one of the six must be set: an empty APNs or admin value would switch that feature off on the server.
# --skip-config leaves apns.env, admin.env and compose.override.yaml on the server as they are (no file needed).
set -euo pipefail
# shellcheck source=dev/deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_CONFIG=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done

HOST=${TROMMI_HUB_HOST:-root@trommi-hub.tail276436.ts.net}
PORT=${TROMMI_HUB_PORT:-2222}
export SSH_AUTH_SOCK=${TROMMI_SSH_AUTH_SOCK:-$HOME/.1password/agent.sock}
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=yes -o BatchMode=yes)
SCP=(scp -P "$PORT" -o StrictHostKeyChecking=yes -o BatchMode=yes)
ENV_FILE=${TROMMI_DEPLOY_ENV:-$HOME/.config/trommi/deploy/hub.env}

guard_tree
IMAGE="trommi-hub:$SHA"
# The hub image: hub/Dockerfile (Node) or hub-rs/Dockerfile (Rust, same port, volume, env, uid; hub-rs/README.md).
DOCKERFILE=${HUB_DOCKERFILE:-hub-rs/Dockerfile}

# ---- the secrets file ----
PREVIEW_ORIGINS_DEFAULT='https://desktop.TAILNET.ts.net:8443'
if [ "$SKIP_CONFIG" = 1 ]; then
  say "--skip-config: the server's apns.env / admin.env / compose.override.yaml stay as they are"
  # shellcheck disable=SC1090 # the local secrets file
  [ -f "$ENV_FILE" ] && . "$ENV_FILE"
else
  if [ ! -f "$ENV_FILE" ]; then
    refuse "no secrets file $ENV_FILE (see the head of this script), or pass --skip-config"
  else
    [ "$(stat -c %a "$ENV_FILE")" = 600 ] || refuse "$ENV_FILE must be mode 0600 (chmod 600)"
    # shellcheck disable=SC1090 # the local secrets file
    . "$ENV_FILE"
    for v in APNS_KEY APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC ADMIN_LOGINS ADMIN_PASSWORD_HASH; do
      [ -n "${!v:-}" ] || refuse "$v is empty in $ENV_FILE (an empty value turns that feature off on the server)"
    done
  fi
fi
PREVIEW_ORIGINS=${PREVIEW_ORIGINS:-$PREVIEW_ORIGINS_DEFAULT}

# ---- reachability (read-only) ----
say "ssh $HOST -p $PORT"
if [ "$DRY" = 1 ]; then
  "${SSH[@]}" "$HOST" true 2>/dev/null && say "ssh ok (host key known, agent key accepted)" || printf '[dry-run] WOULD REFUSE: ssh to %s -p %s failed\n' "$HOST" "$PORT" >&2
else
  "${SSH[@]}" "$HOST" true || die "ssh to $HOST -p $PORT failed (1Password agent at $SSH_AUTH_SOCK? host key in known_hosts?)"
fi

# ---- test ----
say "test:hub"
run npm --prefix "$REPO" run test:hub
say "fuzz (quick)"
run npm --prefix "$REPO" run fuzz
if [ "$DOCKERFILE" = hub-rs/Dockerfile ]; then
  say "hub-rs contract (cargo test, the hub suites against the Rust hub, differential run vs Node)"
  run "$REPO/hub-rs/contract.sh" --quick
fi

# ---- build ----
say "docker build $IMAGE"
TREE=
cleanup() { [ -n "$TREE" ] && rm -rf "$TREE"; return 0; }
trap cleanup EXIT
if [ "$DRY" = 1 ]; then
  printf '[dry-run] git archive HEAD into a temp dir\n' >&2
  TREE='<tree>'
  run docker build -f "$TREE/$DOCKERFILE" --build-arg "COMMIT=$SHA" --build-arg "PREVIEW_ORIGINS=$PREVIEW_ORIGINS" -t "$IMAGE" "$TREE"
  TREE=
else
  TREE=$(build_tree)
  docker build -f "$TREE/$DOCKERFILE" --build-arg "COMMIT=$SHA" --build-arg "PREVIEW_ORIGINS=$PREVIEW_ORIGINS" -t "$IMAGE" "$TREE"
fi

# ---- ship ----
say "ship image"
if [ "$DRY" = 1 ]; then
  printf "[dry-run] docker save %s | gzip | %s %s 'gunzip | docker load'\n" "$IMAGE" "${SSH[*]}" "$HOST" >&2
else
  docker save "$IMAGE" | gzip | "${SSH[@]}" "$HOST" 'gunzip | docker load'
fi

# ---- apns.env, admin config (secrets on stdin, never on a command line) ----
if [ "$SKIP_CONFIG" != 1 ]; then
  say "APNs config (apns.env)"
  run "${SCP[@]}" "$REPO/hub/deploy-apns.sh" "$HOST:/srv/trommi/deploy-apns.sh"
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC on stdin) | ssh %s bash /srv/trommi/deploy-apns.sh\n' "$HOST" >&2
  else
    # shellcheck disable=SC2016 # expands on the server
    printf '%s\n%s\n%s\n%s\n' "$APNS_KEY" "$APNS_KEY_ID" "$APNS_TEAM_ID" "$APNS_TOPIC" | "${SSH[@]}" "$HOST" 'bash /srv/trommi/deploy-apns.sh; s=$?; rm -f /srv/trommi/deploy-apns.sh; exit $s'
  fi
  say "admin page config (admin.env, compose.override.yaml)"
  run "${SCP[@]}" "$REPO/hub/deploy-admin.sh" "$HOST:/srv/trommi/deploy-admin.sh"
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] (ADMIN_LOGINS, ADMIN_PASSWORD_HASH on stdin) | ssh %s bash /srv/trommi/deploy-admin.sh\n' "$HOST" >&2
  else
    # shellcheck disable=SC2016 # expands on the server
    printf '%s\n%s\n' "$ADMIN_LOGINS" "$ADMIN_PASSWORD_HASH" | "${SSH[@]}" "$HOST" 'bash /srv/trommi/deploy-admin.sh; s=$?; rm -f /srv/trommi/deploy-admin.sh; exit $s'
  fi
fi

# ---- backup and restart ----
say "back up data (online SQLite copy) and restart hub"
if [ "$DRY" = 1 ]; then
  printf "[dry-run] %s %s 'bash -s' < hub/deploy-backup.sh\n" "${SSH[*]}" "$HOST" >&2
else
  "${SSH[@]}" "$HOST" 'bash -s' < "$REPO/hub/deploy-backup.sh"
fi
# shellcheck disable=SC2016 # $prev etc. expand on the server
RESTART="set -e
  cd /srv/trommi
  docker image inspect -f '{{.Id}}' trommi-hub:current > previous-image 2>/dev/null || : > previous-image
  docker tag $IMAGE trommi-hub:current
  docker compose up -d hub
  docker image prune -f >/dev/null"
run "${SSH[@]}" "$HOST" "$RESTART"

# ---- verify, else roll back ----
say "verify: hub.trommi.com/healthz reports $SHA"
verify() {
  local i got
  for i in $(seq 1 30); do
    got=$(curl -fsS --max-time 5 https://hub.trommi.com/healthz | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true)
    echo "attempt $i: $got"
    [ "$got" = "$SHA" ] && return 0
    sleep 3
  done
  return 1
}
if [ "$DRY" = 1 ]; then
  printf '[dry-run] poll https://hub.trommi.com/healthz (30 x 3 s) for commit %s; on failure roll back to previous-image\n' "$SHA" >&2
  printf '[dry-run] now serving: %s\n' "$(curl -fsS --max-time 5 https://hub.trommi.com/healthz 2>/dev/null | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')" >&2
elif ! verify; then
  say "verify failed: rolling back to the previous image"
  # shellcheck disable=SC2016 # expands on the server
  "${SSH[@]}" "$HOST" 'set -e
    cd /srv/trommi
    prev=$(cat previous-image 2>/dev/null || true)
    [ -n "$prev" ] || { echo "no previous image recorded: nothing to roll back to"; exit 1; }
    docker tag "$prev" trommi-hub:current
    docker compose up -d hub
    echo "rolled back to $prev"'
  for _ in $(seq 1 30); do curl -fsS --max-time 5 https://hub.trommi.com/healthz && break; sleep 3; done
  die "deploy of $SHA failed its check; the hub was rolled back to the previous image"
fi

# ---- admin page ----
if [ -n "${ADMIN_LOGINS:-}" ]; then
  say "verify admin page"
  first="${ADMIN_LOGINS%%,*}"
  case "$first" in *[!A-Za-z0-9@._+-]*) die "unexpected characters in the first ADMIN_LOGINS entry" ;; esac
  # shellcheck disable=SC2016 # expands on the server
  ADMIN_CHECK='set -e
    cd /srv/trommi
    echo "published: $(docker compose port hub 8791)"
    [ "$(docker compose port hub 8791)" = 127.0.0.1:8791 ]
    for i in $(seq 1 20); do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/ || true); [ "$code" = 403 ] && break; sleep 2; done
    curl -s http://127.0.0.1:8791/ | grep -q "missing Tailscale-User-Login"
    curl -s -H "Tailscale-User-Login: '"$first"'" http://127.0.0.1:8791/ | grep -q "Admin password"
    echo "admin page: header check and login form ok"'
  run "${SSH[@]}" "$HOST" "$ADMIN_CHECK"
fi

say "done: hub.trommi.com runs $SHA"

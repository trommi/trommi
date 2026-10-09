#!/usr/bin/env bash
# The hub server's first installation, run on the owner's laptop from a checkout of this repository.
#
#   hub/deploy/install.sh inventory           reads the server and writes trommi-inventory-<time>.txt; changes nothing
#   hub/deploy/install.sh install [hub-vN]    installs the updater and the first hub release (default: the newest)
#   hub/deploy/install.sh secrets             sends the push credentials; run it as
#                                               op run --environment <hub production environment id> -- hub/deploy/install.sh secrets
#
# It reaches the server with ssh as root (1Password approves the key). Where:
#   HUB_SSH        default root@trommi-hub.tail276436.ts.net
#   HUB_SSH_PORT   default 22
# While the repository is private the server needs a token to fetch later releases itself; give it once with
#   TROMMI_RELEASE_TOKEN=<fine-grained token, this repository, Contents: read-only> hub/deploy/install.sh install
# The token is sent over the ssh connection, kept in /etc/trommi/updater.env (root only) and never printed.
#
# `install` can be run again at any time: it finds out what is there, prints every step before it takes it, checks
# it afterwards, and deletes nothing. The stack that ran before (docker compose in /srv/trommi) is stopped and moved
# to /srv/trommi-old with all its data. If a step fails after that move, the old stack is put back and started, and
# the script says what happened.
#
# After the first installation everything else arrives by release: the hub, its unit and the updater itself.
set -euo pipefail

HUB_SSH=${HUB_SSH:-root@trommi-hub.tail276436.ts.net}
HUB_SSH_PORT=${HUB_SSH_PORT:-22}
REPOSITORY=${TROMMI_REPOSITORY:-trommi/trommi}
TARGET=x86_64-unknown-linux-musl
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The owner's ssh key lives in 1Password; its agent is used when no other is set.
if [ -z "${SSH_AUTH_SOCK:-}" ] && [ -S "$HOME/.1password/agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/.1password/agent.sock"
fi
SSH=(ssh -p "$HUB_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ControlPath=none -o ConnectTimeout=15 "$HUB_SSH")

# ---------------------------------------------------------------------------------------------------------------
# What runs on the server. Each part is a program of its own, sent over the ssh connection.
# ---------------------------------------------------------------------------------------------------------------

# Reads only. Anything that could be a secret is cut out before it leaves the server.
remote_inventory() {
  cat <<'REMOTE'
set -u
export LC_ALL=C
section() { printf '\n## %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# values of settings whose name sounds secret, and any long run of key-like characters
redact() {
  sed -E \
    -e 's/(([A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASSWD|HASH|CREDENTIAL)[A-Za-z0-9_]*)[[:space:]]*[=:][[:space:]]*).*/\1<redacted>/I' \
    -e 's/(--token[= ])[^ "]+/\1<redacted>/g' \
    -e 's/[A-Za-z0-9+\/_=-]{32,}/<redacted>/g'
}

section "machine"
date -u '+now (UTC): %Y-%m-%d %H:%M:%S'
have timedatectl && timedatectl show -p Timezone -p NTPSynchronized 2>/dev/null
. /etc/os-release 2>/dev/null && echo "os: ${PRETTY_NAME:-?}"
echo "arch: $(uname -m)   kernel: $(uname -r)"
echo "systemd: $(systemctl --version 2>/dev/null | head -1)"
echo "uptime: $(uptime -p 2>/dev/null)"
echo "cpus: $(nproc 2>/dev/null)"
free -m 2>/dev/null | sed -n '1,2p'

section "disk"
df -h / /srv 2>/dev/null

section "tools"
for t in curl python3 openssl sha256sum docker tailscale ss; do
  if have "$t"; then echo "$t: yes"; else echo "$t: MISSING"; fi
done
have openssl && openssl version

section "automatic updates"
if have apt-config; then
  apt-config dump 2>/dev/null | grep -E 'APT::Periodic::(Unattended-Upgrade|Update-Package-Lists)|Unattended-Upgrade::Automatic-Reboot' || echo "no unattended-upgrades settings found"
fi
systemctl is-enabled unattended-upgrades.service 2>/dev/null | sed 's/^/unattended-upgrades.service: /'

section "tailscale"
if have tailscale; then
  tailscale version 2>/dev/null | head -1
  echo "addresses: $(tailscale ip 2>/dev/null | tr '\n' ' ')"
  if have python3; then
    tailscale status --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin).get("Self", {})
print("name:", s.get("DNSName"))
print("tags:", s.get("Tags") or "none (a person'"'"'s device)")
print("online:", s.get("Online"))' 2>/dev/null
    tailscale debug prefs 2>/dev/null | python3 -c '
import json, sys
p = json.load(sys.stdin)
print("Tailscale SSH:", "ON" if p.get("RunSSH") else "off")
print("auto-update:", (p.get("AutoUpdate") or {}).get("Apply"))' 2>/dev/null
  fi
  echo "tailscale serve:"; tailscale serve status 2>&1 | redact | sed 's/^/  /'
fi

section "ssh"
echo "listening:"; ss -tlnpH 2>/dev/null | grep -E 'sshd|"systemd"' | awk '{print "  " $4 "  " $6}'
for u in ssh.socket ssh.service sshd.service; do echo "$u: $(systemctl is-active "$u" 2>/dev/null)"; done
echo "Port and ListenAddress lines:"
grep -HEi '^[[:space:]]*(Port|ListenAddress)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^/  /'
systemctl cat ssh.socket 2>/dev/null | grep -E '^(# |ListenStream)' | sed 's/^/  /'

section "firewall on the machine"
if have ufw; then ufw status 2>/dev/null | head -3; fi
if have nft; then echo "nft rules: $(nft list ruleset 2>/dev/null | grep -c .)"; fi

section "what listens (tcp)"
ss -tlnpH 2>/dev/null | awk '{print $4 "  " $6}' | sort -u
echo
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq ':9443$'; then echo "port 9443: TAKEN"; else echo "port 9443: free"; fi
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq ':8790$'; then echo "port 8790: taken"; else echo "port 8790: free"; fi

section "docker"
if have docker; then
  docker version --format 'docker {{.Server.Version}}' 2>/dev/null
  docker ps -a --format '{{.Names}}  image={{.Image}}  {{.Status}}  ports={{.Ports}}' 2>/dev/null
  echo "compose projects:"; docker compose ls 2>/dev/null | sed 's/^/  /'
  for id in $(docker ps -aq 2>/dev/null); do
    docker inspect "$id" 2>/dev/null | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
cfg, host = c["Config"], c["HostConfig"]
print()
print("container", c["Name"].lstrip("/"))
print("  image:", cfg.get("Image"), c["Image"][:19])
print("  compose service:", (cfg.get("Labels") or {}).get("com.docker.compose.service"))
print("  entrypoint:", cfg.get("Entrypoint"))
print("  command:", cfg.get("Cmd"))
print("  setting names:", sorted(e.split("=", 1)[0] for e in cfg.get("Env") or []))
print("  user:", cfg.get("User") or "(image default)")
print("  network:", host.get("NetworkMode"), " restart:", (host.get("RestartPolicy") or {}).get("Name"))
print("  mounts:", host.get("Binds"))' 2>/dev/null | redact
  done
else
  echo "no docker"
fi

section "/srv"
ls -la /srv 2>/dev/null
for d in /srv/trommi /srv/trommi-old; do
  [ -d "$d" ] || continue
  echo; echo "$d:"; ls -la "$d" 2>/dev/null | sed 's/^/  /'
  du -sh "$d"/* 2>/dev/null | sed 's/^/  /'
  for f in "$d"/compose.yaml "$d"/compose.override.yaml "$d"/docker-compose.yml; do
    [ -f "$f" ] || continue
    echo; echo "$f (secrets cut out):"; redact < "$f" | sed 's/^/  | /'
  done
  for f in "$d"/*.env "$d"/.env; do
    [ -f "$f" ] || continue
    echo "$f, names only: $(grep -Eo '^[A-Za-z_][A-Za-z0-9_]*' "$f" | tr '\n' ' ')"
  done
done

section "a Trommi installation by this script"
if [ -d /etc/trommi ]; then ls -la /etc/trommi | sed 's/^/  /'; else echo "/etc/trommi: not there"; fi
for l in current previous updater updater-previous; do
  [ -L "/srv/trommi/$l" ] && echo "  /srv/trommi/$l -> $(readlink "/srv/trommi/$l")"
done
for u in trommi-hub.service trommi-hub-updater.service trommi-proxy.service; do
  echo "  $u: $(systemctl is-enabled "$u" 2>/dev/null || true) / $(systemctl is-active "$u" 2>/dev/null || true)"
done
id trommi 2>/dev/null | sed 's/^/  user: /' || echo "  user trommi: not there"
[ -x /usr/local/bin/trommi-hub-updater ] && /usr/local/bin/trommi-hub-updater status 2>/dev/null | sed 's/^/  /'
exit 0
REMOTE
}

# The installation. Arguments: <tag> <staging directory>. A token for GitHub may come on standard input (one line).
remote_install() {
  cat <<'REMOTE'
set -euo pipefail
export LC_ALL=C
TAG=$1 STAGE=$2
ROOT=/srv/trommi OLD=/srv/trommi-old ETC=/etc/trommi LIB=/usr/local/lib/trommi
UNITS=/etc/systemd/system
step() { printf '\n--> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
stop() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

IFS= read -r TOKEN || TOKEN=''

# ---- look, change nothing ----
step "Look at the server (nothing is changed yet)"
[ "$(id -u)" = 0 ] || stop "this must run as root"
[ "$(uname -m)" = x86_64 ] || stop "this server is $(uname -m); the release is built for x86_64 only"
[ -d /run/systemd/system ] || stop "this server does not run systemd"
for t in curl python3 sha256sum tailscale ss; do have "$t" || stop "$t is missing on the server"; done
(cd "$STAGE" && sha256sum --quiet -c SHA256SUMS) || stop "the files did not arrive whole; run the script again"
TSIP=$(tailscale ip -4 2>/dev/null | head -1)
case "$TSIP" in 100.*) ;; *) stop "the server has no tailnet address (is tailscale up?)" ;; esac
if [ -d "$ROOT/releases" ]; then STATE=installed
elif [ -f "$ROOT/compose.yaml" ] || [ -f "$ROOT/docker-compose.yml" ]; then STATE=old-stack
elif [ -e "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then stop "$ROOT holds something this script does not know; send the inventory"
else STATE=empty
fi
[ "$STATE" = old-stack ] && [ -e "$OLD" ] && stop "$OLD exists already and $ROOT still holds the old stack; send the inventory"
taken() { ss -tlnpH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p && !seen {print $6; seen = 1}'; }
# whether something listens on exactly this address, and whether anything else listens on its port
listens() { ss -tlnH 2>/dev/null | awk -v a="$1" '$4 == a {found = 1} END {exit !found}'; }
elsewhere() { ss -tlnH 2>/dev/null | awk -v a="$1" -v p=":${1##*:}\$" '$4 ~ p && $4 != a {found = 1} END {exit !found}'; }
by=$(taken 9443)
case "$by" in ''|*trommi-hub-upd*) ;; *) stop "port 9443 is taken by $by" ;; esac
by=$(taken 8790)
case "$STATE:$by" in
  *:''|*:*trommi-hub*) ;;
  old-stack:*docker*) ;;
  *) stop "port 8790 is taken by $by" ;;
esac
PROXY=''
if [ "$STATE" = old-stack ]; then
  have docker || stop "the old stack is a docker compose stack, but docker is not there"
  PROXY=$(docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /cloudflared/ {print $1}')
  [ "$(printf '%s\n' "$PROXY" | grep -c .)" = 1 ] || stop "expected exactly one running cloudflared container, found: ${PROXY:-none}; send the inventory"
fi
if [ -f "$ETC/release-public-key.pem" ] && ! cmp -s "$ETC/release-public-key.pem" "$STAGE/public-key.pem"; then
  stop "another release key is pinned in $ETC/release-public-key.pem; it is never replaced by this script"
fi
ok "state: $STATE; tailnet address $TSIP; ports 9443 and 8790 usable"

# The owner's tailnet login (from this very ssh connection): his own devices may call the endpoint beside the CI.
OWNER=$(tailscale whois --json "${SSH_CLIENT%% *}:$(printf '%s' "$SSH_CLIENT" | awk '{print $2}')" 2>/dev/null | python3 -c '
import json, sys
w = json.load(sys.stdin)
print("" if w["Node"].get("Tags") else w["UserProfile"].get("LoginName", ""))' 2>/dev/null || true)
case "$OWNER" in *[!A-Za-z0-9@._+-]*) OWNER='' ;; esac

# ---- from here on things change; if a step fails after the old stack was moved, it is put back ----
MOVED=0
back() {
  code=$?
  trap - ERR EXIT
  [ "$code" = 0 ] && exit 0
  if [ "$MOVED" = 1 ]; then
    printf '\n!!! A step failed. Putting the old stack back.\n' >&2
    systemctl stop trommi-proxy.service trommi-hub.service trommi-hub-updater.service 2>/dev/null || true
    systemctl disable trommi-proxy.service trommi-hub-updater.service 2>/dev/null || true
    rm -f "$UNITS/trommi-hub.service" "$UNITS/multi-user.target.wants/trommi-hub.service"
    systemctl daemon-reload || true
    failed="/srv/trommi-failed-$(date -u +%Y%m%d-%H%M%S)"
    restored=0
    if [ ! -e "$ROOT" ] || mv "$ROOT" "$failed"; then
      if mv "$OLD" "$ROOT" && (cd "$ROOT" && docker compose up -d); then restored=1; fi
    fi
    if [ "$restored" = 1 ]; then
      printf '!!! The old stack runs again from %s; nothing was deleted (a half-made installation, if any, is in %s).\n    Fix what failed above and run the script again.\n' "$ROOT" "$failed" >&2
    else
      printf '!!! The old stack could NOT be started again. Its files are in %s or %s; there: docker compose up -d\n' "$OLD" "$ROOT" >&2
    fi
  else
    printf '\n!!! A step failed. What ran before still runs; fix what failed above and run the script again.\n' >&2
  fi
  exit "$code"
}
trap back ERR EXIT

step "User trommi (the hub runs as it)"
id trommi >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin trommi
id trommi >/dev/null
ok "$(id trommi)"

if [ "$STATE" = old-stack ]; then
  step "Note how the tunnel (cloudflared) runs today, so that it can run the same way beside the new hub"
  install -d -m 0755 "$ETC"
  python3 "$STAGE/proxy-unit.py" "$PROXY" "$ROOT" "$OLD" "$ETC/proxy.env" "$STAGE/trommi-proxy.service"
  ok "noted in $ETC/proxy.env (root only)"

  step "Stop the old stack (docker compose down in $ROOT; data, volumes and images stay)"
  (cd "$ROOT" && docker compose down)
  [ -z "$(docker ps -q --filter "id=$PROXY")" ] || stop "the old tunnel container still runs"
  ok "stopped"

  step "Move the old stack aside: $ROOT -> $OLD"
  mv "$ROOT" "$OLD"
  MOVED=1
  [ -d "$OLD" ] && [ ! -e "$ROOT" ]
  ok "everything of the old stack is in $OLD"
fi

step "Folders"
install -d -m 0755 "$ROOT" "$ROOT/releases" "$ETC" "$LIB"
install -d -m 0700 "$ROOT/backups"
install -d -m 0700 -o trommi -g trommi "$ROOT/data"
ok "$ROOT (root), $ROOT/data (trommi), $ETC, $LIB"

step "The pinned release key, the updater's unit and its pre-start script"
install -m 0644 "$STAGE/public-key.pem" "$ETC/release-public-key.pem"
install -m 0755 "$STAGE/updater-prestart.sh" "$LIB/updater-prestart.sh"
install -m 0644 "$STAGE/trommi-hub-updater.service" "$UNITS/trommi-hub-updater.service"
printf '%s\n' '#!/bin/sh' '# The updater with the settings its service has: trommi-hub-updater status | deploy hub-v<N>' \
  'set -a; . /etc/trommi/updater.env; set +a' 'exec /srv/trommi/updater/trommi-hub-updater "$@"' > /usr/local/bin/trommi-hub-updater
chmod 0755 /usr/local/bin/trommi-hub-updater
cmp -s "$STAGE/public-key.pem" "$ETC/release-public-key.pem"
ok "installed"

step "Settings: $ETC/hub.env (kept if it is there), $ETC/updater.env"
if [ ! -f "$ETC/hub.env" ]; then
  cat > "$ETC/hub.env" <<'ENV'
# Settings of the hub on this server. Where it listens and keeps its data is fixed in its unit.
HUB_URL=https://hub.trommi.com
HUB_ORIGINS=https://app.trommi.com
# the tunnel on this machine names the client's address in a header
HUB_TRUST_CF=1
# HSTS: "on" makes every answer tell browsers to use HTTPS only for this name and every name below it, for two
# years, marked as fit for the browsers' preload list. Switch it on only when that is decided; then:
# systemctl restart trommi-hub
HUB_HSTS=off
ENV
  chmod 0644 "$ETC/hub.env"
fi
if [ -z "$TOKEN" ] && [ -f "$ETC/updater.env" ]; then
  TOKEN=$(sed -n 's/^UPDATER_GITHUB_TOKEN=//p' "$ETC/updater.env" | head -1)
fi
umask 077
{
  echo "# Settings of the updater (hub/updater/src/main.rs lists them). Written by hub/deploy/install.sh."
  echo "UPDATER_LISTEN=$TSIP:9443"
  echo "UPDATER_REPOSITORY=$REPOSITORY"
  echo "UPDATER_CALLER_TAGS=tag:trommi-ci"
  echo "UPDATER_CALLER_USERS=$OWNER"
  [ -z "$TOKEN" ] || echo "UPDATER_GITHUB_TOKEN=$TOKEN"
} > "$ETC/updater.env.part"
mv -f "$ETC/updater.env.part" "$ETC/updater.env"
umask 022
grep -q "^UPDATER_LISTEN=$TSIP:9443$" "$ETC/updater.env"
ok "the endpoint will listen on $TSIP:9443 only; callers: tag:trommi-ci${OWNER:+ and $OWNER}; GitHub token: $([ -n "$TOKEN" ] && echo there || echo none)"

step "The release $TAG, as it was checked on the laptop, into $ROOT/releases/$TAG"
if [ -d "$ROOT/releases/$TAG" ]; then
  ok "already there (the updater proves it again before it uses it)"
else
  part="$ROOT/releases/.tmp-$TAG-install"
  rm -rf "$part"
  install -d -m 0755 "$part"
  install -m 0755 "$STAGE/trommi-hub-$TARGET" "$part/trommi-hub"
  install -m 0755 "$STAGE/trommi-hub-updater-$TARGET" "$part/trommi-hub-updater"
  install -m 0644 "$STAGE/trommi-hub.service" "$STAGE/manifest.json" "$STAGE/manifest.json.sig" "$part/"
  sync
  mv "$part" "$ROOT/releases/$TAG"
  ok "in place"
fi
if [ ! -L "$ROOT/updater" ]; then
  ln -s "releases/$TAG" "$ROOT/updater"
  ok "the first updater is the one of $TAG"
else
  ok "an updater is in place already ($(readlink "$ROOT/updater")); it changes itself by release"
fi
[ -x "$ROOT/updater/trommi-hub-updater" ]

step "The hub's unit is the one of the running release (a link), started at boot"
ln -sfn "$ROOT/current/trommi-hub.service" "$UNITS/trommi-hub.service"
install -d -m 0755 "$UNITS/multi-user.target.wants"
ln -sfn "$ROOT/current/trommi-hub.service" "$UNITS/multi-user.target.wants/trommi-hub.service"
ok "linked"

step "Start the updater (systemd, at boot too)"
systemctl daemon-reload
systemctl enable trommi-hub-updater.service >/dev/null
systemctl restart trommi-hub-updater.service
for _ in $(seq 1 30); do
  if listens "$TSIP:9443"; then break; fi
  sleep 1
done
listens "$TSIP:9443" || { journalctl -u trommi-hub-updater.service -n 20 --no-pager >&2; stop "the updater does not listen on $TSIP:9443"; }
if elsewhere "$TSIP:9443"; then stop "port 9443 listens on more than the tailnet address"; fi
ok "listening on $TSIP:9443 and nowhere else"

step "Deploy $TAG through the updater (it proves the release itself, swaps, checks health)"
/usr/local/bin/trommi-hub-updater deploy "$TAG" | tee "$STAGE/outcome.json"
grep -q '"ok": true' "$STAGE/outcome.json" || stop "the updater did not accept $TAG (see its answer above)"
curl -fsS --max-time 5 http://127.0.0.1:8790/healthz >/dev/null
systemctl is-active --quiet trommi-hub.service
ok "the hub runs and is well"

if [ -f "$STAGE/trommi-proxy.service" ]; then
  step "Start the tunnel beside the new hub (same image, same settings as before, on the host's network)"
  install -m 0600 "$STAGE/trommi-proxy.service" "$UNITS/trommi-proxy.service"
  systemctl daemon-reload
  systemctl enable trommi-proxy.service >/dev/null
  systemctl restart trommi-proxy.service
  sleep 3
  systemctl is-active --quiet trommi-proxy.service || { journalctl -u trommi-proxy.service -n 20 --no-pager >&2; stop "the tunnel did not start"; }
  ok "trommi-proxy.service runs"
fi

if systemctl is-enabled --quiet trommi-proxy.service 2>/dev/null; then
  step "Ask the hub from outside, through the tunnel"
  url=$(sed -n 's/^HUB_URL=//p' "$ETC/hub.env" | head -1)
  want=$(sed -n 's/.*"commit": "\([0-9a-f]*\)".*/\1/p' "$ROOT/current/manifest.json" | head -1)
  got=''
  for _ in $(seq 1 30); do
    got=$(curl -fsS --max-time 5 "$url/healthz" 2>/dev/null | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p' || true)
    [ "$got" = "$want" ] && break
    sleep 2
  done
  [ "$got" = "$want" ] || stop "$url/healthz does not answer as the new hub (got: ${got:-nothing})"
  ok "$url answers as commit $want"
else
  printf '\n    note: no tunnel was found to carry over; the hub answers on 127.0.0.1:8790 only.\n'
fi

trap - ERR EXIT
step "Done"
/usr/local/bin/trommi-hub-updater status
for u in trommi-hub-updater.service trommi-hub.service trommi-proxy.service; do
  printf '%s: %s, at boot: %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)" "$(systemctl is-enabled "$u" 2>/dev/null || true)"
done
[ -d "$OLD" ] && printf 'The old stack lies untouched in %s (stopped). Remove it yourself when you no longer want it.\n' "$OLD"
rm -rf "$STAGE"
exit 0
REMOTE
}

# Writes the tunnel's settings and a systemd unit that runs the same container definition on the host's network.
# proxy-unit.py <container id> <old root> <where it moves to> <env file> <unit file>
proxy_unit_py() {
  cat <<'PY'
import json, os, subprocess, sys

cid, root, moved, env_path, unit_path = sys.argv[1:6]
if cid == "-":
    c = json.load(sys.stdin)[0]
else:
    c = json.loads(subprocess.check_output(["docker", "inspect", cid]))[0]
cfg, host = c["Config"], c["HostConfig"]

# the settings (the tunnel's token may be among them): a file only root reads
env = [e for e in (cfg.get("Env") or []) if "\n" not in e]
# cloudflared's metrics page must not listen on every address once it shares the host's network
if not any(e.startswith("TUNNEL_METRICS=") for e in env) and "--metrics" not in (cfg.get("Cmd") or []):
    env.append("TUNNEL_METRICS=127.0.0.1:20241")
fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("".join(e + "\n" for e in env))

# the names under which the tunnel reached the hub inside the compose network now mean this machine
names = {"hub"}
project = (cfg.get("Labels") or {}).get("com.docker.compose.project")
if project and cid != "-":
    ids = subprocess.check_output(
        ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]).split()
    for other in ids:
        o = json.loads(subprocess.check_output(["docker", "inspect", other.decode()]))[0]
        if o["Id"] == c["Id"]:
            continue
        names.add(o["Name"].lstrip("/"))
        service = (o["Config"].get("Labels") or {}).get("com.docker.compose.service")
        if service:
            names.add(service)

args = ["/usr/bin/docker", "run", "--rm", "--name", "trommi-proxy", "--network", "host",
        "--env-file", env_path]
for name in sorted(names):
    args += ["--add-host", name + ":127.0.0.1"]
if cfg.get("User"):
    args += ["--user", cfg["User"]]
for bind in host.get("Binds") or []:
    # what was mounted from the old stack's folder is mounted from where that folder moved to
    if bind.startswith(root + "/"):
        bind = moved + bind[len(root):]
    args += ["-v", bind]
entry = cfg.get("Entrypoint") or []
if entry:
    args += ["--entrypoint", entry[0]]
args.append(c["Image"])
args += entry[1:] + (cfg.get("Cmd") or [])


def quote(a):
    # systemd's own quoting: double quotes, with \ " escaped, % and $ doubled
    a = a.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
    return '"' + a + '"'


unit = """# The tunnel (cloudflared) that carries hub.trommi.com to the hub on this machine. Written by hub/deploy/install.sh
# from the container the old stack ran: the same image and settings, now on the host's network.
[Unit]
Description=Trommi tunnel (cloudflared)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStartPre=-/usr/bin/docker rm -f trommi-proxy
ExecStart=%s
ExecStop=/usr/bin/docker stop trommi-proxy
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
""" % " ".join(quote(a) for a in args)
fd = os.open(unit_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(unit)
PY
}

# Arguments: none. Standard input: three lines (key id, team id, topics), then the key in PEM form.
remote_secrets() {
  cat <<'REMOTE'
set -euo pipefail
ETC=/etc/trommi
id trommi >/dev/null 2>&1 || { echo "run 'install' first: the server has no user trommi yet" >&2; exit 1; }
IFS= read -r key_id; IFS= read -r team_id; IFS= read -r topics
umask 077
cat > "$ETC/apns-key.p8.part"
grep -q 'BEGIN PRIVATE KEY' "$ETC/apns-key.p8.part" || { rm -f "$ETC/apns-key.p8.part"; echo "the key did not arrive" >&2; exit 1; }
chown root:trommi "$ETC/apns-key.p8.part"; chmod 0640 "$ETC/apns-key.p8.part"
mv -f "$ETC/apns-key.p8.part" "$ETC/apns-key.p8"
{
  echo "# Push credentials of the hub. Written by hub/deploy/install.sh secrets from the 1Password Environment."
  echo "APPLE_APNS_KEY_FILE=$ETC/apns-key.p8"
  echo "APPLE_APNS_KEY_ID=$key_id"
  echo "APPLE_TEAM_ID=$team_id"
  echo "APPLE_APNS_TOPIC=$topics"
} > "$ETC/hub-secrets.env.part"
mv -f "$ETC/hub-secrets.env.part" "$ETC/hub-secrets.env"
echo "written: $ETC/apns-key.p8 (root and trommi read it), $ETC/hub-secrets.env (root only)"
if systemctl is-active --quiet trommi-hub.service; then
  systemctl restart trommi-hub.service
  sleep 2
  curl -fsS --max-time 5 http://127.0.0.1:8790/healthz >/dev/null || { echo "the hub is NOT well after the restart: journalctl -u trommi-hub -n 30" >&2; exit 1; }
  journalctl -u trommi-hub.service -n 20 --no-pager > /run/trommi-hub-start.log 2>/dev/null || true
  if grep -q '"apns":true' /run/trommi-hub-start.log; then
    echo "the hub was restarted and reports: push to Apple is on"
  else
    echo "the hub was restarted and is well, but does NOT report push to Apple as on: journalctl -u trommi-hub -n 30" >&2; exit 1
  fi
else
  echo "the hub does not run yet; it reads these when it starts"
fi
REMOTE
}

# ---------------------------------------------------------------------------------------------------------------
# What runs on the laptop
# ---------------------------------------------------------------------------------------------------------------

inventory() {
  out="trommi-inventory-$(date +%Y%m%d-%H%M%S).txt"
  say "Reading $HUB_SSH (port $HUB_SSH_PORT); nothing is changed"
  { echo "# Trommi hub server inventory, $(date -u '+%Y-%m-%d %H:%M UTC'), read over $HUB_SSH port $HUB_SSH_PORT"
    remote_inventory | "${SSH[@]}" 'bash -s'
  } > "$out" || die "the server could not be read (ssh to $HUB_SSH port $HUB_SSH_PORT)"
  cat "$out"
  say "Written to $PWD/$out. It holds no secret (values of tokens, keys and passwords are cut out): send it back as it is."
}

install_() {
  for t in ssh scp gh openssl sha256sum python3; do command -v "$t" >/dev/null || die "$t is needed on this laptop"; done
  tag=${1:-}
  if [ -z "$tag" ]; then
    say "Find the newest hub release of $REPOSITORY"
    tag=$(gh release list --repo "$REPOSITORY" --limit 200 --json tagName --jq '.[].tagName' | grep -E '^hub-v[1-9][0-9]*$' | sort -t v -k 2 -n | tail -1) || true
    [ -n "$tag" ] || die "no hub release found in $REPOSITORY (the build on main publishes hub-v<N>)"
  fi
  printf '%s' "$tag" | grep -Eq '^hub-v[1-9][0-9]{0,11}$' || die "not a hub release: $tag"

  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  say "Fetch $tag from GitHub and check it against release/public-key.pem"
  gh release download "$tag" --repo "$REPOSITORY" --dir "$stage"
  cp "$REPO/release/public-key.pem" "$stage/public-key.pem"
  mkdir "$stage/release" && cp "$REPO/release/sign.sh" "$REPO/release/public-key.pem" "$stage/release/"
  sh "$stage/release/sign.sh" verify "$stage/manifest.json"
  sh "$stage/release/sign.sh" files "$stage/manifest.json"
  rm -rf "$stage/release"
  grep -q "\"product\": \"trommi-hub\"" "$stage/manifest.json" || die "the manifest is not a hub's"
  grep -q "\"repository\": \"$REPOSITORY\"" "$stage/manifest.json" || die "the manifest is of another repository"
  grep -q "\"tag\": \"$tag\"" "$stage/manifest.json" || die "the manifest is of another release"
  for f in "trommi-hub-$TARGET" "trommi-hub-updater-$TARGET" trommi-hub.service; do
    grep -q "\"name\": \"$f\"" "$stage/manifest.json" || die "the manifest does not name $f"
  done
  cp "$HERE/trommi-hub-updater.service" "$HERE/updater-prestart.sh" "$stage/"
  proxy_unit_py > "$stage/proxy-unit.py"
  { printf 'TARGET=%q\nREPOSITORY=%q\n' "$TARGET" "$REPOSITORY"; remote_install; } > "$stage/install-remote.sh"
  (cd "$stage" && sha256sum -- * > SHA256SUMS)

  say "Copy the checked files to $HUB_SSH"
  remote_stage="/root/trommi-install-$tag"
  "${SSH[@]}" "rm -rf '$remote_stage' && mkdir -m 0700 '$remote_stage'"
  scp -q -P "$HUB_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ControlPath=none "$stage"/* "$HUB_SSH:$remote_stage/"

  say "Install on $HUB_SSH (every step is printed before it is taken)"
  # the token, if any, travels on standard input: never on a command line
  printf '%s\n' "${TROMMI_RELEASE_TOKEN:-}" | "${SSH[@]}" "bash '$remote_stage/install-remote.sh' '$tag' '$remote_stage'" \
    || die "the installation did not finish; what the server printed above says where it stopped and what runs now. Running this script again is safe."

  say "From this laptop: the hub's public address"
  curl -fsS --max-time 10 https://hub.trommi.com/healthz && echo
  cat <<EOF

Installed. Next:
  1. hub/deploy/install.sh secrets      (under op run, see the head of this script): push to Apple
  2. set the repository variable HUB_SERVER_READY to true: from then on every hub build on main is delivered
Which hub and which updater run:  ssh -p $HUB_SSH_PORT $HUB_SSH trommi-hub-updater status
EOF
}

secrets() {
  for name in APPLE_APNS_KEY APPLE_APNS_KEY_ID APPLE_TEAM_ID APPLE_APNS_TOPIC; do
    [ -n "${!name:-}" ] || die "$name is not set; run this under: op run --environment <hub production environment id> -- $0 secrets"
  done
  for name in APPLE_APNS_KEY_ID APPLE_TEAM_ID APPLE_APNS_TOPIC; do
    case "${!name}" in *[!A-Za-z0-9.,_-]*) die "$name holds characters that do not belong there" ;; esac
  done
  # the key may have lost its line breaks on the way: put it back into PEM form
  body=$(printf '%s' "$APPLE_APNS_KEY" | sed -e 's/\\n/ /g' -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  key=$(printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)")
  printf '%s\n' "$key" | openssl pkey -noout 2>/dev/null || die "APPLE_APNS_KEY is not readable as a private key"
  say "Send the four push settings to $HUB_SSH (names only are shown: APPLE_APNS_KEY, APPLE_APNS_KEY_ID, APPLE_TEAM_ID, APPLE_APNS_TOPIC)"
  topics=$(printf '%s' "$APPLE_APNS_TOPIC" | tr -d ' ')
  script=$(remote_secrets)
  printf '%s\n%s\n%s\n%s\n' "$APPLE_APNS_KEY_ID" "$APPLE_TEAM_ID" "$topics" "$key" | "${SSH[@]}" "bash -c $(printf '%q' "$script")"
}

# Checks this script without a server: the programs it sends parse, and the tunnel unit is written as expected.
selftest() {
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  remote_inventory > "$tmp/inventory.sh" && bash -n "$tmp/inventory.sh"
  remote_install > "$tmp/install.sh" && bash -n "$tmp/install.sh"
  remote_secrets > "$tmp/secrets.sh" && bash -n "$tmp/secrets.sh"
  if command -v shellcheck >/dev/null 2>&1; then
    # TARGET and REPOSITORY are put in front of the installation program when it is sent
    shellcheck -s bash -S warning -e SC2154 "$tmp/inventory.sh" "$tmp/install.sh" "$tmp/secrets.sh"
  fi
  proxy_unit_py > "$tmp/proxy-unit.py"
  cat > "$tmp/inspect.json" <<'JSON'
[{"Id":"abc","Name":"/trommi-cloudflared-1","Image":"sha256:0123","Config":{"Image":"cloudflare/cloudflared:latest",
  "Env":["TUNNEL_TOKEN=not-a-real-token","PATH=/usr/bin"],"Entrypoint":["cloudflared","--no-autoupdate"],
  "Cmd":["tunnel","run","--url","http://hub:8790/100%$x"],"User":"65532:65532","Labels":{}},
  "HostConfig":{"Binds":["/srv/trommi/cf:/etc/cloudflared:ro","/var/lib/x:/x"],"NetworkMode":"trommi_default"}}]
JSON
  python3 "$tmp/proxy-unit.py" - /srv/trommi /srv/trommi-old "$tmp/proxy.env" "$tmp/proxy.service" < "$tmp/inspect.json"
  [ "$(stat -c %a "$tmp/proxy.env")" = 600 ] && [ "$(stat -c %a "$tmp/proxy.service")" = 600 ]
  grep -qx 'TUNNEL_TOKEN=not-a-real-token' "$tmp/proxy.env"
  grep -qx 'TUNNEL_METRICS=127.0.0.1:20241' "$tmp/proxy.env"
  if grep -q 'not-a-real-token' "$tmp/proxy.service"; then die "the tunnel's token would be written into the unit"; fi
  # shellcheck disable=SC2016 # the text systemd is given, as it is
  want='ExecStart="/usr/bin/docker" "run" "--rm" "--name" "trommi-proxy" "--network" "host" "--env-file" "'"$tmp"'/proxy.env" "--add-host" "hub:127.0.0.1" "--user" "65532:65532" "-v" "/srv/trommi-old/cf:/etc/cloudflared:ro" "-v" "/var/lib/x:/x" "--entrypoint" "cloudflared" "sha256:0123" "--no-autoupdate" "tunnel" "run" "--url" "http://hub:8790/100%%$$x"'
  grep -qxF "$want" "$tmp/proxy.service" || { grep '^ExecStart=' "$tmp/proxy.service"; die "the tunnel unit is not as expected"; }
  # what the inventory cuts out
  redact=$(sed -n '/^redact() {$/,/^}$/p' "$tmp/inventory.sh")
  out=$(printf '%s\n' 'TUNNEL_TOKEN=abc' '  command: tunnel run --token eyJhIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwIn0' 'image: x' 'password: "p"' | bash -c "$redact; redact")
  case "$out" in *abc*|*eyJ*|*'"p"'*) die "the inventory would show a secret" ;; esac
  printf '%s\n' "$out" | grep -qx 'image: x' || die "the inventory cuts out too much"
  echo "selftest: ok"
}

case "${1:-}" in
  inventory) inventory ;;
  install) install_ "${2:-}" ;;
  secrets) secrets ;;
  selftest) selftest ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

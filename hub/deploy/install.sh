#!/usr/bin/env bash
# The hub server's first installation, run on the owner's laptop from a checkout of this repository.
#
#   hub/deploy/install.sh inventory          reads the server, writes trommi-inventory-<time>.txt; changes nothing
#   hub/deploy/install.sh install [hub-vN]   installs the updater and a hub release (default: the newest)
#   hub/deploy/install.sh secrets            sends the push credentials; run it as
#                                              op run --environment <hub production environment id> -- hub/deploy/install.sh secrets
#   hub/deploy/install.sh back               undoes `install`: stops the new hub, puts the old stack back, starts it
#
# It reaches the server with ssh as root (1Password approves the key): HUB_SSH (default
# root@trommi-hub.tail276436.ts.net), HUB_SSH_PORT (default 22).
#
# What `install` does on the server, each step printed before it is taken and checked after:
#   1. looks, and stops before changing anything if something is not as expected
#   2. stops the old hub container (docker compose stop hub in /srv/trommi) and moves the whole old stack, with its
#      data and backups, to /srv/trommi-old. The tunnel container (cloudflared) is not touched and keeps running.
#   3. makes a new, empty /srv/trommi, installs the pinned release key, the updater and its unit
#   4. lets the updater deploy the release (it proves it itself), and asks the hub through its public address
# It deletes nothing and can be run again at any time. If a step fails after the old hub was stopped, the old stack
# is put back and started. After the first installation everything arrives by release: hub, its unit, the updater.
set -euo pipefail

HUB_SSH=${HUB_SSH:-root@trommi-hub.tail276436.ts.net}
HUB_SSH_PORT=${HUB_SSH_PORT:-22}
REPOSITORY=trommi/trommi
TARGET=x86_64-unknown-linux-musl
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The owner's ssh key lives in 1Password; its agent is used when no other is set.
if [ -z "${SSH_AUTH_SOCK:-}" ] && [ -S "$HOME/.1password/agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/.1password/agent.sock"
fi
SSH_OPTIONS=(-o StrictHostKeyChecking=accept-new -o ControlPath=none -o ConnectTimeout=15)
SSH=(ssh -p "$HUB_SSH_PORT" "${SSH_OPTIONS[@]}" "$HUB_SSH")

# ---------------------------------------------------------------------------------------------------------------
# What runs on the server: programs sent over the ssh connection
# ---------------------------------------------------------------------------------------------------------------

# Reads only. Settings are shown by name, never by value; command lines only as far as they are plain words.
remote_inventory() {
  cat <<'REMOTE'
set -u
export LC_ALL=C
section() { printf '\n## %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# a second net under everything printed below: values of settings whose name sounds secret, long key-like runs
redact() {
  sed -E \
    -e 's/(([A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASSWD|HASH|CREDENTIAL)[A-Za-z0-9_]*)"?[[:space:]]*[=:][[:space:]]*).*/\1<redacted>/I' \
    -e 's/(--token[= ]+)[^ ]+/\1<redacted>/g' \
    -e 's/[A-Za-z0-9+\/_=-]{32,}/<redacted>/g'
}
{
section "machine"
date -u '+now (UTC): %Y-%m-%d %H:%M:%S'
have timedatectl && timedatectl show -p Timezone -p NTPSynchronized 2>/dev/null
. /etc/os-release 2>/dev/null && echo "os: ${PRETTY_NAME:-?}"
echo "arch: $(uname -m)   kernel: $(uname -r)   systemd: $(systemctl --version 2>/dev/null | head -1)"
echo "cpus: $(nproc 2>/dev/null)"; free -m 2>/dev/null | sed -n '1,2p'
df -h / /srv 2>/dev/null

section "tools"
for t in curl python3 openssl sha256sum docker tailscale ss flock; do
  if have "$t"; then echo "$t: yes"; else echo "$t: MISSING"; fi
done

section "automatic updates"
have apt-config && apt-config dump 2>/dev/null | grep -E 'APT::Periodic::(Unattended-Upgrade|Update-Package-Lists)|Unattended-Upgrade::Automatic-Reboot'
echo "unattended-upgrades.service: $(systemctl is-enabled unattended-upgrades.service 2>/dev/null)"

section "tailscale"
if have tailscale; then
  tailscale version 2>/dev/null | head -1
  echo "addresses: $(tailscale ip 2>/dev/null | tr '\n' ' ')"
  tailscale status --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin).get("Self", {})
print("name:", s.get("DNSName"), " tags:", s.get("Tags") or "none", " online:", s.get("Online"))' 2>/dev/null
  tailscale debug prefs 2>/dev/null | python3 -c '
import json, sys
p = json.load(sys.stdin)
print("Tailscale SSH:", "ON" if p.get("RunSSH") else "off", " auto-update:", (p.get("AutoUpdate") or {}).get("Apply"))' 2>/dev/null
  echo "tailscale serve:"; tailscale serve status 2>&1 | sed 's/^/  /'
fi

section "ssh"
for u in ssh.socket ssh.service; do echo "$u: $(systemctl is-active "$u" 2>/dev/null)"; done
grep -HEi '^[[:space:]]*(Port|ListenAddress)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^/  /'

section "firewall on the machine"
have ufw && ufw status 2>/dev/null | head -1
have nft && echo "nft rules: $(nft list ruleset 2>/dev/null | grep -c .)"

section "what listens (tcp)"
ss -tlnpH 2>/dev/null | awk '{print $4 "  " $6}' | sort -u
for p in 9443 8790; do
  if ss -tlnH 2>/dev/null | awk -v p=":$p\$" '$4 ~ p {f = 1} END {exit !f}'; then echo "port $p: taken"; else echo "port $p: free"; fi
done

section "docker"
if have docker; then
  docker version --format 'docker {{.Server.Version}}' 2>/dev/null
  echo "compose projects:"; docker compose ls 2>/dev/null | sed 's/^/  /'
  for id in $(docker ps -aq 2>/dev/null); do
    docker inspect "$id" 2>/dev/null | python3 -c '
import json, re, sys
c = json.load(sys.stdin)[0]
cfg, host = c["Config"], c["HostConfig"]
def words(args):
    # only what is plainly a flag or a sub-command is shown
    return [a if re.fullmatch(r"-{0,2}[A-Za-z][A-Za-z0-9-]*|/[A-Za-z0-9/_.-]{1,40}", a) else "<hidden>" for a in args or []]
print()
print("container", c["Name"].lstrip("/"), "-", c["State"]["Status"])
print("  image:", cfg.get("Image"), c["Image"][:19])
print("  compose service:", (cfg.get("Labels") or {}).get("com.docker.compose.service"))
print("  entrypoint:", words(cfg.get("Entrypoint")), " command:", words(cfg.get("Cmd")))
print("  setting names:", sorted(e.split("=", 1)[0] for e in cfg.get("Env") or []))
print("  user:", cfg.get("User") or "(image default)", " network:", host.get("NetworkMode"),
      " restart:", (host.get("RestartPolicy") or {}).get("Name"))
print("  ports:", sorted((host.get("PortBindings") or {}).keys()), " mounts:", [m.get("Source") for m in c.get("Mounts") or []])' 2>/dev/null
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
  for f in "$d"/*.env "$d"/.env; do
    [ -f "$f" ] && echo "  $f, names only: $(grep -Eo '^[A-Za-z_][A-Za-z0-9_]*' "$f" | tr '\n' ' ')"
  done
done

section "a Trommi installation by this script"
if [ -d /etc/trommi ]; then ls -la /etc/trommi | sed 's/^/  /'; else echo "/etc/trommi: not there"; fi
for l in current previous updater updater-previous; do
  [ -L "/srv/trommi/$l" ] && echo "  /srv/trommi/$l -> $(readlink "/srv/trommi/$l")"
done
for u in trommi-hub.service trommi-hub-updater.service; do
  echo "  $u: $(systemctl is-active "$u" 2>/dev/null || true)"
done
[ -x /usr/local/bin/trommi-hub-updater ] && /usr/local/bin/trommi-hub-updater status 2>/dev/null | sed 's/^/  /'
} 2>&1 | redact
exit 0
REMOTE
}

# Shared by `install` and `back`: where things are, and how the old stack is put back.
remote_common() {
  cat <<'REMOTE'
set -euo pipefail
export LC_ALL=C
ROOT=/srv/trommi OLD=/srv/trommi-old UNITS=/etc/systemd/system
step() { printf '\n--> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
stop() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
# whether something listens on exactly this address; whether anything listens on this port at all
listens() { ss -tlnH 2>/dev/null | awk -v a="$1" '$4 == a {f = 1} END {exit !f}'; }
port_taken() { ss -tlnH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {f = 1} END {exit !f}'; }
old_stack_here() { [ -f "$1/compose.yaml" ] || [ -f "$1/docker-compose.yml" ]; }

# One installation or undoing at a time.
exec 9> /run/trommi-install.lock
flock -n 9 || stop "another run of this script is at work on the server"

# Stops what this script installed and starts the old stack from where it was. Deletes nothing.
put_old_back() {
  systemctl disable --now trommi-hub-updater.service >/dev/null 2>&1 || true
  systemctl stop trommi-hub.service >/dev/null 2>&1 || true
  rm -f "$UNITS/trommi-hub.service"
  systemctl daemon-reload || true
  if [ -d "$OLD" ]; then
    if [ -e "$ROOT" ]; then
      aside="/srv/trommi-new-$(date -u +%Y%m%d-%H%M%S)"
      mv "$ROOT" "$aside"
      echo "    the new installation (its data too) is kept in $aside"
    fi
    mv "$OLD" "$ROOT"
  fi
  old_stack_here "$ROOT" || { echo "    there is no old stack in $ROOT to start" >&2; return 1; }
  (cd "$ROOT" && docker compose up -d)
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:8790/healthz >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "    the old hub was started but does not answer on 127.0.0.1:8790: cd $ROOT && docker compose ps" >&2
  return 1
}
REMOTE
}

remote_back() {
  remote_common
  cat <<'REMOTE'
step "Stop the new hub and its updater, put the old stack back into $ROOT and start it"
put_old_back || stop "the old stack is not running; see above"
ok "the old stack runs again (docker compose in $ROOT)"
REMOTE
}

# Arguments: <tag> <staging directory>.
remote_install() {
  remote_common
  cat <<'REMOTE'
TAG=$1 STAGE=$2 ETC=/etc/trommi LIB=/usr/local/lib/trommi

# ---- 1. look, change nothing ----
step "Look at the server (nothing is changed yet)"
[ "$(id -u)" = 0 ] || stop "this must run as root"
[ "$(uname -m)" = x86_64 ] || stop "this server is $(uname -m); the release is built for x86_64"
[ -d /run/systemd/system ] || stop "this server does not run systemd"
for t in curl python3 sha256sum tailscale ss; do command -v "$t" >/dev/null || stop "$t is missing on the server"; done
(cd "$STAGE" && sha256sum --quiet -c SHA256SUMS) || stop "the files did not arrive whole; run the script again"
TSIP=$(tailscale ip -4 2>/dev/null | head -1)
case "$TSIP" in 100.*) ;; *) stop "the server has no tailnet address (is tailscale up?)" ;; esac
if [ -f "$ETC/release-public-key.pem" ] && ! cmp -s "$ETC/release-public-key.pem" "$STAGE/public-key.pem"; then
  stop "another release key is pinned in $ETC/release-public-key.pem; this script never replaces it"
fi
if old_stack_here "$ROOT"; then
  [ ! -e "$OLD" ] || stop "$OLD exists already although $ROOT still holds the old stack; run 'inventory' and look"
  command -v docker >/dev/null || stop "the old stack is a docker compose stack, but docker is not there"
  STATE=old-stack
elif [ -d "$ROOT/releases" ] || [ ! -e "$ROOT" ] || [ -z "$(ls -A "$ROOT")" ]; then
  STATE=ours
else
  stop "$ROOT holds something this script does not know; run 'inventory' and look"
fi
if port_taken 9443 && ! systemctl is-active --quiet trommi-hub-updater.service; then stop "port 9443 is taken by something else"; fi
if [ "$STATE" = ours ] && port_taken 8790 && ! systemctl is-active --quiet trommi-hub.service; then
  stop "port 8790 is taken by something else"
fi
tunnels=0
if command -v docker >/dev/null; then
  tunnels=$(docker ps --filter network=host --format '{{.Image}}' | grep -ci cloudflared || true)
fi
ok "state: $STATE; tailnet address $TSIP; tunnel containers on the host's network: $tunnels (left as they are)"

# The owner's tailnet login, from this very ssh connection: his own devices may call the endpoint beside the CI.
read -r client_ip client_port _ <<< "${SSH_CLIENT:-}"
OWNER=$(tailscale whois --json "$client_ip:$client_port" 2>/dev/null | python3 -c '
import json, sys
w = json.load(sys.stdin)
print("" if w["Node"].get("Tags") else w["UserProfile"].get("LoginName", ""))' 2>/dev/null || true)
case "$OWNER" in *[!A-Za-z0-9@._+-]*) OWNER='' ;; esac

# ---- from here on things change; if a step fails once the old hub was stopped, the old stack is put back ----
TOUCHED=0
on_exit() {
  code=$?
  trap - EXIT
  [ "$code" = 0 ] && exit 0
  if [ "$TOUCHED" = 1 ]; then
    printf '\n!!! A step failed. Putting the old stack back.\n' >&2
    if put_old_back; then
      printf '!!! The old stack runs again from %s. Nothing was deleted. Fix what failed above and run install again.\n' "$ROOT" >&2
    else
      printf '!!! The old stack does NOT run. Run:  hub/deploy/install.sh back\n' >&2
    fi
  else
    printf '\n!!! A step failed. Nothing that ran before was stopped. Fix what failed above and run install again.\n' >&2
  fi
  exit "$code"
}
trap on_exit EXIT

step "User trommi (the hub runs as it)"
id trommi >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin trommi
ok "$(id trommi)"

if [ "$STATE" = old-stack ]; then
  step "Stop the old hub container (docker compose stop hub in $ROOT); the tunnel container keeps running"
  TOUCHED=1
  (cd "$ROOT" && docker compose stop hub)
  for _ in $(seq 1 15); do port_taken 8790 || break; sleep 1; done
  if port_taken 8790; then stop "port 8790 is still taken after the old hub was stopped"; fi
  ok "stopped; port 8790 is free"

  step "Move the old stack aside with all its data and backups: $ROOT -> $OLD"
  mv "$ROOT" "$OLD"
  [ -d "$OLD" ] && [ ! -e "$ROOT" ]
  ok "in $OLD, untouched"
fi

step "Folders (a new, empty data folder: the hub starts clean)"
systemctl stop trommi-hub-updater.service >/dev/null 2>&1 || true
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
# the address devices sign in to (their signatures name it)
HUB_URL=https://hub.trommi.com
HUB_ORIGINS=https://app.trommi.com
# the tunnel on this machine names the client's address in a header; without this every client is one source
HUB_TRUST_CF=1
HUB_WEB_PUSH_SUBJECT=mailto:trommi@mail101.de
# HSTS: "on" makes every answer tell browsers to use HTTPS only for this name and every name below it, for two
# years, marked as fit for the browsers' preload list. Switch it on only when that is decided; then:
# systemctl restart trommi-hub
HUB_HSTS=off
# The admin page (later, on 127.0.0.1:8791 behind tailscale serve) starts only when its password hash is set,
# in hub-secrets.env: HUB_ADMIN_PASSWORD_HASH=...
ENV
fi
chmod 0644 "$ETC/hub.env"
printf '%s\n' "# Settings of the updater (hub/updater/src/main.rs lists them). Written by hub/deploy/install.sh." \
  "UPDATER_LISTEN=$TSIP:9443" "UPDATER_REPOSITORY=$REPOSITORY" "UPDATER_CALLER_TAGS=tag:trommi-ci" \
  "UPDATER_CALLER_USERS=$OWNER" > "$ETC/updater.env"
chmod 0644 "$ETC/updater.env"
ok "the endpoint will listen on $TSIP:9443 only; callers: tag:trommi-ci${OWNER:+ and $OWNER}"

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
if [ -L "$ROOT/updater" ]; then
  ok "an updater is in place already ($(readlink "$ROOT/updater")); it changes itself by release"
else
  ln -s "releases/$TAG" "$ROOT/updater"
  ok "the first updater is the one of $TAG"
fi
[ -x "$ROOT/updater/trommi-hub-updater" ]
# the hub's unit is the one of the release that runs; the updater starts the hub, also after a reboot
ln -sfn "$ROOT/current/trommi-hub.service" "$UNITS/trommi-hub.service"

step "Start the updater (systemd; at boot too)"
systemctl daemon-reload
systemctl enable trommi-hub-updater.service >/dev/null
systemctl restart trommi-hub-updater.service
listens "$TSIP:9443" || { journalctl -u trommi-hub-updater.service -n 20 --no-pager >&2; stop "the updater does not listen on $TSIP:9443"; }
[ "$(ss -tlnH | awk '$4 ~ /:9443$/' | wc -l)" = 1 ] || stop "port 9443 listens on more than the tailnet address"
ok "listening on $TSIP:9443 and nowhere else"

step "Deploy $TAG through the updater (it proves the release itself, swaps, checks health)"
/usr/local/bin/trommi-hub-updater deploy "$TAG" > "$STAGE/outcome.json" || true
cat "$STAGE/outcome.json"
python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") is True else 1)' "$STAGE/outcome.json" \
  || stop "the updater did not accept $TAG (its answer is above; the hub's own words: journalctl -u trommi-hub -n 30)"
curl -fsS --max-time 5 http://127.0.0.1:8790/healthz >/dev/null
systemctl is-active --quiet trommi-hub.service
ok "the hub runs and is well"

step "Ask the hub from outside, through the tunnel"
url=$(sed -n 's/^HUB_URL=//p' "$ETC/hub.env" | head -1)
want=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["commit"])' "$ROOT/current/manifest.json")
got=''
for _ in $(seq 1 30); do
  got=$(curl -fsS --max-time 5 "$url/healthz" 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin).get("commit", ""))' 2>/dev/null || true)
  [ "$got" = "$want" ] && break
  sleep 2
done
[ "$got" = "$want" ] || stop "$url/healthz does not answer as the new hub (got: ${got:-nothing}, expected $want)"
ok "$url answers as commit $want"

trap - EXIT
step "Done"
/usr/local/bin/trommi-hub-updater status
printf 'trommi-hub.service: %s    trommi-hub-updater.service: %s, at boot: %s\n' \
  "$(systemctl is-active trommi-hub.service)" "$(systemctl is-active trommi-hub-updater.service)" "$(systemctl is-enabled trommi-hub-updater.service)"
[ -d "$OLD" ] && printf 'The old stack lies untouched in %s (its hub container stopped, its tunnel container still running).\n' "$OLD"
printf 'Should a later release refuse the data of an earlier one (before launch the hub does not migrate), a clean\nstart is: systemctl stop trommi-hub; mv %s/data %s/data-old; install -d -m 0700 -o trommi -g trommi %s/data; systemctl start trommi-hub\n' "$ROOT" "$ROOT" "$ROOT"
rm -rf "$STAGE"
printf '\nINSTALLED: %s runs.\n' "$TAG"
REMOTE
}

# Standard input: three lines (key id, team id, topics), then the key in PEM form.
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
# other lines of the file (set by hand, such as the admin page's password hash) are kept
{ grep -v '^APPLE_\|^# Push credentials' "$ETC/hub-secrets.env" 2>/dev/null || true
  printf '%s\n' "# Push credentials of the hub. Written by hub/deploy/install.sh secrets from the 1Password Environment." \
    "APPLE_APNS_KEY_FILE=$ETC/apns-key.p8" "APPLE_APNS_KEY_ID=$key_id" "APPLE_TEAM_ID=$team_id" "APPLE_APNS_TOPIC=$topics"
} > "$ETC/hub-secrets.env.part"
mv -f "$ETC/hub-secrets.env.part" "$ETC/hub-secrets.env"
echo "written: $ETC/apns-key.p8 (root and trommi read it), $ETC/hub-secrets.env (root only)"
systemctl is-active --quiet trommi-hub.service || { echo "the hub does not run yet; it reads these when it starts"; exit 0; }
systemctl restart trommi-hub.service
sleep 2
curl -fsS --max-time 5 http://127.0.0.1:8790/healthz >/dev/null || { echo "the hub is NOT well after the restart: journalctl -u trommi-hub -n 30" >&2; exit 1; }
journalctl -u trommi-hub.service -n 20 --no-pager > /run/trommi-hub-start.log 2>/dev/null || true
if grep -q '"apns":true' /run/trommi-hub-start.log; then
  echo "SECRETS SENT: the hub was restarted and reports that push to Apple is on"
else
  echo "the hub was restarted and is well, but does NOT report push to Apple as on: journalctl -u trommi-hub -n 30" >&2; exit 1
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
  say "INVENTORY WRITTEN: $PWD/$out (settings by name only, no values). Read it once before you send it."
}

# Fetches the release into $1 and proves it: the signature of the manifest, then every file against the manifest.
fetch_release() {
  stage=$1 tag=$2
  for name in manifest.json manifest.json.sig "trommi-hub-$TARGET" "trommi-hub-updater-$TARGET" trommi-hub.service; do
    curl -fsSL --max-time 300 -o "$stage/$name" "https://github.com/$REPOSITORY/releases/download/$tag/$name" \
      || die "could not fetch $name of $tag from GitHub"
  done
  mkdir "$stage/release" && cp "$REPO/release/sign.sh" "$REPO/release/public-key.pem" "$stage/release/"
  sh "$stage/release/sign.sh" verify "$stage/manifest.json" || die "the signature of $tag is not good"
  rm -rf "$stage/release"
  python3 - "$stage" "$tag" "$REPOSITORY" "$TARGET" <<'PY' || die "the release $tag is not what its manifest says"
import hashlib, json, os, sys
stage, tag, repository, target = sys.argv[1:5]
m = json.load(open(os.path.join(stage, "manifest.json")))
assert m["product"] == "trommi-hub" and m["repository"] == repository, "another product or repository"
assert m["tag"] == tag and tag == "hub-v%d" % m["version"], "another release"
for name in ("trommi-hub-" + target, "trommi-hub-updater-" + target, "trommi-hub.service"):
    entries = [a for a in m["assets"] if a["name"] == name]
    assert len(entries) == 1, "the manifest does not name exactly one " + name
    data = open(os.path.join(stage, name), "rb").read()
    assert len(data) == entries[0]["size"] and hashlib.sha256(data).hexdigest() == entries[0]["sha256"], name + " is not the file the manifest names"
    print(name + ": as the manifest says")
PY
}

install_() {
  for t in ssh scp curl openssl sha256sum python3; do command -v "$t" >/dev/null || die "$t is needed on this laptop"; done
  tag=${1:-}
  if [ -z "$tag" ]; then
    say "Find the newest hub release of $REPOSITORY"
    tag=$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPOSITORY/releases?per_page=100" | python3 -c '
import json, re, sys
tags = [r["tag_name"] for r in json.load(sys.stdin) if not r["draft"] and re.fullmatch(r"hub-v[1-9][0-9]*", r["tag_name"])]
print(max(tags, key=lambda t: int(t[5:])) if tags else "")') || die "GitHub could not be asked for the releases"
    [ -n "$tag" ] || die "no hub release found in $REPOSITORY (the build on main publishes hub-v<N>)"
  fi
  printf '%s' "$tag" | grep -Eq '^hub-v[1-9][0-9]{0,11}$' || die "not a hub release: $tag"

  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  say "Fetch $tag from GitHub and check it against release/public-key.pem"
  fetch_release "$stage" "$tag"
  cp "$REPO/release/public-key.pem" "$HERE/trommi-hub-updater.service" "$HERE/updater-prestart.sh" "$stage/"
  { printf 'TARGET=%q\nREPOSITORY=%q\n' "$TARGET" "$REPOSITORY"; remote_install; } > "$stage/install-remote.sh"
  (cd "$stage" && sha256sum -- * > SHA256SUMS)

  say "Copy the checked files to $HUB_SSH"
  remote_stage=$("${SSH[@]}" 'mktemp -d /root/trommi-install.XXXXXX')
  case "$remote_stage" in /root/trommi-install.*) ;; *) die "the server gave no folder to copy into" ;; esac
  scp -q -P "$HUB_SSH_PORT" "${SSH_OPTIONS[@]}" "$stage"/* "$HUB_SSH:$remote_stage/"

  say "Install on $HUB_SSH (every step is printed before it is taken)"
  "${SSH[@]}" "bash '$remote_stage/install-remote.sh' '$tag' '$remote_stage'" \
    || die "the installation did not finish; the server's last lines above say where it stopped and what runs now. Running install again is safe."

  cat <<EOF

Next:
  1. op run --environment <hub production environment id> -- hub/deploy/install.sh secrets     (push to Apple)
  2. nothing else: from now on every hub build on main is delivered by itself
Which hub and which updater run:   ssh -p $HUB_SSH_PORT $HUB_SSH trommi-hub-updater status
Back to the old stack:             hub/deploy/install.sh back
EOF
}

back() {
  say "Put the old stack back on $HUB_SSH"
  remote_back | "${SSH[@]}" 'bash -s' || die "the old stack does not run; see above"
  say "BACK: the old stack runs again; the new installation was stopped and kept."
}

secrets() {
  for name in APPLE_APNS_KEY APPLE_APNS_KEY_ID APPLE_TEAM_ID APPLE_APNS_TOPIC; do
    [ -n "${!name:-}" ] || die "$name is not set; run this under: op run --environment <hub production environment id> -- $0 secrets"
  done
  topics=$(printf '%s' "$APPLE_APNS_TOPIC" | tr -d ' ')
  for value in "$APPLE_APNS_KEY_ID" "$APPLE_TEAM_ID" "$topics"; do
    case "$value" in *[!A-Za-z0-9.,_-]*) die "one of the three short push settings holds characters that do not belong there" ;; esac
  done
  # the key may have lost its line breaks on the way: put it back into PEM form
  body=$(printf '%s' "$APPLE_APNS_KEY" | sed -e 's/\\n/ /g' -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  key=$(printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)")
  printf '%s\n' "$key" | openssl pkey -noout 2>/dev/null || die "APPLE_APNS_KEY is not readable as a private key"
  say "Send the four push settings to $HUB_SSH (only their names are ever shown)"
  # the values travel on standard input, the program as the command: nothing secret is on a command line
  printf '%s\n%s\n%s\n%s\n' "$APPLE_APNS_KEY_ID" "$APPLE_TEAM_ID" "$topics" "$key" | "${SSH[@]}" "bash -c $(printf '%q' "$(remote_secrets)")"
}

# Checks this script without a server (the build runs it): the programs it sends parse and pass shellcheck, and the
# inventory's second net catches what it should.
check() {
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  remote_inventory > "$tmp/inventory.sh"; remote_install > "$tmp/install.sh"
  remote_back > "$tmp/back.sh"; remote_secrets > "$tmp/secrets.sh"
  for f in "$tmp"/*.sh; do bash -n "$f"; done
  if command -v shellcheck >/dev/null 2>&1; then
    # TARGET and REPOSITORY are put in front of the installation program when it is sent
    shellcheck -s bash -S warning -e SC2154 "$tmp"/*.sh
  fi
  redact=$(sed -n '/^redact() {$/,/^}$/p' "$tmp/inventory.sh")
  out=$(printf '%s\n' 'TUNNEL_TOKEN=abc' 'run --token eyJhIjoiMTIz' '"ADMIN_PASSWORD_HASH": "short"' 'image: x' | bash -c "$redact; redact")
  case "$out" in *abc*|*eyJ*|*short*) die "the inventory would show a secret" ;; esac
  printf '%s\n' "$out" | grep -qx 'image: x' || die "the inventory cuts out too much"
  echo "check: ok"
}

case "${1:-}" in
  inventory) inventory ;;
  install) install_ "${2:-}" ;;
  secrets) secrets ;;
  back) back ;;
  check) check ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

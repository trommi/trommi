#!/usr/bin/env bash
# The hub server's installation, run on the owner's laptop from a checkout of this repository.
#
#   hub/deploy/install.sh inventory          reads the server, writes trommi-inventory-<time>.txt; changes nothing
#   hub/deploy/install.sh install [hub-vN]   installs the fixed parts and a hub release (default: the newest)
#   hub/deploy/install.sh secrets            sends the push credentials; run it as
#                                              op run --environment <hub production environment id> -- hub/deploy/install.sh secrets
#
# It reaches the server with ssh as root (1Password approves the key): HUB_SSH (default
# root@trommi-hub.tail276436.ts.net), HUB_SSH_PORT (default 22).
#
# What is installed here and only here (root's; no release can change it): the users `trommi` and `trommi-updater`,
# the pinned release key and the settings in /etc/trommi, the units trommi-hub.service, trommi-hub-updater.service,
# trommi-hub-ctl.socket and trommi-hub-ctl@.service, and the scripts hub-prestart.sh, updater-prestart.sh and
# hub-ctl.sh in /usr/local/lib/trommi. What arrives by release afterwards: the hub and the updater, as programs
# under /srv/trommi/deploy, which belongs to trommi-updater. Nothing of Trommi runs as root except hub-ctl.sh, which
# starts or stops the hub's unit when the updater asks. A change to one of the fixed parts: run `install` again.
#
# `install` prints each step before it takes it and checks it after; it deletes nothing and can be run again at any
# time. On a server whose updater still runs as root (installed before this) it converts in place: about a minute
# without the hub; if a step fails, everything is moved back and the old updater is started.
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
    # flags by their name; of everything else only the program and the two sub-commands a tunnel is run with
    return [a if re.fullmatch(r"--?[A-Za-z][A-Za-z0-9-]*", a) or a in ("tunnel", "run", "cloudflared", "/trommi-hub") else "<hidden>" for a in args or []]
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
for d in /srv/trommi /srv/trommi/deploy; do
  for l in current previous updater updater-previous; do
    [ -L "$d/$l" ] && echo "  $d/$l -> $(readlink "$d/$l")"
  done
done
id trommi 2>&1; id trommi-updater 2>&1
for u in trommi-hub.service trommi-hub-updater.service trommi-hub-ctl.socket; do
  echo "  $u: $(systemctl is-active "$u" 2>/dev/null || true)"
done
[ -x /usr/local/bin/trommi-hub-updater ] && /usr/local/bin/trommi-hub-updater status 2>/dev/null | sed 's/^/  /'
} 2>&1 | redact
exit 0
REMOTE
}

# Shared by what `install` runs on the server: where things are, and how a conversion is undone.
remote_common() {
  cat <<'REMOTE'
set -euo pipefail
export LC_ALL=C
# whatever the ssh session hands down: nothing made here is writable by others
umask 022
ROOT=/srv/trommi DEPLOY=/srv/trommi/deploy ETC=/etc/trommi LIB=/usr/local/lib/trommi UNITS=/etc/systemd/system
SAVE=/etc/trommi/before-noroot
MOVED="releases current previous updater updater-previous state.json deploy.lock updater-reverted"
step() { printf '\n--> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
stop() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
# whether something listens on exactly this address; whether anything listens on this port at all
listens() { ss -tlnH 2>/dev/null | awk -v a="$1" '$4 == a {f = 1} END {exit !f}'; }
port_taken() { ss -tlnH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {f = 1} END {exit !f}'; }
# Root does not write or run anything under $DEPLOY itself: that folder is the updater's, and whatever lies in it
# is not root's to trust. Files go in and commands run there as the updater's user.
as_updater() { (cd / && runuser -u trommi-updater -- "$@"); }
hub_well() {
  for _ in $(seq 1 "${1:-30}"); do
    if curl -fsS --max-time 3 http://127.0.0.1:8790/healthz >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# One installation at a time.
exec 9> /run/trommi-install.lock
flock -n 9 || stop "another run of this script is at work on the server"

# Undoes the conversion of an installation whose updater ran as root: the releases, links and state as they were
# copied into $SAVE before anything was handed to the updater's user, the old units, and the old updater started.
# Nothing that user could have written is taken back or run: its folder is set aside as it is. Every step is checked
# by itself (a function called in a condition does not stop at a failing command on its own). Safe to run on a
# conversion that was cut off anywhere.
undo_conversion() {
  [ -d "$SAVE" ] || return 0
  systemctl disable --now trommi-hub-ctl.socket >/dev/null 2>&1 || true
  systemctl stop trommi-hub-updater.service trommi-hub.service 'trommi-hub-ctl@*.service' >/dev/null 2>&1 || true
  rm -f "${UNITS:?}/trommi-hub-ctl.socket" "${UNITS:?}/trommi-hub-ctl@.service" "${UNITS:?}/trommi-hub.service" || return 1
  aside="$ROOT/conversion-undone-$(date -u +%Y%m%d-%H%M%S)"
  mkdir -m 0700 "$aside" || return 1
  if [ -e "$DEPLOY" ]; then mv -T "$DEPLOY" "$aside/deploy" || return 1; fi
  for name in $MOVED; do
    if [ -e "$ROOT/$name" ] || [ -L "$ROOT/$name" ]; then mv -T "$ROOT/$name" "$aside/$name" || return 1; fi
  done
  cp -a "$SAVE/releases" "$ROOT/releases" || return 1
  # the copy's folder is root's alone; the hub (as trommi) must reach its program through it again
  chmod 0755 "$ROOT/releases" || return 1
  if [ -f "$SAVE/state.json" ]; then cp -a "$SAVE/state.json" "$ROOT/state.json" || return 1; fi
  while read -r name target; do
    ln -sfn "$target" "$ROOT/$name" || return 1
  done < "$SAVE/links"
  if [ -d "$ROOT/backups" ]; then chown -R root:root "$ROOT/backups" || return 1; fi
  install -m 0644 "$SAVE/trommi-hub-updater.service" "$UNITS/trommi-hub-updater.service" || return 1
  install -m 0644 "$SAVE/updater.env" "$ETC/updater.env" || return 1
  install -m 0755 "$SAVE/command" /usr/local/bin/trommi-hub-updater || return 1
  ln -sfn "$ROOT/current/trommi-hub.service" "$UNITS/trommi-hub.service" || return 1
  systemctl daemon-reload || return 1
  systemctl enable trommi-hub-updater.service >/dev/null 2>&1 || true
  systemctl restart trommi-hub-updater.service || { echo "    the old updater did not start: journalctl -u trommi-hub-updater -n 30" >&2; return 1; }
  hub_well 45 || { echo "    the old updater runs, but the hub does not answer on 127.0.0.1:8790: journalctl -u trommi-hub -n 30" >&2; return 1; }
  mv -T "$SAVE" "$ETC/before-noroot-undone-$(date -u +%Y%m%d-%H%M%S)" || return 1
  echo "    what the new updater's user had in its folder is kept, unused, in $aside"
}
REMOTE
}

# Arguments: <tag> <staging directory>.
remote_install() {
  remote_common
  cat <<'REMOTE'
TAG=$1 STAGE=$2

# ---- 1. look, change nothing ----
step "Look at the server (nothing is changed yet)"
[ "$(id -u)" = 0 ] || stop "this must run as root"
[ "$(uname -m)" = x86_64 ] || stop "this server is $(uname -m); the release is built for x86_64"
[ -d /run/systemd/system ] || stop "this server does not run systemd"
for t in curl python3 sha256sum tailscale ss runuser setsid flock useradd; do command -v "$t" >/dev/null || stop "$t is missing on the server"; done
(cd "$STAGE" && sha256sum --quiet -c SHA256SUMS) || stop "the files did not arrive whole; run the script again"
TSIP=$(tailscale ip -4 2>/dev/null | head -1)
case "$TSIP" in 100.*) ;; *) stop "the server has no tailnet address (is tailscale up?)" ;; esac
if [ -f "$ETC/release-public-key.pem" ] && ! cmp -s "$ETC/release-public-key.pem" "$STAGE/public-key.pem"; then
  stop "another release key is pinned in $ETC/release-public-key.pem; this script never replaces it"
fi
if [ -f "$ROOT/compose.yaml" ] || [ -f "$ROOT/docker-compose.yml" ]; then
  stop "$ROOT holds a docker compose stack; this script no longer moves one aside (move it away by hand first)"
fi
if [ -d "$SAVE" ]; then
  step "An earlier run was cut off while it converted this installation: first everything back as it was"
  undo_conversion || stop "the earlier conversion could not be undone; see above"
  ok "as before the conversion"
fi
if [ -d "$DEPLOY" ]; then STATE=installed            # the updater runs as its own user already
elif [ -d "$ROOT/releases" ]; then STATE=as-root     # an installation whose updater runs as root: it is converted
else STATE=fresh
fi
ACTIVE=$ROOT; [ "$STATE" = installed ] && ACTIVE=$DEPLOY
if [ -e "$ACTIVE/deploy-journal.json" ] || [ -e "$ACTIVE/updater-trial" ]; then
  stop "a deploy or a change of the updater is in the middle on the server; run this again in a few minutes"
fi
if [ "$STATE" = fresh ]; then
  if port_taken 9443; then stop "port 9443 is taken by something else"; fi
  if port_taken 8790; then stop "port 8790 is taken by something else"; fi
fi
ok "state: $STATE; tailnet address $TSIP"

# The owner's tailnet login, from this very ssh connection: his own devices may call the endpoint beside the CI.
# If it cannot be told (a call from a tagged device), the login an earlier installation wrote down stays.
read -r client_ip client_port _ <<< "${SSH_CLIENT:-}"
OWNER=$(tailscale whois --json "$client_ip:$client_port" 2>/dev/null | python3 -c '
import json, sys
w = json.load(sys.stdin)
print("" if w["Node"].get("Tags") else w["UserProfile"].get("LoginName", ""))' 2>/dev/null || true)
[ -n "$OWNER" ] || OWNER=$(sed -n 's/^UPDATER_CALLER_USERS=//p' "$ETC/updater.env" 2>/dev/null | head -1)
case "$OWNER" in *[!A-Za-z0-9@._+-]*) OWNER='' ;; esac

# ---- from here on things change; a conversion that fails is undone ----
CONVERTING=0 STOPPED=0
on_exit() {
  code=$?
  trap - EXIT
  [ "$code" = 0 ] && exit 0
  # the updater's lock, held from the conversion's start: let go of it before any updater is started again
  exec 8>&- 2>/dev/null || true
  if [ "$CONVERTING" != 1 ] && [ "$STOPPED" = 1 ]; then
    printf '\n!!! A step failed. Starting the updater that was stopped for this run again (it starts the hub).\n' >&2
    if systemctl start trommi-hub-updater.service; then
      printf '!!! It runs. Fix what failed above and run install again.\n' >&2
    else
      printf '!!! It did NOT start: journalctl -u trommi-hub-updater -n 30\n' >&2
    fi
  elif [ "$CONVERTING" = 1 ]; then
    printf '\n!!! A step failed. Putting the installation back as it was (updater as root).\n' >&2
    if undo_conversion; then
      printf '!!! Back as before: the old updater and the hub run. Nothing was deleted. Fix what failed above and run install again.\n' >&2
    else
      printf '!!! It could NOT be put back by itself. What was there is noted in %s; run install again, it tries the way back first.\n' "$SAVE" >&2
    fi
  else
    printf '\n!!! A step failed. Nothing that ran before was stopped by this run. Fix what failed above and run install again.\n' >&2
  fi
  exit "$code"
}
trap on_exit EXIT

step "Users: trommi (the hub runs as it) and trommi-updater (the updater runs as it); neither can log in"
for user in trommi trommi-updater; do
  id "$user" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
done
ok "$(id trommi); $(id trommi-updater)"

step "Ask the tailnet who a caller is, as the updater's user (it must work without root)"
as_updater tailscale whois --json "$TSIP:1" >/dev/null || stop "tailscaled does not answer an unprivileged user; the updater could not check its callers"
ok "it answers"

if [ "$STATE" = as-root ]; then
  step "Stop the updater (a deploy that runs is finished first) and keep any other deploy out"
  STOPPED=1
  systemctl stop trommi-hub-updater.service
  # the updater's own lock: a deploy started by hand on the server would hold it
  exec 8>> "$ROOT/deploy.lock"
  flock -n 8 || stop "a deploy started by hand is still running on the server"
  if [ -e "$ROOT/deploy-journal.json" ] || [ -e "$ROOT/updater-trial" ]; then
    stop "a deploy or a change of the updater was in the middle; run this again in a few minutes"
  fi
  ok "stopped; nothing else changes the installation now"

  step "Copy what runs today into $SAVE, root's alone (the way back if a later step fails)"
  rm -rf "${SAVE:?}.part"
  install -d -m 0700 "$SAVE.part" "$SAVE.part/releases"
  install -m 0644 "$UNITS/trommi-hub-updater.service" "$SAVE.part/trommi-hub-updater.service"
  install -m 0644 "$ETC/updater.env" "$SAVE.part/updater.env"
  install -m 0755 /usr/local/bin/trommi-hub-updater "$SAVE.part/command"
  if [ -f "$ROOT/state.json" ]; then cp -a "$ROOT/state.json" "$SAVE.part/state.json"; fi
  : > "$SAVE.part/links"
  for name in current previous updater updater-previous; do
    [ -L "$ROOT/$name" ] || continue
    target=$(readlink "$ROOT/$name")
    tag=${target#releases/}
    case "$tag" in hub-v*[!0-9]*|hub-v|'') stop "the link $name names no release ($target); nothing was changed" ;; hub-v*) ;; *) stop "the link $name names no release ($target); nothing was changed" ;; esac
    printf '%s %s\n' "$name" "$target" >> "$SAVE.part/links"
    [ -d "$SAVE.part/releases/$tag" ] || cp -a "$ROOT/releases/$tag" "$SAVE.part/releases/$tag"
  done
  [ -x "$SAVE.part/releases/$(sed -n 's|^updater releases/||p' "$SAVE.part/links")/trommi-hub-updater" ] \
    || stop "the installation has no updater to go back to; nothing was changed"
  [ -f "$SAVE.part/releases/$(sed -n 's|^current releases/||p' "$SAVE.part/links")/trommi-hub.service" ] \
    || stop "the hub that runs has no unit file to go back to; nothing was changed"
  # on disk before anything is handed over: a power cut after this point finds a whole copy to go back to
  sync -f "$SAVE.part" && sync "$SAVE.part"
  mv -T "$SAVE.part" "$SAVE"
  sync "$ETC"
  ok "$(tr '\n' ';' < "$SAVE/links")"

  step "Stop the hub (it is down from here until the new updater starts it, about a minute)"
  CONVERTING=1
  systemctl stop trommi-hub.service
  ok "stopped"

  step "Move releases, links and state into $DEPLOY and hand that folder to trommi-updater; backups to trommi"
  install -d -m 0755 "$DEPLOY"
  for name in $MOVED; do
    if [ -e "$ROOT/$name" ] || [ -L "$ROOT/$name" ]; then mv -T "$ROOT/$name" "$DEPLOY/$name"; fi
  done
  # the updater before this one expects to be root: it is no fallback any more (the copy above still has it)
  rm -f "${DEPLOY:?}/updater-previous"
  # the updater as root wrote some of this for everyone to change (state.json): only its owner may. Done while the
  # tree is still root's; handing it over is the last thing root does inside it.
  chmod -R go-w "$DEPLOY"
  chown -hR trommi-updater:trommi-updater "$DEPLOY"
  if [ -d "$ROOT/backups" ]; then chown -R trommi:trommi "$ROOT/backups"; fi
  # the lock went along with its file: let go of it, the new updater takes it itself
  exec 8>&-
  ok "moved"
fi

step "Folders: $ROOT (root), data and backups (trommi), deploy (trommi-updater)"
if systemctl is-active --quiet trommi-hub-updater.service; then
  STOPPED=1
  systemctl stop trommi-hub-updater.service
fi
install -d -m 0755 "$ROOT" "$ETC" "$LIB"
install -d -m 0700 -o trommi -g trommi "$ROOT/data" "$ROOT/backups"
install -d -m 0755 -o trommi-updater -g trommi-updater "$DEPLOY"
as_updater mkdir -p "$DEPLOY/releases"
[ "$(stat -c '%U' "$ROOT")" = root ] && [ "$(stat -c '%U' "$DEPLOY")" = trommi-updater ] && [ "$(stat -c '%U %a' "$ROOT/data")" = "trommi 700" ]
ok "in place"

step "What is installed once and belongs to root: the pinned release key, four units, three scripts, the command"
install -m 0644 "$STAGE/public-key.pem" "$ETC/release-public-key.pem"
install -m 0755 "$STAGE/updater-prestart.sh" "$STAGE/hub-prestart.sh" "$STAGE/hub-ctl.sh" "$LIB/"
# until now a link into the release
rm -f "${UNITS:?}/trommi-hub.service"
install -m 0644 "$STAGE/trommi-hub.service" "$STAGE/trommi-hub-updater.service" "$STAGE/trommi-hub-ctl.socket" "$STAGE/trommi-hub-ctl@.service" "$UNITS/"
install -m 0755 "$STAGE/command" /usr/local/bin/trommi-hub-updater
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

step "The release $TAG, as it was checked on the laptop, into $DEPLOY/releases/$TAG (written as trommi-updater)"
if as_updater test -d "$DEPLOY/releases/$TAG"; then
  ok "already there (the updater proves it again before it uses it)"
else
  part="$DEPLOY/releases/.tmp-$TAG-install"
  as_updater rm -rf "${part:?}"
  as_updater mkdir "$part"
  put() { as_updater sh -c 'umask 022; cat > "$1" && chmod "$2" "$1"' sh "$part/$2" "$3" < "$STAGE/$1"; }
  put "trommi-hub-$TARGET" trommi-hub 0755
  put "trommi-hub-updater-$TARGET" trommi-hub-updater 0755
  put manifest.json manifest.json 0644
  put manifest.json.sig manifest.json.sig 0644
  as_updater sh -c 'sync "$1"/* "$1" && mv -T "$1" "$2" && sync "$(dirname "$2")"' sh "$part" "$DEPLOY/releases/$TAG"
  ok "in place"
fi
if [ "$STATE" = installed ] && as_updater test -x "$DEPLOY/updater/trommi-hub-updater"; then
  ok "an updater is in place already ($(as_updater readlink "$DEPLOY/updater")); it changes itself by release"
else
  as_updater ln -sfn "releases/$TAG" "$DEPLOY/updater"
  ok "the updater is the one of $TAG"
fi
as_updater test -x "$DEPLOY/updater/trommi-hub-updater"

step "Start the helper's socket and the updater (systemd; at boot too); the updater starts the hub"
systemctl daemon-reload
systemctl enable --now trommi-hub-ctl.socket >/dev/null
systemctl enable trommi-hub-updater.service >/dev/null
systemctl restart trommi-hub-updater.service || { journalctl -u trommi-hub-updater.service -n 20 --no-pager >&2; stop "the updater did not start"; }
[ "$(stat -c '%U %a' /run/trommi-hub-ctl.sock)" = "trommi-updater 600" ] || stop "the helper's socket is not the updater's alone"
listens "$TSIP:9443" || { journalctl -u trommi-hub-updater.service -n 20 --no-pager >&2; stop "the updater does not listen on $TSIP:9443"; }
[ "$(ss -tlnH | awk '$4 ~ /:9443$/' | wc -l)" = 1 ] || stop "port 9443 listens on more than the tailnet address"
pid=$(systemctl show -p MainPID --value trommi-hub-updater.service)
[ "$(stat -c '%U' "/proc/$pid")" = trommi-updater ] || stop "the updater does not run as trommi-updater"
ok "the updater runs as trommi-updater and listens on $TSIP:9443 and nowhere else"

step "Deploy $TAG through the updater (it proves the release itself, swaps, checks health)"
/usr/local/bin/trommi-hub-updater deploy "$TAG" > "$STAGE/outcome.json" || true
cat "$STAGE/outcome.json"
python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") is True else 1)' "$STAGE/outcome.json" \
  || stop "the updater did not accept $TAG (its answer is above; the hub's own words: journalctl -u trommi-hub -n 30)"
hub_well 5 || stop "the hub does not answer on 127.0.0.1:8790"
pid=$(systemctl show -p MainPID --value trommi-hub.service)
[ "$(stat -c '%U' "/proc/$pid")" = trommi ] || stop "the hub does not run as trommi"
ok "the hub runs as trommi and is well"

step "Ask the hub from outside, through the tunnel"
url=$(sed -n 's/^HUB_URL=//p' "$ETC/hub.env" | head -1)
want=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["commit"])' "$STAGE/manifest.json")
got=''
for _ in $(seq 1 30); do
  got=$(curl -fsS --max-time 5 "$url/healthz" 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin).get("commit", ""))' 2>/dev/null || true)
  [ "$got" = "$want" ] && break
  sleep 2
done
[ "$got" = "$want" ] || stop "$url/healthz does not answer as the new hub (got: ${got:-nothing}, expected $want)"
ok "$url answers as commit $want"

# from here on there is no way back by itself, and none is needed; the note of how it was is kept beside
CONVERTING=0
if [ -d "$SAVE" ]; then mv -T "$SAVE" "$ETC/before-noroot-done-$(date -u +%Y%m%d-%H%M%S)"; fi
trap - EXIT
step "Done"
/usr/local/bin/trommi-hub-updater status
printf 'trommi-hub.service: %s    trommi-hub-updater.service: %s, at boot: %s    trommi-hub-ctl.socket: %s\n' \
  "$(systemctl is-active trommi-hub.service)" "$(systemctl is-active trommi-hub-updater.service)" \
  "$(systemctl is-enabled trommi-hub-updater.service)" "$(systemctl is-active trommi-hub-ctl.socket)"
printf 'Should a later release refuse the data of an earlier one (before launch the hub does not migrate), a clean\nstart is: systemctl stop trommi-hub; mv %s/data %s/data-old; install -d -m 0700 -o trommi -g trommi %s/data; systemctl start trommi-hub\n' "$ROOT" "$ROOT" "$ROOT"
rm -rf "${STAGE:?}"
printf '\nINSTALLED: %s runs; the updater runs as trommi-updater, the hub as trommi, nothing of Trommi as root.\n' "$TAG"
REMOTE
}

# The command for the owner on the server, installed as /usr/local/bin/trommi-hub-updater.
remote_command() {
  cat <<'COMMAND'
#!/bin/sh
# trommi-hub-updater status | deploy hub-v<N>: the updater with the settings its service has, as the updater's own
# user. Never as root: what lies under /srv/trommi/deploy is the updater's, not root's to run. It runs in a session
# of its own, so it has no hold on the terminal of whoever calls this.
set -a; . /etc/trommi/updater.env; set +a
# as under its unit (UMask=0022), whatever the caller's shell has
umask 022
program=/srv/trommi/deploy/updater/trommi-hub-updater
if [ "$(id -u)" != 0 ]; then
  [ "$(id -un)" = trommi-updater ] || { echo "run this as root" >&2; exit 1; }
  exec "$program" "$@"
fi
cd /
setsid -w runuser -u trommi-updater -- "$program" "$@" < /dev/null
code=$?
# 10: this deploy went well and put another updater in place; the serving one makes room for it
if [ "$code" = 10 ]; then
  systemctl try-restart --no-block trommi-hub-updater.service
  code=0
fi
exit "$code"
COMMAND
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
  for name in manifest.json manifest.json.sig "trommi-hub-$TARGET" "trommi-hub-updater-$TARGET"; do
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
for name in ("trommi-hub-" + target, "trommi-hub-updater-" + target):
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
  cp "$REPO/release/public-key.pem" "$HERE"/trommi-hub.service "$HERE"/trommi-hub-updater.service \
    "$HERE"/trommi-hub-ctl.socket "$HERE/trommi-hub-ctl@.service" "$HERE"/updater-prestart.sh "$HERE"/hub-prestart.sh \
    "$HERE"/hub-ctl.sh "$stage/"
  remote_command > "$stage/command"
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
EOF
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
  remote_secrets > "$tmp/secrets.sh"; remote_command > "$tmp/command.sh"
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
  check) check ;;
  *) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

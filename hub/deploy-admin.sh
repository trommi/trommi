#!/bin/bash
# hub/deploy-admin.sh runs on trommi-hub (piped over ssh by .github/workflows/deploy.yml) before the hub restarts.
# Reads ADMIN_LOGINS and ADMIN_PASSWORD_HASH as two lines on stdin (never on a command line), then idempotently writes
#   /srv/trommi/admin.env               (0600) ADMIN_PORT/HOST, ADMIN_PUBLISHED_LOOPBACK, the logins, the initial hash
#   /srv/trommi/compose.override.yaml   env_file admin.env + ports 127.0.0.1:8791:8791 (host loopback only)
# `tailscale serve --https=8443 http://localhost:8791` (set up once on the server) puts the page on the tailnet.
# A compose.override.yaml not written by this script is never touched: the script stops instead.
set -euo pipefail
cd /srv/trommi
IFS= read -r logins || true
IFS= read -r hash || true
MARK='# managed by .github/workflows/deploy.yml (hub/deploy-admin.sh); edits are overwritten'
if [ -e compose.override.yaml ] && ! head -n 1 compose.override.yaml | grep -qxF "$MARK"; then
  echo "admin: compose.override.yaml exists and is not ours; not touching it" >&2; exit 1
fi
if [ -z "$logins" ]; then
  echo "admin: ADMIN_LOGINS is empty; admin page off"
  rm -f compose.override.yaml admin.env
  exit 0
fi
case "$logins$hash" in *[!A-Za-z0-9@._,:+=-]*) echo "admin: unexpected characters in ADMIN_LOGINS or the hash" >&2; exit 1;; esac
umask 077
{ echo 'ADMIN_PORT=8791'; echo 'ADMIN_HOST=0.0.0.0'; echo 'ADMIN_PUBLISHED_LOOPBACK=1'
  echo "ADMIN_LOGINS=$logins"; echo "ADMIN_PASSWORD_HASH=$hash"; } > admin.env.tmp
mv admin.env.tmp admin.env
[ -f compose.override.yaml ] && cp compose.override.yaml compose.override.yaml.prev
umask 022
cat > compose.override.yaml <<YAML
$MARK
services:
  hub:
    env_file: [admin.env]
    ports: ["127.0.0.1:8791:8791"]
YAML
if ! docker compose config -q; then
  echo "admin: compose config invalid with the override; restoring" >&2
  if [ -f compose.override.yaml.prev ]; then mv compose.override.yaml.prev compose.override.yaml; else rm -f compose.override.yaml; fi
  exit 1
fi
rm -f compose.override.yaml.prev
echo "admin: admin.env + compose.override.yaml in place (logins: $(echo "$logins" | tr ',' '\n' | grep -c .))"

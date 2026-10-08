#!/bin/bash
# hub/deploy-apns.sh runs on trommi-hub (piped over ssh by .github/workflows/deploy.yml) before hub/deploy-admin.sh.
# Reads APNS_KEY (the .p8 as one line, newlines written as \n), APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC as four lines
# on stdin (never on a command line) and writes /srv/trommi/apns.env (0600); with an empty key it removes the file
# and the hub runs without APNs. deploy-admin.sh adds apns.env to the hub's env_file when it exists.
set -euo pipefail
cd /srv/trommi
IFS= read -r key || true
IFS= read -r key_id || true
IFS= read -r team_id || true
IFS= read -r topic || true
if [ -z "$key" ] || [ -z "$key_id" ] || [ -z "$team_id" ] || [ -z "$topic" ]; then
  echo "apns: not configured; apns.env removed"
  rm -f apns.env
  exit 0
fi
case "$key_id$team_id$topic" in *[!A-Za-z0-9.,-]*) echo "apns: unexpected characters in the key id, team id or topic" >&2; exit 1;; esac
if printf '%s' "$key" | grep -q '[^A-Za-z0-9+/= \\-]'; then echo "apns: unexpected characters in the key" >&2; exit 1; fi
umask 077
{ echo "APNS_KEY=$key"; echo "APNS_KEY_ID=$key_id"; echo "APNS_TEAM_ID=$team_id"; echo "APNS_TOPIC=$topic"; } > apns.env.tmp
mv apns.env.tmp apns.env
echo "apns: apns.env in place (key $key_id, topics: $topic)"

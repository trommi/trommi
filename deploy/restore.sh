#!/usr/bin/env bash
# Put a backup made by deploy/backup.sh back as a data directory.
#
#   deploy/restore.sh ARCHIVE --data DIR [--replace]
#
#   ARCHIVE     a trommi-data-<date>.tar.gz
#   --data DIR  the data directory to fill; it must not exist or be empty
#   --replace   DIR holds data already: move it aside as DIR.before-restore-<date>
#               first (nothing is deleted)
#
# Stop the hub first, and make sure no session takes its port in between
# (ss -ltnp 'sport = :8790'): a hub that runs on DIR would write its state over
# the restored one. On Linux the script refuses a directory whose pad.db a
# process of yours has open; elsewhere it cannot see a hub.
#
# What comes back: the database as one file (pad.db, no -wal or -shm; the hub
# makes them again), attachments, assets, pad, scribbles, sessions, the admin
# log, and the secrets if the backup held them (token, admin-token, tinfoil.key,
# mode 0600). Without them the hub mints a new token and admin key at its next
# start, and every browser signs in again with the new link from url.txt.
# Passkeys are in the database and keep working under the same address.
#
# The output names paths, counts and sizes, never the contents of a file.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
archive=
data=
replace=0
while [ $# -gt 0 ]; do
  case $1 in
    --data) data=${2:?--data needs a directory}; shift 2 ;;
    --replace) replace=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$archive" ] || { echo "only one archive at a time" >&2; exit 2; }; archive=$1; shift ;;
  esac
done
[ -n "$archive" ] && [ -n "$data" ] || { echo "usage: deploy/restore.sh ARCHIVE --data DIR [--replace]" >&2; exit 2; }
[ -f "$archive" ] || { echo "error: no archive at $archive" >&2; exit 1; }
# Only what backup.sh writes: everything under trommi-data/, nothing that climbs out of it.
names=$(tar -tzf "$archive") || { echo "error: $archive is not a readable archive" >&2; exit 1; }
if printf '%s\n' "$names" | grep -qvE '^trommi-data(/|$)' || printf '%s\n' "$names" | grep -qE '(^|/)\.\.(/|$)'; then
  echo "error: $archive was not made by deploy/backup.sh" >&2; exit 1
fi

if [ -e "$data" ] && [ -n "$(ls -A "$data" 2>/dev/null)" ]; then
  if [ -f "$data/pad.db" ] && [ -d /proc/self/fd ]; then
    db=$(realpath "$data/pad.db")
    for fd in /proc/[0-9]*/fd/*; do
      [ "$(readlink "$fd" 2>/dev/null)" != "$db" ] || { echo "error: a process has $db open (pid $(echo "$fd" | cut -d/ -f3)): stop the hub first" >&2; exit 1; }
    done
  fi
  [ "$replace" = 1 ] || { echo "error: $data is not empty; give --replace to move it aside first, or name another directory" >&2; exit 1; }
  aside=${data%/}.before-restore-$(date +%Y%m%d-%H%M%S)
  mv "$data" "$aside"
  echo "Moved aside: $data -> $aside"
fi
mkdir -p "$data"
chmod 700 "$data"
tar -C "$data" -xzf "$archive" --strip-components=1 --no-same-owner
for f in token admin-token tinfoil.key pad.db; do [ ! -f "$data/$f" ] || chmod 600 "$data/$f"; done

echo "Restored: $archive"
echo "  into:     $data ($(find "$data" -type f | wc -l) files, $(du -sh "$data" | cut -f1))"
if [ -f "$data/pad.db" ]; then
  node=
  for candidate in "${BOARD_NODE:-}" node /usr/bin/node; do
    [ -n "$candidate" ] && command -v "$candidate" >/dev/null && "$candidate" -e 'require("node:sqlite")' 2>/dev/null && { node=$candidate; break; }
  done
  if [ -n "$node" ]; then
    echo "  database: integrity checked; pad.db holds $("$node" "$here/sqlite-snapshot.mjs" --counts "$data/pad.db")"
  else
    echo "  database: not checked (no node with node:sqlite)"
  fi
fi
if [ -f "$data/token" ]; then
  echo "  secrets:  restored (mode 0600); the old login link and cookies work again"
else
  echo "  secrets:  none in the backup; the hub mints a new token at its next start, open the new link from $data/url.txt"
fi

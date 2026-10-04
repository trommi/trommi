#!/usr/bin/env bash
# Back up the hub's data directory into one tar file, while the hub keeps running.
#
#   deploy/backup.sh [--data DIR] [--to DIR] [--keep N] [--no-secrets]
#
#   --data DIR     data directory (default: $BOARD_DATA, else the installed unit's, else <checkout>/data)
#   --to DIR       where the archive goes (default: ~/.local/state/trommi/backups)
#   --keep N       afterwards keep only the newest N archives in that directory (default: keep all)
#   --no-secrets   leave out token, admin-token and tinfoil.key; a restore then
#                  mints a new token and admin key and every browser logs in again
#
# The archive is mode 0600. With secrets in it (the default) it opens the board
# to whoever reads it: treat it like the data directory itself. Until the board
# encrypts end to end, the archive also holds every conversation in clear text.
#
# What is in it: the board's database (pad.db: cards, messages, sessions, assets'
# records, the pad, passkeys), files/ (attachments), assets/ (ciphertext of
# published assets), pad/, scribbles/, sessions/, agents/, speech/, the admin
# log, the old state.json where it still lies there, and the secrets (token,
# admin-token, tinfoil.key). Not in it: url.txt (spells out the token, written
# again at every start), logs, half-written files, pad.db-wal and pad.db-shm.
#
# Consistency: every SQLite database (*.db) is copied by SQLite itself, from a
# read-only connection (deploy/sqlite-snapshot.mjs, VACUUM INTO): the database as
# it was at one moment, with what still sat in the write-ahead log, and checked
# with integrity_check. The three files are never copied raw. The database is
# copied first and the attachments after it, so every file the copied state
# refers to is in the archive, unless the hub's 30-day cleanup deleted it in
# between. Files that arrived after the snapshot come along unreferenced; the
# admin page lists such files as orphans. Needs node 22.5 or newer (node:sqlite).
#
# Restore: deploy/restore.sh <archive> --data DIR, with the hub stopped.
#
# The output names paths, counts and sizes, never the contents of a file.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
config=${XDG_CONFIG_HOME:-$HOME/.config}
data=${BOARD_DATA:-}
to=${XDG_STATE_HOME:-$HOME/.local/state}/trommi/backups
keep=
secrets=1
while [ $# -gt 0 ]; do
  case $1 in
    --data) data=${2:?--data needs a directory}; shift 2 ;;
    --to) to=${2:?--to needs a directory}; shift 2 ;;
    --keep) keep=${2:?--keep needs a number}; shift 2 ;;
    --no-secrets) secrets=0; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case ${keep:-1} in *[!0-9]*|0) echo "--keep needs a number of 1 or more" >&2; exit 2 ;; esac
if [ -z "$data" ] && [ -f "$config/systemd/user/trommi-hub.service" ]; then
  data=$(sed -n 's/^Environment=BOARD_DATA=//p' "$config/systemd/user/trommi-hub.service" | tail -n 1)
fi
data=${data:-$repo/data}
[ -d "$data" ] || { echo "error: no data directory at $data" >&2; exit 1; }
[ -f "$data/pad.db" ] || [ -f "$data/state.json" ] || { echo "error: neither pad.db nor state.json in $data; is this the hub's data directory?" >&2; exit 1; }

# A node that knows SQLite, for the snapshot of the database.
node=
for candidate in "${BOARD_NODE:-}" node /usr/bin/node; do
  [ -n "$candidate" ] && command -v "$candidate" >/dev/null && "$candidate" -e 'require("node:sqlite")' 2>/dev/null && { node=$candidate; break; }
done
shopt -s nullglob
databases=("$data"/*.db)
shopt -u nullglob
[ ${#databases[@]} -eq 0 ] || [ -n "$node" ] || { echo "error: $data holds a SQLite database and no node with node:sqlite (22.5 or newer) was found; set BOARD_NODE. Nothing was written" >&2; exit 1; }

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$to"
stage=$(mktemp -d "${TMPDIR:-/tmp}/trommi-backup.XXXXXX")
trap 'rm -rf "$stage"' EXIT
copy=$stage/trommi-data

# Never in a backup: the login links (they spell out the token and are written
# again at every start), logs, and files the hub was in the middle of writing.
# The databases neither: they come from the snapshot below, never as raw files.
skip=(--anchored --no-wildcards-match-slash --exclude=./state.json --exclude=./url.txt --exclude='./*.log'
  --exclude='./state.json.*.tmp' --exclude='./token.[0-9]*' --exclude='./admin-token.[0-9]*'
  --exclude='./*.db' --exclude='./*.db-wal' --exclude='./*.db-shm' --exclude='./*.db-journal')
# The small copies of pictures (thumbs/) are a cache: the hub makes them again on request.
skip+=(--exclude=./thumbs)
[ "$secrets" = 1 ] || skip+=(--exclude=./token --exclude=./admin-token --exclude=./tinfoil.key)

mkdir "$copy"
# The state first, then everything else without touching the copy of the state.
counts=
for db in "${databases[@]}"; do
  found=$("$node" "$here/sqlite-snapshot.mjs" "$db" "$copy/$(basename "$db")") || { echo "error: the snapshot of $db failed; nothing was written" >&2; exit 1; }
  [ "$(basename "$db")" != pad.db ] || counts=$found
done
# The file from before SQLite, where it is still there: whole by itself (it was replaced by rename).
have_json=0
[ ! -f "$data/state.json" ] || { cp -p "$data/state.json" "$copy/state.json"; have_json=1; }
# tar to tar keeps modes and times and takes the exclude list; rsync may not be installed.
# Status 1 means a file changed or vanished while it was read, which a running hub may cause.
status=0
tar -C "$data" "${skip[@]}" --warning=no-file-changed --warning=no-file-removed -cf - . | tar -C "$copy" -xf - || status=$?
[ "$status" -le 1 ] || { echo "error: copying $data failed" >&2; exit "$status"; }

# An old state.json must be one the hub can load. Checked only if a node is at hand that runs.
check=
for candidate in "$node" /usr/bin/node node; do
  [ -n "$candidate" ] && command -v "$candidate" >/dev/null && "$candidate" -e 0 2>/dev/null && { check=$candidate; break; }
done
# The secrets and the databases are private whatever mode they had.
for f in token admin-token tinfoil.key; do [ ! -f "$copy/$f" ] || chmod 600 "$copy/$f"; done
if [ -n "$check" ] && [ "$have_json" = 1 ]; then
  "$check" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!s || typeof s !== "object" || Array.isArray(s)) process.exit(1)' "$copy/state.json" 2>/dev/null \
    || { echo "error: the copied state.json is not valid JSON; nothing was written" >&2; exit 1; }
fi

archive=$to/trommi-data-$stamp.tar.gz
tar -C "$stage" -czf "$archive.part" trommi-data
mv "$archive.part" "$archive"

files=$(find "$copy" -type f | wc -l)
echo "Backed up: $data"
echo "  archive:  $archive ($(du -h "$archive" | cut -f1), mode $(stat -c %a "$archive"))"
echo "  contents: $files files, $(du -sh "$copy" | cut -f1) unpacked"
if [ ${#databases[@]} -gt 0 ]; then
  echo "  database: ${#databases[@]} SQLite snapshot(s), integrity checked$([ -z "$counts" ] || echo "; pad.db holds $counts")"
fi
[ "$have_json" = 0 ] || echo "  old file: state.json $([ -n "$check" ] && echo "checked as valid JSON" || echo "not checked (no node)")"
if [ "$secrets" = 1 ]; then
  echo "  secrets:  included (token, admin key, speech key where present); keep the archive private"
else
  echo "  secrets:  left out"
fi

if [ -n "$keep" ]; then
  # Names sort by date, so the oldest come first.
  mapfile -t old < <(find "$to" -maxdepth 1 -type f -name 'trommi-data-*.tar.gz' | sort | head -n -"$keep")
  for f in "${old[@]}"; do rm -f "$f"; done
  echo "  kept:     the newest $keep archives, removed ${#old[@]} older"
fi

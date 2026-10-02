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
# Consistency: the hub replaces state.json by rename, so a copy of it is always
# a whole file. It is copied first and the attachments after it, so every file
# the copied state refers to is in the archive, unless the hub's 30-day cleanup
# deleted it in between. Files that arrived after the state was copied come along
# unreferenced; the admin page lists such files as orphans.
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
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case ${keep:-1} in *[!0-9]*|0) echo "--keep needs a number of 1 or more" >&2; exit 2 ;; esac
if [ -z "$data" ] && [ -f "$config/systemd/user/trommi-hub.service" ]; then
  data=$(sed -n 's/^Environment=BOARD_DATA=//p' "$config/systemd/user/trommi-hub.service" | tail -n 1)
fi
data=${data:-$repo/data}
[ -d "$data" ] || { echo "error: no data directory at $data" >&2; exit 1; }
[ -f "$data/state.json" ] || { echo "error: no state.json in $data; is this the hub's data directory?" >&2; exit 1; }

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$to"
stage=$(mktemp -d "${TMPDIR:-/tmp}/trommi-backup.XXXXXX")
trap 'rm -rf "$stage"' EXIT
copy=$stage/trommi-data

# Never in a backup: the login links (they spell out the token and are written
# again at every start), logs, and files the hub was in the middle of writing.
skip=(--anchored --no-wildcards-match-slash --exclude=./state.json --exclude=./url.txt --exclude='./*.log'
  --exclude='./state.json.*.tmp' --exclude='./token.[0-9]*' --exclude='./admin-token.[0-9]*')
[ "$secrets" = 1 ] || skip+=(--exclude=./token --exclude=./admin-token --exclude=./tinfoil.key)

mkdir "$copy"
# The state first, then everything else without touching the copy of the state.
cp -p "$data/state.json" "$copy/state.json"
# tar to tar keeps modes and times and takes the exclude list; rsync may not be installed.
# Status 1 means a file changed or vanished while it was read, which a running hub may cause.
status=0
tar -C "$data" "${skip[@]}" --warning=no-file-changed --warning=no-file-removed -cf - . | tar -C "$copy" -xf - || status=$?
[ "$status" -le 1 ] || { echo "error: copying $data failed" >&2; exit "$status"; }

# The copy must be a state the hub can load. Checked only if a node is at hand that runs.
check=
for candidate in /usr/bin/node node; do
  command -v "$candidate" >/dev/null && "$candidate" -e 0 2>/dev/null && { check=$candidate; break; }
done
if [ -n "$check" ]; then
  "$check" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!s || typeof s !== "object" || Array.isArray(s)) process.exit(1)' "$copy/state.json" 2>/dev/null \
    || { echo "error: the copied state.json is not valid JSON; nothing was written" >&2; exit 1; }
fi

archive=$to/trommi-data-$stamp.tar.gz
tar -C "$stage" -czf "$archive.part" trommi-data
mv "$archive.part" "$archive"

files=$(find "$copy" -type f | wc -l)
echo "Backed up: $data"
echo "  archive:  $archive ($(du -h "$archive" | cut -f1), mode $(stat -c %a "$archive"))"
echo "  contents: $files files, $(du -sh "$copy" | cut -f1) unpacked, state.json $([ -n "$check" ] && echo "checked as valid JSON" || echo "not checked (no node)")"
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

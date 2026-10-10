#!/bin/sh
# Runs before every start of the hub (ExecCondition of trommi-hub.service), as the hub's user:
#   hub-prestart.sh <deploy folder> <data folder> <backups folder> <runtime folder>
#
# When the release about to start is another one than the last one that was copied for, it copies the database
# (hub.db with its -wal and -shm files: the hub stands still at this moment, so the three are one consistent state)
# and the hub's own keys (*.key) into <backups>/before-<release>-<time>/ and keeps the three newest copies. Not the
# files people uploaded.
#
# When the copy fails:
# - a NEWER release than the last one is not started on data that could not be copied first: this ends with 1, which
#   tells systemd to skip the start (no retry by itself); the updater then puts the release before back.
#   Asked a second time for the same release, it lets it start without a copy and says so: a full disk must not
#   keep the hub down for good. (The note of the first try lies in the runtime folder, which is memory.)
# - the release before coming back (a rollback), or the same one, always starts.
set -u
deploy=${1:-/srv/trommi/deploy} data=${2:-/srv/trommi/data} backups=${3:-/srv/trommi/backups} run=${4:-/run/trommi-hub}
umask 077
release=$(basename "$(readlink "$deploy/current" 2>/dev/null)" 2>/dev/null)
number=${release#hub-v}
# not a release name: nothing to copy for (and nothing of that text is used any further)
case "$number" in ''|*[!0-9]*) exit 0 ;; esac
[ "hub-v$number" = "$release" ] || exit 0
last=$(cat "$backups/last-release" 2>/dev/null)
[ "$last" = "$release" ] && exit 0
last_number=${last#hub-v}
case "$last_number" in ''|*[!0-9]*) last_number=0 ;; esac

# written whole and flushed, or not at all
note() { printf '%s\n' "$2" > "$backups/$1.part" && sync "$backups/$1.part" && mv -f "$backups/$1.part" "$backups/$1" && sync "$backups"; }
set -- "$data"/hub.db* "$data"/*.key
found=''
for f in "$@"; do [ -f "$f" ] && found=1; done
if [ -z "$found" ]; then
  note last-release "$release" || true
  exit 0
fi
dir="$backups/before-$release-$(printf '%012d' "$(date +%s)")"
rm -rf "${dir:?}.part"
ok=1
mkdir -p "$dir.part" || ok=''
for f in "$@"; do
  [ -f "$f" ] || continue
  [ -n "$ok" ] && { cp "$f" "$dir.part/" || ok=''; }
done
[ -n "$ok" ] && { sync "$dir.part"/* "$dir.part" || ok=''; }
[ -n "$ok" ] && { mv -T "$dir.part" "$dir" || ok=''; }
[ -n "$ok" ] && { note last-release "$release" || ok=''; }
if [ -z "$ok" ]; then
  rm -rf "${dir:?}.part" "${dir:?}"
  if [ "$number" -lt "$last_number" ]; then
    echo "hub-prestart: no copy could be made before $release comes back; starting it all the same"
    exit 0
  fi
  if [ "$(cat "$run/copy-failed" 2>/dev/null)" = "$release" ]; then
    echo "hub-prestart: the copy before $release failed again; starting without it"
    exit 0
  fi
  printf '%s\n' "$release" > "$run/copy-failed" 2>/dev/null || true
  echo "hub-prestart: the database could not be copied before $release starts; not starting" >&2
  exit 1
fi
rm -f "${run:?}/copy-failed"
echo "hub-prestart: copied to $dir"
# the three newest stay; the names end in the time
for old in $(cd "$backups" && ls -d before-* 2>/dev/null | awk -F- '{print $NF " " $0}' | sort | awk '{print $2}' | head -n -3); do
  rm -rf "${backups:?}/$old"
done
exit 0

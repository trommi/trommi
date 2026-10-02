#!/usr/bin/env bash
# Wait until the human says something to any session held by dev/session.mjs, then print it and exit.
#   dev/wait-answer.sh [SECONDS]     give up after SECONDS (default 3000)
# Whoever started this in the background is woken by its exit; start it again to keep listening.
set -uo pipefail
cd "$(dirname "$0")/.."
dir=${BOARD_DATA:-data}/sessions
secs=${1:-3000}
declare -A seen
for f in "$dir"/*.log; do [ -e "$f" ] && seen[$f]=$(stat -c %s "$f"); done
for ((i = 0; i < secs; i += 2)); do
  sleep 2
  out=
  for f in "$dir"/*.log; do
    [ -e "$f" ] || continue
    size=$(stat -c %s "$f"); old=${seen[$f]:-0}
    [ "$size" = "$old" ] && continue
    # keep-alive lines grow the file too; only frames with the human's word count
    new=$(tail -c +$((old + 1)) "$f" | grep '^data: .*"kind":"\(chat\|decision\|decision_reopened\|scribble\|pad\)"' | sed "s/^data: /$(basename "$f" .log): /" | cut -c1-1500)
    seen[$f]=$size
    [ -n "$new" ] && out+="$new"$'\n'
  done
  if [ -n "$out" ]; then sleep 1; printf '%s' "$out"; exit 0; fi
done
echo "nothing new in $secs seconds"

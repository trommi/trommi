#!/usr/bin/env bash
# Add simulated sessions to a board that is already running (e.g. your real one),
# so the inbox and the sidebar have something to show next to the real session.
#   dev/join.sh [SECONDS] [who ...]     default: 3600 seconds, all five personas
# They use the board's own data folder for the token and stay until the time is up.
set -euo pipefail
cd "$(dirname "$0")/.."
secs=${1:-3600}
shift || true
who=("$@")
[ ${#who[@]} -eq 0 ] && who=(web api infra ios docs)
pids=()
for w in "${who[@]}"; do
  node dev/fake-agent.mjs "$w" &
  pids+=($!)
  sleep 1.5
done
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
sleep "$secs"

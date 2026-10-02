#!/usr/bin/env bash
# Three simulated agents on one board, to see the multi-agent view.
#   dev/trio.sh PORT [SECONDS]      default 600 seconds, then everything stops
# Opens on all interfaces with the token "demo": http://<host>:PORT/?t=demo
# Speech works if data/tinfoil.key exists (it is copied into the demo's data folder).
set -euo pipefail
cd "$(dirname "$0")/.."
port=${1:?port}
secs=${2:-600}
data=${TMPDIR:-/tmp}/board-trio-$port
rm -rf "$data"
mkdir -p "$data"
[ -f data/tinfoil.key ] && cp data/tinfoil.key "$data/tinfoil.key"
export BOARD_PORT=$port BOARD_DATA=$data BOARD_TOKEN=${BOARD_TOKEN:-demo}
pids=()
for who in web api infra; do
  node dev/fake-agent.mjs "$who" &
  pids+=($!)
  sleep 1.5
done
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
sleep "$secs"

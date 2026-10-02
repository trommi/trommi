#!/usr/bin/env bash
# Preview server with demo data, independent of any Claude Code session.
#   dev/serve.sh PORT [SECONDS]     serve http://localhost:PORT/?t=demo for SECONDS (default 600)
# Chat messages and decisions are accepted and change the state; nothing
# answers them, because no agent is attached.
set -euo pipefail
cd "$(dirname "$0")/.."
port=${1:?port}
secs=${2:-600}
data=${TMPDIR:-/tmp}/board-dev-$port
rm -rf "$data"
node dev/demo-state.mjs "$data"
# stdin stays open for $secs; the server exits when it closes.
sleep "$secs" | BOARD_PORT=$port BOARD_HOST=127.0.0.1 BOARD_TOKEN=demo BOARD_DATA=$data node server/server.mjs

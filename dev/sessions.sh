#!/usr/bin/env bash
# Hold the worker sessions online on the board (see dev/session.mjs).
#   dev/sessions.sh "Web UI" "Server" ...
set -euo pipefail
cd "$(dirname "$0")/.."
pids=()
for name in "$@"; do node dev/session.mjs link "$name" & pids+=($!); done
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
wait

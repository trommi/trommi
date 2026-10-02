#!/usr/bin/env bash
# Screenshot a running preview server (see dev/serve.sh).
#   dev/shot.sh PORT OUT.png [WIDTH,HEIGHT] [/path#flags]
# Flags are the page's own hash flags, e.g. "/#decisions,dark".
# Chromium cannot start inside the Claude Code command sandbox; run this
# command with the sandbox disabled.
set -euo pipefail
port=${1:?port}
out=${2:?output png}
size=${3:-1440,900}
target=${4:-/}
page=${target%%#*}
frag=${target#"$page"}
prof=$(mktemp -d)
timeout 30 chromium --headless=new --disable-gpu --no-proxy-server --hide-scrollbars \
  --user-data-dir="$prof" --timeout=4000 --window-size="$size" \
  --screenshot="$out" "http://localhost:$port$page?t=demo$frag" >/dev/null 2>&1 || true
rm -rf "$prof"
ls -la "$out"

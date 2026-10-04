#!/bin/sh
# Trommi: connect the Claude Code project in the current folder to your Trommi account.
#
#   cd <your project> && curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>'
#
# Needs Node 22 or newer and Claude Code (claude). What it does:
#   1. downloads the Trommi connector (one file) to ~/.local/share/trommi/connector/ and checks its SHA-256,
#   2. registers it for this folder: claude mcp add trommi --scope project (writes .mcp.json here),
#   3. joins your account with the invite link (the link is passed by environment, never printed),
#   4. tells you how to start Claude Code so that Trommi's messages reach it.
# POSIX sh: runs on Linux and macOS (dash, bash, zsh as sh).
set -eu

# Everything is in main(), called on the last line: piped into sh, the whole script is read before anything runs
# (and no command below reads the rest of it from stdin; each gets </dev/null as well).
main() {
APP="${TROMMI_APP:-https://app.trommi.com}"
DIR="${TROMMI_CONNECTOR_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/trommi/connector}"


LINK="${1:-${TROMMI_INVITE:-}}"
[ -n "$LINK" ] || fail "no invite link. In the Trommi app choose \"Invite an agent\" and copy the command shown there."
case "$LINK" in
  http://*|https://*) ;;
  *) fail "that does not look like an invite link (it starts with https://)." ;;
esac

# ---- what this machine needs --------------------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is missing. Install Node 22 or newer (https://nodejs.org), then run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' </dev/null 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Node $(node -v 2>/dev/null) is too old; Trommi needs Node 22 or newer."
command -v claude >/dev/null 2>&1 || fail "Claude Code (claude) is missing. Install it (https://claude.com/claude-code), then run this again."
command -v curl >/dev/null 2>&1 || fail "curl is missing."

# ---- 1. the connector ---------------------------------------------------------------------------------------------
mkdir -p "$DIR"
TMP="$DIR/.download.$$"
trap 'rm -f "$TMP" "$TMP.sha256"' EXIT INT TERM
say "Downloading the Trommi connector…"
curl -fsSL "$APP/connector.mjs" -o "$TMP" || fail "could not download $APP/connector.mjs"
curl -fsSL "$APP/connector.mjs.sha256" -o "$TMP.sha256" || fail "could not download $APP/connector.mjs.sha256"
WANT=$(cut -d ' ' -f 1 < "$TMP.sha256" | tr -d '\r\n')
GOT=$(sha256 "$TMP")
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || fail "the downloaded connector does not match its checksum; nothing was changed. Try again."
# The file is named channel.mjs: the connector recognises itself as the program by that name.
CONNECTOR="$DIR/channel.mjs"
mv -f "$TMP" "$CONNECTOR"
printf '%s  channel.mjs\n' "$GOT" > "$DIR/channel.mjs.sha256"
say "Connector $(printf '%s' "$GOT" | cut -c 1-12) in $DIR"

# ---- 2. registered for this folder ---------------------------------------------------------------------------------
# Project scope: .mcp.json in this folder, so every project folder has its own connector entry (and its own key).
# Claude Code starts it in this folder, which names the key slot.
claude mcp remove trommi --scope project </dev/null >/dev/null 2>&1 || true
claude mcp add trommi --scope project -- node "$CONNECTOR" </dev/null >/dev/null || fail "claude mcp add failed (run this in your project folder)"
say "Registered for $(pwd) (.mcp.json)"

# ---- 3. join ------------------------------------------------------------------------------------------------------
say "Joining your Trommi account… (the app adds this agent by itself; keep it open)"
TROMMI_INVITE="$LINK" node "$CONNECTOR" join </dev/null >/dev/null || fail "joining did not work (an invite link works once and for a limited time: make a new one in the app)"
say "Joined."

# ---- 4. next step -------------------------------------------------------------------------------------------------
say ""
say "Done. Start Claude Code in this folder with:"
say ""
say "  claude --dangerously-load-development-channels server:trommi"
say ""
say "Always start (or resume: claude --resume <id> ...) with that flag: without it Claude Code drops every Trommi message."
}

say() { printf '%s\n' "$*"; }
fail() { printf 'trommi: %s\n' "$*" >&2; exit 1; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1" </dev/null
  fi
}

main "$@"

#!/bin/sh
# Trommi: connect the Claude Code project in the current folder to your Trommi account.
#
#   cd <your project> && curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>'
#
# Needs Claude Code (claude) and curl; the connector is one static binary (connector-rs), no Node. What it does:
#   1. downloads the connector of this machine (Linux x86_64 or aarch64) to ~/.local/share/trommi/connector/ and checks
#      its SHA-256: connector/trommi-connector-<target>.sha256 names the newest binary, which is served at
#      connector/<sha256>/trommi-connector-<target>,
#   2. installs the Trommi plugin for this folder from Trommi's own marketplace:
#        claude plugin marketplace add https://app.trommi.com/plugins/marketplace.json
#        claude plugin install trommi@trommi --scope local     (.claude/settings.local.json here)
#      The plugin runs the same connector as MCP server and a monitor that wakes Claude for every board message, so a
#      plain `claude` hears the board. It also allows the plugin's own tools here (they only talk to your board).
#      A Claude Code without plugin support gets the connector as before: claude mcp add trommi --scope project.
#   3. joins your account with the invite link (the link is passed by environment, never printed),
#   4. tells you how to start Claude Code.
# macOS has no connector build yet: there the script stops and says so.
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
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64) TARGET=x86_64-unknown-linux-musl ;;
  Linux/aarch64|Linux/arm64) TARGET=aarch64-unknown-linux-musl ;;
  Darwin/*) fail "there is no Trommi connector for macOS yet (only Linux, x86_64 and aarch64, for now)." ;;
  *) fail "there is no Trommi connector for $(uname -s)/$(uname -m) (only Linux, x86_64 and aarch64, for now)." ;;
esac
command -v claude >/dev/null 2>&1 || fail "Claude Code (claude) is missing. Install it (https://claude.com/claude-code), then run this again."
command -v curl >/dev/null 2>&1 || fail "curl is missing."

# ---- 1. the connector ---------------------------------------------------------------------------------------------
NAME=trommi-connector
mkdir -p "$DIR"
TMP="$DIR/.download.$$"
trap 'rm -f "$TMP" "$TMP.sha256"' EXIT INT TERM
say "Downloading the Trommi connector…"
curl -fsSL "$APP/connector/$NAME-$TARGET.sha256" -o "$TMP.sha256" || fail "could not download $APP/connector/$NAME-$TARGET.sha256"
WANT=$(cut -d ' ' -f 1 < "$TMP.sha256" | tr -d '\r\n')
case "$WANT" in ''|*[!0-9a-f]*) fail "$APP/connector/$NAME-$TARGET.sha256 names no connector." ;; esac
curl -fsSL "$APP/connector/$WANT/$NAME-$TARGET" -o "$TMP" || fail "could not download $APP/connector/$WANT/$NAME-$TARGET"
GOT=$(sha256 "$TMP")
[ "$WANT" = "$GOT" ] || fail "the downloaded connector does not match its checksum; nothing was changed. Try again."
CONNECTOR="$DIR/$NAME"
chmod 755 "$TMP"
mv -f "$TMP" "$CONNECTOR"
printf '%s  %s\n' "$GOT" "$NAME" > "$DIR/$NAME.sha256"
say "Connector $(printf '%s' "$GOT" | cut -c 1-12) in $DIR"

# ---- 2. the plugin, for this folder ---------------------------------------------------------------------------------
# Local scope: enabled only in this folder (every project folder has its own key), in .claude/settings.local.json.
# Claude Code starts the connector in this folder, which names the key slot.
MARKET="${TROMMI_MARKETPLACE:-$APP/plugins/marketplace.json}"
PLUGIN=""
if claude plugin marketplace add "$MARKET" </dev/null >/dev/null 2>&1 || claude plugin marketplace update trommi </dev/null >/dev/null 2>&1; then
  claude plugin marketplace update trommi </dev/null >/dev/null 2>&1 || true
  if claude plugin install trommi@trommi --scope local </dev/null >/dev/null 2>&1; then
    claude plugin update trommi@trommi </dev/null >/dev/null 2>&1 || true
    PLUGIN=yes
  fi
fi
if [ -n "$PLUGIN" ]; then
  # An older install registered the connector in .mcp.json: two of them in one session would be two members.
  claude mcp remove trommi --scope project </dev/null >/dev/null 2>&1 || true
  # The plugin's tools (reply, cards, inbox ...) only talk to the human's board: allowed in this folder, so a board
  # message never waits for a yes in a terminal nobody watches (.claude/settings.local.json, not committed).
  mkdir -p .claude
  "$CONNECTOR" allow-tools </dev/null || say "(could not allow the Trommi tools in .claude/settings.local.json; Claude Code will ask once per tool)"
  say "Trommi plugin installed for $(pwd)"
else
  say "This Claude Code has no plugin support (update it: claude update); registering the connector directly."
  claude mcp remove trommi --scope project </dev/null >/dev/null 2>&1 || true
  claude mcp add trommi --scope project -- "$CONNECTOR" </dev/null >/dev/null || fail "claude mcp add failed (run this in your project folder)"
  say "Registered for $(pwd) (.mcp.json)"
fi

# ---- 3. join ------------------------------------------------------------------------------------------------------
say "Joining your Trommi account… (keep the app open: it shows six emoji; compare them with the ones shown below and tap \"They match\" there)"
TROMMI_INVITE="$LINK" "$CONNECTOR" join </dev/null >/dev/null || fail "joining did not work (the line above says why)"
say "Joined."

# ---- 4. next step -------------------------------------------------------------------------------------------------
say ""
if [ -n "$PLUGIN" ]; then
  say "Done. Start Claude Code in this folder with:"
  say ""
  say "  claude"
  say ""
  say "Board messages wake it through the Trommi plugin's monitor (also after claude --continue or --resume)."
  say "Optional, live channel instead: claude --dangerously-load-development-channels plugin:trommi@trommi"
else
  say "Done. Start Claude Code in this folder with:"
  say ""
  say "  claude --dangerously-load-development-channels server:trommi"
  say ""
  say "Always start (or resume: claude --resume <id> ...) with that flag: without it Claude Code drops every Trommi message."
fi
}

say() { printf '%s\n' "$*"; }
fail() { printf 'trommi: %s\n' "$*" >&2; exit 1; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else fail "sha256sum (or shasum) is missing."
  fi
}

main "$@"

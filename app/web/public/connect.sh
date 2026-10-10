#!/bin/sh
# Trommi: connect the project in the current folder to your Trommi account, in one line:
#
#   cd <your project> && curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>'
#
# The older way, kept because the iOS app's invite sheet and the website still show it. The app's invite page now shows
# the same as three commands, and this script runs just those:
#   1. installs the connector with install.sh of github.com/trommi/trommi (it checks the release's signature), unless
#      it is installed already: curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh
#   2. sets it up for Claude Code and/or Codex, whichever is here: trommi-connector setup claude|codex
#   3. connects this folder with the invite link (passed by environment, never printed): trommi-connector connect
# POSIX sh: runs on Linux and macOS (dash, bash, zsh as sh).
set -eu

# Everything is in main(), called on the last line: piped into sh, the whole script is read before anything runs
# (and no command below reads the rest of it from stdin; each gets </dev/null).
main() {
INSTALL=https://raw.githubusercontent.com/trommi/trommi/main/install.sh
CONNECTOR="$HOME/.local/share/trommi/bin/trommi-connector"

LINK="${1:-${TROMMI_INVITE:-}}"
[ -n "$LINK" ] || fail "no invite link. In the Trommi app choose \"Invite an agent\" and copy the commands shown there."
case "$LINK" in
  http://*|https://*) ;;
  *) fail "that does not look like an invite link (it starts with https://)." ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is missing."
HAS_CLAUDE='' HAS_CODEX=''
if command -v claude >/dev/null 2>&1; then HAS_CLAUDE=yes; fi
if command -v codex >/dev/null 2>&1; then HAS_CODEX=yes; fi
[ -n "$HAS_CLAUDE$HAS_CODEX" ] || fail "neither Claude Code (claude) nor Codex (codex) is here. Install one, then run this again."

# ---- 1. the connector ---------------------------------------------------------------------------------------------
if [ ! -x "$CONNECTOR" ]; then
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT INT TERM
  curl -fsSL "$INSTALL" -o "$TMP" </dev/null || fail "could not download $INSTALL"
  sh "$TMP" </dev/null || fail "installing the connector did not work (the lines above say why)"
fi

# ---- 2. Claude Code, Codex ----------------------------------------------------------------------------------------
if [ -n "$HAS_CLAUDE" ]; then "$CONNECTOR" setup claude </dev/null || fail "trommi-connector setup claude did not work"; fi
if [ -n "$HAS_CODEX" ]; then "$CONNECTOR" setup codex </dev/null || fail "trommi-connector setup codex did not work"; fi

# ---- 3. this folder -----------------------------------------------------------------------------------------------
say "Connecting $(pwd)… (keep the app open: it shows six emoji; compare them with the ones shown below and tap \"They match\" there)"
TROMMI_INVITE="$LINK" "$CONNECTOR" connect </dev/null || fail "connecting did not work (the line above says why)"
say ""
say "Done. Start Claude Code (claude) or Codex (codex) in this folder."
}

say() { printf '%s\n' "$*"; }
fail() { printf 'trommi: %s\n' "$*" >&2; exit 1; }

main "$@"

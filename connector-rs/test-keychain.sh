#!/bin/sh
# test-keychain.mjs in a D-Bus session of its own with a throwaway gnome-keyring: never the real keyring.
# Needs dbus-run-session, gnome-keyring-daemon and secret-tool (libsecret).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export OUTER_DBUS="${DBUS_SESSION_BUS_ADDRESS:-none}"
t=$(mktemp -d "${TMPDIR:-/tmp}/trommi-keyring-XXXXXX")
trap 'rm -rf "$t"' EXIT INT TERM
mkdir -p "$t/run" "$t/data" "$t/config" && chmod 700 "$t/run"
export HOME="$t" XDG_DATA_HOME="$t/data" XDG_RUNTIME_DIR="$t/run" XDG_CONFIG_HOME="$t/config" HERE="$here"
dbus-run-session -- sh -c '
  [ "$DBUS_SESSION_BUS_ADDRESS" != "$OUTER_DBUS" ] || { echo "the same bus as outside: stopped"; exit 1; }
  printf throwaway | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
  gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1
  printf x | timeout 5 secret-tool store --label=probe service trommi-probe account a || { echo "no Secret Service in the test session"; exit 1; }
  timeout 300 node "$HERE/test-keychain.mjs"
'

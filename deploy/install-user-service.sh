#!/usr/bin/env bash
# Install the Trommi hub as a systemd user service. Safe to run again: it only
# rewrites the unit when it differs and never overwrites hub.env.
#
#   deploy/install-user-service.sh [--data DIR] [--node PATH] [--dry-run] [--enable]
#   deploy/install-user-service.sh --uninstall [--dry-run]
#
#   --data DIR   data directory of the hub (default: <checkout>/data, where the
#                agent sessions of this checkout look for the token)
#   --node PATH  node binary to run (default: /usr/bin/node, else the node on PATH)
#   --dry-run    print what would be done, change nothing
#   --enable     also reload the user manager and enable and start the service.
#                Without it the script only writes files and prints the commands.
#   --uninstall  stop and disable the service and remove the unit; hub.env and data stay
#
# Writes only to ~/.config/systemd/user and ~/.config/trommi (or below
# $XDG_CONFIG_HOME), and creates the data directory if it is missing. It never
# enables lingering; it tells you whether lingering is on and how to switch it on.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
config=${XDG_CONFIG_HOME:-$HOME/.config}
unit_dir=$config/systemd/user
env_dir=$config/trommi
unit=$unit_dir/trommi-hub.service
env_file=$env_dir/hub.env

data=$repo/data
node=
dry=0
enable=0
uninstall=0
while [ $# -gt 0 ]; do
  case $1 in
    --data) data=${2:?--data needs a directory}; shift 2 ;;
    --node) node=${2:?--node needs a path}; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --enable) enable=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# Print the step; carry it out unless this is a dry run.
run() {
  say "  $*"
  [ "$dry" = 1 ] || "$@"
}
[ "$dry" = 1 ] && say "(dry run: nothing is changed)"

if [ "$uninstall" = 1 ]; then
  say "Removing the Trommi hub service"
  if [ -e "$unit" ]; then
    run systemctl --user disable --now trommi-hub.service || warn "could not stop or disable the service (no user manager?)"
    run rm -f "$unit"
    run systemctl --user daemon-reload || true
  else
    say "  no unit at $unit, nothing to remove"
  fi
  say "Kept: $env_file and the data directory."
  exit 0
fi

# ---- checks ------------------------------------------------------------------

case $data in /*) ;; *) data=$PWD/$data ;; esac
case "$repo$data" in *[[:space:]]*) die "paths with spaces are not supported in the unit: $repo, $data" ;; esac

# The user manager starts services with a bare environment: no login shell, no
# version manager. A shim that needs one fails there, so test in that environment.
works() { env -i HOME="$HOME" PATH=/usr/bin:/bin "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
if [ -z "$node" ]; then
  for candidate in /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && works "$candidate" && { node=$candidate; break; }
  done
  [ -n "$node" ] || die "no node 22 or newer that runs outside a login shell; install nodejs (pacman -S nodejs) or pass --node /abs/path/to/node"
else
  case $node in /*) ;; *) die "--node must be an absolute path" ;; esac
  works "$node" || die "$node does not run as node 22 or newer in a bare environment"
fi

[ -f "$repo/server/server.mjs" ] || die "no server/server.mjs in $repo"
[ -d "$repo/node_modules/@modelcontextprotocol/sdk" ] || warn "dependencies are missing; run: (cd $repo && npm ci --omit=dev)"
grep -q BOARD_HUB_ONLY "$repo/server/server.mjs" || warn "this server.mjs does not know BOARD_HUB_ONLY; the service will refuse to start until the checkout is updated"

say "Trommi hub as a systemd user service"
say "  checkout:  $repo"
say "  node:      $node ($("$node" --version))"
say "  data:      $data"
say "  unit:      $unit"
say "  settings:  $env_file"
say

# ---- files -------------------------------------------------------------------

say "Directories"
for dir in "$unit_dir" "$env_dir"; do
  if [ -d "$dir" ]; then say "  exists: $dir"; else run mkdir -p "$dir"; fi
done
[ "$dry" = 1 ] || chmod 700 "$env_dir"
if [ -d "$data" ]; then
  say "  exists: $data"
else
  say "  the data directory is outside ~/.config and is created now:"
  run mkdir -p -m 700 "$data"
fi

say "Unit"
rendered=$(sed -e "s|@TROMMI_DIR@|$repo|g" -e "s|@NODE@|$node|g" -e "s|@DATA_DIR@|$data|g" "$here/systemd/trommi-hub.service")
if [ -f "$unit" ] && [ "$rendered" = "$(cat "$unit")" ]; then
  say "  unchanged: $unit"
else
  [ -f "$unit" ] && say "  differs from the template, replacing: $unit" || say "  writing: $unit"
  [ "$dry" = 1 ] || printf '%s\n' "$rendered" > "$unit"
fi

say "Settings"
if [ -f "$env_file" ]; then
  say "  kept as it is: $env_file"
  if grep -qE '^[[:space:]]*(BOARD_DATA|BOARD_HUB_ONLY)=' "$env_file"; then
    warn "$env_file sets BOARD_DATA or BOARD_HUB_ONLY; remove those lines, the unit sets both and the file would override it"
  fi
else
  say "  writing defaults (port 8790, loopback only): $env_file"
  [ "$dry" = 1 ] || install -m 600 "$here/hub.env.example" "$env_file"
fi

if [ "$dry" = 0 ] && command -v systemd-analyze >/dev/null; then
  say "Check"
  if out=$(systemd-analyze --user verify "$unit" 2>&1); then
    say "  systemd-analyze verify: ok"
  else
    say "  systemd-analyze verify reported:"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
fi

# ---- start, or say how --------------------------------------------------------

port=8790
[ -f "$env_file" ] && port=$(sed -n 's/^[[:space:]]*BOARD_PORT=\([0-9]\{1,\}\).*/\1/p' "$env_file" | tail -n 1)
port=${port:-8790}

say
if [ "$enable" = 1 ]; then
  say "Starting"
  run systemctl --user daemon-reload
  run systemctl --user enable --now trommi-hub.service
  say
  say "Status: systemctl --user status trommi-hub    Logs: journalctl --user -u trommi-hub -f"
else
  say "Not started. When the hub that runs today on port $port is stopped:"
  say "  systemctl --user daemon-reload"
  say "  systemctl --user enable --now trommi-hub"
  say "  systemctl --user status trommi-hub"
  say "  journalctl --user -u trommi-hub -f"
  say "(or run this script again with --enable)"
fi
say "While another process holds port $port the service waits and takes the port as soon as it is free."
say "Login links: $data/url.txt    Admin key: $data/admin-token"

say
linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)
case $linger in
  yes) say "Lingering is on: the hub starts at boot and survives logout." ;;
  no) say "Lingering is off: the hub runs only while you are logged in. This script does not change that."
      say "  To keep it running after logout and start it at boot: loginctl enable-linger $(id -un)" ;;
  *) say "Could not read the lingering state (loginctl show-user $(id -un) -p Linger). This script does not change it." ;;
esac

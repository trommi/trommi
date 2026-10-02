#!/usr/bin/env bash
# Offer the hub to the tailnet over HTTPS with `tailscale serve`.
# Prints the commands and the resulting addresses; runs nothing unless --apply is given.
#
#   deploy/tailscale-serve.sh [--port N] [--https N] [--client PORT[:HTTPS]] [--off] [--apply]
#
#   --port N              local port of the hub (default: BOARD_PORT from ~/.config/trommi/hub.env, else 8790)
#   --https N             HTTPS port on the tailnet name (default 443)
#   --client PORT[:HTTPS] also offer a static web client that listens on local PORT
#                         (deploy/Caddyfile.client: 8792) on HTTPS port HTTPS (default 8444)
#   --off                 print (or with --apply run) the commands that take it down again
#   --apply               run the commands instead of only printing them
#
# Serve, never funnel: funnel would put the board on the public internet.
set -euo pipefail

config=${XDG_CONFIG_HOME:-$HOME/.config}
env_file=$config/trommi/hub.env
port=
https=443
client=
off=0
apply=0
while [ $# -gt 0 ]; do
  case $1 in
    --port) port=${2:?--port needs a number}; shift 2 ;;
    --https) https=${2:?--https needs a number}; shift 2 ;;
    --client) client=${2:?--client needs PORT or PORT:HTTPS}; shift 2 ;;
    --off) off=1; shift ;;
    --apply) apply=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$port" ] && [ -f "$env_file" ]; then
  port=$(sed -n 's/^[[:space:]]*BOARD_PORT=\([0-9]\{1,\}\).*/\1/p' "$env_file" | tail -n 1)
fi
port=${port:-8790}
client_port=${client%%:*}
client_https=8444
case $client in *:*) client_https=${client##*:} ;; esac
for n in "$port" "$https" ${client:+"$client_port" "$client_https"}; do
  case $n in ''|*[!0-9]*) echo "not a port number: $n" >&2; exit 2 ;; esac
done

# The machine's name in the tailnet, e.g. laptop.tail1234.ts.net. Asking is read-only.
name=
if command -v tailscale >/dev/null; then
  name=$(tailscale status --self --peers=false --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n 1) || true
  name=${name%.}
fi
shown=${name:-MACHINE.TAILNET.ts.net}
url() { [ "$1" = 443 ] && printf 'https://%s' "$shown" || printf 'https://%s:%s' "$shown" "$1"; }

cmds=()
if [ "$off" = 1 ]; then
  cmds+=("tailscale serve --https=$https off")
  [ -n "$client" ] && cmds+=("tailscale serve --https=$client_https off")
else
  cmds+=("tailscale serve --bg --https=$https http://127.0.0.1:$port")
  [ -n "$client" ] && cmds+=("tailscale serve --bg --https=$client_https http://127.0.0.1:$client_port")
fi

[ "$apply" = 1 ] && echo "Running:" || echo "Commands (not run; add --apply to run them):"
for c in "${cmds[@]}"; do
  echo "  $c"
  if [ "$apply" = 1 ]; then
    command -v tailscale >/dev/null || { echo "tailscale is not installed" >&2; exit 1; }
    # shellcheck disable=SC2086
    $c
  fi
done
echo
if [ -z "$name" ]; then
  echo "Could not ask tailscale for this machine's name (is tailscaled running?); a placeholder is shown."
fi
if [ "$off" = 1 ]; then
  echo "After that $(url "$https") no longer answers. The hub itself keeps running."
  exit 0
fi
echo "Resulting addresses, reachable only from devices in your tailnet:"
echo "  board:        $(url "$https")/   ->  http://127.0.0.1:$port"
[ -n "$client" ] && echo "  web client:   $(url "$client_https")/   ->  http://127.0.0.1:$client_port"
echo
echo "Then:"
echo "  1. Put the address into $env_file so the login link names it:"
echo "       BOARD_PUBLIC_URL=$(url "$https")"
echo "     and restart: systemctl --user restart trommi-hub"
echo "  2. The login link for a phone is the https line in <data>/url.txt (it carries the token; do not paste it anywhere)."
echo "  3. Check what is served:  tailscale serve status"
echo
echo "Needs MagicDNS and HTTPS certificates switched on for the tailnet (admin console, DNS page)."
echo "The first request takes a few seconds while the certificate is issued."

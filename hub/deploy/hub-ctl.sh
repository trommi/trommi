#!/bin/sh
# Runs as root for one connection to trommi-hub-ctl.socket (see trommi-hub-ctl@.service). It reads one line. The
# line must be exactly `start` or `stop`; then it does that to the hub's unit and answers `ok` or `failed: <why>`.
# Nothing the caller sends reaches a command: the two commands are written out below.
IFS= read -r verb || true
case "$verb" in
  start) out=$(systemctl start trommi-hub.service 2>&1) && { echo ok; exit 0; } ;;
  stop) out=$(systemctl stop trommi-hub.service 2>&1) && { echo ok; exit 0; } ;;
  *) echo "failed: only start and stop are taken"; exit 0 ;;
esac
echo "failed: $(printf '%s' "$out" | head -n 1 | cut -c1-300)"

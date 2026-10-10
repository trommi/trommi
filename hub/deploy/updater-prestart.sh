#!/bin/sh
# Runs before every start of the updater (ExecStartPre of trommi-hub-updater.service):  updater-prestart.sh <root>
#
# A deploy that brings a new updater leaves <root>/updater-trial ("0 hub-v124") and points the link <root>/updater
# at the new release. An updater that comes up removes the note. This script counts the starts while the note is
# there: at the first it lets the new updater try; if the note is still there at the next start, the new updater
# did not come up, and the link goes back to <root>/updater-previous. The old updater then starts, finds
# <root>/updater-reverted and says so in its answers.
#
# It uses nothing but the shell and coreutils. Whatever happens here, systemd goes on to start the updater the link
# names (the unit ignores this script's exit code).
root=${1:-/srv/trommi/deploy}
cd "$root" 2>/dev/null || exit 0
[ -f updater-trial ] || exit 0
# A trial is about the program, not about the network: while the tailnet address the updater listens on is not there
# (Tailscale updating itself, an early boot), no try is counted. The updater itself waits for the address too.
address=${UPDATER_LISTEN%:*}
if [ -n "$address" ] && command -v ip >/dev/null 2>&1 && ! ip -o addr 2>/dev/null | grep -qF " $address/"; then
  echo "updater-prestart: $address is not there yet; this start is not counted as a try"
  exit 0
fi
count='' tag=''
read -r count tag < updater-trial || true
if [ "$count" = 0 ]; then
  if printf '1 %s\n' "$tag" > updater-trial.part && mv -f updater-trial.part updater-trial; then
    echo "updater-prestart: first start of the updater of $tag"
    exit 0
  fi
  # the try cannot be written down: rather go back now than try without end
fi
# The link goes back first; the note of the trial goes only when that is done, so a failure here is tried again at
# the next start.
[ -L updater-previous ] || { echo "updater-prestart: no previous updater to go back to"; rm -f updater-trial; exit 0; }
rm -f updater.part
if ! { ln -s "$(readlink updater-previous)" updater.part && mv -fT updater.part updater; }; then
  echo "updater-prestart: could not put the previous updater back; trying again at the next start"
  exit 1
fi
if ! { printf '%s\n' "$tag" > updater-reverted.part && mv -f updater-reverted.part updater-reverted; }; then
  exit 1
fi
rm -f updater-trial
sync 2>/dev/null || true
echo "updater-prestart: the updater of $tag did not come up; back to $(readlink updater)"
exit 0

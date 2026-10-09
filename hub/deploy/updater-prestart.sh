#!/bin/sh
# Runs before every start of the updater (ExecStartPre of trommi-hub-updater.service):  updater-prestart.sh <root>
#
# A deploy that brings a new updater leaves <root>/updater-trial ("0 hub-v124") and points the link <root>/updater
# at the new release. An updater that comes up removes the note. This script counts the starts while the note is
# there: at the first it lets the new updater try; if the note is still there at the next start, the new updater
# did not come up, and the link goes back to <root>/updater-previous. The old updater then starts, finds
# <root>/updater-reverted and says so in its answers.
#
# It uses nothing but the shell and coreutils, and it never fails the start: whatever happens here, systemd goes on
# to start the updater the link names.
root=${1:-/srv/trommi}
cd "$root" 2>/dev/null || exit 0
[ -f updater-trial ] || exit 0
count='' tag=''
read -r count tag < updater-trial || true
if [ "$count" = 0 ]; then
  printf '1 %s\n' "$tag" > updater-trial.part && mv -f updater-trial.part updater-trial
  echo "updater-prestart: first start of the updater of $tag"
  exit 0
fi
if [ -L updater-previous ]; then
  ln -s "$(readlink updater-previous)" updater.part 2>/dev/null && mv -fT updater.part updater
  echo "updater-prestart: the updater of $tag did not come up; back to $(readlink updater)"
fi
printf '%s\n' "$tag" > updater-reverted
rm -f updater-trial updater.part
sync 2>/dev/null || true
exit 0

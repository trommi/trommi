#!/usr/bin/env bash
# Runs xcodebuild for CI so that a failure is readable at a glance:
#   tools/ci-xcodebuild.sh NAME "Title for the summary" xcodebuild-arguments...
# writes  build/logs/NAME.raw.log   everything xcodebuild said
#         build/logs/NAME.txt       the short version (xcbeautify, or errors and verdicts if it is missing)
# prints the short version (with annotations on GitHub), appends the first errors to
# the job summary, and exits with xcodebuild's own status.
set -uo pipefail
name=${1:?name}
title=${2:?title}
shift 2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p build/logs
raw=build/logs/$name.raw.log
short=build/logs/$name.txt

if command -v xcbeautify >/dev/null 2>&1 && [ -n "${GITHUB_ACTIONS:-}" ]; then
  # Errors and failed tests become annotations on the commit.
  xcodebuild "$@" 2>&1 | tee "$raw" | xcbeautify --renderer github-actions | tee "$short"
  status=${PIPESTATUS[0]}
elif command -v xcbeautify >/dev/null 2>&1; then
  xcodebuild "$@" 2>&1 | tee "$raw" | xcbeautify | tee "$short"
  status=${PIPESTATUS[0]}
else
  xcodebuild "$@" > "$raw" 2>&1
  status=$?
  grep -E "(error|warning): |^\*\* |^Test (Suite|Case) |^Testing started|^xcodebuild: " "$raw" | tee "$short"
fi

"$here/ci-summary.sh" "$title" "$raw" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
exit "$status"

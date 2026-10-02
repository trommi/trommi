#!/usr/bin/env bash
# Turns a raw xcodebuild log into a few lines of Markdown for the job summary:
# the verdict, and the first errors with file and line, each once.
#   tools/ci-summary.sh "Build" build/logs/build.raw.log
set -uo pipefail
title=${1:?title}
log=${2:?log file}
max=${3:-25}

echo "### $title"
if [ ! -s "$log" ]; then
  echo "No log was written: the step did not get as far as xcodebuild."
  exit 0
fi

verdict=$(grep -E '^\*\* [A-Z ]+ \*\*' "$log" | tail -1)
echo "${verdict:-No verdict line in the log (the step was cut off).}"
echo

# Compiler and linker errors: "path/File.swift:12:5: error: text". Paths are cut down to the repository.
errors=$(grep -E '(: error: |^error: |^ld: |^xcodebuild: error)' "$log" | sed -E "s#^.*/client/ios/##" | awk '!seen[$0]++')
count=$(printf '%s' "$errors" | grep -c . || true)
if [ "$count" -gt 0 ]; then
  echo "**$count different errors**, the first $max:"
  echo
  echo '```'
  printf '%s\n' "$errors" | head -n "$max"
  echo '```'
  echo
  echo "Errors per file:"
  echo
  echo '```'
  printf '%s\n' "$errors" | grep -E '^[^ :]+\.swift:' | cut -d: -f1 | sort | uniq -c | sort -rn | head -15
  echo '```'
fi

# Tests that failed: "Test Case '-[Target.Class method]' failed" and the assertion lines before them.
failed=$(grep -E "^Test Case .* failed|^Failing tests:|^\s+-\[.*\]$|: error: -\[|XCTAssert.* failed" "$log" | sed -E "s#^.*/client/ios/##" | awk '!seen[$0]++')
if [ -n "$failed" ] && [ "$count" -eq 0 ]; then
  echo "**Failed tests:**"
  echo
  echo '```'
  printf '%s\n' "$failed" | head -n "$max"
  echo '```'
fi
passed=$(grep -cE "^Test Case .* passed" "$log" || true)
failedCount=$(grep -cE "^Test Case .* failed" "$log" || true)
if [ "$((passed + failedCount))" -gt 0 ]; then echo "Tests: $passed passed, $failedCount failed."; fi
exit 0

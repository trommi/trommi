#!/bin/bash
# Pin the code under test: a clone of origin/main (default dir: $FUZZ_TARGET or /tmp/trommi-fuzz-target). Run between fuzz runs.
T=${FUZZ_TARGET:-/tmp/trommi-fuzz-target}
REPO=$(cd "$(dirname "$0")/../.." && git remote get-url origin)
[ -d "$T/.git" ] || git clone -q "$REPO" "$T"
git -C "$T" fetch -q origin && git -C "$T" checkout -q -f origin/main 2>/dev/null
git -C "$T" log --oneline -1

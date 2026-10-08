#!/bin/bash
# hub-rs/contract.sh: the cross-implementation contract against the Rust hub, one line per suite.
#   hub-rs/contract.sh [--quick]        (from anywhere; builds the release binary first)
# The Rust tests (crypto vectors, units), then the JS suites with HUB_CMD, interop (all pairs; Swift ones when
# ios/TrommiCore is built), the connector e2e parts, quick fuzz. --quick skips interop, e2e and fuzz.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
cargo=${CARGO:-$HOME/.cargo/bin/cargo}
"$cargo" build --release -p trommi-hub --manifest-path "$here/Cargo.toml" -q || exit 1
export HUB_CMD="$here/target/release/trommi-hub"
cd "$repo" || exit 1
fail=0
run() {   # name, command…
  local name=$1; shift
  local out; out=$("$@" 2>&1); local code=$?
  printf '%-22s %s %s\n' "$name" "$([ $code = 0 ] && echo ok || echo FAIL)" "$(printf '%s\n' "$out" | grep -v '^\s*$' | tail -1 | cut -c1-110)"
  [ $code = 0 ] || fail=1
}
cargo_tests() {
  local out; out=$("$cargo" test --release -q --manifest-path "$here/Cargo.toml" 2>&1) || { echo "$out"; return 1; }
  echo "$out" | awk '/test result/ { p += $4; f += $6 } END { print p " passed, " f " failed (vectors.json, units)" }'
}
run "cargo test" cargo_tests
run "hub/test.mjs" node hub/test.mjs
run "hub/ops/test.mjs" node hub/ops/test.mjs
run "hub/accounts-test" node hub/accounts-test.mjs
run "hub/admin-test" node hub/admin-test.mjs
if [ "${1:-}" != "--quick" ]; then
  run "interop (all pairs)" node dev/interop/run.mjs --hub-cmd "$HUB_CMD"
  for p in integration updates hooks monitor keyclaim link; do run "connector e2e $p" node connector/test-e2e.mjs --only "$p"; done
  run "fuzz --quick" node dev/fuzz/run.mjs --quick
fi
exit $fail

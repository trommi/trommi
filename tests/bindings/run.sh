#!/bin/sh
# Every test of the bindings, from a clean checkout, on Linux or macOS:
#   the facade from Rust · the browser binding in Node and in headless Chromium · the Swift binding with
#   `swift test` · the TypeScript declarations under tsc · the manifest against both bindings.
# Needs: the Rust toolchain of rust-toolchain.toml, wasm-bindgen 0.2.129, Node, Swift, Chromium (`chromium` on the
# PATH, or CHROMIUM), and `npm ci` once for tsc. Both bindings are built with the recovery stand-in, which the
# scenario needs until the core carries the recovery construct.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
export TROMMI_STAND_IN_RECOVERY=1
cargo test --locked -p trommi-tests --test bindings_facade
sh core/wasm/build.sh
node tests/bindings/node.mjs
node tests/bindings/browser.mjs > "${TMPDIR:-/tmp}/trommi-browser-report.json" || { cat "${TMPDIR:-/tmp}/trommi-browser-report.json"; exit 1; }
echo "browser: passed (report in ${TMPDIR:-/tmp}/trommi-browser-report.json)"
npx tsc -p tests/bindings
echo "typings: accepted by tsc"
sh core/swift/build.sh host
swift test --package-path tests/bindings/swift ${SWIFT_SCRATCH:+--scratch-path "$SWIFT_SCRATCH"}
node tests/bindings/manifest.mjs --swift

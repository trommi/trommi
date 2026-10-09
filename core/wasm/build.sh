#!/bin/sh
# Build trommi-core for the browser: pkg/trommi_core_wasm.js (a plain ES module, no bundler) and
# pkg/trommi_core_wasm_bg.wasm. Needs the Rust target wasm32-unknown-unknown and wasm-bindgen 0.2.129
# (cargo install wasm-bindgen-cli --version 0.2.129 --locked): the same version as the crate in Cargo.lock.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
target=${CARGO_TARGET_DIR:-$here/../../target}
cargo build --manifest-path "$here/Cargo.toml" --profile wasm --target wasm32-unknown-unknown --locked
# The command and the crate must be the same version, or the JavaScript does not fit the .wasm.
want=$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$here/Cargo.toml")
have=$(wasm-bindgen --version | sed 's/^wasm-bindgen //')
[ "$have" = "$want" ] || { echo "wasm-bindgen is $have, the workspace pins $want (cargo install wasm-bindgen-cli --version $want --locked)" >&2; exit 1; }
rm -rf "$here/pkg"
wasm-bindgen --target web --out-dir "$here/pkg" "$target/wasm32-unknown-unknown/wasm/trommi_core_wasm.wasm"
wasm=$here/pkg/trommi_core_wasm_bg.wasm
printf 'wasm: %s bytes raw, %s gzip -9' "$(wc -c < "$wasm")" "$(gzip -9 -c "$wasm" | wc -c)"
command -v brotli >/dev/null && printf ', %s brotli -q 11' "$(brotli -q 11 -c "$wasm" | wc -c)"
echo

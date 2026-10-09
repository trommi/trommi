#!/bin/sh
# Build trommi-core for the browser into pkg/ (not in the repository):
#   trommi_core_wasm_bg.wasm   the core
#   trommi_core_wasm.js        its glue, written by wasm-bindgen (a plain ES module, no bundler)
#   trommi-core.js, .d.ts      what an app imports, and its types (from js/)
#   idb-store.js, .d.ts        a device's store on IndexedDB (from js/)
#   build.json                 the SHA-256 and the sizes of each file: what a build that names files by their
#                              content, or fetches the .wasm with `integrity`, reads
# Needs the Rust target wasm32-unknown-unknown and wasm-bindgen 0.2.129
# (cargo install wasm-bindgen-cli --version 0.2.129 --locked): the same version as the crate in Cargo.lock.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
target=${CARGO_TARGET_DIR:-$repo/target}
# The command and the crate must be the same version, or the JavaScript does not fit the .wasm.
want=$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$here/Cargo.toml")
have=$(wasm-bindgen --version | sed 's/^wasm-bindgen //')
[ "$have" = "$want" ] || { echo "wasm-bindgen is $have, the workspace pins $want (cargo install wasm-bindgen-cli --version $want --locked)" >&2; exit 1; }
# Paths of this machine stay out of the file (they would sit in the texts of panics): the same sources give the
# same bytes wherever they are built.
cargo_home=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$repo=/trommi --remap-path-prefix=$(rustc --print sysroot)=/rust" \
  cargo build --manifest-path "$here/Cargo.toml" --profile wasm --target wasm32-unknown-unknown --locked
rm -rf "$here/pkg"
wasm-bindgen --target web --no-typescript --out-dir "$here/pkg" "$target/wasm32-unknown-unknown/wasm/trommi_core_wasm.wasm"
cp "$here"/js/*.js "$here"/js/*.d.ts "$here/pkg/"

# Sizes and hashes. gzip is `gzip -9`, brotli `brotli -q 11` (null where the command is missing). Each is made into
# a file of its own and checked before it is counted; build.json appears whole or not at all.
work=$(mktemp -d "${TMPDIR:-/tmp}/trommi-wasm.XXXXXX")
bytes() { wc -c < "$1" | tr -d ' '; }
{
  printf '{\n'
  first=1
  for file in trommi_core_wasm_bg.wasm trommi_core_wasm.js trommi-core.js idb-store.js; do
    path=$here/pkg/$file
    sha256sum "$path" > "$work/sha"
    hash=$(cut -d' ' -f1 "$work/sha")
    [ ${#hash} -eq 64 ] || { echo "no SHA-256 of $file" >&2; exit 1; }
    gzip -9 -c "$path" > "$work/gzip"
    brotli=null
    if command -v brotli >/dev/null; then
      brotli -q 11 -c "$path" > "$work/brotli"
      brotli=$(bytes "$work/brotli")
    fi
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '  "%s": { "sha256": "%s", "raw": %s, "gzip": %s, "brotli": %s }' "$file" "$hash" "$(bytes "$path")" "$(bytes "$work/gzip")" "$brotli"
  done
  printf '\n}\n'
} > "$work/build.json"
mv "$work/build.json" "$here/pkg/build.json"
cat "$here/pkg/build.json"

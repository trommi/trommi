#!/bin/sh
# Build trommi-core for Swift: the static library per platform and UniFFI's Swift file and C header, into the Swift
# package TrommiCoreRust next to this script.
#   build.sh            the host (Linux or macOS: for `swift test`) and iOS (device)
#   build.sh host       the host only
#   build.sh ios        iOS only
# Needs the Rust targets (rustup target add aarch64-apple-ios); no Apple SDK and no Apple linker: a static library is
# an archive of object files, which rustc writes itself. (`cargo build` would also try the cdylib, which needs a linker
# for iOS: hence `cargo rustc --crate-type staticlib`.)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
what=${1:-all}
target=${CARGO_TARGET_DIR:-$here/../../target}
package=$here/TrommiCoreRust
cd "$here"

staticlib() {   # staticlib <rust target or ""> <folder under lib/>
  if [ -n "$1" ]; then
    cargo rustc --release --locked --target "$1" --crate-type staticlib
    from=$target/$1/release
  else
    cargo rustc --release --locked --crate-type staticlib
    from=$target/release
  fi
  mkdir -p "$package/lib/$2"
  cp "$from/libtrommi_core_ffi.a" "$package/lib/$2/libtrommi_core_ffi.a"
}

# The bindings are read from a host build of the library (a cdylib), whatever they are for.
cargo build --release --locked
cargo build --release --locked --manifest-path bindgen/Cargo.toml
generated=$(mktemp -d "${TMPDIR:-/tmp}/trommi-uniffi.XXXXXX")
lib=$target/release/libtrommi_core_ffi.so
[ -f "$lib" ] || lib=$target/release/libtrommi_core_ffi.dylib
"$target/release/uniffi-bindgen" generate "$lib" --language swift --no-format --out-dir "$generated"
mkdir -p "$package/Sources/TrommiCoreFFI/include" "$package/Sources/TrommiCoreRust"
cp "$generated/TrommiCoreFFI.h" "$package/Sources/TrommiCoreFFI/include/TrommiCoreFFI.h"
cp "$generated/TrommiCoreRust.swift" "$package/Sources/TrommiCoreRust/TrommiCoreRust.swift"

case "$(uname -s)" in Darwin) host=macos ;; *) host=linux ;; esac
[ "$what" = ios ] || staticlib "" "$host"
# The deployment target only names the oldest iOS in the object files; the app's own is higher.
if [ "$what" != host ]; then
  IPHONEOS_DEPLOYMENT_TARGET=${IPHONEOS_DEPLOYMENT_TARGET:-17.0} staticlib aarch64-apple-ios ios
  # rustc puts its copy of the compiler runtime's C and assembly helpers (compiler_builtins: outlined atomics,
  # fp_mode) into every static library. The app links Apple's libclang_rt.ios.a, which has the same symbols. A linker
  # that takes archive members on demand never loads Rust's copy; one told to load every member (-all_load, which the
  # darwin SDK toolset of omarchy-apple-dev passes to every link) fails with "duplicate symbol: __fe_raise_inexact",
  # "_aarch64_cas1_relax" and so on. So those members are taken out of the archive; Apple's copy serves them.
  builtins=$(ls "$(rustc --print sysroot)"/lib/rustlib/aarch64-apple-ios/lib/libcompiler_builtins-*.rlib)
  ar=$(command -v llvm-ar || echo "$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/llvm-ar")
  nm=$(command -v llvm-nm || echo "$(dirname "$ar")/llvm-nm")
  work=$(mktemp -d "${TMPDIR:-/tmp}/trommi-builtins.XXXXXX")
  "$ar" t "$builtins" | grep '\.o$' | grep -v '\.rcgu\.o$' > "$work/members"
  # Checked, not assumed: every symbol these members define must be in Apple's runtime of the darwin SDK
  # (DARWIN_CLANG_RT names its libclang_rt.ios.a; without the SDK the build stops, unless DARWIN_CLANG_RT=unchecked).
  # A new Rust that adds a helper Apple lacks stops the build.
  rt=${DARWIN_CLANG_RT:-$HOME/.config/swiftpm/swift-sdks/darwin.artifactbundle/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/clang/lib/darwin/libclang_rt.ios.a}
  if [ -f "$rt" ]; then
    (cd "$work" && "$ar" x "$builtins" $(cat members) && "$nm" --defined-only --extern-only $(cat members) 2>/dev/null | awk 'NF==3{print $3}' | sort -u > removed)
    "$nm" --defined-only --extern-only "$rt" 2>/dev/null | awk 'NF==3{print $3}' | sort -u > "$work/apple"
    missing=$(comm -23 "$work/removed" "$work/apple")
    [ -z "$missing" ] || { echo "not in Apple's libclang_rt.ios.a, so not removed safely:" $missing >&2; exit 1; }
    echo "compiler runtime: $(wc -l < "$work/members") members with $(wc -l < "$work/removed") symbols leave the archive, all of them in Apple's libclang_rt.ios.a"
  elif [ "${DARWIN_CLANG_RT:-}" = unchecked ]; then
    echo "compiler runtime: $(wc -l < "$work/members") members leave the archive, NOT checked against Apple's runtime" >&2
  else
    echo "no Apple compiler runtime at $rt to check against (DARWIN_CLANG_RT=<its libclang_rt.ios.a>, or DARWIN_CLANG_RT=unchecked to go on without the check)" >&2; exit 1
  fi
  xargs "$ar" d "$package/lib/ios/libtrommi_core_ffi.a" < "$work/members"
fi
ls -l "$package"/lib/*/libtrommi_core_ffi.a

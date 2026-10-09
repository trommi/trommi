#!/bin/sh
# Build trommi-core for Swift: the static library per platform and UniFFI's Swift file and C header, into the Swift
# package TrommiCoreRust next to this script.
#   build.sh            the host (Linux or macOS: for `swift test`) and iOS (device and simulator)
#   build.sh host       the host only
#   build.sh ios        iOS only
# Everything it writes is build output and not in the repository: lib/<platform>/libtrommi_core_ffi.a,
# Sources/TrommiCoreFFI/include/TrommiCoreFFI.h, Sources/TrommiCoreRust/TrommiCoreRust.swift. A script that ships
# the app from a clean checkout runs `build.sh ios` first.
# Needs the Rust targets (rustup target add aarch64-apple-ios); no Apple SDK and no Apple linker: a static library is
# an archive of object files, which rustc writes itself. (`cargo build` would also try the cdylib, which needs a linker
# for iOS: hence `cargo rustc --crate-type staticlib`.)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
what=${1:-all}
target=${CARGO_TARGET_DIR:-$here/../../target}
package=$here/TrommiCoreRust
cd "$here"
# Paths of this machine stay out of the library (they would sit in the texts of panics).
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(cd "$here/../.." && pwd)=/trommi --remap-path-prefix=$(rustc --print sysroot)=/rust"
export RUSTFLAGS

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
# rustc puts its copy of the compiler runtime's C and assembly helpers (compiler_builtins: outlined atomics,
# fp_mode) into every static library. The app links Apple's libclang_rt, which has the same symbols. A linker
# that takes archive members on demand never loads Rust's copy; one told to load every member (-all_load, which the
# darwin SDK toolset of omarchy-apple-dev passes to every link) fails with "duplicate symbol: __fe_raise_inexact",
# "_aarch64_cas1_relax" and so on. So those members are taken out of the archive; Apple's copy serves them.
# Checked, not assumed: every symbol these members define must be in Apple's runtime of the darwin SDK
# (DARWIN_CLANG_RT names the folder of its libclang_rt.*.a; without the SDK the build stops, unless
# DARWIN_CLANG_RT=unchecked, which is for trying things and never for a build that ships). A new Rust that adds a
# helper Apple lacks stops the build.
without_builtins() {   # without_builtins <rust target> <folder under lib/> <Apple's runtime: ios or iossim>
  builtins=$(ls "$(rustc --print sysroot)"/lib/rustlib/"$1"/lib/libcompiler_builtins-*.rlib)
  ar=$(command -v llvm-ar || echo "$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/llvm-ar")
  nm=$(command -v llvm-nm || echo "$(dirname "$ar")/llvm-nm")
  work=$(mktemp -d "${TMPDIR:-/tmp}/trommi-builtins.XXXXXX")
  "$ar" t "$builtins" > "$work/all"
  grep '\.o$' "$work/all" | grep -v '\.rcgu\.o$' > "$work/members"
  [ -s "$work/members" ] || { echo "no C or assembly members found in $builtins" >&2; exit 1; }
  rt_folder=${DARWIN_CLANG_RT:-$HOME/.config/swiftpm/swift-sdks/darwin.artifactbundle/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/clang/lib/darwin}
  rt=$rt_folder/libclang_rt.$3.a
  if [ -f "$rt" ]; then
    # Each inspection writes a file and is checked on its own: a failed one must not look like "nothing missing".
    (cd "$work" && "$ar" x "$builtins" $(cat members))
    (cd "$work" && "$nm" --defined-only --extern-only $(cat members)) > "$work/removed.nm" 2> /dev/null
    "$nm" --defined-only --extern-only "$rt" > "$work/apple.nm" 2> /dev/null
    awk 'NF==3{print $3}' "$work/removed.nm" | sort -u > "$work/removed"
    awk 'NF==3{print $3}' "$work/apple.nm" | sort -u > "$work/apple"
    [ -s "$work/removed" ] && [ -s "$work/apple" ] || { echo "the symbols of $builtins or of $rt could not be read" >&2; exit 1; }
    missing=$(comm -23 "$work/removed" "$work/apple")
    [ -z "$missing" ] || { echo "not in Apple's $(basename "$rt"), so not removed safely:" $missing >&2; exit 1; }
    echo "$2: $(wc -l < "$work/members") members of the compiler runtime with $(wc -l < "$work/removed") symbols leave the archive, all of them in Apple's $(basename "$rt")"
  elif [ "${DARWIN_CLANG_RT:-}" = unchecked ]; then
    echo "$2: $(wc -l < "$work/members") members of the compiler runtime leave the archive, NOT checked against Apple's runtime: not for a build that ships" >&2
  else
    echo "no Apple compiler runtime at $rt to check against (DARWIN_CLANG_RT=<the folder of libclang_rt.$3.a>)" >&2; exit 1
  fi
  xargs "$ar" d "$package/lib/$2/libtrommi_core_ffi.a" < "$work/members"
  # And they are gone.
  "$ar" t "$package/lib/$2/libtrommi_core_ffi.a" > "$work/after"
  if grep -q -x -F -f "$work/members" "$work/after"; then echo "$2: the members are still in the archive" >&2; exit 1; fi
}

# The deployment target only names the oldest iOS in the object files; the app's own is higher.
# The simulator's library is for a Mac (TROMMI_IOS_SIMULATOR=1 makes the package link it) and stays as rustc
# writes it: Apple's runtime for the simulator lacks most of these helpers (the check above refuses it), and a
# Mac's linker loads archive members on demand, where two copies do not meet.
if [ "$what" != host ]; then
  IPHONEOS_DEPLOYMENT_TARGET=${IPHONEOS_DEPLOYMENT_TARGET:-17.0} staticlib aarch64-apple-ios ios
  without_builtins aarch64-apple-ios ios ios
  IPHONEOS_DEPLOYMENT_TARGET=${IPHONEOS_DEPLOYMENT_TARGET:-17.0} staticlib aarch64-apple-ios-sim ios-simulator
fi
ls -l "$package"/lib/*/libtrommi_core_ffi.a

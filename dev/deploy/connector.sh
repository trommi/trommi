#!/bin/bash
# dev/deploy/connector.sh: the connector's release (connector-rs) from this machine to app.trommi.com.
# README.md "Deploy without CI".
#
#   dev/deploy/connector.sh [--dry-run] [--allow-unpushed] [--no-build]
#
# Cloudflare's build of the web app has no Rust toolchain, so the connector is built here and uploaded apart from the
# app: node connector-rs/build-plugin.mjs makes the binaries (static musl for Linux x86_64 and aarch64; macOS arm64 and
# x86_64 with cargo-zigbuild and zig, no Apple SDK), the plugin zip and marketplace.json in connector-rs/dist/; they
# go into the R2 bucket trommi-releases (app/web/wrangler.jsonc, binding RELEASES), from which app/web/worker.js
# serves them at https://app.trommi.com/connector/… and /plugins/…. The files named by their content go first, the
# pointers (the .sha256 files, then marketplace.json) last, so a reader never sees a pointer to a file that is not
# there yet. Then it checks what app.trommi.com serves.
# --dry-run builds (local, harmless) and prints the uploads. --no-build takes connector-rs/dist/ as it is.
# Once: npx wrangler login; npx wrangler r2 bucket create trommi-releases.
set -euo pipefail
# shellcheck source=dev/deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUILD=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done
WRANGLER=(npx --yes wrangler@4)
BUCKET=trommi-releases
DIST="$REPO/connector-rs/dist"
TARGETS=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin x86_64-apple-darwin)

guard_tree

# ---- build ----
if [ "$BUILD" = 1 ]; then
  say "build: node connector-rs/build-plugin.mjs"
  node "$REPO/connector-rs/build-plugin.mjs" "$DIST" --targets "$(IFS=,; echo "${TARGETS[*]}")"
fi
for t in "${TARGETS[@]}"; do
  [ -s "$DIST/connector/trommi-connector-$t.sha256" ] || die "no $t build in $DIST (run without --no-build)"
done
[ -s "$DIST/plugins/marketplace.json" ] || die "no plugins/marketplace.json in $DIST"
version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plugins[0].version)' "$DIST/plugins/marketplace.json")
say "release $version: $(cd "$DIST" && find connector plugins -type f | sort | tr '\n' ' ')"

# ---- upload ----
say "wrangler auth"
"${WRANGLER[@]}" whoami >/dev/null 2>&1 && say "wrangler: logged in" || refuse "wrangler is not logged in: npx wrangler login"
cd "$REPO/app/web"   # (wrangler reads wrangler.jsonc here)
put() { run "${WRANGLER[@]}" r2 object put "$BUCKET/$1" --file "$DIST/$1" --remote; }
files() { (cd "$DIST" && find "$@" -type f | sort); }
for f in $(files connector -mindepth 2) $(files plugins -name 'trommi-*.zip'); do put "$f"; done   # named by content
for f in $(files connector -maxdepth 1); do put "$f"; done                                         # the pointers
put plugins/marketplace.json                                                                       # last

# ---- check what app.trommi.com serves ----
[ "$DRY" = 1 ] && { say "dry run: nothing uploaded"; exit 0; }
q="ci=local-$$"
for t in "${TARGETS[@]}"; do
  want=$(cut -d ' ' -f 1 < "$DIST/connector/trommi-connector-$t.sha256")
  got=$(curl -fsS --max-time 10 "https://app.trommi.com/connector/trommi-connector-$t.sha256?$q" | cut -d ' ' -f 1)
  [ "$got" = "$want" ] || die "app.trommi.com/connector/trommi-connector-$t.sha256 says ${got:-nothing}, the release $want"
  curl -fsS --max-time 60 "https://app.trommi.com/connector/$want/trommi-connector-$t" | sha256sum | grep -q "^$want " || die "app.trommi.com does not serve the $t binary $want"
done
zip=$(curl -fsS --max-time 10 "https://app.trommi.com/plugins/marketplace.json?$q" | node -e 'let s = ""; process.stdin.on("data", d => { s += d }).on("end", () => console.log(JSON.parse(s).plugins[0].source.url))')
case "$zip" in */plugins/trommi-"$version".zip) ;; *) die "the served marketplace names $zip, not trommi-$version.zip" ;; esac
curl -fsS --max-time 60 -o /dev/null "$zip" || die "the plugin archive $zip is not served"
say "done: app.trommi.com serves connector release $version"

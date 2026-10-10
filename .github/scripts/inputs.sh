#!/bin/sh
# What each part of a release is built from, as one SHA-256 per part: `.github/scripts/inputs.sh [<commit>]` prints
# lines `<part> <sha256>` for web, connector, ios, hub, updater.
#
# The hash is over the lines `git ls-tree -r <commit>` prints for the part's paths (mode, type, object id, path),
# never over the working tree, so it is the same on every machine for the same commit. Two commits with the same
# value for a part build the same part. A path too many costs one needless release; a path too few ships a stale
# part: when in doubt a path is in. build.yml is in every part (it holds build settings), tests are in none (they
# ship nothing).
set -eu
commit=${1:-HEAD}
# every part: the shared core, the Rust workspace and toolchain, the build workflow, the release form
shared='core/ Cargo.toml Cargo.lock rust-toolchain.toml .github/workflows/build.yml .github/workflows/release.yml .github/scripts/inputs.sh release/'
paths() {
  case $1 in
    web) echo "app/web/ connector/tools.json connector/prompt.md demo/ package.json package-lock.json .node-version .github/scripts/web_release.mjs .github/tools/wrangler/ .github/workflows/deploy_web.yml" ;;
    connector) echo "connector/ install.sh .claude-plugin/ .node-version" ;;
    ios) echo "ios/ demo/ .github/scripts/ios_testflight.sh .github/scripts/ios_archive.sh .github/scripts/ios_entitlements.py .github/workflows/deploy_ios.yml" ;;
    # the hub program: the hub's crate (hub/updater and hub/deploy belong to the updater)
    hub) echo "hub/Cargo.toml hub/src/ hub/build.rs hub/static/ .github/workflows/deploy_hub.yml" ;;
    updater) echo "hub/updater/ hub/deploy/ .github/workflows/deploy_hub.yml" ;;
  esac
}
for part in web connector ios hub updater; do
  # shellcheck disable=SC2046,SC2086
  sum=$(git ls-tree -r "$commit" -- $shared $(paths "$part") | LC_ALL=C sort -k4 | sha256sum | cut -d' ' -f1)
  echo "$part $sum"
done

#!/bin/sh
# Writes the manifest of a release to standard output: the statement that is signed.
#   release/manifest.sh <product> <version> <commit> <file>...
#   release/manifest.sh trommi-hub 123 <sha> out/trommi-hub-x86_64-unknown-linux-musl out/trommi-hub.service
# product: trommi-hub, trommi-connector, ...; the release tag is the product without "trommi-", then -v<version>
# (hub-v123). version: a whole number that only grows. Every file is named with its size and SHA-256; the name in
# the manifest is the file's name without its folder, which is also its name as a release asset.
# The repository is $GITHUB_REPOSITORY (default trommi/trommi).
set -eu
[ $# -ge 4 ] || { echo "usage: $0 <product> <version> <commit> <file>..." >&2; exit 2; }
product=$1 version=$2 commit=$3
shift 3
case $product in trommi-?*) ;; *) echo "product must start with trommi-" >&2; exit 2 ;; esac
case $product in *[!a-z0-9-]*) echo "product: lower-case letters, digits and - only" >&2; exit 2 ;; esac
case $version in ''|0*|*[!0-9]*) echo "version must be a whole number without leading zero" >&2; exit 2 ;; esac
[ ${#version} -le 12 ] || { echo "version is too long" >&2; exit 2; }
case $commit in *[!0-9a-f]*) echo "commit must be a full lower-case SHA" >&2; exit 2 ;; esac
[ ${#commit} -eq 40 ] || { echo "commit must be a full lower-case SHA" >&2; exit 2; }
repository=${GITHUB_REPOSITORY:-trommi/trommi}
case $repository in *[!A-Za-z0-9._/-]*) echo "unexpected repository name" >&2; exit 2 ;; esac

printf '{\n  "product": "%s",\n  "repository": "%s",\n  "version": %s,\n  "tag": "%s-v%s",\n  "commit": "%s",\n  "assets": [' \
  "$product" "$repository" "$version" "${product#trommi-}" "$version" "$commit"
sep=
for file in "$@"; do
  name=$(basename "$file")
  case $name in *[!A-Za-z0-9._-]*) echo "asset name not plain: $name" >&2; exit 2 ;; esac
  [ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
  sum=$(sha256sum "$file" | cut -d' ' -f1)
  size=$(wc -c < "$file" | tr -d ' ')
  printf '%s\n    { "name": "%s", "sha256": "%s", "size": %s }' "$sep" "$name" "$sum" "$size"
  sep=,
done
printf '\n  ]\n}\n'

#!/bin/sh
# Writes the manifest of a release to standard output: the statement that is signed.
#   release/manifest.sh <product> <version> <commit> <file>...
#   release/manifest.sh trommi 123 <sha> out/*
# product: `trommi`, the one release of every part (tag v123); the older per-part products (trommi-hub,
# trommi-connector) get the product without "trommi-", then -v<version> (hub-v123). version: a whole number that
# only grows. With $PARTS set (the release of every part), the manifest also says per part what its build read and
# whether that changed since the release before: $PARTS is lines of `<part> <inputs sha256> <true|false>`. Every file is named with its size and SHA-256; the name in
# the manifest is the file's name without its folder, which is also its name as a release asset.
# The repository is $GITHUB_REPOSITORY (default trommi/trommi).
set -eu
[ $# -ge 4 ] || { echo "usage: $0 <product> <version> <commit> <file>..." >&2; exit 2; }
product=$1 version=$2 commit=$3
shift 3
case $product in trommi|trommi-?*) ;; *) echo "product must be trommi or start with trommi-" >&2; exit 2 ;; esac
case $product in *[!a-z0-9-]*) echo "product: lower-case letters, digits and - only" >&2; exit 2 ;; esac
case $version in ''|0*|*[!0-9]*) echo "version must be a whole number without leading zero" >&2; exit 2 ;; esac
[ ${#version} -le 12 ] || { echo "version is too long" >&2; exit 2; }
case $commit in *[!0-9a-f]*) echo "commit must be a full lower-case SHA" >&2; exit 2 ;; esac
[ ${#commit} -eq 40 ] || { echo "commit must be a full lower-case SHA" >&2; exit 2; }
repository=${GITHUB_REPOSITORY:-trommi/trommi}
case $repository in *[!A-Za-z0-9._/-]*) echo "unexpected repository name" >&2; exit 2 ;; esac

case $product in trommi) tag=v$version ;; *) tag=${product#trommi-}-v$version ;; esac

printf '{\n  "product": "%s",\n  "repository": "%s",\n  "version": %s,\n  "tag": "%s",\n  "commit": "%s",\n' \
  "$product" "$repository" "$version" "$tag" "$commit"
# per part: "inputs": {"hub": "<sha256>", ...} (the updater reads its two) and "changed": {"hub": true, ...}
if [ -n "${PARTS:-}" ]; then
  inputs= changed= sep=
  for line in $(printf '%s\n' "$PARTS" | tr ' ' ':'); do
    part=${line%%:*} rest=${line#*:}
    sum=${rest%%:*} flag=${rest#*:}
    case $part in ''|*[!a-z]*) echo "part: lower-case letters only: $part" >&2; exit 2 ;; esac
    case $sum in *[!0-9a-f]*) echo "inputs of $part: not a SHA-256" >&2; exit 2 ;; esac
    [ ${#sum} -eq 64 ] || { echo "inputs of $part: not a SHA-256" >&2; exit 2; }
    case $flag in true|false) ;; *) echo "changed of $part: true or false" >&2; exit 2 ;; esac
    inputs="$inputs$sep\"$part\": \"$sum\""
    changed="$changed$sep\"$part\": $flag"
    sep=', '
  done
  printf '  "inputs": { %s },\n  "changed": { %s },\n' "$inputs" "$changed"
fi
printf '  "assets": ['
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

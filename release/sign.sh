#!/bin/sh
# Signs and checks a release manifest. One form for every part that is released (hub, connector, ...).
#
#   release/sign.sh sign   manifest.json     writes manifest.json.sig; the private key is read from $SIGN_RELEASE_KEY
#   release/sign.sh verify manifest.json     checks manifest.json.sig against release/public-key.pem
#   release/sign.sh files  manifest.json     checks every file the manifest names (beside it) by size and SHA-256
#
# The signature is Ed25519 over the exact bytes of the manifest, 64 raw bytes (openssl pkeyutl -rawin).
# Whoever checks a release: first the signature, then that the manifest says the product, repository, tag and
# version that were asked for, then each file against the manifest. The public key is release/public-key.pem in
# this repository; a release never brings a key with it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-} manifest=${2:-}
if [ -z "$mode" ] || [ ! -f "$manifest" ]; then echo "usage: $0 sign|verify|files <manifest.json>" >&2; exit 2; fi

# A key may arrive with its line breaks turned into spaces (the 1Password form does that when a value is edited by
# hand), so it is put back into PEM form from its base64 body before it is read.
pem() {
  body=$(printf '%s' "$1" | sed -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)"
}

case $mode in
  sign)
    [ -n "${SIGN_RELEASE_KEY:-}" ] || { echo "SIGN_RELEASE_KEY is not set" >&2; exit 1; }
    umask 077
    key=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign.XXXXXX")
    trap 'rm -f "$key"' EXIT INT TERM
    pem "$SIGN_RELEASE_KEY" > "$key"
    openssl pkeyutl -sign -rawin -inkey "$key" -in "$manifest" -out "$manifest.sig"
    rm -f "$key"
    # what was just signed must check against the key in the repository: a wrong private key stops here
    "$0" verify "$manifest"
    ;;
  verify)
    [ "$(wc -c < "$manifest.sig" | tr -d ' ')" = 64 ] || { echo "$manifest.sig is not 64 bytes" >&2; exit 1; }
    openssl pkeyutl -verify -rawin -pubin -inkey "$here/public-key.pem" -in "$manifest" -sigfile "$manifest.sig" >/dev/null \
      || { echo "$manifest: the signature does not match release/public-key.pem" >&2; exit 1; }
    echo "$manifest: signature good"
    ;;
  files)
    dir=$(dirname "$manifest")
    # one asset per line in the manifest, as release/manifest.sh writes it
    sed -n 's/^ *{ "name": "\([A-Za-z0-9._-]*\)", "sha256": "\([0-9a-f]\{64\}\)", "size": \([0-9]*\) }.*/\1 \2 \3/p' "$manifest" > "$manifest.list"
    trap 'rm -f "$manifest.list"' EXIT
    [ -s "$manifest.list" ] || { echo "$manifest names no file" >&2; exit 1; }
    # a manifest not written one asset per line would hide entries from this check: refuse it
    [ "$(grep -o '"name"' "$manifest" | wc -l | tr -d ' ')" = "$(wc -l < "$manifest.list" | tr -d ' ')" ] \
      || { echo "$manifest is not in the form release/manifest.sh writes" >&2; exit 1; }
    while read -r name sum size; do
      if [ "$(sha256sum "$dir/$name" | cut -d' ' -f1)" != "$sum" ] || [ "$(wc -c < "$dir/$name" | tr -d ' ')" != "$size" ]; then
        echo "$name is not the file the manifest names" >&2; exit 1
      fi
      echo "$name: as the manifest says"
    done < "$manifest.list"
    ;;
  *) echo "usage: $0 sign|verify|files <manifest.json>" >&2; exit 2 ;;
esac

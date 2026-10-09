#!/bin/sh
# Placeholder release signing: writes SHA256SUMS over the files of a folder and signs it with SIGN_RELEASE_KEY
# (Ed25519). Runs under `op run`, which supplies the key; the key file lives only for the signature.
#   sign.sh <folder>
set -eu
cd "$1"
# a key may arrive with its line breaks turned into spaces, so it is put back into PEM form from its base64 body
pem() {
  body=$(printf '%s' "$1" | sed -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)"
}
key=$(mktemp)
trap 'rm -f "$key"' EXIT
chmod 600 "$key"
pem "$SIGN_RELEASE_KEY" > "$key"
rm -f SHA256SUMS SHA256SUMS.sig
sha256sum -- * > SHA256SUMS
openssl pkeyutl -sign -inkey "$key" -rawin -in SHA256SUMS -out SHA256SUMS.sig

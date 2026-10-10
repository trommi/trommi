#!/usr/bin/env bash
# The App Store release from this machine (store.py does the work; app/ios/README.md "App Store release"):
#
#   store.sh check              offline, nothing is sent
#   store.sh upload [BUILD]     metadata, screenshots, the version and its build into App Store Connect; submits nothing
#   store.sh submit --yes       the version goes to App Review
#   store.sh release --yes      an approved version (release type MANUAL) goes on sale
#   store.sh status             read only
#
# Environment as for ship-local.sh: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH [~/.appstoreconnect/private_keys/
# AuthKey_<id>.p8], read first from ~/.config/trommi/ios.env (TROMMI_IOS_ENV names another file). Or run it under
# `op run` with APPLE_ASC_KEY, APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID from the 1Password Environment: the key is then
# written to a file of mode 600 that is removed when the script ends. APPSTORE_DEMO_PASSWORD only with a demo account.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
[ "${1:-}" = check ] && exec python3 "$here/store.py" check

ios_env=${TROMMI_IOS_ENV:-$HOME/.config/trommi/ios.env}
# shellcheck disable=SC1090 # the local config file
[ -f "$ios_env" ] && { set -a; . "$ios_env"; set +a; }
if [ -n "${APPLE_ASC_KEY:-}" ]; then
  keys=$(mktemp -d "${TMPDIR:-/tmp}/trommi-asc.XXXXXX")
  trap 'rm -rf "$keys"' EXIT
  umask 077
  body=$(printf '%s' "$APPLE_ASC_KEY" | sed -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)" > "$keys/AuthKey.p8"
  umask 022
  export ASC_KEY_PATH=$keys/AuthKey.p8 ASC_KEY_ID=${APPLE_ASC_KEY_ID:?} ASC_ISSUER_ID=${APPLE_ASC_ISSUER_ID:?}
fi
export ASC_KEY_ID=${ASC_KEY_ID:?set ASC_KEY_ID (or run under op run with APPLE_ASC_KEY_ID)}
export ASC_ISSUER_ID=${ASC_ISSUER_ID:?set ASC_ISSUER_ID}
export ASC_KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}
[ -r "$ASC_KEY_PATH" ] || { echo "no API key at $ASC_KEY_PATH" >&2; exit 1; }
export BUNDLE_ID=com.trommi.ios
python3 "$here/store.py" "$@"

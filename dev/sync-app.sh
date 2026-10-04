#!/usr/bin/env bash
# dev/sync-app.sh: copy the client core into the app repo, so the app imports the very same files.
#   crypto/zcrypto.mjs  -> <app>/public/vendor/zcrypto.mjs   (replaces client/core/zcrypto.mjs, the re-export shim)
#   client/core/*.mjs   -> <app>/public/vendor/              (without tests, the Node-only file adapter)
#   hub/channel-tools.mjs, hub/richhtml.mjs -> <app>/public/vendor/   (tool reference for the help page)
# Usage: dev/sync-app.sh [app repo dir]   (default: $TROMMI_APP or ~/git/trommi, the legacy app repo trommi/trommi-app-legacy)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-${TROMMI_APP:-$HOME/git/trommi}}"
dest="$app/public/vendor"
[ -d "$app/public" ] || { echo "no app repo at $app (expected public/)" >&2; exit 1; }
mkdir -p "$dest"
# From the committed tree (HEAD), never from the working tree: other streams edit files there in place.
ref="${SYNC_REF:-HEAD}"
for f in $(git -C "$here" ls-tree --name-only "$ref" client/core/); do
  name="$(basename "$f")"
  case "$name" in *.mjs) ;; *) continue ;; esac
  case "$name" in test*.mjs|*-test.mjs|test-hub.mjs|load.mjs|storage-file.mjs|zcrypto.mjs|session-grants.mjs) continue ;; esac
  git -C "$here" show "$ref:$f" > "$dest/$name"
done
git -C "$here" show "$ref:crypto/zcrypto.mjs" > "$dest/zcrypto.mjs"
if git -C "$here" cat-file -e "$ref:crypto/session-grants.mjs" 2>/dev/null; then git -C "$here" show "$ref:crypto/session-grants.mjs" > "$dest/session-grants.mjs"; fi
# The agent tool and event reference for the app's help page (browser-safe: no node imports).
for f in hub/channel-tools.mjs hub/richhtml.mjs; do git -C "$here" show "$ref:$f" > "$dest/$(basename "$f")"; done
commit="$(git -C "$here" rev-parse --short "$ref")"
printf '// Copied from trommi-hub %s by dev/sync-app.sh. Do not edit here: edit client/core/ and crypto/ in trommi-hub.\nexport const CORE_COMMIT = %s\n' "$commit" "'$commit'" > "$dest/core-version.mjs"
echo "synced client/core + zcrypto ($commit) into $dest"
ls "$dest"

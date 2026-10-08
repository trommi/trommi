#!/usr/bin/env bash
# TestFlight without CI: builds the App Store version of ios/TrommiApp on this Linux machine (xtool, the darwin SDK,
# rcodesign; ios/README.md "TestFlight without CI"), signs it for App Store distribution, uploads it with the App Store
# Connect Build Uploads API, waits until it is VALID, puts it into the internal group "Intern" and sets its German
# "What to Test" from the commit subjects since the last build.
#
#   ship-local.sh [REF]          REF defaults to origin/main (fetched first); built from a clean git worktree of it
#   ship-local.sh --dry-run [REF]   everything up to the signed, offline-validated .ipa; no upload
#
# Environment (defaults in brackets):
#   ASC_KEY_ID [Z86FGC8S66] ASC_ISSUER_ID [the team's] ASC_KEY_PATH [~/.appstoreconnect/private_keys/AuthKey_<id>.p8]
#     a team key with the Admin role (it creates the Apple Distribution certificate and the App Store profile)
#   ASC_IDENTITY_DIR [~/.appstoreconnect/private_keys/distribution]  the distribution key (key.pem, 0600) and cert.der;
#     created on the first run, reused while the certificate is valid
#   BUILD_NUMBER   [the highest build number in App Store Connect + 1]
#   ITS_NON_EXEMPT_ENCRYPTION [NO]   written as ITSAppUsesNonExemptEncryption
#   NOTES          What to Test instead of the generated text
#   TESTFLIGHT_TESTER [82179548+chriopter@users.noreply.github.com]   kept in the group "Intern"
#   OUT_DIR        [~/.cache/trommi-ship]   where the .ipa is kept
#   APPLE_DEV      [~/.local/share/omarchy-apple-dev]   its tools/asc.py (stamp, frameworks, identity, validate, upload)
# Nothing here prints key material or tokens. App extensions are not shipped: any PlugIns/ in the build is dropped.
set -euo pipefail

dry=0
[ "${1:-}" = --dry-run ] && { dry=1; shift; }
ref=${1:-origin/main}

here=$(dirname "$(readlink -f "$0")")
repo=$(git -C "$here" rev-parse --show-toplevel)
APPLE_DEV=${APPLE_DEV:-$HOME/.local/share/omarchy-apple-dev}
PY="$HOME/pymobile3-venv/bin/python"     # has `cryptography`, which omarchy-apple-dev's asc.py needs
TOOLS="$APPLE_DEV/tools"
sdk_cache=$(ls -d "$HOME"/.cache/xtool/darwin-iPhoneOS*.xtoolsdk 2>/dev/null | sort -V | tail -n1)
[ -n "$sdk_cache" ] || { echo "no darwin SDK in ~/.cache/xtool (omarchy-apple-dev install-toolchain.sh)" >&2; exit 1; }
export DARWIN_SDK=${DARWIN_SDK:-$sdk_cache}
# DTXcode/DTXcodeBuild: asc.py stamp reads <sdk>.version.plist (Xcode.app/Contents/version.plist of the .xip the SDK
# came from) or XCODE_VERSION/XCODE_BUILD.
[ -f "$sdk_cache.version.plist" ] || : "${XCODE_VERSION:?set XCODE_VERSION and XCODE_BUILD (the Xcode the SDK came from)}"
ACTOOL=${ACTOOL:-$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/Developer/Platforms/iPhoneOS.platform/Developer/usr/bin/actool}

export BUNDLE_ID=com.trommi.ios
export ASC_KEY_ID=${ASC_KEY_ID:-Z86FGC8S66}
export ASC_ISSUER_ID=${ASC_ISSUER_ID:-70cb783d-4a08-4023-9ddd-989f0bbe0332}
export ASC_KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}
export ASC_IDENTITY_DIR=${ASC_IDENTITY_DIR:-$HOME/.appstoreconnect/private_keys/distribution}
[ -r "$ASC_KEY_PATH" ] || { echo "no API key at $ASC_KEY_PATH" >&2; exit 1; }
out_dir=${OUT_DIR:-$HOME/.cache/trommi-ship}
tester=${TESTFLIGHT_TESTER:-82179548+chriopter@users.noreply.github.com}
PATH="$(dirname "$(readlink -f "$(command -v swift)")"):$HOME/.local/bin:$PATH"
export PATH

work=$(mktemp -d "${TMPDIR:-/tmp}/trommi-ship.XXXXXX")
cleanup() { git -C "$repo" worktree remove --force "$work/src" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

echo "== 1. Clean worktree of $ref =="
case "$ref" in origin/*) git -C "$repo" fetch -q origin "${ref#origin/}" ;; esac
git -C "$repo" worktree add -q --detach "$work/src" "$ref"
src="$work/src"
sha=$(git -C "$src" rev-parse --short=7 HEAD)
app_dir="$src/ios/TrommiApp"
asc() { python3 "$here/asc.py" "$@"; }
version=$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$app_dir/AppStore/project.yml")
[ -n "$version" ] || { echo "no MARKETING_VERSION in AppStore/project.yml" >&2; exit 1; }
asc prepare "$BUNDLE_ID"
build=${BUILD_NUMBER:-$(asc next-build)}
echo "building $BUNDLE_ID $version ($build) from $sha"

echo "== 2. Release build (xtool) =="
cd "$app_dir"
ulimit -n 65536 2>/dev/null || true
xtool dev build --configuration release
app=$(find xtool -maxdepth 1 -name '*.app' -print -quit)
[ -n "$app" ] || { echo "no .app under xtool/" >&2; exit 1; }
if [ -d "$app/PlugIns" ]; then echo "dropping app extensions: $(ls "$app/PlugIns")"; rm -rf "$app/PlugIns"; fi

echo "== 3. App icon (actool, AppStore/Assets.xcassets) =="
min=$("$PY" -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["MinimumOSVersion"])' "$app/Info.plist")
"$ACTOOL" "$app_dir/AppStore/Assets.xcassets" --compile "$app" --platform iphoneos --app-icon AppIcon \
  --minimum-deployment-target "$min" --output-partial-info-plist "$work/icon.plist" --output-format human-readable-text

echo "== 4. Info.plist: icon, version, export compliance; App Store keys, frameworks =="
"$PY" - "$app/Info.plist" "$work/icon.plist" "$version" "${ITS_NON_EXEMPT_ENCRYPTION:-NO}" <<'PYEOF'
import plistlib, sys
path, icon, version, its = sys.argv[1:]
d = plistlib.load(open(path, "rb"))
d.update(plistlib.load(open(icon, "rb")))
d["CFBundleShortVersionString"] = version
d["ITSAppUsesNonExemptEncryption"] = its.upper() == "YES"
plistlib.dump(d, open(path, "wb"), fmt=plistlib.FMT_BINARY)
PYEOF
"$PY" "$TOOLS/asc.py" stamp "$app" "$build"
"$PY" "$TOOLS/asc.py" frameworks "$app"

echo "== 5. Distribution identity and signature =="
sign_dir="$work/signing"
"$PY" "$TOOLS/asc.py" identity "$app" "$sign_dir"     # Apple Distribution certificate + App Store profile via the API
chmod 600 "$ASC_IDENTITY_DIR/key.pem"
# The profile's entitlements plus the app's own (aps-environment: production from AppStore/TrommiApp.entitlements),
# each one checked against what the profile grants.
"$PY" - "$sign_dir/entitlements.plist" "$app_dir/AppStore/TrommiApp.entitlements" "$app/embedded.mobileprovision" <<'PYEOF'
import plistlib, sys
out, extra, prov = sys.argv[1:]
ent = plistlib.load(open(out, "rb"))
raw = open(prov, "rb").read()
granted = plistlib.loads(raw[raw.index(b"<?xml"):raw.index(b"</plist>") + 8])["Entitlements"]
for k, v in plistlib.load(open(extra, "rb")).items():
    if granted.get(k) != v:
        sys.exit(f"the App Store profile does not grant {k} = {v} (it grants {granted.get(k)!r})")
    ent[k] = v
plistlib.dump(ent, open(out, "wb"))
print("entitlements:", ", ".join(f"{k}={v}" for k, v in sorted(ent.items())))
PYEOF
team=$("$PY" -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["com.apple.developer.team-identifier"])' \
  "$sign_dir/entitlements.plist")
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "team id '$team' is not a bare 10-character team id" >&2; exit 1; }
"$PY" "$TOOLS/fill-team-prefix.py" --team "$team" "$app"
sign_args=(--pem-file "$sign_dir/key.pem" --certificate-der-file "$sign_dir/cert.der" --team-name "$team")
shopt -s nullglob
for framework in "$app"/Frameworks/*.framework; do rcodesign sign "${sign_args[@]}" "$framework"; done
shopt -u nullglob
rcodesign sign "${sign_args[@]}" --entitlements-xml-file "$sign_dir/entitlements.plist" "$app"

echo "== 6. Package and offline validation =="
ipa="$work/Trommi-$version-$build.ipa"
mkdir "$work/Payload"
cp -a "$app" "$work/Payload/"
(cd "$work" && zip -qry "$ipa" Payload)
"$PY" "$TOOLS/asc.py" validate "$ipa"
if [ "$dry" = 1 ]; then
  mkdir -p "$out_dir" && cp "$ipa" "$out_dir/"
  echo "dry run: $out_dir/$(basename "$ipa")"
  exit 0
fi

echo "== 7. Upload (Build Uploads API) =="
"$PY" "$TOOLS/asc.py" upload "$ipa"

echo "== 8. Processing, group Intern, What to Test =="
out="$work/wait.out"
GITHUB_OUTPUT="$out" asc wait "$version" "$build"
build_id=$(sed -n 's/^build_id=//p' "$out")
asc internal "$build_id" Intern "$tester"
if [ -z "${NOTES:-}" ]; then
  since=$(asc last-sha || true)
  if [ -n "$since" ] && git -C "$src" merge-base --is-ancestor "$since" HEAD 2>/dev/null; then
    subjects=$(git -C "$src" log --no-merges --format='- %s' "$since..HEAD" -- ios)
  fi
  [ -n "${subjects:-}" ] || subjects=$(git -C "$src" log -1 --format='- %s')
  NOTES=$(printf 'Neu in Build %s (%s):\n%s' "$build" "$sha" "$subjects")
fi
asc notes "$build_id" "$NOTES"
mkdir -p "$out_dir" && cp "$ipa" "$out_dir/"
echo "TestFlight: $BUNDLE_ID $version ($build) from $sha is VALID and in Intern"
echo "BUILD_NUMBER=$build"

#!/bin/bash
# The TestFlight delivery of the iOS app on a macOS runner; deploy_ios.yml runs it under `op run`, which is where
# the App Store Connect key comes from. Steps: the bundle ids and the app record (asc.py prepare) -> the build
# number (the highest App Store Connect has, plus one) -> Trommi.xcodeproj from AppStore/project.yml (XcodeGen) ->
# archive (Release, cloud-managed signing through the API key) -> check the archive -> export for App Store Connect
# with destination upload (internal testing only) -> wait until the build is processed -> the group "Intern" holds
# it -> "What to Test".
#
# Environment, from the 1Password Environment: APPLE_ASC_KEY (the .p8 of a team key with the Admin role; it may
# arrive with its line breaks turned into spaces), APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, APPLE_TEAM_ID.
# From the workflow: RUNNER_TEMP, COMMIT (the commit that is built), XCODEGEN (the command), and optionally
# ITS_NON_EXEMPT_ENCRYPTION (YES or NO, default YES), TESTFLIGHT_TESTER (an address kept in the group), NOTES.
# Nothing here prints a value of the first four. The key lies in one file under RUNNER_TEMP, mode 600, removed when
# the script ends (and once more by the workflow, whatever happened).
set -euo pipefail

for name in APPLE_ASC_KEY APPLE_ASC_KEY_ID APPLE_ASC_ISSUER_ID APPLE_TEAM_ID RUNNER_TEMP COMMIT XCODEGEN; do
  [ -n "${!name:-}" ] || { echo "::error::$name is not set for this run"; exit 1; }
done

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
appstore=$repo/ios/TrommiApp/AppStore
BUNDLE_ID=com.trommi.ios
export BUNDLE_ID

# A key may arrive with its line breaks turned into spaces (the 1Password form does that when a value is edited by
# hand), so it is put back into PEM form from its base64 body before it is read.
pem() {
  body=$(printf '%s' "$1" | sed -e 's/-----[A-Z ]*-----//g' | tr -d ' \n\r\t')
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$(printf '%s' "$body" | fold -w 64)"
}

keys=$RUNNER_TEMP/asc
cleanup() { rm -rf "$keys"; }
trap cleanup EXIT
umask 077
mkdir -p "$keys"
key=$keys/AuthKey.p8
pem "$APPLE_ASC_KEY" > "$key"
chmod 600 "$key"
openssl pkey -in "$key" -noout 2>/dev/null || { echo "::error::APPLE_ASC_KEY is not readable as a private key"; exit 1; }
umask 022
# asc.py reads these three
export ASC_KEY_ID=$APPLE_ASC_KEY_ID ASC_ISSUER_ID=$APPLE_ASC_ISSUER_ID ASC_KEY_PATH=$key
asc() { python3 "$appstore/asc.py" "$@"; }
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$APPLE_ASC_KEY_ID" -authenticationKeyIssuerID "$APPLE_ASC_ISSUER_ID")

echo "== 1. Bundle ids and app record =="
asc prepare "$BUNDLE_ID"

echo "== 2. Version and build number =="
version=$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$appstore/project.yml")
[ -n "$version" ] || { echo "::error::no MARKETING_VERSION in project.yml"; exit 1; }
# One more than the highest App Store Connect has: rising whatever was shipped before, from here or from another
# machine. Not reserved: two uploads started at the same moment from two places take the same number, and App
# Store Connect refuses the second (start it again). Deliveries from this workflow run one after another.
build=$(asc next-build)
printf '%s' "$build" | grep -Eq '^[1-9][0-9]*$' || { echo "::error::no build number from App Store Connect"; exit 1; }
short=$(printf '%s' "$COMMIT" | cut -c1-7)
echo "building $BUNDLE_ID $version ($build) from $short"

echo "== 3. Project (XcodeGen) =="
xcodebuild -version
"$XCODEGEN" generate --spec "$appstore/project.yml"

echo "== 4. Archive =="
archive=$RUNNER_TEMP/Trommi.xcarchive
its=YES
[ "${ITS_NON_EXEMPT_ENCRYPTION:-YES}" = NO ] && its=NO
xcodebuild archive \
  -project "$appstore/Trommi.xcodeproj" -scheme Trommi -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  -derivedDataPath "$RUNNER_TEMP/DerivedData" \
  "${auth[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CURRENT_PROJECT_VERSION="$build" \
  INFOPLIST_KEY_ITSAppUsesNonExemptEncryption="$its"

echo "== 5. What went into the archive =="
app=$archive/Products/Applications/Trommi.app
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Info.plist"; }
echo "$(plist CFBundleIdentifier) $(plist CFBundleShortVersionString) ($(plist CFBundleVersion))"
[ "$(plist CFBundleIdentifier)" = "$BUNDLE_ID" ] && [ "$(plist CFBundleVersion)" = "$build" ] || { echo "::error::the archive is not $BUNDLE_ID build $build"; exit 1; }
for extension in TrommiShare TrommiNotify TrommiLive; do
  [ -d "$app/PlugIns/$extension.appex" ] || { echo "::error::the app extension $extension is missing"; exit 1; }
done
# (the archive is signed for development; the export signs for distribution, with the entitlements file's
# aps-environment production)
if codesign -d --entitlements :- "$app" > "$RUNNER_TEMP/entitlements.plist" 2>/dev/null; then
  echo "aps-environment of the archive: $(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$RUNNER_TEMP/entitlements.plist" 2>/dev/null || echo none)"
fi

echo "== 6. Export and upload =="
cat > "$RUNNER_TEMP/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$archive" -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" \
  -exportPath "$RUNNER_TEMP/export" \
  "${auth[@]}"
rm -f "$RUNNER_TEMP/ExportOptions.plist"

echo "== 7. App Store Connect processes the build =="
asc wait "$version" "$build" | tee "$RUNNER_TEMP/wait.txt"
build_id=$(sed -n 's/^build_id: //p' "$RUNNER_TEMP/wait.txt" | tail -n 1)
[ -n "$build_id" ] || { echo "::error::App Store Connect named no build"; exit 1; }

echo "== 8. Internal group \"Intern\" =="
asc internal "$build_id" Intern "${TESTFLIGHT_TESTER:-}"

echo "== 9. What to Test =="
# the text the app's folder carries (AppStore/WhatToTest.txt, at most 4000 characters), else the commit's subject
notes=${NOTES:-}
[ -n "$notes" ] || [ ! -s "$appstore/WhatToTest.txt" ] || notes="Build $build ($short). $(head -c 3900 "$appstore/WhatToTest.txt")"
[ -n "$notes" ] || notes="Neu in Build $build ($short): $(git -C "$repo" log -1 --format=%s "$COMMIT" | cut -c1-300)"
asc notes "$build_id" "$notes" || echo "::warning::What to Test was not set"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### iOS: TestFlight build $build"
    echo
    echo "Version $version, build $build, commit \`$COMMIT\`, in the group Intern."
  } >> "$GITHUB_STEP_SUMMARY"
fi

#!/bin/bash
# The TestFlight delivery of the iOS app on a macOS runner; deploy_ios.yml runs it under `op run`, which is where
# the App Store Connect key comes from. Steps: the bundle ids and the app record (asc.py prepare) -> the build
# number (the highest App Store Connect has, plus one) -> Trommi.xcodeproj from AppStore/project.yml (XcodeGen) ->
# archive (ios_archive.sh: signed ad hoc, nothing created on the Apple account) -> check the archive -> export for
# App Store Connect, signed with the team's cloud-managed distribution certificate through the API key, first to a
# file whose entitlements are checked, then with destination upload (internal testing only) -> wait until the build is processed -> the group "Intern" holds
# it -> "What to Test".
#
# Environment, from the 1Password Environment: APPLE_ASC_KEY (the .p8 of a team key with the Admin role; it may
# arrive with its line breaks turned into spaces), APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, APPLE_TEAM_ID.
# From the workflow: RUNNER_TEMP, COMMIT (the commit that is built), XCODEGEN (the command), and optionally
# ITS_NON_EXEMPT_ENCRYPTION (YES or NO, default YES), ITS_EXPORT_COMPLIANCE_CODE (the code of the app's export
# compliance documentation in App Store Connect; with YES the export needs it once that documentation exists; when
# empty, the code of the APPROVED documentation is read from App Store Connect, `asc.py export-code`),
# TESTFLIGHT_TESTER (an address kept in the group), NOTES.
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

its=YES
[ "${ITS_NON_EXEMPT_ENCRYPTION:-YES}" = NO ] && its=NO
code=${ITS_EXPORT_COMPLIANCE_CODE:-}
if [ -z "$code" ] && [ "$its" = YES ]; then
  # Not set by the repository variable: the code of the app's APPROVED documentation, read from App Store Connect
  # (read only; the step fails listing the declarations' states if none is approved).
  code=$(asc export-code)
fi
if [ -n "$code" ]; then
  # written into the app's Info.plist of this checkout only; App Store Connect matches it against the documentation
  [ "$its" = YES ] || { echo "::error::ITS_EXPORT_COMPLIANCE_CODE is set but ITS_NON_EXEMPT_ENCRYPTION is NO"; exit 1; }
  printf '%s' "$code" | grep -Eq '^[A-Za-z0-9-]{1,128}$' || { echo "::error::ITS_EXPORT_COMPLIANCE_CODE is not a plain code"; exit 1; }
  info=$repo/ios/TrommiApp/Info.plist
  /usr/libexec/PlistBuddy -c "Delete :ITSEncryptionExportComplianceCode" "$info" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :ITSEncryptionExportComplianceCode string $code" "$info"
  echo "export compliance code: $code"
fi

echo "== 3. Project (XcodeGen) =="
xcodebuild -version
"$XCODEGEN" generate --spec "$appstore/project.yml"

echo "== 4. Archive =="
archive=$RUNNER_TEMP/Trommi.xcarchive
# No -allowProvisioningUpdates and no key here: the archive is signed ad hoc (ios_archive.sh says why).
bash "$here/ios_archive.sh" "$archive" "$RUNNER_TEMP/DerivedData" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CURRENT_PROJECT_VERSION="$build" \
  INFOPLIST_KEY_ITSAppUsesNonExemptEncryption="$its"

echo "== 5. What went into the archive =="
app=$archive/Products/Applications/Trommi.app
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Info.plist"; }
echo "$(plist CFBundleIdentifier) $(plist CFBundleShortVersionString) ($(plist CFBundleVersion))"
[ "$(plist CFBundleIdentifier)" = "$BUNDLE_ID" ] && [ "$(plist CFBundleVersion)" = "$build" ] || { echo "::error::the archive is not $BUNDLE_ID build $build"; exit 1; }
if [ -n "$code" ]; then
  [ "$(plist ITSEncryptionExportComplianceCode)" = "$code" ] || { echo "::error::the archive does not carry the export compliance code"; exit 1; }
fi
for extension in TrommiShare TrommiNotify TrommiLive; do
  [ -d "$app/PlugIns/$extension.appex" ] || { echo "::error::the app extension $extension is missing"; exit 1; }
done
# (the archive is signed ad hoc and ios_archive.sh has checked its entitlements; the export signs for distribution)

echo "== 6. Export and upload =="
# Signing style automatic with the Admin key: Xcode signs with the team's cloud-managed Apple Distribution
# certificate (Apple keeps its private key) and makes or renews the App Store profiles of the four bundle ids.
# No certificate is created on the account. The first export writes the signed app to a file, whose entitlements
# are checked against the files (nothing goes to Apple); the second, the same signing, uploads.
export_options() {
  cat > "$RUNNER_TEMP/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF
}
export_options export
xcodebuild -exportArchive \
  -archivePath "$archive" -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" \
  -exportPath "$RUNNER_TEMP/signed" \
  "${auth[@]}"
ipa=$(ls "$RUNNER_TEMP"/signed/*.ipa)
mkdir -p "$RUNNER_TEMP/ipa"
unzip -q "$ipa" -d "$RUNNER_TEMP/ipa"
python3 "$here/ios_entitlements.py" "$appstore" "$RUNNER_TEMP/ipa/Payload/Trommi.app" --distribution
codesign -dvv "$RUNNER_TEMP/ipa/Payload/Trommi.app" 2>&1 | grep '^Authority=' | head -n 1 || true
export_options upload
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

#!/bin/bash
# The archive of the iOS app, the same on a pull request (build.yml, no secret) and in the delivery
# (ios_testflight.sh). It needs no Apple account and creates nothing on it:
#   ios_archive.sh <archive path> <derived data path> [BUILD_SETTING=value …]
#
# The archive is signed ad hoc (identity "-", manual style, no provisioning profile, no -allowProvisioningUpdates).
# Automatic signing on a fresh runner made a new Apple Development certificate in every run (its keychain is empty),
# until the team reached Apple's limit of certificates. The ad hoc signature carries each target's entitlements file,
# and the export (ios_testflight.sh) signs everything anew for distribution with the team's cloud-managed
# certificate, taking the entitlements from that signature. An archive without any signature would lose them
# (push, the App Group, the associated domains), so after the archive this script checks that the app and each of
# its three extensions carry every entry of their entitlements file, value for value.
# Expects Trommi.xcodeproj generated from AppStore/project.yml (XcodeGen).
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: ios_archive.sh <archive path> <derived data path> [BUILD_SETTING=value …]" >&2; exit 2; }
archive=$1
derived=$2
shift 2

here=$(cd "$(dirname "$0")" && pwd)
appstore=$(cd "$here/../.." && pwd)/app/ios/TrommiApp/AppStore

xcodebuild archive \
  -project "$appstore/Trommi.xcodeproj" -scheme Trommi -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  -derivedDataPath "$derived" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- AD_HOC_CODE_SIGNING_ALLOWED=YES \
  PROVISIONING_PROFILE_SPECIFIER= PROVISIONING_PROFILE= \
  "$@"

app=$archive/Products/Applications/Trommi.app
python3 "$here/ios_entitlements.py" "$appstore" "$app"

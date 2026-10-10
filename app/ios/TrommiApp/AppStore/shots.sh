#!/usr/bin/env bash
# The App Store screenshots: builds app/ios/TrommiApp for the iOS simulator on a Mac (XcodeGen's project of
# project.yml, unsigned) and photographs the built-in demo (the made-up "Fernly" room of demo/data; nothing is sent)
# on one iPhone and one iPad, light theme, clean status bar. Each picture is one state of demo/data/screens.json,
# opened with the launch hook TROMMI_SCREEN=<id>; TROMMI_STORE_SHOTS=1 leaves out the demo's marks (DemoMode.swift).
#
#   shots.sh                     build, then all shots on both devices
#   shots.sh --no-build          the shots only, from the app of the last build
#
# Before it: the Rust core for the simulator in core/swift/TrommiCoreRust (`core/swift/build.sh ios`; on Linux too,
# then copy lib/ios-simulator, Sources/TrommiCoreFFI/include and Sources/TrommiCoreRust over: all three from the same
# commit as this checkout).
#
# Environment (defaults in brackets):
#   XCODEGEN   [xcodegen]   the XcodeGen binary
#   PHONE      [iPhone 18 Pro Max]       a simulator whose screenshots are 1320x2868 (App Store 6.9")
#   IPAD       [iPad Pro 13-inch (M5)]   a simulator whose screenshots are 2064x2752 (App Store 13")
#     (of several with that name, the one of the newest iOS: the app's deployment target is iOS 27)
#   OUT        [AppStore/screenshots/en-US]   pictures land in OUT/iphone-6.9 and OUT/ipad-13
#   DERIVED    [~/Library/Caches/trommi-shots]   Xcode's build folder, kept between runs
#   WAIT       [6]   seconds between the launch and the picture
#   SHOTS_PHONE, SHOTS_IPAD   the shots, "<file name> <screen id>" per line (defaults below)
# The pictures are PNG without an alpha channel (App Store Connect refuses one), checked for that and their size.
# The simulators get English as their language (the iPad's status bar shows the date).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
xcodegen=${XCODEGEN:-xcodegen}
phone=${PHONE:-iPhone 18 Pro Max}
ipad=${IPAD:-iPad Pro 13-inch (M5)}
out=${OUT:-$here/screenshots/en-US}
derived=${DERIVED:-$HOME/Library/Caches/trommi-shots}
wait=${WAIT:-6}
bundle=com.trommi.ios
default_shots="01-desk desk
02-decision card--two-pictures
03-chat chat
04-scribble-board scribble-board
05-note desk--corner-note-open"
shots_phone=${SHOTS_PHONE:-$default_shots}
shots_ipad=${SHOTS_IPAD:-$default_shots}

if [ "${1:-}" != --no-build ]; then
  [ -f "$here/../../../../core/swift/TrommiCoreRust/lib/ios-simulator/libtrommi_core_ffi.a" ] \
    || { echo "no Rust core for the simulator: run core/swift/build.sh ios first" >&2; exit 1; }
  (cd "$here" && "$xcodegen" generate --spec project.yml --quiet)
  # TROMMI_IOS_SIMULATOR=1: the package links lib/ios-simulator (core/swift/TrommiCoreRust/Package.swift)
  TROMMI_IOS_SIMULATOR=1 xcodebuild build -project "$here/Trommi.xcodeproj" -scheme Trommi \
    -destination "generic/platform=iOS Simulator" -derivedDataPath "$derived" \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM= ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
    > "$derived.log" 2>&1 || { grep -E 'error:' "$derived.log" | sort -u | head -20 >&2; echo "build failed: $derived.log" >&2; exit 1; }
fi
app="$derived/Build/Products/Debug-iphonesimulator/Trommi.app"
[ -d "$app" ] || { echo "no app at $app: build first" >&2; exit 1; }

udid_of() {   # the available simulator of that name on the newest iOS (the list goes from old to new)
  xcrun simctl list devices available | grep -F "    $1 (" | tail -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/'
}

shoot() {   # shoot <device name> <folder> <width> <height> <shots>
  local udid; udid=$(udid_of "$1")
  [ -n "$udid" ] || { echo "no simulator \"$1\"" >&2; exit 1; }
  # English for the system's own words (the iPad's date in the status bar): set once, then a fresh start of the device
  xcrun simctl boot "$udid" 2> /dev/null || true
  xcrun simctl bootstatus "$udid" -b > /dev/null
  if [ "$(xcrun simctl spawn "$udid" defaults read -g AppleLocale 2> /dev/null)" != en_US ]; then
    xcrun simctl spawn "$udid" defaults write -g AppleLanguages -array en
    xcrun simctl spawn "$udid" defaults write -g AppleLocale -string en_US
    xcrun simctl shutdown "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b > /dev/null
  fi
  xcrun simctl ui "$udid" appearance light
  # 9:41 and no carrier name. The iPad's status bar always shows a date beside the time (iPadOS 27; no override hides
  # it), so it is a fixed one: Jan 9, Apple's (an ISO time with milliseconds sets the date too; the zone of that day
  # here). Over an app the simulator names the weekday on its own (Sun, though 9 Jan 2007 was a Tuesday). Set twice:
  # right after a fresh start the first one has not always held.
  for _ in 1 2; do
    xcrun simctl status_bar "$udid" override --time "2007-01-09T09:41:00.000$(date -j -f '%Y-%m-%d %H:%M' '2007-01-09 09:41' +%z | sed -E 's/([0-9]{2})$/:\1/')" \
      --operatorName '' --dataNetwork wifi --wifiMode active --wifiBars 3 \
      --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
    sleep 3
  done
  xcrun simctl install "$udid" "$app"
  mkdir -p "$out/$2"
  while read -r name screen; do
    [ -n "$name" ] || continue
    SIMCTL_CHILD_TROMMI_SCREEN=$screen SIMCTL_CHILD_TROMMI_THEME=light SIMCTL_CHILD_TROMMI_STORE_SHOTS=1 \
      xcrun simctl launch --terminate-running-process "$udid" "$bundle" > /dev/null
    sleep "$wait"
    xcrun simctl io "$udid" screenshot --type=png "$out/$2/$name.png" > /dev/null 2>&1
    flatten "$out/$2/$name.png"
    size=$(sips -g pixelWidth -g pixelHeight -g hasAlpha "$out/$2/$name.png" | awk '/pixel|hasAlpha/{printf "%s ", $2}')
    [ "$size" = "$3 $4 no " ] || { echo "$2/$name.png is $size, not $3 $4 without alpha" >&2; exit 1; }
    echo "$2/$name.png  $screen"
  done <<< "$5"
  xcrun simctl terminate "$udid" "$bundle" 2> /dev/null || true
  xcrun simctl status_bar "$udid" clear
}

# The PNG drawn again without its alpha channel (Core Graphics, RGB with no alpha; ImageIO writes it as RGB).
flattener="$derived/flatten.swift"
mkdir -p "$derived"
cat > "$flattener" << 'SWIFT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let src = CGImageSourceCreateWithURL(url, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
      let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { exit(1) }
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
guard let flat = ctx.makeImage(), let dst = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(dst, flat, nil)
exit(CGImageDestinationFinalize(dst) ? 0 : 1)
SWIFT
xcrun swiftc -O -sdk "$(xcrun --sdk macosx --show-sdk-path)" "$flattener" -o "$derived/flatten"
flatten() { "$derived/flatten" "$1"; }

shoot "$phone" iphone-6.9 1320 2868 "$shots_phone"
shoot "$ipad" ipad-13 2064 2752 "$shots_ipad"

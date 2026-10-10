#!/usr/bin/env bash
# The App Store screenshots as posters: each raw screenshot of AppStore/screenshots-raw/en-US (shots.sh) under a
# headline in frame.html, rendered by headless Chromium at the App Store's exact size into AppStore/screenshots/en-US,
# which store.py uploads. Runs on Linux or macOS: needs `chromium` (or CHROMIUM) and ImageMagick's `magick`.
#
#   marketing/render.sh
#
# The iPad's status bar shows a date next to the time that iPadOS cannot be told to leave out (and a weekday that
# does not match it): it is painted over in the status bar's own colour, so the time and the icons stay.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
raw=$here/../screenshots-raw/en-US
out=$here/../screenshots/en-US
browser=${CHROMIUM:-chromium}
work=$(mktemp -d "${TMPDIR:-/tmp}/trommi-poster.XXXXXX")
trap 'rm -rf "$work"' EXIT

# file name | headline | the words underlined (the end of the headline) | the line under it
shots='01-desk|Your agents ring. You decide.|decide.|Claude Code and Codex ask as cards on your phone.
02-decision|Every question as a card.|card.|Pictures, options, a page to try. One tap answers.
03-chat|One tap, they keep working.|working.|Chat with every session, wherever you are.
04-scribble-board|Draw it, send it.|send it.|Sketch on the Scribble Board, send the part that matters.
05-note|End-to-end encrypted.|encrypted.|Notes, cards and chats are sealed on your phone.'

enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }

for target in "iphone-6.9 phone 1320 2868" "ipad-13 tablet 2064 2752"; do
  read -r folder device w h <<< "$target"
  mkdir -p "$out/$folder"
  while IFS='|' read -r name head under line; do
    src=$raw/$folder/$name.png
    [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
    shot=$work/$folder-$name.png
    if [ "$device" = tablet ]; then
      # the date and the app's name after the time: x 168..560, y 0..70 of the 2064-wide picture
      fill=$(magick "$src" -format '%[pixel:p{555,4}]' info:)
      magick "$src" -fill "$fill" -draw 'rectangle 168,0 560,70' "$shot"
    else
      cp "$src" "$shot"
    fi
    url="file://$here/frame.html?device=$device&shot=$(enc "$shot")&head=$(enc "$head")&under=$(enc "$under")&line=$(enc "$line")"
    "$browser" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size="$w,$h" --virtual-time-budget=4000 --screenshot="$out/$folder/$name.png" "$url" 2>/dev/null
    # no alpha channel (App Store Connect refuses one); the exact size
    magick "$out/$folder/$name.png" -background '#f5f6f2' -alpha remove -alpha off "$out/$folder/$name.png"
    size=$(magick identify -format '%wx%h' "$out/$folder/$name.png")
    [ "$size" = "${w}x$h" ] || { echo "$folder/$name.png is $size, not ${w}x$h" >&2; exit 1; }
    echo "$folder/$name.png"
  done <<< "$shots"
done

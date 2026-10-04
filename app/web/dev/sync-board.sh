#!/usr/bin/env bash
# Copies the look and the views of today's board (trommi-hub: client/web, server/views) into the app, unchanged
# except for import paths, so the app renders the same markup with the same CSS and pen drawings.
#   dev/sync-board.sh [/path/to/trommi-hub]      default: ~/git/trommi
# What it writes (do not edit these by hand; edit the board's files and sync again):
#   public/css/*.css            the board's stylesheets
#   public/js/pen.js ui.js focus-marks.js richhtml.js      the pen drawings and the helpers the controllers import
#   public/t/controllers/*.js public/t/lib/*.js public/t/islands/*.js   the Stimulus controllers (run on public/js/app/stimulus.mjs)
#   public/js/views/*.mjs       server/views/* as browser modules (rendered in the page, see README "Render strategy")
# public/vendor/ is not touched (stream B's dev/sync-app.sh writes it).
set -euo pipefail
cd "$(dirname "$0")/.."
HUB=${1:-$HOME/git/trommi}
W=$HUB/client/web
mkdir -p public/css public/js/views public/t/controllers public/t/lib public/t/islands public/icons

cp "$W"/css/*.css public/css/
cp "$W"/js/pen.js "$W"/js/ui.js "$W"/js/focus-marks.js "$W"/js/richhtml.js public/js/
cp "$W"/drawings.json public/ 2>/dev/null || true
cp -r "$W"/icons/. public/icons/ 2>/dev/null || true
cp "$W"/t/controllers/*.js public/t/controllers/
cp "$W"/t/lib/*.js public/t/lib/
cp "$W"/t/islands/*.js public/t/islands/
# Hotwire's package names point at the app's own small stand-ins.
sed -i \
  -e "s#from '@hotwired/stimulus'#from '/js/app/stimulus.mjs'#" \
  -e "s#from '@hotwired/turbo'#from '/js/app/turbo.mjs'#" \
  public/t/controllers/*.js public/t/lib/*.js

# The views. Node-only neighbours are replaced by small browser modules of the app (public/js/app/node-stubs/).
for f in "$HUB"/server/views/*.mjs; do
  name=$(basename "$f")
  case "$name" in layout.mjs) continue ;; esac   # the app has its own layout (public/js/app/layout.mjs)
  sed \
    -e "s#'../../client/web/js/pen.js'#'../pen.js'#" \
    -e "s#'../../client/web/t/lib/keys.js'#'/t/lib/keys.js'#" \
    -e "s#'../thumbs.mjs'#'../app/node-stubs/thumbs.mjs'#" \
    -e "s#'../blocked.mjs'#'../app/node-stubs/blocked.mjs'#" \
    -e "s#'../fixtures.mjs'#'../app/node-stubs/fixtures.mjs'#" \
    -e 's#process\.env\.[A-Z_]*#undefined#g' \
    "$f" > "public/js/views/$name"
done
# blocked.mjs reads two numbers from the environment; in the browser they are the defaults.
sed -e 's#Number(process.env.BOARD_SILENT_MS || \(.*\))$#\1#' -e 's#Number(process.env.BOARD_OFFLINE_GRACE_MS || \(.*\))$#\1#' \
  "$HUB/server/blocked.mjs" > public/js/app/node-stubs/blocked.mjs
grep -q process.env public/js/app/node-stubs/blocked.mjs && { echo "blocked.mjs still reads process.env" >&2; exit 1; }
echo "synced from $HUB ($(git -C "$HUB" rev-parse --short HEAD))"

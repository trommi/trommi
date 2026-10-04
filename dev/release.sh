#!/usr/bin/env bash
# Before a push to main: writes the app shell's file list and a version (a hash of the files) into public/sw.js, so
# the service worker keeps exactly this release and drops the previous one. No build: the files stay as they are.
#   dev/release.sh
set -euo pipefail
cd "$(dirname "$0")/../public"
# Only what git tracks (what is deployed); a missing file would make the worker's install fail.
files=$(git ls-files . | grep -v -e '^mock/' -e '^sw.js$' -e '^_headers$' -e '^index.html$' -e '\.md$' | sed 's#^#/#' | LC_ALL=C sort)
version=$(for f in $files; do sha256sum ".$f"; done | sha256sum | cut -c1-12)
VERSION="$version" FILES="$files" node -e "
const fs = require('fs')
const list = ['/', ...process.env.FILES.split('\\n').filter(Boolean)]
let s = fs.readFileSync('sw.js', 'utf8')
s = s.replace(/^const VERSION = .*$/m, 'const VERSION = ' + JSON.stringify(process.env.VERSION)).replace(/^const SHELL = .*$/m, 'const SHELL = ' + JSON.stringify(list))
fs.writeFileSync('sw.js', s)"
echo "sw.js: version $version, $(echo "$files" | wc -l) files"

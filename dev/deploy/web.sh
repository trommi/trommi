#!/bin/bash
# dev/deploy/web.sh: the web app deploy from this machine, without GitHub Actions. README.md "Deploy without CI".
#
#   dev/deploy/web.sh [--dry-run] [--allow-unpushed] [--deploy]
#
# Without --deploy: the steps of .github/workflows/web-app.yml. Cloudflare Workers Builds builds every push to main by
# itself (no Actions minutes); this waits until https://app.trommi.com serves a build of the newest commit in the watch
# paths and checks that the served connector matches its checksum and the plugin it names is served.
# With --deploy: first builds HEAD here as Cloudflare would (`git archive HEAD`, WORKERS_CI=1, which runs npm ci at the
# root and writes public/) and uploads it with `wrangler deploy` (local auth: `npx wrangler login` once), then checks.
# Use it when Cloudflare's own build is down or a commit must go out without a push.
set -euo pipefail
# shellcheck source=dev/deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DEPLOY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    --deploy) DEPLOY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done
WRANGLER=(npx --yes wrangler@4)

guard_tree

# ---- optional: build and upload ----
TREE=
cleanup() { [ -n "$TREE" ] && rm -rf "$TREE"; return 0; }
trap cleanup EXIT
if [ "$DEPLOY" = 1 ]; then
  say "wrangler auth"
  if [ "$DRY" = 1 ]; then
    "${WRANGLER[@]}" whoami >/dev/null 2>&1 && say "wrangler: logged in" || printf '[dry-run] WOULD REFUSE: wrangler is not logged in (npx wrangler login)\n' >&2
    printf '[dry-run] git archive HEAD into a temp dir; WORKERS_CI=1 WORKERS_CI_COMMIT_SHA=%s node app/web/dev/build.mjs (npm ci + write)\n' "$SHA" >&2
    printf '[dry-run] (cd <tree>/app/web && %s deploy)\n' "${WRANGLER[*]}" >&2
  else
    "${WRANGLER[@]}" whoami >/dev/null 2>&1 || die "wrangler is not logged in: npx wrangler login"
    TREE=$(build_tree)
    say "build (as Cloudflare: npm ci, dev/build.mjs --write) in $TREE"
    (cd "$TREE/app/web" && WORKERS_CI=1 WORKERS_CI_COMMIT_SHA="$SHA" node dev/build.mjs)
    say "wrangler deploy"
    (cd "$TREE/app/web" && "${WRANGLER[@]}" deploy)
  fi
fi

# ---- wait for the build of the newest commit in Cloudflare's watch paths (web-app.yml, step 1) ----
paths=(app/web shared connector package.json package-lock.json)
full=$(git -C "$REPO" log -1 --format=%H "$SHA" -- "${paths[@]}")
want=${full:0:7}
current() {
  local served
  echo "$1" | grep -Eq '^[0-9a-f]{7,40}$' || return 1
  served=$(git -C "$REPO" rev-parse --verify --quiet "$1^{commit}") || return 1
  git -C "$REPO" merge-base --is-ancestor "$full" "$served" || return 1
  git -C "$REPO" merge-base --is-ancestor "$served" "$SHA" || return 1
  [ -z "$(git -C "$REPO" log -1 --format=%H "$full..$served" -- "${paths[@]}")" ]
}
say "newest commit in Cloudflare's watch paths: $want (HEAD ${SHA:0:7})"
tries=60
[ "$DRY" = 1 ] && tries=1
for i in $(seq 1 "$tries"); do
  got=$(curl -fsS --max-time 10 "https://app.trommi.com/gen/build.txt?ci=$i" | sed -n 's/^commit: //p' || true)
  sw=$(curl -fsS --max-time 10 "https://app.trommi.com/sw.js?ci=$i" | sed -n 's/^const VERSION = "\([^"]*\)".*/\1/p' || true)
  echo "attempt $i: build.txt commit ${got:-none}, sw.js version ${sw:-none}"
  if current "$got"; then
    [ -n "$sw" ] && [ "$sw" != "dev" ] && break
    refuse "app.trommi.com serves $got with an unbuilt sw.js (VERSION dev)"; break
  fi
  if [ "$i" = "$tries" ]; then
    refuse "app.trommi.com did not serve $want; it serves ${got:-nothing} (check the Cloudflare build of trommi-app)"
    break
  fi
  sleep 10
done

# ---- the connector is served and matches its checksum (web-app.yml, step 2) ----
DL=$(mktemp -d "${TMPDIR:-/tmp}/trommi-web.XXXXXX")
trap 'cleanup; rm -rf "$DL"' EXIT
why=
check() {
  local q="ci=local-$$-$1" want got zip
  curl -fsS --max-time 30 -o "$DL/connector.mjs" "https://app.trommi.com/connector.mjs?$q" || { why="app.trommi.com/connector.mjs is not served"; return 1; }
  want=$(curl -fsS --max-time 10 "https://app.trommi.com/connector.mjs.sha256?$q" | cut -d ' ' -f 1 | tr -d '\r\n')
  got=$(sha256sum "$DL/connector.mjs" | cut -d ' ' -f 1)
  echo "connector.mjs sha256 $got, connector.mjs.sha256 says $want"
  [ -n "$want" ] && [ "$got" = "$want" ] || { why="app.trommi.com/connector.mjs does not match connector.mjs.sha256"; return 1; }
  zip=$(curl -fsS --max-time 10 "https://app.trommi.com/plugins/marketplace.json?$q" | node -e 'let s = ""; process.stdin.on("data", d => { s += d }).on("end", () => console.log(JSON.parse(s).plugins[0].source.url))')
  echo "plugin archive $zip"
  case "$zip" in *"/trommi-${got:0:12}.zip") ;; *) why="the marketplace does not name the plugin of this connector"; return 1 ;; esac
  curl -fsS --max-time 30 -o /dev/null "$zip" || { why="the plugin archive $zip is not served"; return 1; }
}
tries=12
[ "$DRY" = 1 ] && tries=1
ok=0
for try in $(seq 1 "$tries"); do
  if check "$try"; then ok=1; break; fi
  echo "try $try of $tries: $why"
  [ "$try" -lt "$tries" ] && sleep 10
done
[ "$ok" = 1 ] || refuse "$why"
say "done: app.trommi.com serves a build of $want with a matching connector"

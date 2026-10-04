#!/usr/bin/env bash
# Remove the legacy board (old server, SPA, Turbo views, old clients, their tools and docs)
# once the new app is in use. The list and the reasons: docs/cleanup-plan.md.
#   dev/cleanup.sh            dry run (default): what would go, sizes, blockers; changes nothing
#   dev/cleanup.sh --apply    back up, remove the DELETE paths in one commit, run the new test suites;
#                             if a suite fails the removal is undone and nothing is committed.
# Never pushes. After --apply: look at `git show --stat`, then push yourself.
# Backups go to $BACKUP_DIR (default ~/Nextcloud/Christopher/Backups):
#   trommi-hub-legacy-<date>.bundle   the full history (git bundle --all), verified
#   trommi-hub-legacy-<date>.tgz      the current files of the removed paths
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  ''|--dry-run) ;;
  *) echo "usage: dev/cleanup.sh [--apply]" >&2; exit 2 ;;
esac

# "delete" in docs/cleanup-plan.md. To delete a "decide" item, move its line up here.
DELETE=(
  server                                  # old board: hub + Turbo views + MCP channel in one process
  client/web                              # old SPA, Turbo client, pad page, designs/ (109 MB of pictures)
  client/linux                            # Qt client of the old plaintext API
  demo                                    # screenshots, audit pictures, test-card images of the old board
  docs/qa-shots                           # screenshots of old-board QA rounds
  deploy                                  # old Dockerfile/compose/systemd/Caddy/backup of the old hub
  dev/demo-state.mjs dev/drawings-json.mjs dev/fake-agent.mjs dev/fixtures.mjs dev/icons.mjs
  dev/keys-test.mjs dev/pen-sync.mjs dev/richhtml-test.mjs dev/say-test.mjs
  dev/turbo-keys-test.mjs dev/turbo-measure.mjs dev/turbo-ui-test.mjs dev/ui-test.mjs
  dev/join.sh dev/serve.sh dev/sessions.sh dev/shot.sh dev/trio.sh dev/wait-answer.sh
  docs/architecture.md docs/architecture-target.md docs/asset-sharing.md
  docs/bugs-wide.md docs/handover.md docs/operations.md docs/pad.md docs/perf-baseline.md
  docs/qa-dark-phone.md docs/qa-phone-design.md docs/qa-report.md docs/screens.md docs/storage.md
  docs/turbo.md
)
# "decide" in docs/cleanup-plan.md: never touched by this script, only listed.
DECIDE=(
  client/ios .github/workflows/ios.yml .github/workflows/ios-testflight.yml
  assets dev/session.mjs dev/interface-doc.mjs docs/interface.md docs/question-contract.md
  docs/push.md docs/tech-stack.md docs/naming.md docs/marketing.md
  docs/open-from-chat.md docs/open-today.md docs/open-work.md TODO.md
)
# The new system's suites. All must pass after the removal.
TESTS=(
  "node crypto/test.mjs --no-bench"
  "node crypto/hub-test.mjs"
  "node hub/test.mjs"
  "node client/core/test.mjs"
  "node hub/channel-test.mjs"
)

say() { printf '%s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# Only paths git still tracks (some may already be gone).
present=()
for p in "${DELETE[@]}"; do
  [[ -n "$(git ls-files -- "$p" | head -1)" ]] && present+=("$p") || say "  (already gone: $p)"
done
[[ ${#present[@]} -gt 0 ]] || { say "Nothing left to delete."; exit 0; }

say "== Would delete (tracked files only; untracked/ignored files stay):"
total_k=0; total_n=0
for p in "${present[@]}"; do
  n=$(git ls-files -- "$p" | wc -l)
  k=$(git ls-files -z -- "$p" | du -ck --files0-from=- 2>/dev/null | tail -1 | cut -f1)
  total_k=$((total_k + k)); total_n=$((total_n + n))
  printf '  %8s KiB %5s files  %s\n' "$k" "$n" "$p"
done
printf '  %8s KiB %5s files  TOTAL\n' "$total_k" "$total_n"

say "== Left alone (decide):"
for p in "${DECIDE[@]}"; do [[ -e "$p" ]] && say "  $p"; done
say "  data/ (not in git; the old board's state: archive it yourself once the board is stopped)"

# Blockers: kept code that still names a path about to go.
say "== References from kept code to deleted paths:"
# A directory counts as named when "<dir>/" appears, a file by its full path; comment lines are only mentions.
regex=$(printf '%s\n' "${present[@]}" | sed 's/[.]/\\./g' | paste -sd'|')
named=$(for p in "${present[@]}"; do [[ -d "$p" ]] && printf '%s/\n' "$p" || printf '%s\n' "$p"; done | sed 's/[.]/\\./g' | paste -sd'|')
named="(^|[^[:alnum:]_./-]|\.\./|\./)($named)"
mapfile -t kept < <(git ls-files -- '*.mjs' '*.js' '*.sh' '*.yml' '*.yaml' '*.json' '*.html' '*Dockerfile*' '.dockerignore' \
  | grep -vE "^($regex)(/|$)" | grep -vx 'dev/cleanup.sh')
blockers=$( ((${#kept[@]})) && grep -nE "$named" -- "${kept[@]}" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#|\*)' || true)
if [[ -n "$blockers" ]]; then say "$blockers" | cut -c1-200 | sed 's/^/  /'; else say "  none"; fi
docrefs=$(git ls-files -- '*.md' | grep -vE "^($regex)(/|$)" | xargs -r grep -lE "$named" || true)
if [[ -n "$docrefs" ]]; then say "== Kept docs that still mention them (fix the text; not a blocker):"; say "$docrefs" | sed 's/^/  /'; fi

if pgrep -f 'server/server\.mjs' >/dev/null; then
  board_running=1; say "== The old board (server/server.mjs) is still running: pids $(pgrep -f 'server/server\.mjs' | paste -sd' ')"
else board_running=0; fi

say "== .git now: $(git count-objects -vH | sed -n 's/^size-pack: //p') packed (history keeps everything until rewritten; see the plan)"

if [[ $APPLY -eq 0 ]]; then
  say ""; say "Dry run: nothing changed. Run with --apply to back up, remove and test."
  exit 0
fi

# ---- apply ----
[[ "$(git branch --show-current)" == main ]] || die "not on main"
git diff --quiet && git diff --cached --quiet || die "uncommitted changes to tracked files; commit or stash first"
[[ $board_running -eq 0 ]] || die "stop the old board first (it serves from these files)"
[[ -z "$blockers" ]] || die "kept code still references deleted paths (listed above); fix those first"

BACKUP_DIR=${BACKUP_DIR:-$HOME/Nextcloud/Christopher/Backups}
name="trommi-hub-legacy-$(date +%F)"
bundle="$BACKUP_DIR/$name.bundle"; tgz="$BACKUP_DIR/$name.tgz"
mkdir -p "$BACKUP_DIR"
[[ -e "$bundle" || -e "$tgz" ]] && die "$bundle or $tgz exists already; move it away first"

say "== Backup"
git bundle create "$bundle" --all
git bundle verify "$bundle" >/dev/null || die "bundle does not verify: $bundle"
git archive --format=tar.gz -o "$tgz" HEAD -- "${present[@]}"
tar tzf "$tgz" >/dev/null || die "archive unreadable: $tgz"
ls -lh "$bundle" "$tgz" | sed 's/^/  /'
(cd "$BACKUP_DIR" && sha256sum "$name.bundle" "$name.tgz" > "$name.sha256")

start=$(git rev-parse HEAD)
undo() { say "== Undoing the removal (back to $start)"; git reset -q --hard "$start"; }

say "== Removing"
git rm -r -q -- "${present[@]}"

say "== Tests"; log=$(mktemp -t cleanup-test.XXXXXX)
for t in "${TESTS[@]}"; do
  f=$(awk '{print $2}' <<<"$t")
  [[ -f "$f" ]] || { undo; die "test file missing: $f"; }
  say "  \$ $t"
  if ! $t >"$log" 2>&1; then tail -30 "$log"; undo; die "red: $t (log: $log)"; fi
done

git commit -q -F - <<EOF
Remove the legacy board: old server, SPA/Turbo client, old clients, their tools and docs

The new system (hub/, crypto/, client/core/, the app at app.trommi.com, the agent
channel hub/channel.mjs) no longer imports any of it. Removed: ${present[*]}

Backup of the full history and of the removed files:
  $bundle
  $tgz
List and reasons: docs/cleanup-plan.md.

EOF
say "== Committed $(git rev-parse --short HEAD). Not pushed. Check: git show --stat; then git push."

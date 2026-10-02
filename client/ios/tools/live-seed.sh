#!/usr/bin/env bash
# Puts the cards on a demo board that only an agent can make, so the live tests can meet
# them: a question handed in as sections, one that was revised, and one that replaces two.
#   dev/serve.sh 8851 120 &          (from the repository root)
#   client/ios/tools/live-seed.sh 8851
# It links a session "iOS fixture" for a moment (dev/session.mjs), calls the board's tools
# as that session, and lets go. Only for a board started by dev/serve.sh: it writes to it.
set -euo pipefail
port=${1:?port}
root=$(cd "$(dirname "$0")/../../.." && pwd)
export BOARD_PORT=$port BOARD_TOKEN=${BOARD_TOKEN:-demo} BOARD_DATA=${TMPDIR:-/tmp}/board-dev-$port
cd "$root"

for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/healthz" && break; sleep 0.5; done
node dev/session.mjs link "iOS fixture" &
link=$!
trap 'kill $link 2>/dev/null || true' EXIT
call() { node dev/session.mjs call ios-fixture "$@"; }
for i in $(seq 1 30); do call list_cards >/dev/null 2>&1 && break; sleep 0.3; done
id_of() { sed -n 's/^card \([0-9a-f]*\) .*/\1/p'; }

# 1. One structured text: paragraphs tied to options, several may be ticked.
call create_decision '{"title":"iOS fixture: sectioned","multiple":true,"text":"Three parts, each stands on its own. Tick what I may build.\n\n[limit*] Raise the limit: 60 instead of 30 seconds.\n\n[async] Export in the background: The file arrives by mail.\n\n[page] Paginate the export"}' >/dev/null

# 2. A question that was reworded after it was asked.
revised=$(call create_decision '{"title":"iOS fixture: revised","body":"First wording.","options":[{"key":"a","label":"Anton"},{"key":"b","label":"Berta"}]}' | id_of)
call revise_card "{\"card_id\":\"$revised\",\"body\":\"Second wording.\",\"note\":\"Said it more clearly\"}" >/dev/null

# 3. One question that replaces two.
one=$(call create_decision '{"title":"iOS fixture: part one","options":[{"key":"yes","label":"Yes"},{"key":"no","label":"No"}]}' | id_of)
two=$(call create_decision '{"title":"iOS fixture: part two","options":[{"key":"yes","label":"Yes"},{"key":"no","label":"No"}]}' | id_of)
call merge_cards "{\"card_ids\":[\"$one\",\"$two\"],\"title\":\"iOS fixture: merged\",\"multiple\":true,\"options\":[{\"key\":\"one\",\"label\":\"Part one\"},{\"key\":\"two\",\"label\":\"Part two\"}]}" >/dev/null

# 4. A plain two-way question the tests may answer, take back and write notes on.
call create_decision '{"title":"iOS fixture: plain","body":"For the tests.","options":[{"key":"a","label":"Anton"},{"key":"b","label":"Berta"},{"key":"c","label":"Cesar"}]}' >/dev/null
echo "seeded the board on port $port"

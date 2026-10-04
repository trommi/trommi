# Parity: today's Turbo board → the new app (app.trommi.com)

Kept by the verifier ("Superkind", night of 4 October 2026). The goal: the new app reaches the same level as the
server-rendered Turbo board in every function, every decision round trip between agent and human, the look and
Christopher's design decisions, and is faster, end to end encrypted through the thin hub.

**Status (second pass, 4 Oct ~03:40; app main incl. 6213254, hub main incl. 6774b2d):** checklist
**121 ok · 9 gap · 221 todo** of 351 rows. Screenshots: 42 states × 4 profiles on Turbo, on the app's mock room
and on a **real E2E room** (`dev/verify/app-room.mjs`: the app founds the room, three `hub/channel.mjs` sessions file
the same fixture cards). Decision round trips through the real channel: **46 of 47 checks green locally, 45 of 46
on the live system** (app.trommi.com + hub.trommi.com); the one red is the outside share link of `publish_asset`
(designed, open). Short keys: 21 of 26 checked keys behave as on Turbo (`dev/verify/keys.mjs`).

## How it is checked (dev/verify/)

| script | what |
|---|---|
| `dev/verify/turbo-board.mjs` | a throwaway Turbo board (own port 8910-8919, own data folder, never 8790): 3 demo agents, all fixture cards, an approval from session "Courier" |
| `dev/verify/shoot.mjs --target turbo\|app` | brings a target into every named state (`dev/verify/states.mjs`) and shoots it at 1440x900 light/dark and 390x844 light/dark; `targets/turbo.mjs`, `targets/app.mjs` (the app reuses the Turbo recipes: same addresses, same markup) |
| `dev/verify/sbs.mjs` | one image per state and profile: Turbo left, new app right |
| `dev/verify/perf.mjs --target …` | cold load, warm load, navigation Desk→session→card→back, live update latency; desktop, desktop 4x CPU, phone 4x CPU |
| `dev/verify/app-room.mjs` | a real E2E room for shooting: hub + app (kept Chromium profile) + three channel sessions filing the fixtures; then `VERIFY_APP_MODE=room shoot.mjs --target app` |
| `dev/verify/keys.mjs --target …` | the short keys, same expectation on both targets |
| `dev/verify/rounds.mjs` | every decision round trip: `hub/channel.mjs` (MCP stdio, as Claude Code starts it) ↔ the app's UI in Chromium, over a real hub (`hub/server.mjs`, port 8891-8899); human acts only through clicks and forms |

```bash
node dev/verify/turbo-board.mjs --port 8910 --data $V/turbo-data &        # writes $V/turbo-board.json
node dev/verify/shoot.mjs --target turbo --start --out $V/shots --verify-dir $V
node dev/verify/shoot.mjs --target app --base http://127.0.0.1:8900 --out $V/shots --verify-dir $V
node dev/verify/sbs.mjs --left $V/shots/turbo --right $V/shots/app --out $V/sbs
node dev/verify/perf.mjs --target turbo --out $V/perf-turbo.json --verify-dir $V
node dev/verify/rounds.mjs --app http://127.0.0.1:8900 --out $V/rounds
```

Evidence keys in the table below: **S:<state>** = `shots/{turbo,app}/<profile>/<state>.png` and `sbs/<profile>/<state>.png`
of the run (scratchpad `verify/`), a selection in `docs/parity-shots/`; **R rNN** = round `rNN_*` of `dev/verify/rounds.mjs`
(`rounds.json`). Caveat for desk and session states: the mock room's sessions (trommi, crypto, trommi-ui) differ from
the Turbo test board's (Web-Frontend, API, Infrastruktur, Courier); the fixture cards of desk "Test" are the same.

## Gaps, priority order (sent to the area owners)

Open after the second pass:

| # | prio | gap | evidence | owner |
|---|---|---|---|---|
| 1 | P1 | Marks on pictures are not drawn in a real room (mock fine): the model carries `{x, y, width, height}`, the board's marks code reads `{x, y, w, h}` | S:card-marks real room (`shots-room`) | Card / Integrator (board-state) |
| 2 | P2 | Session names from the channel read "desktop · /full/path/to/folder"; Turbo shows the folder name ("trommi"); sidebar and headings become unreadable | S:desk, session real room | Channel (D) |
| 3 | P2 | Cards inline in a conversation have corner ticks only, no border; the session drawing overlaps the name in the header; status pill cut to "Stopped: …" | S:session-thread, session real room vs `parity-shots/` | Session |
| 4 | P2 | `publish_asset`: no link for people outside the room (Turbo: `<base>/a/<id>#<key>`, `share_asset`) | R r15 | Channel (D) + hub (designed, open) |
| 5 | P2 | Key `n` opens the memo chooser when notes are put away instead of a new note (Turbo has the same code path; fix sent to C) | keys.mjs | Integrator (C) |
| 6 | P3 | `g f` goes to `/q/<n>` instead of `/walk`; Help lacks "FOR AGENTS"; German "Geräte" entry and update banner in the English UI; phone session strip 7 px taller; agents row buttons shifted | S:*, keys.mjs | Integrator |
| 7 | ? | Asset cards in the conversation and the files drawer: raw text / "0 files" in the mock (1st pass); not re-checked with a real published asset | S:session-thread, session-files (mock) | Session |
| 8 | ? | Pointto arrow after answering: missing in the 1st pass, Desk reports fixed (c5bd7a3), not re-verified | S:toast-after-answer | Desk |

Fixed between the passes and verified: pad layer on the closed Desk and its dark canvas, pad toolbar and pad mode,
help page, menu push row and "Geräte" icon, "→ choice" in the answer toast, attachment titles as captions, gutter
drawings on the Desk, `set_status` with a fresh `card_id` (channel), `publish_asset` announced in the conversation.

Not gaps (my harness): memos stacking and "stays on the card page after answering" in the first real-room run came
from states that change the room being shot one after another in the same room; re-checked in the mock (lands on the
Desk with the toast, 4 of 4).

Same as Turbo (no gap): every card face in all 4 profiles (pictures with arrow, recommended, multiple, sections,
urgency, revised, snoozed, answered, info, code, thread, hand back, artifact, files, approval, More menu), keys sheet,
jump, rail, agents, picture page, session conversation, status lines, composer, pad open.

## Decision round trips agent ↔ human (real channel, real hub, app UI)

Times: local dev hub (desktop) / **live** (app.trommi.com + hub.trommi.com, 4 Oct ~03:20).

| round | result | times local / live |
|---|---|---|
| found room in the app → agent invite → `hub/channel.mjs` joins | ok | channel start → in the room 963 ms |
| create_decision (recommended) → answer → `decision` → close_card summary on the card | ok | tool → app 66 / 48 ms; click → event 30 / 104 ms |
| answer → toast Undo → `decision_reopened previous_choice`; answered card "decide again" button | ok | 27 / 103 ms |
| multiple choice → `choices=perf,plan` | ok | 28 / 103 ms |
| sections → `choices=sync,offline` | ok | 28 / 102 ms |
| pictures (decrypted) + marks drawn | ok locally; **marks gap in a real room** (#1) | picture decrypted when the card page stands |
| hand back (Revise) → `chat handback=1` → revise_card → presented again, new wording | ok | 27 / 52 ms; revise → v2 in app 64 / 66 ms |
| What?? → `chat explain=1` → reply present → explanation on card, back on Desk | ok | 27 / 53 ms; reply → on card 380 / 372 ms |
| I don't give a duck → `decision trust=1` | ok | 27 / 103 ms |
| Shred → `shredded`; Snooze → leaves Desk, no event (as Turbo) | ok | 27 / 102 ms |
| info → Read → `info_read` | ok | 28 / 103 ms |
| permission_request → Allow / Deny → `notifications/claude/channel/permission` | ok | request → app 63 / 64 ms; click → Claude Code 27-29 / 103-104 ms |
| set_urgency → knock; withdraw_card → row gone; merge_cards → merged card | ok | 64 / 66 ms; 249 / 248 ms |
| set_status (working + decision with card_id) | ok (fixed between passes) | status → session page 448 ms live |
| composer chat → `chat`; human file → decrypted file at the agent; agent reply visible | ok | 31 / 62 ms; reply → visible 65 / 67 ms |
| publish_asset → announcement + outside link | announced: ok; outside link: **gap** (#4) | |

| second device: human invite → 6-digit check code typed on the laptop → phone in the room → agent card on the phone → answer on the phone → agent, laptop row leaves | ok | join 3.2 / 4.4 s; card → phone 25 / 69 ms; phone answer → agent 29 / 103 ms; → laptop row gone 336 / 416 ms |

Not yet run end to end: memo → crowned session (the Memo area reports its own E2E test green: two browsers + agent,
note 10-22 ms after click, scratchpad/ui-memo/memo-e2e.mjs), pad send-selection, copy card into chat, drafts sync
between two devices, desks / crown / archive, push notifications, video/audio.

## Performance: Turbo vs new app

Median of 3 runs, headless Chromium, everything on this PC (no network emulation). Turbo: test board with 20 open
cards on the main desk. App: mock room on the dev server (`?mock=1`, 7 open on the main desk; "room" = the real E2E room of `app-room.mjs`, 18 cards, the same dev server, device already in the room) and the same on
https://app.trommi.com (Cloudflare, real network). "ready" = first Desk row in the DOM (in-page clock); nav = click
until the target stands (no reload); live = agent tool call until visible.

| | Turbo desktop | app desktop | Turbo 4x CPU | app 4x CPU | Turbo phone 4x | app phone 4x |
|---|---|---|---|---|---|---|
| cold load: Desk ready (ms) | **58** | 200 (room: 142) | **80** | 315 (room: 307) | **128** | 294 (room: 306) |
| cold: first paint (ms) | 64 | 308 | 188 | 576 | 128 | 504 |
| cold: requests / kB | 73 / 476 | 109 / 1926 | 73 / 477 | 110 / 1934 | 69 / 461 | 106 / 1448 |
| cold: longest task (ms) | 0 | 88 | 84 | **237** | 0 | 155 |
| warm load: Desk ready (ms) | **34** | 129 (room: 94) | **57** | 229 (room: 208) | **83** | 276 (room: 209) |
| warm: kB transferred | 34 | 1925 (dev server no-cache) | 34 | 1932 | 35 | 1447 |
| nav Desk → session (ms) | 192 | **149** (room: 113) | 391 | **347** (room: 183) | 281 | 287 (room: 184) |
| nav session → card (ms) | 132 | **81** (room: 99) | 205 | **140** (room: 152) | 251 | **178** (room: 190) |
| nav card → back (ms) | 133 | **101** (room: 98) | 214 | **190** (room: 159) | 244 | **193** (room: 168) |
| live: agent call → visible (ms) | 17-18 | 62-76 local, 44-64 live (E2E: seal, hub, verify, decrypt) | 27-39 | | 30-35 | |
| live: human click → agent event (ms) | (n/a) | 27-31 local, ~103 live | | | | |

app.trommi.com (production, mock room, real network): desktop cold 371 ms ready / 480 ms first paint, warm **110 ms
from the service worker** (5 kB); phone 4x cold 470 / warm 221 ms, longest task 209 ms.

Reading: the app navigates faster than Turbo (no server round trip), and its live path stays well under 100 ms with
full encryption. It loads slower: ~110 requests and 1.1-1.9 MB of modules on a cold load, ~100-200 ms of script
before the first row, and one task over the 200 ms budget at 4x CPU. Warm loads are fast only from the service worker
(on the dev server every module is fetched again). Not yet measured: the app on a big real room (Stream F's 100k
load test and the crazy room), real phone, Safari.

## The checklist (from the code of the Turbo board)

Source of truth: the server-rendered board as of commit 39160d0 (`server/turbo.mjs`, `server/views/*.mjs`,
`client/web/t/**` Stimulus controllers and libs, the few old modules it still imports: `client/web/js/pen.js`,
`js/focus-marks.js`, `js/richhtml.js`, `js/ui.js` adviceLoop, `js/push.js`), the hub (`server/server.mjs`), and the
pad (`client/web/pad/`). Line numbers are of that commit. `status`: ok (checked, same), gap (checked, differs or missing), todo (not checked yet).

Conventions used below
- **R** = the rendered page as the hub serves it (Turbo); routes without a prefix (`BOARD_TURBO_BASE` empty).
- **agent call** = an MCP tool call by a linked session (`/agent/tool`, or `dev/verify/turbo-board.mjs` `linkSession().tool()`).
- **event** = what the linked session receives on its `/agent/link` stream (`notifications/claude/channel` with
  `meta.kind`, unless another method is named).
- Fixture card numbers: `POST /dev/fixtures` with `Accept: application/json` returns `cards: [numbers]` in the order
  of `server/fixtures.mjs` FIXTURES minus `chat`: pictures, yesno, long, multiple, sections, urgent, high, revised,
  marks, snoozed, answered, info, code, thread, handback, artifact, files (17). They live on desk "Test"
  (sessions `test-alpha`, `test-beta`).
- Desk in view is a per-browser cookie `trommi_desk`, set by `GET /?desk=<id>` which **303s to `/` and drops every
  other query parameter** (`server/turbo.mjs:214-218`).

## Findings while reading (for the verifier, not rows)

1. `dev/verify/targets/turbo.mjs` states `desk-pile-later` / `desk-pile-done` load `/?desk=main&pile=…`: the desk
   redirect drops `pile`, so the pile never opens; and the snoozed/answered fixtures are on desk "Test", not "main".
   Correct recipe: `GET /?desk=<testDesk>` first (cookie), then `GET /?pile=later`.
2. A brand-new desk is not empty while any knock (high/critical/permission) is open anywhere: knocks of other desks
   show on every desk (`server/views/model.mjs:30`). The Courier permission and the urgent/high fixtures are knocks.
3. Keys: the marked Desk row shows caps `Y`/`N` on its tiles (`keys_controller.js:60`), but the table has no `y`/`n`
   answer keys (`n` is "new memo"). The memo button's tooltip says "( / )" (`memo.mjs:73`) but the key is `n`.
4. `set_status` doc says "decision = red, working = yellow"; Turbo draws decision with the knock drawing and working
   with a ring (`views/session.mjs:244`), status lines only on the session page.
5. Queue order is fixed oldest-first (`server.mjs:265-276`); the permission_request doc ("always on top") and the
   crown tooltip ("its questions come first", `views/agents.mjs:119`) no longer describe what happens.
6. Copy a card (clip) writes text to the clipboard and `sessionStorage['trommi-cardclip']`; the Turbo composer does
   not read it, so `meta.cards` / `cards_json` are only produced by the old client's `/message` (`server.mjs:3180`).
7. `/pad`, `/s/<a>+<b>` (sessions laid together), `/s/<id>/scribble` are not Turbo routes: they fall to the old client
   (`/old/#…`, `server.mjs:3123`, `3417-3420`). Jump's "Scratchpad" result links there.

## Named UI states for screenshots

Suffix rule: every state also exists as `<slug>-phone` (viewport 390x844, touch) and `<slug>-dark`
(`localStorage['agent-board-theme']='dark'` before load, see `layout.mjs:30`). Listed explicitly where the phone or
dark variant looks different on purpose.

| slug | URL path (Turbo) | must be on screen | how to get there | wait for |
|---|---|---|---|---|
| desk | `/?desk=main` → `/` | sidebar with sessions, Desk pill with count, "Next N →", rows grouped by sender, tiles, stamped stack tabs | load | `#desk-list .inbox-row` |
| desk-test | `/?desk=<testDesk>` → `/` | fixture rows of Test Alpha/Beta (thumbs, Choose, info, knocks) | testDesk id from the menu's `.menu-desk[data-desk]` or fixtures JSON `desk` | `#desk-list .inbox-row` |
| desk-empty | `/` on a board with no open card | "Desk is clear." + drawing + "As soon as an agent has a question…" | board without fixtures/agents, or answer every open card | `#desk-head h2`, `.inbox-empty` |
| desk-clear-below | `/` with only snoozed/with-agent cards | "Desk is clear." + "N working · N snoozed" | snooze the last open card | `#desk-head p` |
| desk-pile-later | `/?desk=<testDesk>` then `/?pile=later` | Snooze tab open, line "Until <day hh:mm>", Wake up | two loads (finding 1) | `[data-pile="later"].is-open .inbox-pile-sheets` |
| desk-pile-works | `/?pile=works` | Working tab open (gear), handback fixture "In revision" line with Take back | testDesk cookie | `[data-pile="works"].is-open` |
| desk-pile-done | `/?pile=done` | Done list: "Ja · not closed by the agent"/"· done by the agent", Take back | testDesk cookie | `[data-pile="done"].is-open` |
| desk-pile-trash | `/?pile=trash` | basket tab, Shredded / Withdrawn lines | shred a card first | `[data-pile="trash"].is-open` |
| desk-stack-search | `/stacks/done?q=Changelog` | Done open, search field filled, one matching line | load | `#stack-list-done .inbox-done` |
| desk-scrolled-stacks | `/` scrolled to bottom | four stamped tabs in one line under the rows | `scrollTo(0, 1e6)` on `#inbox` | `#desk-stacks` in view |
| desk-row-marked | `/` | first row with `.is-current` outline, caps on its tiles | key `j` | `#desk-list .inbox-row.is-current` |
| desk-news | `/` scrolled up, card arrives below | "1 new ↓" button | agent `create_decision` while scrolled | `.inbox-news:not([hidden])` |
| desk-knock-edge | `/` with a knock out of sight | "↓ ⟨knock⟩ 1 knock" strip | scroll so a `[data-knock]` row is beyond the edge | `.inbox-edge-knock:not([hidden])` |
| desk-pointto | `/` wide, mouse over a row | pen arrow from the sidebar row to the card | hover `#desk-list .inbox-row[data-from]` | `svg.pointto-layer path` |
| menu | `/` | Trommi pill menu open: jump field, sun/moon, desks with "N open" + D1…, Agents/Help/Keys, push bell, Dev folded | click `#brand-menu` | `#brand-doors:not([hidden])` |
| menu-dev | `/` | menu with Dev unfolded: fake decisions, Create/Remove test cards, All screens, Old board, Admin | menu, click `#dev-open` | `#menu-dev[open]` |
| menu-new-desk | `/` | "+" line "Name of the new desk" with cursor | menu, click `#desk-add` | `#desk-new:not([hidden])` |
| jump | `/` | results frame for "Migration" (card titles, Nr.) | Ctrl+K, type `Migration` | `#jump-results a[role=option]` |
| keys-sheet | `/` | dialog "Keys" with the six short rows, Close Esc | key `?` | `#keys-sheet[open]` |
| keys-pending-g | `/` | chip "G" with what may follow (D Desk, A Agents, J jump, F Next, 1…9) | key `g` (1.6 s window) | `.keys-pending` |
| pad | `/` | paper in front, pen in hand, pen switch pressed | key `p` | `#deskpad-pen[aria-pressed="true"]` |
| pad-cards-hidden | `/` | cards wiped off, only paper, clear switch pressed (knock count on it) | key `w` | `#inbox[data-cards-hidden]` |
| memo-new | `/` | yellow note floating, keyboard in it, crown send button | click `#memo-open` (or key `n`) | `#memos .memo .memo-field:focus` |
| memo-list | `/` | round button with count, list "New memo" + put-away notes | write a note, Escape, click `#memo-open` | `#memo-away:not([hidden])` |
| rail | `/` (wide) | sidebar folded to drawings + badges, `|<` pressed | key `[` | `html[data-rail="folded"]` |
| sidebar-subs-open | `/` | crowned main unfolded, subs under it with pen bracket | link a sub (`introduce {parent}`), click `.crown-fold` | `.agent-row[data-fold="open"]` |
| row-sheet-phone | `/` at 390x844 | bottom sheet: title, Snooze/Revise/duck/What??/Shred, Open | long press 450 ms on a row's text | `#row-sheet[open]` |
| session | `/s/web-frontend` | heading (drawing, name), quiet line, conversation with asked rows, status lines, composer, filter icon | load | `#session .log`, `#session-status-web-frontend` |
| session-empty | `/s/<new session>` | "What should the agent start with?" + 3 starters | link a session that has said nothing | `.empty-chat` |
| session-permission | `/s/courier` | approval asked inline as Desk row (Allow/Deny), status line "Prüfung" | load | `#session .ask-card` |
| session-questions | `/s/test-alpha?only=questions` | "N questions wait for you", rows, "Earlier questions" | load | `#session-questions-test-alpha` |
| session-files | `/s/test-beta/files` | files drawer open with groups, Jump to | load | `.files-drawer:not([hidden]) .files-group` |
| session-picture | `/s/test-beta/files/1` | one picture large, "1 / n", Back to Test Beta, Open the original | load | `body[data-t-view="picture"] .t-picture img` |
| session-rename | `/s/test-alpha` | rename form under the name, Save/Cancel | click `.t-head-name` | `details.t-pick-name[open] input` |
| session-marks | `/s/test-alpha` | drawing grid under the mark | click `.t-head-mark` | `.mark-grid` |
| card-<kind> (17) | `/q/<nr[kind]>` | the fixture card: pictures, yesno, long, multiple, sections, urgent, high, revised, marks, snoozed, answered, info, code, thread, handback, artifact, files | load | `.tc-card` (answered: `.tc-answer .is-picked`; handback: `.tc-answer` "In revision") |
| card-permission | `/q/<permission nr>` | Knock! Permission, Allow/Deny, no Whatever | nr from `/s/courier` row link | `.tc-card[data-kind="permission"]` |
| card-version-old | `/q/<revised>?v=1` | old wording read-only, "Version 1 cannot be answered" | load | `.tc-answer .tc-quiet` |
| card-revise-open | `/q/<yesno>` | Revise field "What should change?" + Hand back | key `b` | `details.tc-revise[open]` |
| card-option-note | `/q/<long>` | note line under one option | click `.tc-opt-pen` | `.tc-opt-note:not([hidden])` |
| card-more-menu | `/q/<yesno>` | More: Snooze, Shred, Copy (Read aloud, Open the page when present) | click `.tc-more-open` | `details.tc-more[open]` |
| card-walk | `/walk` → `/q/<n>?walk=1` | "1 of N" with arrows | load | `.tc-count` |
| card-from-session | `/s/test-alpha/q/<yesno>` | "Back to Test Alpha" | load | `.tc-back` |
| picture | `/q/<pictures>/p/1` | picture large, "1 / 3", arrows | load | `.t-picture img` |
| picture-marks | `/q/<marks>/p/1` | circles with labels "zu eng?" | load | `.t-picture .focus-circles path` |
| agents | `/agents` | ledger lines, state, asks/does, model, machine, last seen, crown, Archive group | load | `#ledger-list .ledger-line[data-id]` |
| agents-phone-sheet | `/agents` at 390x844 | "…" sheet: open, rename, drawing, crown, move, archive | click `.ledger-menu` | `.ledger-dots[open] .ledger-sheet` |
| help | `/help.html` | help page (static, not Turbo) | load | `body` |
| not-found | `/q/999999` | "This question is not on the board any more." + Back to the Desk | load | `main#inbox h2` |
| toast-after-answer (mutates) | `/q/<yesno>` | toast "Answered — title → label" with Undo U, back on the Desk | click an option | `#says-host .says` |
| card-what-sent (mutates) | `/q/<multiple>` | toast "Asked: What??", card on Working stack | click `.tc-wtf` | `#says-host .says` |

## Desk

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| desk-route | `GET /` renders the Desk; tab title `(n) <desk> · Trommi` | `server/turbo.mjs:212-225`; `views/desk.mjs:128-134` | load `/`; `body[data-t-view=desk]`, `#desk-list`; title count = open rows | ok | S:desk |
| desk-order | rows in the hub's fixed order, oldest first; urgency/revision/snooze never move a card | `server.mjs:265-276` queueOf; `views/model.mjs:28-31` | file A, B, C; `set_urgency C critical`; order stays A, B, C | todo | |
| desk-runs | consecutive cards of one session stand in one `section.inbox-group[data-sender][data-run=single\|many]` | `views/desk.mjs:106-116` | two cards of S1 then one of S2 → two sections, first `data-run=many` | todo | |
| desk-row-gutter | row gutter: session drawing in its hue, link to `/s/<id>`; name hidden while the sidebar arrow is on | `views/desk.mjs:75`; `views/gutter-hover.mjs:9-12` | click gutter → `/s/<id>`; with `TROMMI_NAME_ON_HOVER=0` the name shows | ok | S:desk-test real room (2nd pass) |
| desk-row-title | title link to `/q/<n>`; body line = notes (revised / replaces N questions / Back from snooze / urgency reason) · plain text | `views/desk.mjs:65-78`; `views/text.mjs:18,58` | revise a card → row says "revised"; set urgency reason → shown | ok | S:desk |
| desk-row-meta | `Nr. n`, copy button, relative age (self-updating every 30 s) | `views/desk.mjs:79,84`; `application.js:194-201` | wait 1 min → "1 min ago" without reload | todo | |
| desk-row-thumbs | up to 3 picture thumbs (56 px, srcset) linking to `/q/<n>/p/1` | `views/desk.mjs:85`; `views/picture.mjs:19-35` | pictures fixture row shows 3 imgs with `?w=` srcs | todo | |
| desk-row-carries | chips: N pictures / videos / recordings / files / pages / a table / a layout | `views/text.mjs:77-99`; `views/desk.mjs:85` | code fixture → "a table"; files fixture → "3 files"; artifact → "a layout" | todo | |
| desk-row-quiet-icons | info row "To read" page icon; low urgency "Whenever" icon | `views/desk.mjs:70-71` | `create_info` → page icon; `urgency: low` → whenever icon | todo | |
| desk-row-knock | knock = permission, high or critical: `data-knock`, tab "Knock! Permission / Knock! Blocking / Knock" | `views/text.mjs:14-15`; `views/desk.mjs:77` | urgent fixture → "Knock! Blocking"; high → "Knock" | ok | S:desk; R r13 |
| desk-tiles-thumbs | 2 options or a permission: thumbs tiles (down left, up right; up = first option or `allow`), label size usual/small/none, `short` labels | `views/desk.mjs:40-54`; `views/text.mjs:61-73` | yesno fixture: two tiles "Behalten" (left) "Löschen" (right, lead) | ok | S:desk |
| desk-tile-choose | more than 2 options or `multiple`: one "Choose" link to `/q/<n>`, tooltip "N options[, several]" | `views/desk.mjs:55-57` | long fixture → Choose; click → `/q/<n>` | ok | S:desk |
| desk-tile-info | info row: What?? tile + Acknowledge tile | `views/desk.mjs:35-39` | info fixture row has both; Acknowledge → event `info_read` | todo | |
| desk-tile-advised | recommended tile `is-advised`, hand-drawn highlighter, tooltip "The agent recommends this" | `views/desk.mjs:49-51`; `t/controllers/advice_controller.js:6-10` | yesno (recommended del) → `.inbox-answer.is-advised .advice-loop` | todo | |
| desk-row-tabs | tabs beside the title: Snooze (shown), Revise (hidden, not permission), I don't give a duck (hidden, decision only), Shred (shown, not permission) | `views/desk.mjs:28,79-84` | permission row has only Snooze; keys/sheet press the hidden ones | todo | |
| desk-answer-leaves | a tile posts `stay=1`; row slides out 160 ms, stream `remove row-<id>`; toast with Undo | `turbo.mjs:190-195`; `application.js:204-219` | tap a tile → row gone, toast "Answered — <title> → <label>", event `decision` | ok | R r01/r02 |
| desk-row-error | refused answer on the Desk: row replaced with "Not saved: …" | `turbo.mjs:185`; `views/desk.mjs:88` | answer a card the agent just decided elsewhere → error line in the row | todo | |
| desk-head-next | heading "Next N →" links `/walk` (G F) | `views/desk.mjs:96-98`; `views/nextplease.mjs:9-12` | N = open rows; click → first card `?walk=1` | todo | |
| desk-head-clear | nothing waiting: "Desk is clear." + "N working · N snoozed" | `views/desk.mjs:99-102`; `views/stacks.mjs:72-75` | snooze the last card → "1 snoozed" | todo | |
| desk-empty | no open card at all: drawing + "As soon as an agent has a question, it shows up here." | `views/desk.mjs:122` | state desk-empty | todo | |
| desk-live-add | a new card arrives live at the end (before the stacks); heading, pill and tab title follow | `turbo.mjs:230-247`; `t/controllers/title_controller.js:9-12` | agent `create_decision` → row appears, `(n+1)` in title | ok | R: rows appear 62-76 ms after the tool call |
| desk-live-change | a changed row is replaced; a reorder updates the whole list; rows that leave are removed | `turbo.mjs:232-245` | `revise_card` → row replaced in place | todo | |
| desk-news | card arriving out of sight: "N new ↓", click scrolls and flashes it | `t/controllers/desk_controller.js:12-41` | scroll up, agent files → button; click → row centered | todo | |
| desk-knock-edges | knocks out of sight: strips "↑/↓ N knocks" at the list edges, click goes to the nearest | `t/controllers/desk_controller.js:24-42`; `views/desk.mjs:132-133` | scroll a knock out of view → strip; click | ok | S:desk knock band |
| desk-fit-tall | a two-line title gives its row `data-tall` | `application.js:141-150` | long fixture row has `data-tall` | todo | |
| desk-pointto | wide + mouse: pen arrow from the sidebar row to the hovered card; hovering a sidebar row draws arrows to its cards | `t/controllers/pointto_controller.js:22-96`; `views/gutter-hover.mjs:15` | hover row → `svg.pointto-layer`; leave → gone | todo | gap in 1st pass; Desk reports fixed in c5bd7a3, not re-verified |
| desk-stacks | four stamped tabs at the foot: Snooze, Working, Done, Trash (basket) with counts; empty tab faint and disabled | `views/stacks.mjs:130-164` | counts match `stackCounts`; empty tab `disabled` | todo | |
| desk-stack-rules | later = open+snoozed; works = with agent, or decided < 6 h and session online; done = older/offline decided or done with an answer/read; trash = shredded or withdrawn; permission never listed | `views/stacks.mjs:41-50` | answer a card of an online fake agent → Working; after its `close_card` → Done | todo | |
| desk-stack-open | click a tab: its list opens right below, one at a time; Escape closes and focuses the tab; stays open across stream replaces | `application.js:112-138`; `views/stacks.mjs:148` | open Done, file a card → Done still open | todo | |
| desk-stack-lines | line: mark, title link, grey line (Until…, last word, "<answer> · done by the agent / · not closed by the agent", Shredded, Withdrawn: reason), sender, age, way back (Wake up / Take back; none for withdrawn) | `views/stacks.mjs:79-91,134-145` | each fixture lands with the right grey line | todo | |
| desk-stack-more | more than 8 lines: "N more" link `/?pile=<kind>` shows them all | `views/stacks.mjs:120-124`; `turbo.mjs:221` | 9 done cards → "1 more" → all 9 | todo | |
| desk-stack-search | search over an open stack: GET `/stacks/<kind>?q=` into `turbo-frame#stack-list-<kind>`, 220 ms debounce, Escape empties, kept across stream replaces | `views/stacks.mjs:120-124,169-173`; `t/controllers/stack_search_controller.js:13-38` | type "Change" in Done → one line; Escape → all | todo | |
| desk-stack-wake | Wake up → `POST /cards/<id>/wake` → row back with "Back from snooze"; no agent event | `turbo.mjs:159`; `server.mjs:2287-2300` | snoozed fixture → Wake up → row on Desk | todo | |
| desk-stack-takeback | Take back on Working (with agent) → `/takeback` (event `handback_withdrawn`); on Done/Trash → `/reopen` (event `decision_reopened`) | `views/stacks.mjs:82-89`; `turbo.mjs:140-149,161` | both lines → card on Desk, the right event | todo | |
| desk-switch | `GET /?desk=<id>` sets cookie `trommi_desk`, 303 to `/`; the model is cut to that desk (sessions, cards, stacks, counts) | `turbo.mjs:214-219`; `views/model.mjs:11-19` | switch to Test → only Test sessions in sidebar | ok | S:desk-test |
| desk-other-knocks | knocks of other desks show on this desk, the session named "Name · Desk" | `views/model.mjs:19,30` | on main: urgent fixture of desk Test shows "Test Alpha · Test" | todo | |
| desk-no-js | every tile is a plain form: without scripts it redirects to `/?said=<id>:<way>` and shows the toast | `turbo.mjs:196-207`; test `dev/turbo-ui-test.mjs:668` | disable JS, tap a tile → Desk without the row + toast | todo | |
| desk-archived | cards of archived sessions are not on the Desk | `server.mjs:266-269` | archive an offline session with a card → row gone | todo | |

## Session view

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| sess-route | `GET /s/<id>`: heading, quiet line, conversation, composer, filter; title `(n) <name> · Trommi` | `views/session.mjs:373-392,449-462` | load `/s/web-frontend` | ok | S:session |
| sess-404 | unknown session → "This session is not on the board." (404) | `views/session.mjs:442-448` | `/s/nobody` | todo | |
| sess-heading | drawing (opens drawings), crown toggle, name (renames), red hand "Stopped: <why>" | `views/session.mjs:209-215`; `views/session-edit.mjs:51-54` | stop a working session's link → hand appears | gap | S:session real room: name "desktop · /full/path" (channel; Turbo: folder name), drawing overlaps the name |
| sess-quiet-line | task or connected/disconnected, model · host (caps), "N files" chip | `views/session.mjs:217-222` | `introduce {model, task}` → shown live | todo | |
| sess-window | latest 60 messages; "Earlier messages N" loads the 60 before in `turbo-frame#earlier-<msg>` (`?before=`); "To the latest messages" | `views/session.mjs:24,258-268,377-382` | 70 messages → link "10"; click → older appear | todo | |
| sess-days-times | day lines Today / Yesterday / date; times shown in the browser's zone with full tooltip | `views/session.mjs:53-63,197`; `t/controllers/log_controller.js:19-31` | messages across midnight → two day lines | todo | |
| sess-msg-agent | agent message: head "Agent" + time (cont. messages grouped < 5 min), rich text, attachments, Details fold, "About <card>" link | `views/session.mjs:185-196` | `reply {text, details, card_id}` → all parts | ok | S:session; R r14 |
| sess-msg-user | user message: bubble, scribble card, attachments, About link, copied-card chips (`m.cards`) | `views/session.mjs:189-192` | composer message with a picture → bubble + shot | todo | |
| sess-code-copy | fenced code gets a head with Copy ("Copied" / "Not copied") | `views/session.mjs:166-167`; `t/controllers/copy_controller.js:6-32` | reply with ```js``` → Copy works | todo | |
| sess-ask-open | an open question stands where it was asked as its Desk row (tiles answer; links `/s/<id>/q/<n>`) | `views/session.mjs:113-122` | `/s/courier` shows the approval row | gap | S:session-thread real room: inline card without border |
| sess-ask-closed | a closed or waiting question is one line: Answered / I don't give a duck / Shredded / Done / With the agent / Snoozed, linking to its card | `views/session.mjs:103-130` | answer a card → row becomes "Answered <label>" line | todo | |
| sess-events | event lines for decided, done, urgency, reopened, revised, trusted, snoozed, handed, shredded | `views/session.mjs:103-109` | `set_urgency` → "Urgency" line | todo | |
| sess-composer | `POST /s/<id>/message` (text + up to 12 files, multipart); with Turbo the composer comes back empty and focused; message appears via stream; event `chat` | `views/session.mjs:275-283,483-508`; `server.mjs:3180-3218` | send "hi" → message in log; agent gets `kind=chat` content "hi" | ok | S:session; R r14 |
| sess-composer-keys | Enter sends on a fine pointer; on touch Enter is a newline; Ctrl/Cmd+Enter sends everywhere; Shift+Enter newline; Send disabled while empty | `t/controllers/composer_controller.js:26-45` | touch emulation: Enter adds a line | todo | |
| sess-composer-draft | typed text kept in `localStorage['agent-board-draft:<id>']`, survives reload, cleared on success | `t/controllers/composer_controller.js:15-24,43` | type, reload → text back | todo | |
| sess-composer-files | picker, paste (renamed `pasted-<ts>.png`), drop anywhere on the page; chips with thumbnail and ×; at most 12 | `t/controllers/composer_controller.js:48-95` | paste an image → chip; send → meta `files`, `image_path` | ok | R r14: human file decrypted at the agent |
| sess-send-error | empty or too many files → "Not sent: …" (422), words kept | `views/session.mjs:492-502` | send 13 files → error line | todo | |
| sess-empty | no messages: "What should the agent start with?" + 3 starters (`?say=` fills and focuses the composer) | `views/session.mjs:271-272,461` | click "Where do we stand?" → composer filled | todo | |
| sess-working | "Agent is working" dots for 10 min after the human's last word | `views/session.mjs:26,238-242` | send a message → dots under the log | todo | |
| sess-to-end | scrolled up: "To the end" / "N new messages"; arriving messages do not move the view | `t/controllers/log_controller.js:52-87` | scroll up, agent replies twice → "2 new messages" | todo | |
| sess-open-chip | "N open" chip while an open question of the log is out of sight; goes to the next | `views/session.mjs:249-254`; `t/controllers/log_controller.js:91-110` | scroll an asked row away → chip; click → row focused | ok | S:session-permission "1 open" |
| sess-filter | filter icon menu: All messages / Questions only (count) / Files (N) (phone only); dot while on | `views/session.mjs:226-236` | `?only=questions` → ticked + dot | todo | |
| sess-questions | `?only=questions` (and `/s/<id>/questions` redirect): "N questions wait for you" rows, then "Earlier questions" lines | `views/session.mjs:288-298,463` | load for test-alpha | ok | S:session-questions (order differs, P3) |
| sess-files-drawer | "N files" chip opens the drawer (lazy frame `/s/<id>/files`), a group per card or message, thumbs, "Jump to"; Escape, click beside, × close; `/s/<id>/files` opens it | `views/session.mjs:300-369,464-473`; `t/controllers/files_controller.js:15-53` | open, Jump to → message `.is-jumped` | todo | mock "0 files" (1st pass); real room had no published assets |
| sess-picture | `/s/<id>/files/<n>`: picture large, "i / n", prev/next (replace), Back to the conversation (`#msg-…`) or the files, "Open the page / the original" | `views/session.mjs:395-405,474-479` | click a shot in the log → page; Back → log | todo | |
| sess-live | live: heading, quiet line, filter counts, new messages before `log-end-<id>`, changed messages, status, open chip, files list; a rewritten log refreshes | `views/session.mjs:511-557` | agent reply appears without reload | ok | R r14 reply visible 65 ms |
| sess-card | `/s/<id>/q/<n>`: the card page, "Back to <session>", an answer returns to the session (`back` field) | `turbo.mjs:197-202,252-264`; `views/card.mjs:258-271,288` | answer from there → back on `/s/<id>?said=…` | gap | S:session-thread real room: inline cards have corner ticks only, no border |
| sess-old-only | not Turbo: `/s/<a>+<b>` (laid together), `/s/<id>/scribble` → old client | `views/session.mjs:455`; `server.mjs:3123,3417-3420` | load → redirect to `/old/#…` | todo | |

## Cards and decisions (the card page)

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| card-route | `/q/<n>` (number or id) inside the frame with the sidebar; 404 page when gone | `turbo.mjs:252-264` | `/q/<nr>`, `/q/<card id>`, `/q/999999` | ok | S: same in 4 profiles |
| card-head | "Back to Desk/<session>" (Esc), "k of N" with before/next arrows (only while waiting), "More" | `views/card.mjs:266-279` | open a middle card → "2 of 5" | ok | S: same in 4 profiles |
| card-lead | knock tab, title, meta (session link, age, Nr., "revised · N messages below" → thread) | `views/card.mjs:111-124` | thread fixture → "4 messages below" | ok | S: same in 4 profiles |
| card-fit-text | card holds ≤ 340 chars of prose, whole paragraphs; more (or code/tables) → "More in the comments ↓" + "The whole text" in the thread | `views/card.mjs:33-47,122,200-202` | long fixture → link + whole text block | ok | S: same in 4 profiles |
| card-media | picture stage (640 px), thumb strip, before/next (replace), "i / n · title", zoom → `/q/<n>/p/<i>` | `views/card.mjs:87-99` | pictures fixture → 3 thumbs, `?pic=2` | ok | S:card-marks, card-artifact captions from attachments[].title (2nd pass) |
| card-opts-single | each option a submit button (`formaction /decide`, `name=key`), label + one-line detail | `views/card.mjs:154-163` | click → answered | ok | S: same in 4 profiles |
| card-opts-multiple | checkboxes + "Send the answer" | `views/card.mjs:160-161,166` | multiple fixture | ok | S: same in 4 profiles |
| card-advised | recommended option: highlighter, tooltip, screen-reader ", recommended by the agent" | `views/card.mjs:155-159` | pictures fixture option B | ok | S: same in 4 profiles |
| card-or-row | decision: "or" I don't give a duck, What?? tile, Revise tile | `views/card.mjs:165-167` | yesno fixture | ok | S: same in 4 profiles |
| card-info-ways | info: What?? + Acknowledge | `views/card.mjs:150` | info fixture | ok | S: same in 4 profiles |
| card-permission-ways | permission: Allow/Deny only, no duck/What??/Revise, no Snooze/Shred in More | `views/card.mjs:167,274` | card-permission | ok | S: same in 4 profiles |
| card-answered | closed: what was said (labels / Shredded / Read / duck: advised / Withdrawn by the agent), "Your note", option notes, "Done by the agent: summary", Take back where allowed | `views/card.mjs:142-147` | answered fixture: "Ja", "Your note: Ja, ab der nächsten Version." | ok | S: same in 4 profiles |
| card-with-agent | handed back / What?? pending: "In revision — It is with its session…" + Take back | `views/card.mjs:148` | handback fixture | ok | S: same in 4 profiles |
| card-thread | comments: whole text, "Options in detail", links of options, "Why it is urgent", the talk; What?? + answer as one "Explained" block; "Version n[, as you asked]"; "Earlier versions (n)" fold | `views/card.mjs:184-245` | thread, revised, sections fixtures | ok | S: same in 4 profiles |
| card-option-links | links written into options are not on the tiles; listed under "Links of the options" | `views/card.mjs:171-176` | option label with a URL | todo | |
| card-field | "Write to the agent about this question": Enter sends (Shift+Enter newline), clip, Send → `/cards/<id>/message`; stays on the card, toast "Message sent"; field empties | `views/card.mjs:287-293`; `turbo.mjs:135-139,165-170,201`; `t/controllers/card_controller.js:123-127` | send → event `chat` with `card_id`, no handback | todo | |
| card-note-with-answer | the field's text goes along as the answer's note | `turbo.mjs:121,154` | type, click option → event content = note | todo | |
| card-option-note | pencil per option opens `note-<key>`; Enter blurs; empty line hides; sent as option notes | `views/card.mjs:158,163`; `t/controllers/card_controller.js:103-117` | note on B, answer A → "Notes on options:" B not chosen | todo | |
| card-draft | ticks, note, option notes, marks saved 700 ms after the last stroke (`POST /cards/<id>/draft`) → "Saved" / "Not saved"; rendered back; the stream never replaces under typing | `turbo.mjs:274-281,293-306`; `t/controllers/card_controller.js:130-145`; `server.mjs:2072-2089` | tick, reload → still ticked | todo | |
| card-marks | drawing and pinned notes on the card (focus-marks), in field `marks`, sent with answer, message, revise, shred | `t/controllers/card_controller.js:32-45`; `turbo.mjs:125` | draw, answer → meta `marks` count | gap | S:card-marks real room: marks not drawn; model has {width,height}, view wants {w,h} |
| card-files | files attached in the field go with an answer or a message (multipart); dropped if the answer is refused | `turbo.mjs:128-131,283-291`; `t/controllers/card_controller.js:148-167` | drop a file on the card, answer → meta `files` | todo | |
| card-stale | answer to a version that was reworded meanwhile is refused (hidden `revised` stamp, 409) | `turbo.mjs:122`; `views/card.mjs:139` | open, `revise_card`, answer the old page → "Not saved" | todo | |
| card-version-old | `?v=n`: older version read-only, "Version n cannot be answered" + link to now; only the thread stays live | `views/card.mjs:28,141,219`; `turbo.mjs:254-258,305` | revised fixture `?v=1` | todo | |
| card-pic-option | picture ↔ option pairing (section names it; `-<key>` file names; as many pictures as options ≥ 3); hover/focus an option swaps the stage picture; paired option `data-match` | `views/card.mjs:54-83`; `t/controllers/card_controller.js:72-100` | pictures fixture: hover "Entwurf C" → picture 3 | ok | S: same in 4 profiles |
| card-arrow | pen arrow from the picture (or its first circle) to the matched option, only when side by side | `t/controllers/card_controller.js:172-202` | wide card → `svg.focus-arrow` | ok | S: same in 4 profiles |
| card-circles | agent marks circled with labels over the picture (stage and picture page) | `t/controllers/circles_controller.js:25-54`; `views/card.mjs:96,305` | marks fixture → two circles "zu eng?" "zum Vergleich" | ok | S: same in 4 profiles |
| card-more | More: Snooze, Shred (open, not permission), Copy, Read aloud (with speech), Open the page | `views/card.mjs:273-278` | card-more-menu | ok | S: same in 4 profiles |
| card-live | live: lead, answer (ignoring the draft), thread replaced; the card gone → page refreshes | `turbo.mjs:292-308` | agent `reply {card_id}` → thread grows | todo | |
| card-walk | `/walk` → first waiting card `?walk=1`; an answer goes to the card that stood after it, then the Desk | `turbo.mjs:203-206,226-229` | answer in walk → next card URL `?walk=1&said=…` | ok | S: same in 4 profiles |
| card-error | refused answer on the page: 422, "Not saved: …" in `.tc-error` | `turbo.mjs:186-188`; `views/card.mjs:136` | answer an already decided card | todo | |
| card-say | Read aloud (only with `state.speech`): `GET /speech/card/<id>`, second press stops | `t/controllers/say_controller.js:6-14`; `server.mjs:3527` | with speech key set | todo | |
| card-open-page | picture with `page` → "Open the page" (More, picture page) | `views/card.mjs:265,277,304` | artifact fixture | todo | |
| card-sections | sections: plain blocks on the card, keyed blocks in "Options in detail", recommended from `[key*]`, section picture pairs with its option | `views/card.mjs:49,56-59,203-204` | sections fixture | ok | S: same in 4 profiles |
| card-rich | light markdown: lists, bold, code, tables, links, bare `/x.html` paths, `__underline__`, "☞" drawn hand (not in the thread); html fences/`card.html` in a sandboxed frame | `views/text.mjs:106-181`; `t/controllers/richhtml_controller.js:7-10` | code + artifact fixtures | ok | S: same in 4 profiles |
| card-merged-note | merged card says "replaces N questions" | `views/text.mjs:18` | rt-merge | todo | |

## Decision round trips

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| rt-basic | create → answer → event → close | `server.mjs:1673-1679,2111-2176`; `turbo.mjs:151-155` | agent `create_decision {title, options:[a,b]}` → row (thumbs) → tap b → toast "Answered — t → B" → event `decision` `choice=b` → agent `close_card {summary}` → Working→Done line "B · done by the agent" | ok | R r01: create 66 ms→app, click→`decision choice=now` 30 ms, close_card summary on card |
| rt-choose | 3+ options via the card page | `views/desk.mjs:55-57`; `views/card.mjs:162` | `create_decision` 3 options → Choose → option → event `decision`; back on Desk | ok | R r01/r03 via card page |
| rt-multiple | several answers | `views/card.mjs:160-166`; `server.mjs:2167` | `multiple:true` → tick a, c → Send the answer → event `choice=a choices=a,c` | ok | R r03: `choices=perf,plan` |
| rt-multiple-none | Send with nothing ticked is refused | `turbo.mjs:153` | → "Not saved: pick an option first" | todo | |
| rt-sections | text/sections question | `server.mjs:1514-1544` | `create_decision {text:"…\n\n[x*] …\npicture: a.png", attachments}` → card blocks + "Options in detail", x advised → answer → event | ok | R r04: 5 parts, `choices=sync,offline` |
| rt-recommended | recommended advice | `views/desk.mjs:49-51,72`; `views/card.mjs:155-165` | `recommended:'b'` → highlighter on B (row + card), duck tooltip "agent takes B" | ok | R r01 `.tc-opt.is-advised`; S:card-yesno, card-pictures same |
| rt-pictures | per-option pictures | `views/card.mjs:54-83` | attachments `x-a.png,x-b.png,x-c.png` → hover swaps, arrow, row byline 3 thumbs → answer → event | ok | R r05 picture decrypted on card page; S:card-pictures same |
| rt-picture-marks | pictures with marks | `server.mjs:1118`; `circles_controller.js` | attachment `{path, marks:[{x,y,w,h,label}]}` → circles on stage and `/p/1`; arrow starts at circle | gap | R r05 ok on the drawn marker check in the dev run, but S:card-marks real room shows no circles (width/height vs w/h) |
| rt-notes | note + option notes | `server.mjs:2158-2170` | note "after backup", note on B, answer A → content note + "Notes on options:\n- B [b], not chosen: …", meta `option_notes=b` | todo | |
| rt-answer-files | files with an answer | `turbo.mjs:128-131`; `server.mjs:2170` | attach file in field, answer → meta `files`, `image_path` | todo | |
| rt-answer-marks | marks with an answer | `server.mjs:2163,2168` | draw on card, answer → meta `marks=N`, content "Notes pinned to the card:" | todo | |
| rt-handback | hand back → revise_card → presented again | `turbo.mjs:163`; `server.mjs:3194-3196,1688-1761`; `views/card.mjs:128,214-219` | B / Revise tile → "What should change?" → Hand back → card to Working ("In revision"), toast "Handed back" Undo → event `chat card_id handback=1` (content = words) → agent `revise_card {card_id, options…}` → card back on Desk "revised", thread "Version 2, as you asked", "See version 1", "Earlier versions" | ok | R r06: hand back→`chat handback=1` 27 ms, revise_card→v2 in app 64 ms, row back |
| rt-handback-bare | Revise with no words from a row / sheet | `turbo.mjs:42,163`; `views/card.mjs:196,232` | row sheet Revise → event content "Back to you: please revise this question and present it again."; thread shows "Revise" | todo | |
| rt-handback-present | reply instead of rewording | `server.mjs:1656-1671` | after handback, `reply {card_id, text}` → stays in revision (tool says so); `reply {card_id, present:true}` → back on Desk | ok | R r06/r07: presented again on the Desk |
| rt-handback-takeback | take the hand-back back | `turbo.mjs:140-149,162`; `server.mjs:3659-3672` | Take back (card or Working line, or toast Undo) → event `handback_withdrawn card_id` → card on Desk; thread "You took it back" | todo | |
| rt-what | What?? → explanation → presented | `turbo.mjs:164`; `views/text.mjs:12`; `server.mjs:1661-1664` | E / `.tc-wtf` → toast "Asked: What??" Undo → card to Working → event `chat card_id explain=1` content EXPLAIN_TEXT → agent `reply {card_id, text}` → card back on Desk by itself; thread "You asked: What??" + answer block | ok | R r07: What??→`chat explain=1` 27 ms; reply→explanation on card 380 ms, back on Desk |
| rt-what-info | What?? on an info card | `views/desk.mjs:37`; `views/card.mjs:150` | info row What?? → same chain, then Acknowledge | todo | |
| rt-trust | I don't give a duck | `turbo.mjs:156`; `server.mjs:2178-2207` | R / duck → toast "I don't give a duck" Undo → event `decision trust=1 choice=<recommended>` (content "decide yourself…") → agent reply + `close_card`; answered view "I don't give a duck: B" | ok | R r08: duck→`decision choice=g trust=1` 27 ms |
| rt-trust-none | duck without advice | `server.mjs:2187-2190` | no `recommended` → event `choice=""`; Done line "I don't give a duck" | todo | |
| rt-trust-undo | take the duck back | `server.mjs:2408-2418` | Undo → event `decision_reopened trust=1 previous_choice` → card open, note in draft | todo | |
| rt-reopen | decide again | `turbo.mjs:161`; `server.mjs:2420-2434` | answer, then toast Undo / Take back (Done line or card) → card open with previous ticks + note as draft → event `decision_reopened previous_choice[, previous_choices]` → thread "Your answer was taken back: open again" → answer again → new `decision` | ok | R r02: Undo→`decision_reopened previous_choice=yes` 27 ms; answered card button too |
| rt-reopen-withdrawn | withdrawn cards have no way back | `views/stacks.mjs:89`; `server.mjs:2404` | withdraw → Trash line without button; card page no Take back | todo | |
| rt-shred | shred → told not to ask again | `turbo.mjs:160`; `server.mjs:2210-2240` | X / More Shred / row bin → toast "Shredded" Undo → event `shredded card_id` (+note, marks, files) → Trash "Shredded" | ok | R r09: More→Shred→`shredded` 27 ms |
| rt-shred-undo | fish it out | `server.mjs:2384-2396` | Undo / Take back in Trash → event `decision_reopened shredded=1 previous_choice=""` → card open, note + marks as draft | todo | |
| rt-snooze | snooze until next morning | `turbo.mjs:158`; `server.mjs:2281-2321` | L / Snooze → card to Later "Until <day hh:mm>", toast "Snoozed" Undo (wake) → no event → at SNOOZE_HOUR (or `BOARD_SNOOZE_TICK_MS`) back on Desk "Back from snooze" | ok | R r10: leaves the Desk list, no agent event (as Turbo) |
| rt-refusals | permission cannot be snoozed, shredded, trusted, revised, withdrawn, merged, closed while open | `server.mjs:2181,2214,2290,1690,1816,1772,1831` | each → "Not saved: …" toast/error | todo | |
| rt-merge | merge_cards | `server.mjs:1763-1797` | two open cards → `merge_cards {card_ids, title, multiple:true…}` → old rows leave live, Trash "Withdrawn: Merged into Nr. N", new row at the oldest's place with "replaces 2 questions"; status lines repointed | ok | R r13: merge_cards → merged card on the Desk |
| rt-withdraw | withdraw_card | `server.mjs:1813-1827` | `withdraw_card {reason}` → row gone live; Trash "Withdrawn: reason"; card page "Withdrawn by the agent" | ok | R r13: withdraw_card → row gone 249 ms |
| rt-urgency | set_urgency | `server.mjs:1799-1811` | `high` with reason → knock tab, reason on row + "Why it is urgent", session "Urgency" line, place unchanged; `low` → whenever icon | ok | R r13: set_urgency → knock on the row 64 ms |
| rt-close | close_card | `server.mjs:1829-1839` | after answer → Done; answered view "Done by the agent: summary"; session line "Done" | ok | R r01 |
| rt-revise-open | revise_card on an open card | `server.mjs:1730-1757` | `revise_card {card_id, title}` → row "revised", version 2, old page answer refused (rt-stale) | todo | |
| rt-revise-decided | revising a decided card is refused | `server.mjs:1691-1693` | → tool error | todo | |
| rt-ask-back | question back about a card | `turbo.mjs:165-170` | card field "What does X mean?" → event `chat card_id` → `reply {card_id}` → in the card's thread live; card stays open | todo | |

## Info and permission

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| ip-info-read | create_info → read → info_read | `server.mjs:1681-1686,2325-2339` | `create_info {title, body}` → row "To read" → Acknowledge → event `info_read`; Done "Read" | ok | R r11: Read→`info_read` 28 ms |
| ip-info-reopen | an info read can be taken back; agent not told | `server.mjs:2398-2403` | Done "Read" Take back → row unread again, no event | todo | |
| ip-info-phone | phone: info card's Acknowledge stands in the first screen | test `dev/turbo-ui-test.mjs:435` | 390x844 info fixture | todo | |
| ip-permission | permission_request → card → verdict | `server.mjs:1934-1975,2150-2157` | linked session posts `/agent/permission {request_id, tool_name, description, input_preview}` → row "Knock! Permission" Allow/Deny (urgency critical) → Allow → method `notifications/claude/channel/permission {request_id, behavior:"allow"}`; card status done at once, in no stack | ok | R r12: permission_request→app 63 ms; Allow/Deny→`behavior` at Claude Code 27-29 ms |
| ip-permission-dedup | a repeated request id makes no second card | `server.mjs:1959-1960` | post the same request twice → one row | todo | |
| ip-permission-blocked | waiting for permission shows the session as stopped (red hand) | `server/blocked.mjs:32` | sidebar badge hand, title "Stopped: Waiting for permission" | todo | |

## Status lines

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| st-working | `set_status working` → line with ring on the session page; sidebar drawing draws itself; Agents "Asks or does" = "label: detail" | `server.mjs:1841-1859`; `views/session.mjs:238-247`; `views/sidebar.mjs:13-15`; `views/agents.mjs:98-102` | `set_status {id:'t', label:'Tests', state:'working', detail:'42/48'}` | ok | R r14: status lines on the session page |
| st-decision | `state:decision` + `card_id` → knock-drawn line linking to the card | `views/session.mjs:243-245` | line `data-state=decision` href `/s/<id>/q/<n>` | ok | R r14 (2nd pass: card_id race fixed in the channel) |
| st-decision-yellow | answering (decide/duck/shred) that card turns the line to working (yellow) and clears its card | `server.mjs:2131-2133,2196-2198,2226-2228` | answer → line `data-state=working`, no link | todo | |
| st-done | `done` → tick; shown 10 min after its update, then hidden | `views/session.mjs:241` | set done → tick; 10 min later gone | todo | |
| st-clear | `clear_status {id}` / all | `server.mjs:1861-1864` | line gone live | todo | |
| st-label-needed | a new line without `label` is refused | `server.mjs:1850` | tool error | todo | |
| st-stopped | stopped hand: disconnected while working, error, waiting for permission, blocking question, silent too long | `server/blocked.mjs:23-36`; `views/sidebar.mjs:27-36,82-86` | kill a working agent → hand on row, Desk pill hand, heading "Stopped: …", Agents state "stopped" | todo | |
| st-badge | sidebar ring with open count; `data-offline`, `data-working`; link `/s/<id>` | `views/sidebar.mjs:27-36` | file a card → ring 1 | todo | |
| st-introduce | introduce: model/task in quiet line + Agents, icon becomes the drawing (unless picked by hand), parent/main nest it | `server.mjs:1865-1875` | `introduce {model, task, icon:'flask', parent}` | ok | R r14 introduce accepted |

## Memos and pad

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| memo-new | round yellow button (key `n`) makes a floating note (`POST /memos`), keyboard in it; without scripts the form makes one and comes back | `views/memo.mjs:67-79,106-110`; `t/controllers/memos_controller.js:37-41` | click `#memo-open` → `.memo[data-fresh]` | todo | |
| memo-save | typing saved through `POST /memo` (350 ms), flushed on leaving/pagehide | `t/lib/memo.js:48-75,310` | type, reload → text kept | todo | |
| memo-send | Enter or the crown button sends: note tears off into an envelope sealed with the crown, flies to the crowned session's row; toast "Memo sent to X" with Undo for the hold (3 s); then event `chat` (content, files meta); message in that session's log | `views/memo.mjs:34-38,124-132`; `t/lib/memo.js:222-294`; `server.mjs:3222-3238,3270-3288` | send → after 3 s agent gets `kind=chat` | todo | |
| memo-unsend | Undo within the hold brings the note back; later "too late" | `views/memo.mjs:134`; `server.mjs:3245-3258` | U within 3 s → note back, no event | todo | |
| memo-no-crown | no crown on the desk: send button is a dashed crown linking to `/agents`; send refused | `views/memo.mjs:36,126` | take the crown off → dashed | todo | |
| memo-session | on `/s/<id>` a note belongs to that session: shown only there, sealed with its drawing, sent to it | `views/memo.mjs:26-32,71`; test `dev/turbo-ui-test.mjs:742` | write on `/s/test-beta` → `data-seal="session"` value test-beta | todo | |
| memo-put-away | Escape puts the note away (empty → gone); button shows the count; click lists "New memo" + notes; a line opens it (`/memos/<id>/open`) | `t/controllers/memos_controller.js:23-30`; `views/memo.mjs:67-79,111-116` | state memo-list | todo | |
| memo-bin | bin throws it away; toast "Note thrown away" Undo remakes it | `views/memo.mjs:118-123` | U → note back with text | todo | |
| memo-attach | clip, paste, drop on the note; chips (click = take off); more than 5 fold | `t/lib/memo.js:330-356`; `t/controllers/memo_controller.js:10-31` | paste image → chip; send → meta files | todo | |
| memo-carry | dragged by its head; dropped on the Desk's bare paper it lies there and scrolls with it | `t/lib/memo.js:358-416` | drag onto paper → `place=paper` | todo | |
| memo-phone | phone: a note is a sheet at the bottom, one at a time; floating notes counted on the button | `views/memo.mjs:72`; `t/lib/memo.js:18,28` | 390x844 | todo | |
| memo-live | notes appear/change/leave on every open page; a note being typed in is not replaced | `views/memo.mjs:164-185`; `t/lib/memo.js:151-197` | two tabs | todo | |
| pad-paper | the Desk is paper: the pad (`/pad/?embed=1&desk=1`) lies under the rows, laid when idle | `t/lib/paper.js:1-17,276-297`; `views/memo.mjs:82-85` | Desk → `#deskpad` iframe | ok | S:pad, desk real room: dot grid, no pad chrome on the closed Desk (2nd pass) |
| pad-pen | P or the pen switch: draw anywhere on the Desk; Escape gives the keys back | `t/lib/paper.js:95-104,339`; `t/lib/clear.js:26-35` | state pad | ok | S:pad real room: toolbar with icons, cards faded (2nd pass) |
| pad-clear | W or the clear switch: cards wiped off to the right, back on second press; knock count on the switch; never kept over a reload | `t/lib/paper.js:36-38,107-111,178-195`; `t/lib/clear.js:43-67` | state pad-cards-hidden; reload → cards back | todo | |
| pad-zoom | pinch zoom of the paper (whole width … 200 %), kept per browser | `t/lib/paper.js:132-175` | touch pinch | todo | |
| pad-send | select on the pad → "Send to…" (S) → session (usual ones first) → panel with preview → Send → `POST /pad/send` → message with picture in that session + event `pad {pad, message_id, elements, image_path}`; **what was sent leaves the canvas** (one undo brings it back) | `client/web/pad/pad.js:1188-1300,1301-1368,1370-1390`; `server/pad.mjs:276` | select 2 notes → send to Web-Frontend → elements gone, event `kind=pad elements=…` | todo | |
| pad-old-page | `/pad` itself is the old client (jump "Scratchpad" goes there) | `views/menu.mjs:58`; `server.mjs:3123` | `/pad` → `/old/#/pad` | todo | |
| scribble-old | session canvas (Scribble) only in the old client; send → event `scribble` | `server.mjs:2360-2377` | `/s/<id>/scribble` → old client | todo | |

## Media, attachments, assets

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| med-shots | agent pictures in a message: grid (1 large or several), link to `/s/<id>/files/<n>`, sized variants | `views/session.mjs:92-100`; `views/picture.mjs:19-35` | `reply {attachments:[png]}` | ok | R r05 decrypted; S:card-pictures |
| med-video-audio | video and audio play inline with caption | `views/session.mjs:97-99` | reply with mp4 / mp3 | todo | |
| med-files | other files as download chips | `views/session.mjs:99` | reply with csv | todo | |
| med-page-of-pic | `{path, page}`: "Open the page" under the shot, on the picture page and card More | `views/session.mjs:99,401`; `views/card.mjs:265,277,304` | artifact fixture | ok | S:picture same |
| med-thumbs | `/files/<name>?w=` variants (srcset 1x/2x), GIF and unknown sizes keep the original | `views/picture.mjs:19-35`; `server.mjs:3458-3462` | inspect `src` | todo | |
| med-reply-html | `reply.html` in a sandboxed frame under the words; `details` folded | `views/session.mjs:194-195`; `views/text.mjs:151` | thread fixture table | todo | |
| med-asset-card | published asset in the log: preview decrypted in the browser (picture, page first screen), kind · size, title, note, Open | `views/session.mjs:149-162`; `t/controllers/assetthumb_controller.js:17-99` | artifact fixture assets | todo | mock showed raw text (1st pass); not re-checked with a real published asset |
| med-asset-copy | "Copy link" releases it (`POST /asset/share`) and copies `/r/<id>#<key>`; toast "Link copied" with "Stop sharing" | `t/controllers/share_controller.js:28-59`; `server.mjs:3533-3543` | click → clipboard `/r/…`; card "Shared · Stop", opens count | todo | see med-asset-card |
| med-asset-stop | "Stop" takes the release back | `t/controllers/share_controller.js:47` | `/r/<id>#key` → gone | todo | |
| med-asset-gone | revoked/expired asset: "No longer available" | `views/session.mjs:153` | agent `revoke_asset` | todo | |
| med-asset-link | `/a/<id>#<key>` in text → asset chip named by title | `views/text.mjs:34-46,109-112` | reply with the link | gap | R r15: no outside link |
| med-viewer | `/a/<id>#<key>` viewer, `/r/<id>#<key>` outside page | `server.mjs:3383-3384` | open both | ok | S:picture same |
| med-uploads | human files (composer, card field, memo) stored under `/files/`, event meta `files`, `image_path` | `server.mjs:3192,3210-3211` | send picture → path exists | ok | R r14 |
| med-limits | 12 files per message, body ≤ 96 MB | `views/session.mjs:27`; `turbo.mjs:285` | 13 files → error | todo | |
| med-voiceover | `create_voiceover` → MP3 path; attached to a reply it plays | `server.mjs:1876` | with speech key | todo | |

## Navigation

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| nav-drive | links go through Turbo; a path not rendered here (meta `t-pages`) loads whole | `application.js:178-191`; `views/layout.mjs:67` | click Help → full load | ok | perf nav |
| nav-t-prefix | old `/t/...` addresses redirect to the same path (302 GET / 307 POST) | `turbo.mjs:391-398` | `/t/q/<n>` → `/q/<n>` | todo | |
| nav-back-desk | card head "Back to Desk/<session>" | `views/card.mjs:271` | click → Desk | ok | perf nav card→back 94-193 ms |
| nav-esc-chain | Escape: leaves a field first, then back to the Desk | `t/lib/keys.js:37`; `keys_controller.js:172,293` | type in field, Esc, Esc | todo | |
| nav-next-line | "Next N →" and the pill's count both lead into the walk | `views/nextplease.mjs:9-12`; `views/sidebar.mjs:74-81` | click pill count → `/q/<n>?walk=1` | todo | |
| nav-history | Back/Forward between Desk and card work; scroll kept (refresh-scroll preserve) | `views/layout.mjs:63-66`; test `dev/turbo-ui-test.mjs:412-417` | Back → Desk with row | todo | |
| nav-sidebar | sidebar row → `/s/<id>` (`is-active` on the current); badge → `/s/<id>` | `views/sidebar.mjs:38-53` | click | todo | |
| nav-menu | pill opens `#brand-doors`; click beside / Escape / a choice closes; a refresh morph keeps it open | `application.js:233-246`; `t/controllers/menu_controller.js:21-52,97` | state menu | ok | S:menu (2nd pass); P3 "Geräte" German |
| nav-jump | Ctrl/Cmd+K or G J → jump field; results (Nr./#n, Desk, Agents, Next, Scratchpad, Help, Keys, Admin, sessions, card titles open first, max 8); Enter takes the first; ↓ into results; `#jump` opens it; `/jump?q=` page without scripts | `views/menu.mjs:47-73,88-93`; `t/controllers/menu_controller.js:55-92` | type "12" → "Nr. 12: …", Enter | ok | S:jump same |
| nav-said | `?said=<card>:<way>` shows the toast once and is removed from the address | `turbo.mjs:90-91`; `application.js:37-39` | reload after an answer → no toast | todo | |
| nav-404 | unknown card/session page with "Back to the Desk" | `turbo.mjs:76` | `/q/999999` | todo | |
| nav-refresh | a page older than the hub (rev) or one that fell behind refreshes once (morph) | `turbo.mjs:326-380` | restart hub → page refreshes | todo | |
| nav-conn | dot on the pill: Connected / No connection | `application.js:222-230`; `views/layout.mjs:42` | break the stream → dot | todo | |

## Keys (one row per entry of `client/web/t/lib/keys.js`)

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| key-list-next | Desk `j` / `↓`: next row; after the last, an opened stack's lines (repeat) | `t/lib/keys.js:11`; `keys_controller.js:142` | `j` → `.is-current` moves | ok | keys.mjs j |
| key-list-prev | Desk `k` / `↑`: previous row (repeat) | `keys.js:12`; `keys_controller.js:143` | | todo | |
| key-list-first | Desk `Home`: first row | `keys.js:13`; `keys_controller.js:144` | | todo | |
| key-list-last | Desk `End`: last row | `keys.js:14`; `keys_controller.js:145` | | todo | |
| key-list-open | Desk `Enter` / `c`: open the marked card | `keys.js:15`; `keys_controller.js:146` | → `/q/<n>` | ok | keys.mjs Enter, c |
| key-list-later | Desk `l`: snooze; on a snoozed line: wake | `keys.js:16`; `keys_controller.js:147` | row → Later | todo | |
| key-list-revise | Desk `b`: hand back at once (no words) | `keys.js:17`; `keys_controller.js:148` | event `chat handback=1` | todo | |
| key-list-trust | Desk `r`: I don't give a duck | `keys.js:18`; `keys_controller.js:149` | event `decision trust=1` | todo | |
| key-list-shred | Desk `x`: shred | `keys.js:19`; `keys_controller.js:150` | event `shredded` | todo | |
| key-list-takeback | Desk `u` / `⌫`: Take back on a marked stack line, else the newest toast's Undo | `keys.js:20`; `keys_controller.js:151` | answer, `u` → reopened | todo | |
| key-pad-cards | Desk `w`: hide/show the cards | `keys.js:21`; `keys_controller.js:153`; `paper.js:340` | `#inbox[data-cards-hidden]` | ok | keys.mjs w; S:pad-cards-hidden |
| key-list-leave | Desk `Esc`: drop the mark | `keys.js:22`; `keys_controller.js:152` | no `.is-current` | ok | keys.mjs Esc |
| key-card-send | card `Enter`: "Send the answer" (multiple) | `keys.js:25`; `keys_controller.js:155` | multiple fixture | todo | |
| key-card-later | card `l` / `s`: snooze | `keys.js:26`; `keys_controller.js:156` | | todo | |
| key-card-trust | card `r`: duck | `keys.js:27`; `keys_controller.js:157` | | todo | |
| key-card-revise | card `b`: open the Revise field; Enter there hands back | `keys.js:28`; `keys_controller.js:159-163` | `details.tc-revise[open]` | ok | keys.mjs b |
| key-card-what | card `e`: What?? | `keys.js:29`; `keys_controller.js:164` | event `explain=1` | todo | |
| key-card-shred | card `x`: shred (More item) | `keys.js:30`; `keys_controller.js:165` | | todo | |
| key-card-write | card `a`: focus the field | `keys.js:31`; `keys_controller.js:166` | `.tc-field:focus` | ok | keys.mjs a |
| key-card-back | card `u` / `⌫`: newest toast's Undo, else Take back on the card | `keys.js:32`; `keys_controller.js:167` | | todo | |
| key-card-next | card `j` / `→`: next card unanswered (repeat) | `keys.js:33`; `keys_controller.js:168` | | todo | |
| key-card-prev | card `k` / `←`: previous card (repeat) | `keys.js:34`; `keys_controller.js:169` | | todo | |
| key-card-pic-next | card `⇧→`: next picture | `keys.js:35`; `keys_controller.js:170` | `?pic=2` | ok | keys.mjs Shift+→ |
| key-card-pic-prev | card `⇧←`: previous picture | `keys.js:36`; `keys_controller.js:171` | | todo | |
| key-card-leave | card `Esc` (also in a field): leave the field, then back to the Desk | `keys.js:37`; `keys_controller.js:172` | | ok | keys.mjs Esc |
| key-pic-next | picture page `→` / `j`: next | `keys.js:40`; `keys_controller.js:188` | | todo | |
| key-pic-prev | picture page `←` / `k`: previous | `keys.js:41`; `keys_controller.js:189` | | todo | |
| key-pic-leave | picture page `Esc`: back to the card | `keys.js:42`; `keys_controller.js:190` | | ok | keys.mjs Esc |
| key-ledger-next | Agents `↓` / `j`: next line | `keys.js:45`; `keys_controller.js:174` | | ok | keys.mjs j |
| key-ledger-prev | Agents `↑` / `k`: previous line | `keys.js:46`; `keys_controller.js:175` | | todo | |
| key-ledger-open | Agents `Enter`: open the conversation (not archived) | `keys.js:47`; `keys_controller.js:176` | | todo | |
| key-ledger-walk | Agents `q`: its questions in a walk | `keys.js:48`; `keys_controller.js:177` | | todo | |
| key-ledger-rename | Agents `r`: rename | `keys.js:49`; `keys_controller.js:178` | | todo | |
| key-ledger-mark | Agents `d`: drawing picker | `keys.js:50`; `keys_controller.js:179` | | todo | |
| key-ledger-crown | Agents `c`: give/take the crown | `keys.js:51`; `keys_controller.js:180` | | todo | |
| key-ledger-pair | Agents `+`: lay together with… | `keys.js:52`; `keys_controller.js:181` | | todo | |
| key-ledger-archive | Agents `a`: archive an offline one / fetch back | `keys.js:53`; `keys_controller.js:182` | | todo | |
| key-ledger-down | Agents `⇧↓`: move down | `keys.js:54`; `keys_controller.js:183` | | todo | |
| key-ledger-up | Agents `⇧↑`: move up | `keys.js:55`; `keys_controller.js:184` | | todo | |
| key-ledger-find | Agents `/`: find field (pops controller) | `keys.js:56`; `t/controllers/pops_controller.js:52-55` | | todo | |
| key-ledger-leave | Agents `Esc`: close what is open, then drop the mark | `keys.js:57`; `keys_controller.js:186` | | todo | |
| key-help | `?`: key sheet (six short rows; also menu "Keys") | `keys.js:60,82-89`; `keys_controller.js:192,127-135`; `views/keys.mjs:21-28` | state keys-sheet | ok | keys.mjs ? |
| key-memo-new | `n`: new memo | `keys.js:61`; `keys_controller.js:193` | | gap | keys.mjs n: app focuses the chooser line "New memo" when a memo exists; Turbo opens a note |
| key-go-desk | `g d` / `g i`: Desk | `keys.js:62`; `keys_controller.js:194` | | ok | keys.mjs g i |
| key-go-agents | `g a`: Agents | `keys.js:63`; `keys_controller.js:195` | | ok | keys.mjs g a |
| key-go-jump | `Ctrl/⌘+K` / `g j`: jump field (Desk with menu where no menu) | `keys.js:64`; `keys_controller.js:106-113,197,275` | | ok | keys.mjs g j, Ctrl+K |
| key-go-walk | `g f`: Next (walk) | `keys.js:65`; `keys_controller.js:196` | | gap | keys.mjs g f: app goes to /q/<n>, Turbo to /walk (P3) |
| key-go-session | `g 1…9`: sidebar session n | `keys.js:67`; `keys_controller.js:199` | | ok | keys.mjs g 1 |
| key-desk-switch | `d 1…9`: desk n (not on Agents) | `keys.js:68`; `keys_controller.js:198` | | todo | |
| key-session-next | `.`: next session | `keys.js:69`; `keys_controller.js:200` | | ok | keys.mjs . |
| key-session-prev | `,`: previous session | `keys.js:70`; `keys_controller.js:201` | | todo | |
| key-pen | `p`: the pen on the paper | `keys.js:71`; `keys_controller.js:202`; `paper.js:339` | | ok | keys.mjs p; S:pad |
| key-rail | `[`: fold/open the sidebar (wide only) | `keys.js:72`; `keys_controller.js:203` | | ok | keys.mjs [ |
| key-back | `u` / `⌫`: newest toast's Undo | `keys.js:73`; `keys_controller.js:204` | | todo | |
| key-theme | `t`: light/dark | `keys.js:74`; `keys_controller.js:205-210` | | ok | keys.mjs t |
| key-field-leave | `Esc` in a field: leave it | `keys.js:75`; `keys_controller.js:211` | | todo | |
| key-rules | rules: no Ctrl/Alt/Cmd except Ctrl+K; nothing while typing (Escape only after the field's own handler); nothing while a dialog / `[data-owns-keys]` / video / open details has it; Enter/Space on controls are theirs; held keys repeat only moves | `keys_controller.js:96-106,270-308` | type `j` in a field → no move | todo | |
| key-sequence-chip | `g` / `d` shows a chip of what may follow, 1.6 s | `keys_controller.js:244-264` | state keys-pending-g | todo | |
| key-mark-keep | the mark survives streams and visits (`sessionStorage['trommi-mark']`), moves to the row that took a gone card's place; a clicked row becomes the mark; caps Y/N/L/U on the marked row | `keys_controller.js:53-95,313-317` | answer the marked row → next row marked | todo | |
| key-mac | on a Mac the sheet and jump show ⌘ | `keys_controller.js:131-132`; `menu_controller.js:23` | | todo | |
| key-fields | field keys: card field Enter sends; Revise Enter/Escape; option note Enter blurs; composer Enter/Ctrl+Enter; memo Enter sends, Esc puts away; jump Enter/↓; menu ↑↓ Home End; stack search Esc; files drawer Esc; pops Esc | `card_controller.js:57-60,117,123-127`; `composer_controller.js:35-40`; `memo_controller.js:18-21`; `memos_controller.js:23-30`; `menu_controller.js:74-92`; `stack_search_controller.js:30-37`; `files_controller.js:34-36`; `pops_controller.js:44-50` | each | todo | |

## Agents page (ledger), crowns, desks, groups

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| ag-route | `/agents`: "N of M sessions are connected.", lines in the board's order, mains with subs, "Disconnected", "Archive" | `views/agents.mjs:146-190,204` | load | ok | S:agents (crypto row buttons shifted, P3) |
| ag-line | line: grip (up/down), drawing (picker) + crown, name (rename) + tell-apart second line + group chip, state (ring/hand, asks/working/idle/away/stopped + why), asks (first question link, "+N", Choose) or does, model, machine, last seen, actions | `views/agents.mjs:87-132` | compare with fixture sessions | ok | S:agents |
| ag-sort-find | column heads sort (`?sort=…&down=1`), find field (`?find=`), "Back to your order" / "Show all"; "No session fits." | `views/agents.mjs:162-189` | `/agents?sort=state` | todo | |
| ag-rename | rename form posts `/sessions/<id>/edit label` (given name clears the label); live in sidebar | `views/session-edit.mjs:20-24`; `views/agents.mjs:219-222` | test `dev/turbo-ui-test.mjs:539-543` | todo | |
| ag-drawing | drawing grid (lazy frame `/sessions/<id>/marks`) posts `icon`; agent's icon no longer overrides | `views/session-edit.mjs:30-44`; `views/agents.mjs:206-211`; `server.mjs:3145-3150` | pick → sidebar drawing changes | todo | |
| ag-crown | crown toggle `/sessions/<id>/star`: one crown per desk, taken from the other; taking it off leaves the desk without; archived loses it | `views/agents.mjs:119,240`; `server.mjs:3164-3178,3139` | test `dev/turbo-ui-test.mjs:545-552` | todo | |
| ag-main | "Main agent" pick (`parent`), one level; subs stand under their main in sidebar and ledger | `views/agents.mjs:110`; `views/model.mjs:50-56` | set main → row nested | todo | |
| ag-desk-move | desk pick (more than one desk) moves the session with its group and cards; a sub cannot move alone | `views/agents.mjs:111`; `server.mjs:3155-3160` | move to Test → disappears from main | todo | |
| ag-pair | "Lay together with…" (`/pair with=`) / snip (`/unpair`): group chip "with X + Y"; a group of two dissolves | `views/agents.mjs:104-107,242-259` | pair two → chips | todo | |
| ag-archive | archive (offline only) → toast "Archived" Undo; Archive group with "Fetch back"; online refused | `views/agents.mjs:115,135-143,268`; `server.mjs:3135-3139` | archive offline session | todo | |
| ag-move | up/down among its kind (`/sessions/<id>/move dir`) → sidebar order | `views/agents.mjs:122,230-239`; `server.mjs:1976` | move up → sidebar order | todo | |
| ag-open-walk | open conversation icon; questions-walk icon `/q/<n>?walk=1` | `views/agents.mjs:112-113` | click | todo | |
| ag-phone-sheet | phone: line = mark, name, state, "…"; sheet with every action | `views/agents.mjs:69-84` | state agents-phone-sheet | todo | |
| ag-errors | refused change said in the line ("Not saved: …"), 422 page without scripts | `views/agents.mjs:262-277` | archive an online session | todo | |
| ag-live | changed line replaced; lines come/go/reorder → page refreshes (keeps sort/find); open pickers hold the stream | `views/agents.mjs:279-298`; `pops_controller.js:63-72` | rename elsewhere while open | todo | |
| ag-desks-menu | menu desks with "N open" (+ knock on another desk), D n caps; "+" new desk (`POST /desk`) goes there with toast "Desk added" Undo (removes it) | `views/menu.mjs:17-21,36-39`; `t/controllers/menu_controller.js:100-130`; `server.mjs:3567-3602` | state menu-new-desk | todo | |
| ag-sidebar-folds | a main with subs is a folded stack (≤ 7 edges, lean fan on hover); crown/edges unfold, pen bracket; open state per browser `trommi-crowns-open` | `views/sidebar.mjs:38-53`; `application.js:57-107`; `t/controllers/lean_controller.js`; `views/layout.mjs:35` | state sidebar-subs-open | todo | |
| ag-sidebar-live | sidebar rows replaced one by one while the shape stays; "Disconnected" heading | `turbo.mjs:313-321`; `views/sidebar.mjs:56-68` | agent disconnects → row moves under heading | todo | |

## Toasts and undo

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| toast-shape | one quiet line top right: head + line, Undo (U) as a form (`stay=1 quiet=1`), scribbled time line | `views/toast.mjs:21-28` | any answer | ok | S:toast-after-answer |
| toast-heads | Answered (t → labels), I don't give a duck, Read, Shredded, Snoozed (Undo wake), Handed back / Asked: What?? (Undo takeback), Message sent (no Undo) | `turbo.mjs:79-89` | each way | ok | S:toast-after-answer (2nd pass) |
| toast-timing | ~5 s, pauses under the pointer, max 3 stacked newest on top, survives page changes; gone once Undo is pressed | `application.js:29-53` | hover keeps it | todo | |
| toast-others | Memo sent (hold), Note thrown away, Archived, Test cards made/removed, Desk added, Link copied, Not saved/Not sent alerts | `views/memo.mjs:122,131`; `views/agents.mjs:268`; `server/fixtures.mjs:226,233`; `t/lib/toast.js:76-102` | each | todo | |
| toast-picked | a pressed tile shows `is-picked` until the hub answered | `application.js:218-219` | slow network | ok | S:toast-after-answer (2nd pass) "→ Löschen" |

## Layout, phone, dark

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| lay-frame | topbar Desk pill (drawing, bell, desk name, count/hand), Trommi pill menu, Agents button, sidebar, says-host, keys sheet, memo layer, stream | `views/layout.mjs:38-95` | Desk at 1440x900 | todo | |
| lay-desk-state | pill count with arrow → walk, ringed when knocking; red hand → the stopped session (or Agents if several) | `views/sidebar.mjs:74-86` | stop two sessions → hand → /agents | todo | |
| lay-rail | `|<` at sidebar foot or `[`: folded rail, remembered (`trommi-rail`), set before paint; names as tips beside rows | `views/layout.mjs:32-34`; `t/controllers/rail_controller.js:16-59` | state rail | ok | S:rail |
| lay-card-fixed | card page is one block of fixed height, two columns; under ~860 px answers under pictures | `views/card.mjs:1-12`; `css/cardpage.css` | 1440 vs 390 | todo | |
| lay-phone-breakpoint | phone ≤ 860 px: sidebar a sideways strip (bracket under subs), no rail, no pointto | `application.js:76,85`; `rail_controller.js:9`; `pointto_controller.js:11` | 390x844 | ok | S:* phone-light/phone-dark (strip 7 px taller, P3) |
| lay-phone-row-sheet | phone long press (450 ms, 10 px slop) or right click on a row: sheet Snooze/Revise/duck/What??/Shred/Open; armed after lift | `views/menu.mjs:77-85`; `t/controllers/sheet_controller.js:18-79` | state row-sheet-phone | todo | |
| lay-phone-files | phone: Files in the session filter menu, drawer as bottom sheet | `views/session.mjs:226,234` | test `dev/turbo-ui-test.mjs:496` | todo | |
| lay-phone-memo | phone memo sheet | see memo-phone | | todo | |
| lay-phone-roster | phone Agents button in the bar | `views/layout.mjs:45` | 390x844 | todo | |
| lay-phone-composer | memo button does not cover the composer | test `dev/turbo-ui-test.mjs:745` | 390x844 session | todo | |
| lay-dark | theme from `localStorage['agent-board-theme']` before first paint; `#theme-toggle` (sun/moon) or `t` flips `html[data-theme=dark]` | `views/layout.mjs:30`; `application.js:240-244`; `keys_controller.js:205-210` | toggle, reload → kept | ok | S:* desktop-dark/phone-dark real room (2nd pass) |
| lay-tones | session hue tones on rows, gutter, avatars (`--hue`) | `views/model.mjs:16`; `views/desk.mjs:74-75` | two sessions differ | todo | |
| lay-reduced-motion | no row slide, wipe, arrow drawing or lean under reduced motion | `application.js:22,208`; `clear.js:46`; `pointto_controller.js:66` | emulate | todo | |
| lay-pen-drawings | hand-drawn icons (sketchSvg), doodles, crown, hand, ring from `client/web/js/pen.js`; sober inside conversations | `views/*.mjs` imports of `js/pen.js` | visual | ok | S: drawings and icons same on cards |
| lay-says-pos | toast host fixed top right, same on phone | `views/layout.mjs:88` | 390x844 | todo | |

## Push and PWA

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| push-toggle | menu bell `#push-toggle`: asks permission on the click, registers `/sw.js`, subscribes, `POST /push/subscribe`; says why not (http, iPhone not installed, blocked) | `client/web/js/push.js:1-40`; `views/menu.mjs:41`; `server/push.mjs:249-258` | https + click → subscribed | ok | S:menu (2nd pass) |
| push-options | title vs "Something knocks"; ring for new cards while away (5 min) | `js/push.js:5-8`; `server/push.mjs:56-63` | toggle options → `/push/state` | todo | |
| push-test | test notification `/push/test` | `server/push.mjs:268-272` | → "Push works on this device" | todo | |
| push-knock | a knock (high/critical/permission) rings when no page open; new cards burst-ring; a session newly stopped rings once | `server/push.mjs:66-128,190-215` | close tabs, agent files critical → notification | todo | |
| push-click | tap on notification opens the board at its url | `client/web/sw.js:21` | tap | todo | |
| push-unsubscribe | switching off → `/push/unsubscribe` | `server/push.mjs:259-261` | | todo | |
| pwa | manifest, theme-color, icon, iOS standalone needed for push | `views/layout.mjs:62,69-70`; `client/web/manifest.webmanifest` | Add to Home Screen | todo | |

## Agent MCP tools

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| tool-reply | text, html, details, attachments (path or {path,page,title,mark(s)}), card_id, present | `server.mjs:1111-1129,1656-1671` | each field visible in log / card thread | ok | R r14 reply→visible 65 ms |
| tool-create-decision | title + body/options or sections/text, html, attachments, urgency(+reason), multiple, recommended; returns id, Nr., place, hints | `server.mjs:1131-1141,1673-1679` | rt-basic | ok | R |
| tool-create-info | info card; info_read on close | `server.mjs:1143-1160,1681-1686` | ip-info-read | ok | R r11 |
| tool-revise-card | rewrite in place; version history; presents after hand-back; marks kept on re-attached pictures | `server.mjs:1162-1174,1688-1761` | rt-handback | ok | R r06 |
| tool-merge-cards | ≥ 2 open questions → one at the oldest's place | `server.mjs:1176-1187,1763-1797` | rt-merge | ok | R r13 |
| tool-set-urgency | low/normal/high/critical + reason | `server.mjs:1189-1200,1799-1811` | rt-urgency | ok | R r13 |
| tool-withdraw-card | moot open card → done "Withdrawn" | `server.mjs:1202-1212,1813-1827` | rt-withdraw | ok | R r13 |
| tool-close-card | done with summary (also open cards, see interface.md §7) | `server.mjs:1214-1224,1829-1839` | rt-close | ok | R r01 |
| tool-set-status | status line create/update | `server.mjs:1226-1239,1841-1859` | st-working | ok | R r14 (2nd pass) |
| tool-clear-status | one or all lines | `server.mjs:1241-1244,1861-1864` | st-clear | todo | |
| tool-introduce | model, task, icon, parent, main | `server.mjs:1246-1259,1865-1875` | st-introduce | ok | R r14 |
| tool-create-voiceover | text → MP3 path | `server.mjs:1261-1271,1876` | med-voiceover | todo | |
| tool-list-cards | JSON of own cards incl. queue_position, version, with_agent | `server.mjs:1273-1276,1878-1889` | compare with Desk order | todo | |
| tool-publish-asset | encrypted asset link (in the channel process) → asset card | `server.mjs:1278-1292,1928` | med-asset-card | gap | R r15: announced in the session now; no link for people outside yet (designed, open) |
| tool-list-assets | own assets | `server.mjs:1294-1297,1890` | | todo | |
| tool-revoke-asset | delete ciphertext, link dead | `server.mjs:1299-1302,1892-1897` | med-asset-gone | todo | |
| tool-adopt-session | main takes an existing session as sub (same machine) / release | `server.mjs:1304-1314,1899-1912` | sub under main in sidebar | todo | |
| tool-share-asset | outside release `/r/<id>#key`, expiry, keep | `server.mjs:1316-1327,1914-1926` | card "Shared" | todo | |
| tool-permission-request | (from Claude Code) approval → card | `server.mjs:1934-1975` | ip-permission | ok | R r12 |

## Channel events to the agent

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| ev-chat | `chat`: composer/memo message; content = text or file line; meta files, image_path | `server.mjs:3201-3217,3236` | sess-composer | ok | R r14 composer→`chat` 31 ms |
| ev-chat-card | `chat card_id`: question back from the card field | `server.mjs:3191-3193` | rt-ask-back | todo | |
| ev-chat-handback | `chat card_id handback=1` | `server.mjs:3194-3196` | rt-handback | ok | R r06 |
| ev-chat-explain | `chat card_id explain=1` | same | rt-what | ok | R r07 |
| ev-chat-marks | `chat marks=N` + "Notes pinned to the card:" (card field with marks) | `server.mjs:3186-3187,3208` | draw + send | todo | |
| ev-chat-cards | `chat cards=… cards_json=…` copied cards (old client only, finding 6) | `server.mjs:3189,3211` | old `/message {cards}` | todo | |
| ev-decision | `decision card_id choice` (+ `choices` multiple, `option_notes`, `marks`, `files`, `image_path`) | `server.mjs:2158-2172` | rt-basic, rt-multiple, rt-notes | ok | R r01/r03/r04 |
| ev-decision-trust | `decision trust=1 choice=<recommended or "">` | `server.mjs:2199-2205` | rt-trust | ok | R r08 |
| ev-reopened | `decision_reopened previous_choice` (+ previous_choices) | `server.mjs:2428-2433` | rt-reopen | ok | R r02 |
| ev-reopened-trust | `decision_reopened trust=1` | `server.mjs:2414-2417` | rt-trust-undo | todo | |
| ev-reopened-shredded | `decision_reopened shredded=1` | `server.mjs:2391-2394` | rt-shred-undo | todo | |
| ev-shredded | `shredded card_id` (+ marks, files) | `server.mjs:2228-2237` | rt-shred | ok | R r09 |
| ev-handback-withdrawn | `handback_withdrawn card_id` | `turbo.mjs:145-148`; `server.mjs:3669-3672` | rt-handback-takeback | todo | |
| ev-info-read | `info_read card_id` | `server.mjs:2335-2338` | ip-info-read | ok | R r11 |
| ev-pad | `pad pad message_id elements image_path` | `server.mjs:1419-1422`; `server/pad.mjs:276` | pad-send | todo | |
| ev-scribble | `scribble scribble_id image_path canvas_path canvas_doc` (old client canvas) | `server.mjs:2371-2374` | scribble-old | todo | |
| ev-permission | `notifications/claude/channel/permission {request_id, behavior}` | `server.mjs:2154-2156` | ip-permission | ok | R r12 |
| ev-none | no event for snooze/wake, read taken back, drafts, crown, rename, archive, memo put away | `server.mjs:2287-2321,2398-2403` | watch link stays silent | todo | |

## Admin, pairing, auth, dev

| id | what | turbo code | how to check | status | evidence |
|---|---|---|---|---|---|
| auth-token | `?t=<token>` sets the cookie and redirects to the same path without it | `server.mjs:3373-3381` | open login link | todo | |
| auth-401 | no cookie: Turbo pages get the passkey sign-in page (401) or plain "Access only through the link…" | `server.mjs:3400-3404`; `turbo.mjs:385` | private window `/` | todo | |
| auth-origin | every non-GET needs same Origin (403) | `server.mjs:3405` | POST without Origin | todo | |
| auth-passkeys | `/auth/passkey*`, `/passkeys` page (add, list, remove) | `server.mjs:3394-3397`; `server/passkey.mjs:226-227` | sign in with passkey | todo | |
| auth-pairing | `/pair/*` (BOARD_PAIRING=1): room, found, entry, log, challenge, sign-in, wraps, invites, envelopes, claim | `server.mjs:3386-3392`; `server/pairing.mjs:116-142` | with flag set | ok | R r16: 2nd device joins with 6-digit check code, answers from the phone; live 4.4 s join |
| auth-agent-door | `/agent/link`, `/agent/tool`, `/agent/asset`, `/agent/profile`, `/agent/permission`: loopback + `x-board-token` | `server.mjs:2594-2680,3372` | linkSession | todo | |
| admin-page | `/admin.html` behind its own key: overview, sessions (forget, clear queue), cleanup, links, export, diagnose, token rotate | `server.mjs:2971-3018,3406`; `client/web/js/admin.js` | Dev → Admin | todo | |
| help-page | `/help.html` (+ `#keys`): how it works, keys, tools and events from `/api/tools` | `server.mjs:3423-3426`; `client/web/js/help.js` | menu Help | ok | S:help (2nd pass, real room); P3: "FOR AGENTS" section link missing |
| dev-fake | Dev: "Create 5 fake decisions" / "Remove fake decisions" (`POST /dev/fake-decisions`), then the Desk | `views/menu.mjs:42`; `menu_controller.js:133-145`; `server.mjs:3558-3566` | click → 5 Demo rows | todo | |
| dev-fixtures | Dev: "Create test cards" (`POST /dev/fixtures`, desk Test, toast with Remove) / "Remove test cards" | `server/fixtures.mjs:198-236`; `t/controllers/fixtures_controller.js:12-15` | click → Desk "Test" | todo | |
| dev-links | Dev: All screens (`/screens.html`), Old board (`/old/`), Admin | `views/menu.mjs:42` | links work | todo | |
| health | `/healthz` → `{ok:true}` without login | `server.mjs:3371` | curl | todo | |

## What the Hub v1 protocol (README "Hub v1: the wire protocol") covers of the above

- **Covered by the body/registers:** cards decision/info with sections, html, options, multiple, recommended,
  urgency(+reason), attachments with page/caption/marks (`object_version` card); revise = new object version with
  `change_note`; merge (`merged_into_object_id`, `merged_from_object_ids`); withdraw/close (`withdraw_reason`,
  `close_summary`); answers incl. read/shred/trust, option notes, marks, files (`answer`); decide again
  (`decide_again`); permission request/verdict; chat messages with `hand_back`, `explain`, `present_card`,
  `copied_cards`, `marks`; status lines (`status_line/<id>`), profile (model, task, icon, parent, main); human
  registers draft, snooze, duck, crown, desks, session settings (name, desk, archived, group, icon), read markers;
  memos (`object_type memo`); published assets with `released_until`; canvas strokes and `selection_sent`
  (pad send, "send_away"); push subscriptions (`send_push`, `/push_subscriptions`). Projections computed by the
  client: Desk order, stacks, crowns, Next line, "in revision".
- **Not (or not explicitly) covered:** taking a hand-back back (`handback_withdrawn`, no message flag named); session
  order (`before`) in the session register; speech / read aloud and voiceover; set_status auto-yellow on answer
  (projection rule not stated); per-session memo scope (`memo` body has `desk_id` only); memo hold-and-unsend window;
  archive's crown drop and "online cannot be archived"; asset revoke; the dev routes (fake decisions, fixtures);
  Agents page sort/find (client-only); passkeys and today's token login (replaced by device keys); the old-client-only
  views (scribble per session, sessions laid together, `/pad` overlay); `adopt_session` (as profile `parent_session`
  only).

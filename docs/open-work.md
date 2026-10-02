# Open work: what was decided and is not in the code

Audit of 2 October 2026, looked at between 12:47 and 12:57 (CEST). No app code was changed, nothing was committed,
nothing was written to the live board.

**How it was checked.** The board was read with `node server/board-store.mjs export data` (110 cards at 12:47, 113 at
12:56; every decided card and every message of Christopher's). The code was read at the lines named below. The app was
looked at on throwaway boards started by `dev/ui-test.mjs --script` (own free port, own temporary data folder, stopped
by the suite itself), in headless Chromium at 1440x900, 1024x768 and 400x860. Screenshots are in
`docs/qa-shots/open-work/`.

**Workers were editing while this was written.** The Desk changed between two of my screenshots (12:49 and 12:56,
`desk-1249.png` and `desk-1256.png`). Every row names the time its file was looked at. Line numbers will have moved.

**Count:** 32 done, 12 half, 10 missing (12 when the three Fizzy points of row 3 are counted singly), 3 not
verified or to confirm (rows 22, 23, 25), 4 changed after the brief and to be confirmed (section 2). Six questions
wait on Christopher and are no work yet (section 4).

## 1. Open, most important first

| # | What he asked | State | Evidence (time looked) | Owner | Next step |
|---|---|---|---|---|---|
| 1 | "Trust/Shred/Snooze/Revise server flags" | **missing** for Snooze | Snooze lives in this browser only: `client/web/js/store.js:24,169-177` (`localStorage` key `trommi-later`); `server/server.mjs` has `/decide {trust}`, `/shred`, `/handback` (2824-2884) and no snooze route (12:50). A card snoozed on one device is open on the next. | Server, then Web UI (`store.js`) | `POST /snooze { card_id, off }` sets `card.snoozed`; `putOff()` calls it; move the local list over once. |
| 2 | "Nur einer kann die Krone in einem Raum haben" (12:25, card Nr. 134) | **missing** | `server/server.mjs:2812-2817` sets `starred` and leaves the others; on the test board two sessions were crowned at once (both `/star` calls 200). `client/web/js/quicksend.js:62-75` is written for several crowns. `quicksend.png` (12:53) | Server, Web UI (`quicksend.js`) | `/star` with `starred: true` takes the crown from every other session; drop the "another crowned session" switch. |
| 3 | Fizzy takeovers he ruled on in card Nr. 87: "entwickeln unseren eigenen" circle, "Farben so nicht", "Empty State Box neu entwickeln" | **missing**, all three | Circle: `css/app.css:699-700` still carries Fizzy's two `border-radius` values character for character (the ring round the count). Colours and shadow: `--card-color` is in `css/app.css` 24 times (728, 739-741), the three-layer shadow at 737, `css/focus.css:998`. Empty state: `css/app.css:1003` is still the dashed box turned 2 degrees (12:51). The board says "erledigt"; that meant decided, not built. | Web UI (`app.css`, `ui.js`), Focus (`focus.css`) | Draw the count ring with the pen (`ring()` in `agents.js` already does it); rename and rebuild the card colour from `--urg-*` pairs; replace the box with a drawing and the sentence. |
| 4 | "Shred ist, wenn ich Shift gedrückt halte" (11:58) | **half**: lost when the four tabs went | `js/bar.js:137-141` still sets `body[data-shift]`; `js/inbox.js:517` hides every tab but Snooze, so holding Shift shows nothing. `shift-held.png` (12:53). Key `X` still shreds. | Web UI (`inbox.js`, `app.css`) | While Shift is held, show the Shred tab in place of Snooze (one tab at a time, not four). |
| 5 | "When does a Later card come back?" → "When the rest is done, and next morning at the latest" (card Nr. 100) | **missing** | `js/inbox.js:889` only builds the folded pile "Snoozed"; nothing wakes a card. With an empty Desk the page says "As soon as an agent has a question, it shows up here." (`inbox.js:915`) even when cards are snoozed (12:55). | Web UI (`inbox.js`, `store.js`); needs row 1 for the morning rule | When nothing else is open, lay the snoozed cards out again; with the server flag, clear it the next morning. |
| 6 | "Scribble ist Teil des Chats: man kann in dem Chat direkt scribbeln oder an der Answer" (11:54) | **half** | The opened card has the pen (`js/focus-marks.js:100`). The session's composer has paperclip, microphone and Send, no pen (`js/chat.js:466-470`, probe 12:49). The session still has a separate "Scribble" tab (`index.html`, `#mode-scribble`). | Conversation (`chat.js`) | Put the small pad into the chat composer as the card has it; ask him whether the Scribble tab goes. |
| 7 | "Rechts ist nur die Conversation. Man kann die schmaler schieben und ganz einklappen" (11:54) | **missing** in the joined view | `css/beside.css:42` gives the conversations a fixed `--talk-w`; no handle, no fold in `js/beside.js` (12:52). `joined.png` | Layout (`beside.js`, `beside.css`) | A drag edge that sets `--talk-w`, and a fold to a strip; remember both per browser. |
| 8 | Opened card: "field at the foot" | **half**: not on a phone | At 400x860 the field stands in the middle (y 422), above the options; the four symbols are at the foot. `phone-card.png` (12:53). Desktop is right (`card-thread.png`). | Focus (`focus.css`) | On a phone: decision, thread, options, symbols, then the field fixed at the lower edge. |
| 9 | (his rule: nothing lies over what one presses) | **half** | Phone Desk: the two floating buttons lie on the right answer tile (`phone-desk.png`, 12:49). Joined view at 12:53: the "Scribble" tab lay under them (probe: `mode-scribble under quick-open`); the header moved again by 12:55, not rechecked. | Web UI (`app.css`, floating buttons), Layout | Keep the floats clear of tiles and tabs at every width; add a check to the suite. |
| 10 | "crown clickable only in session title/Agents page" | **half** | Sidebar: no switch (0 `.crown-toggle` in `#agents`), title and Ledger have it (probe 12:53). But quick send crowns too: `js/quicksend.js:91-100` ("crown it"). | Web UI (`quicksend.js`) | With no crown, quick send says where to crown and links to the Agents page; no crowning in its list. Wait for card Nr. 134 if the whole quick send is replaced. |
| 11 | "Next, please" form: "five form proposals pending" | **missing** on the board | The page exists (`client/web/designs/walk-form.html`, five pictures `walk-form-*.png`); no card asks for it (board at 12:56: newest are Nr. 141 menu, Nr. 142 card and notes). | Design | File the question with the five pictures. |
| 12 | Server: "Nachrichten-Log" (card Nr. 33) | **missing** in the running hub | `server/store/README.md:3`: "Not used by `server.mjs` yet". `server/board-store.mjs` keeps the state as rows; there is no running number and no "give me what I missed" (12:50). | Server | Wire `server/store/store.mjs` in, or add `seq` to messages and a `since` on `/events`; decide which before card Nr. 131 is answered. |
| 13 | Server: "Stabile Agenten-IDs" (card Nr. 80) | **missing** | `server/server.mjs:319-330`: the id is still the slug of the name (12:50). | Server | An id the hub makes once and the session keeps; the name becomes a label. |
| 14 | Server: "Kopplung und Schlüssel" (card Nr. 80) | **missing** in the hub | `crypto/hub.mjs` exists and is tested; `server/server.mjs` does not import it (grep, 12:56). | Server (with Crypto) | Wire the pairing routes in behind a flag. |
| 15 | Sub-sessions (card Nr. 123: "Ich gebe es frei") | **missing**, blocked | No `open_session` in `server/server.mjs`. The main session wrote at 12:45: the release must be said in the Claude prompt, not on the board. | Server; first Christopher | Ask him once for the sentence in the prompt; then build. |
| 16 | "Whatever" for Trust, "Snooze" for Later, "Desk" for Inbox | **half**: old words left | "Trusted": `js/inbox.js:217,678,896`, `js/focus.js:1739`, `js/chat.js:231` (seen on screen as "TRUSTED"). "Later": `js/focus.js:223-225` (button label), `js/focus.js:1560` ("waits under Later"). "Inbox": `index.html:93` (12:52). | Web UI, Focus, Conversation | One pass over the strings; "Trusted" needs a word from him or stays (`docs/naming.md` says "for now"). |
| 17 | "Hand! and underline we keep for important stuff the agent wants to say" (card Nr. 90) | **half** | Underline is built (`js/ui.js:140-162`, `__words__`); `pointingHand()` is kept unused (`js/ui.js:927`). | Web UI (`ui.js`); Server for the instruction line | Give the agent a mark for "important" that draws the hand, and tell agents in the channel instructions. |
| 18 | "Desk entry shows knocks and N working" | **half** | "4 working" is there. The badge shows the knock drawing with the total (22), not the knocks (5): `js/agents.js:244-249`. `desk-1249.png` | Web UI (`agents.js`) | Knock drawing with the number of knocks, the total beside it or in the tooltip. |
| 19 | "keys for all of it" | **half** | The table covers Revise, Whatever, Shred, jump and the Ledger (`js/keys.js` `LAYOUT`, 12:51). No key copies a decision (`js/cardclip.js` has none). `dev/keys-test.mjs` was not run by me. | Keyboard (`keys.js`) | A key for copy on a row and in the card; run `dev/keys-test.mjs`. |
| 20 | (QA) the suite follows the app | **half** | `node dev/ui-test.mjs --size desktop` at 12:51: 470 passing, 20 failing, 1 pending (`docs/qa-shots/open-work/ui-test-1251.txt`). Checked by hand on a fresh board at 12:55: the session's questions are in the conversation, a note typed in the foot field goes along with the answer, `X` shreds the card in front. So most failures are the suite expecting "Discuss", the old pile and the old session page. | QA (`dev/ui-test.mjs`) | Bring the walk, later, session and urls groups up to today's card and session page; run phone size too. |
| 21 | (bug from that run) | **half** | Agents page: after an answer in a line, "Back" lies under the page head (`says-back` covered by `header.ledger-head` at 473,43). | Layout (`ledger.css`), Keyboard (`back.css`) | Put the note where the Ledger's head does not cover it. |
| 22 | Phone bugs from `docs/qa-report.md` | **not rechecked** | Open there at 11:47: a tap on a short tag hits its pencil (high on a phone); the crown in the phone strip cannot be tapped. | Focus (`focus.js`, `focus.css`), Web UI | Recheck both on 400x860 with touch; the first one blocks answering. |
| 23 | Hub restart (card Nr. 97: "wait") | **not verified** | `server/server.mjs` was saved at 12:53. Info cards, the agent's own symbol, `cards` on messages and the new paths need the running hub to be that file. I did not touch the live hub. | Main thread / Ops | Ask him for the restart once the UI round is quiet. |
| 24 | Left-over scaffolding | **half** | Still built and hidden: the old roster (`STATUS-ui.md`: "left for QA and the Layout worker"), `.footnav` with `#nav-inbox`, `#focus-open`, `#filter-questions`; `js/beside.js:1-12` still describes the side column that is gone. | Web UI, Layout, QA | Remove them together with the suite's selectors in one pass. |
| 25 | "no bottom bar" | **to confirm** | Wide screens: none. A phone in a session still has a bar at the foot with Conversation and Scribble (`phone-session.png`, 12:53). | Web UI; first Christopher | Ask with a picture whether the phone's two tabs stay. |

## 2. Changed by a worker at 12:53, after the brief I was given: confirm his latest word

| What the brief said | What the app showed at 12:56 | Evidence | Owner | Next step |
|---|---|---|---|---|
| "Desk is the inbox word" | The page heading no longer says Desk; it reads "Next, please (20)". Desk stands only in the sidebar. | `desk-1256.png`; at 12:49 the heading was "Desk · 5 knocks · 22 on your desk from 5 agents · Next, please" (`desk-1249.png`) | Web UI (`inbox.js`) | Confirm that the heading may drop the word. |
| "Next, please as inline words (button disliked)" | The whole heading is the button now. | same | Web UI, Design | Same question; row 11 (the five forms) settles it. |
| "the gutter beside Desk rows shows the sender's drawing only, no bracket line" | No gutter at all: each card carries its session's drawing before the title and takes the session's colour. The link "from 5 agents" to the Agents page went with the sentence. | same; bracket gone in both | Web UI (`inbox.js`, `app.css`) | Confirm; if it stays, the Agents page needs another way in from the Desk. |
| Card colours (row 3) | Cards are now tinted by session through the same `--card-color` mechanism the audit calls Fizzy's. | `desk-1256.png`, `css/app.css:728` | Web UI | Do row 3 before building further on that variable. |

## 3. Done (checked today, time in brackets)

| What he asked | Evidence |
|---|---|
| Desk as the word | `INBOX_WORD = 'Desk'`, `js/ui.js:802`; sidebar and tab title (12:49) |
| Sidebar stays; rings with the count; red ring with the hand for a knock; a stroke running round while working | `desk-1249.png`; `js/agents.js` `badge()`, `ring()` (12:49) |
| "N working" under Desk; no SESSIONS heading | `desk-1249.png` ("4 working"; only "Disconnected" is a heading) |
| No bracket line beside the rows | 0 bracket nodes (12:49) |
| Cards taller, picture stack under the text, small clock beside the title, number on hover | rows 172 px; `.inbox-nr` opacity 0, visible under the pointer (12:49) |
| Choose tile says only "Choose" | tile text "Choose" (12:49) |
| Piles are one line: word and tally | folded pile shows tally and "Snoozed" only, 21 px high (12:53) |
| One Snooze tab on the row | `js/inbox.js:514-517`; the other three are hidden (12:51) |
| Opened card: no side column, decision on top, thread below, field at the foot (desktop) | `card-thread.png`; no `aside` (12:53) |
| Buttons fixed at the right: Snooze, Revise, Whatever, Shred, wordless | order measured left to right at x 1030, 1099, 1168, 1237 (12:49) |
| One place to write; a note on a paragraph only through the pencil; pen only in drawing mode | `js/focus-marks.js:100,126,174-180`; a note typed in the foot field arrived as the answer's note (12:55) |
| Revise with nothing written asks "What should change?" | `js/focus.js:1933-1939`; placeholder seen after the click (12:53) |
| Session page: questions inline in the stream, no column | 6 of 6, 7 of 7, 4 of 4 open questions are rows in the log; `.pane-questions` not shown (12:55) |
| Joined sessions: stacked, one combined list | `joined.png`: one list of 13, two conversations one above the other (12:49) |
| The menu's panel is aligned and not clipped | panel 244 px wide, centred under the pill at 1440 and 1024, at x 12 on a phone (12:49, 12:53). Its place is card Nr. 141. |
| Logo: scribbled Z in an open ring | `index.html:64-68` (12:52) |
| Whatever is the shrugging figure | `js/ui.js:755-756,789`; seen in the card (12:49) |
| Copy a decision into another session | `js/cardclip.js`; copy on the row, "Paste decision Nr. 20" offered in another session's composer and in quick send; `cards` in `server/server.mjs:988` (12:53) |
| Composer takes paste, drop, attach | `js/chat.js:466-470,893-898`, `js/quicksend.js:145-148`, `js/focus.js:625-657` (12:51) |
| Real URLs `/q/N` and `/walk` | `server/server.mjs:2617`; both opened with 200 and the right view (12:49) |
| Crown: no switch in the sidebar, a switch in the session title and on the Agents page | probe 12:53 |
| Agents pick their own symbol | `introduce` with `icon`, `server/server.mjs:435-446,885-891` (12:50) |
| Info cards with What?? and Acknowledge | row tiles and opened card (12:53); `create_info`, `/close` |
| Server flags for Whatever, Shred, Revise | `server/server.mjs:2824-2884` (12:50) |
| Hub state in SQLite | `server/board-store.mjs`, `server/server.mjs:141-155` (12:50) |
| No bottom bar on wide screens | no bar at the foot; two floating buttons (12:49) |
| Agents page is the Ledger | 6 lines, old roster hidden (12:49) |
| Knocks for urgent and blocking; knock sound switch in the menu | "Knock! Blocking" tab, title "(5 knocks) Trommi" (12:49) |
| Admin linked | menu entry "Admin" (12:49) |
| Advice as a marker swipe | seen on "In batches" in the opened card (12:49) |
| Card numbers back | "Nr. 20" on rows and in the walk (12:49) |
| `X` shreds the card in front of the walk, with the way back | strip "Shredded · … Back" (12:55) |

## 4. Waiting on Christopher (no work until answered)

| Card | Question | Proposals |
|---|---|---|
| Nr. 138 | Fewer buttons: in the card, on the row | `/designs/simple-merge.html` and five more |
| Nr. 141 | Desk and menu: where? | `/designs/menu-top.html`, six pages |
| Nr. 142 | How do card and notes meet? | `/designs/card-unfold.html`, five pages |
| Nr. 134 | Quick send to the boss | `/designs/quick-pad.html`, ten pages |
| Nr. 131 | Stack for hub and web app | one proposal left: Node and plain modules; rows 12 to 14 and the rebuild approved in card Nr. 115 hang on it |
| Nr. 133 | Name for America | `/designs/brand.html` |

## 5. Not looked at

- The live hub on 8790 and what it serves (row 23).
- A real phone, Safari, real touch, the knock sound, dictation.
- iOS and the Linux client (parked by him), encryption beyond row 14.
- The drawn arrow from a picture to its option (card Nr. 110) and the loop round a whole group (card Nr. 117): the
  workers' logs say built; I did not recheck them.
- Whether today's work is committed: `git status` listed 174 changed or new paths at 12:56.

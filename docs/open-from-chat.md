# Open from the chat: what Christopher asked for and is not built yet

Read on 3 October 2026 from the Claude transcripts of 1 and 2 October (`b4eda040…`, `1117b1b6…`; the sessions of
28 and 29 September are about lazyheart and the status line, not Trommi) and from his messages and decided cards
on the board (`node server/board-store.mjs export data`: 118 cards, none open; 125 messages of his). Checked against
the code on `trommi-board`, the uncommitted edits of 3 October counted as built. Read only; nothing else changed.

Times are CEST (the transcript's UTC + 2), the same clock as `docs/open-work.md`. Where he changed his mind, the last
word counts; withdrawn requests are listed at the end. "Unverified" means the code does not settle it and it has to
be tried in the browser.

**Since the audit of 12:57 these are built** (not repeated below): Snooze on the server with the wake-up when the
rest is done and next morning (`server/server.mjs:1829-1849`, `store.js:30-36`); one crown per room
(`server.mjs:207-209,2876`); knocks counted on the Desk badge (`agents.js:243-258`); empty state redrawn
(`app.css:1029-1030`); Desk block lower and larger, "working" as the turning ring only (`app.css` diff); quick send
shows the receiver's drawing with its crown (`quicksend.js:2-12`); Scribble button in the composer
(`chat.js:492`); picture and option tied with the drawn arrow (`focus.js:1140-1170`); scribble gallery, region
send as picture plus strokes, eraser takes pictures (uncommitted `scribble.js`, `chat.js`).

## Web UI (inbox.js, agents.js, bar.js, ui.js, store.js, app.js, app.css)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| "Shred ist, wenn ich Shift gedrückt halte, dann kommt Shredding, ansonsten erst, wenn ich die Karte aufklappe" (11:58) | Holding Shift turns the row's tab into Shred | missing | `bar.js:151` sets `body[data-shift]`; nothing in `app.css` or `inbox.js` reads it | While Shift is held, show the Shred tab in place of Snooze |
| "Hand! and underline we keep for important stuff the agent wants to say" (10:51, card Nr. 90) | The agent can mark one passage as important and it gets the drawn hand | half | Underline built; `pointingHand()` unused (`ui.js:927`); no mark in the channel instructions | Add a mark for "important" that draws the hand; tell agents in the instructions (with Server) |
| "Die Farben so nicht… einen anderen Circle, entwickeln unseren eigenen" (11:55, card Nr. 87) | Own ring and own card colours instead of Fizzy's | half | Empty state done; `--card-color` still used 23 times in `app.css`; ring unverified | Compare with card Nr. 87's pictures; rebuild colours from own tokens |
| "desk und sessions kombinieren als workspace switcher (arbeit privat etc)" (10:27, card Nr. 104 "w2"), "Switch Desk" (12:40) | Several desks to switch between | half | Menu has "Switch desk" with one hard-coded entry (`index.html:83-86`); no desks on the server | Needs a desk model on the server first (see Server) |
| "Angeblich warten Sachen auf mich, aber im Stack ist es nicht" (13:42) | The count says questions wait, the walk shows none | unverified | QA round 3 #11: Desk counted 5 where 19 were open; snoozed cards may be counted | Reproduce on a test board; count only what the walk shows |
| "Design zeigt Hand an, obwohl nichts offen ist" (12:19) | Session shows the red hand with nothing open | unverified | none found | Check `summary()` in `agents.js` against open, snoozed and with-agent cards |
| "Wenn ich was beantwortet habe oder auf later geschoben habe… macht's manchmal zeitverzögert" (10:20) | An answered or snoozed row must leave at once | unverified | QA 3 Oct, phone: "Snooze does not move the card" (`docs/qa-report.md`, last section) | Fix on the phone; time the move on desktop |
| Old words: "Trusted", "Later" (decided Whatever, Snooze) | Same words everywhere | half | `server/server.mjs:1742` "Trusted: your call"; `focus.js:1670` "waits under Later" | One pass over the strings (server event text and Focus) |
| His rule: nothing lies over what one presses | Floating buttons clear of tiles and tabs | half | QA 3 Oct phone: the way back lies over the answer tiles; QA r3 #8 (joined view, 1000 px) | Fix at every width; keep the suite check |

## Focus & Scribble (focus*.js/css, scribble.js, chat.js composer)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| "Rechts ist nur die Conversation… Scribble ist Teil des Chats… im Chat direkt scribbeln oder an der Answer" (11:54) | Draw straight into the chat; no canvas column behind the conversation | half | Composer button opens the session canvas *beside* the conversation (`chat.js:491-492`); separate Scribble tab stays (`index.html:127`) | His decision first (see below) |
| "überall in der Entscheidung klicken und schreiben und den Stift klicken und überall scribbeln" (11:46) | Pen draws anywhere on the card | half | Built (`focus-marks.js`); QA 3 Oct: a pen stroke in the walk does not stay on the card | Fix the stroke in the walk; rerun `walk` |
| "Wenn man in dem Stack durchgeht, werden einem teils Sachen gezeigt, die man schon mal gesehen hat" (11:51) | The walk must not show a card twice | unverified | QA r3 #1: a key acts on another card after "Back" (`pendingJump`, `focus.js`) | Reproduce; fix the jump back |
| "Eine Entscheidung ist offen, und wenn ich die abhake, kommt ein Toast oben links und dann kommt die nächste" (12:57) | Answered card goes, toast top left | unverified | Toast exists (`back.js`); position not checked | Check the note's place in the walk; move to top left |
| "Scratchpad… einen Bereich nehme und an den Agent sende… Swoosh in die Sidebar" (11:19) | Cut-out flies into the session | unverified | Swoosh on the global pad (`padlink.js:102`); the new region send of the session canvas goes to the conversation without it | Use the same swoosh for the region send |
| Phone card: field at the foot (open-work row 8) | Decision, thread, options, then the field at the lower edge | unverified | open-work row 8 (12:53); not rechecked | Check at 400x860 |

## Layout (beside, ledger)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| "Man kann die [Conversation] schmaler schieben und ganz einklappen" (11:54) | Drag edge and fold for the conversation column | missing | `beside.css:11` fixed `--talk-w`; no handle or fold in `beside.js` | Drag edge setting `--talk-w`, fold to a strip, remembered per browser |
| "Rail, okay, behalten wir vielleicht als kleine Version der aktuellen Sidebar" (10:27) | A narrow, folded sidebar | missing | no fold in `agents.js` or `app.css` | Low; ask with a picture before building ("vielleicht") |

## Keyboard (keys.js)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| "Generell komplettes Keyboard-Layout umsetzen" (09:48) + "Entscheidung kopieren… in einem anderen Agenten einfügen" (12:28) | A key for copying a decision | missing | no copy action in `keys.js` `LAYOUT`; `cardclip.js` has none | Add copy on a row and in the card; run `dev/keys-test.mjs` |

## Server (server/)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| Card Nr. 33 "log" (10:01) | Message log with running number, fetch what was missed | missing | no `seq`/`since` in `server.mjs`; `server/store/` not wired | Add `seq` to messages and `since` on `/events` |
| Card Nr. 80 (10:10): stable agent ids | An id the hub makes once | missing | `server.mjs:326-336` still the slug of the name | Hub-made id, name as label |
| Card Nr. 80 "pairing" | Pairing and keys in the hub | missing | `crypto/hub.mjs` exists, not imported by `server.mjs` | Wire in behind a flag |
| "Hey, propagiere Subagenten… oder der Agent als Erstentscheidung anbietet" (11:30) + card Nr. 123 "allow" | Agent opens helper sessions and proposes a team on first connect | missing, blocked | no `open_session` in `server.mjs`; TODO.md: needs his release in the Claude prompt | Ask him for the release sentence in the prompt, then build |
| "Der Server muss ggf. Push-Einstellungen berücksichtigen" (board, 09:47) | Push to the phone when a knock lands | missing | nothing in `server.mjs`; TODO.md "Benachrichtigungen" | Later (Ops) |
| Workspace/desks (see Web UI) | Desks as a server notion | missing | — | Model desks before the switcher |

## Design (needs his decision with pictures)

| His words | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| "marken subagent der trommi.com bewertet und noch mal 5 alternativen… amerikanischer Markt, 37signals" (12:00); card Nr. 91 "other" | A name for the US market | missing | card Nr. 133 "Welcher Name für Amerika?" shredded unanswered | File again with pictures, few options |
| "Die Schrift hier wechselt, ist komisch, sollte immer gleich sein" (11:37) | One typeface in that place | unverified | screenshot not available; `--display` and `--font` mixed in `app.css` | Find the spot with him or in the QA shots |

## Ops/Tech (later; he said "UI ist jetzt erst mal Fokus und dann Tech später", 12:24)

| His words / source | What it means | State | Evidence | Next step |
|---|---|---|---|---|
| Card Nr. 97 "wait" | Restart the live hub on the new code | unverified | not touched | Ask once the UI round is quiet |
| Handover "Später" | Channel process out of `server.mjs`, SQLite backup script, landing screenshots | missing | TODO.md: `deploy/backup.sh` knows no SQLite | Later |
| "man kann in ios app dann tinfoil key substituten" (board, 10:34) | Own Tinfoil key on iOS | missing, iOS parked | TODO.md | When he restarts iOS |
| "Thinking Tokens zum Aufklappen" (07:51) | Show everything the agent does | not possible via the channel | `help.js:48` lists it as never sent; TODO.md "Live-Verlauf" via hooks/SDK | Later, via hooks or the Agent SDK |

## Needs his decision

1. **Where Scribble lives** (11:54 vs. the handover's "Scribble als Fläche neben dem Chat"): drawing in the chat
   itself, or the canvas beside the conversation as now; and whether the session's Scribble tab goes. Pictures of
   both.
2. **No Send button, typing goes live, Enter = back to the agent** (11:42: "Dafür brauchen wir eine sehr schlaue
   UI"). Never filed as a card; nothing built. Needs a proposal with pictures.
3. **Name for America** (card Nr. 133 was shredded unanswered).
4. **Several desks**: what a desk is (work/private?) before the server and menu are built.
5. **Phone foot bar** with Conversation and Scribble: stays or goes (open-work row 25).
6. **Folded sidebar ("Rail")**, he said "vielleicht".
7. **Sub-sessions**: the release sentence in the Claude prompt.
8. Unclear words, to ask with a screenshot: "Die Wohnung muss einfach abklickbar und zuklickbar sein" (10:42,
   probably a dictation slip); "Auf die Entscheidung muss ich klicken können und dann muss ein Stack aufgehen, der
   sich darauf bezieht" (11:24); "aufräumen" with a picture (board, 12:06).

## Withdrawn or replaced (do not build)

- Endless scrolling list of decisions (11:01) → one card and a toast (12:57).
- Decisions in a column beside the conversation (11:26), 2/3 + 1/3 split (12:24) → questions inline in the session's
  chat (12:38), card with decision on top and thread below (12:39).
- No sidebar / agents lying on a canvas desktop (12:07, 12:20, 12:27) → "Ich glaube, wir brauchen eine Sidebar"
  (12:39), sidebar back (12:36).
- Stack symbol instead of a number (11:53) → "bei der Inbox darf schon stehen, wie viel da drin ist" (11:59).
- Bottom bar with symbols and the inbox button (11:53) → floating Desk menu, card Nr. 141 "float".
- Four labels Revise, Snooze, Whatever, Delete on the row (12:31) → card Nr. 144 "flag" and 13:09 (Shred up top,
  only Revise and Whatever beside the answers).
- Explain as its own button (card Nr. 102) → only Revise and Whatever remain (13:09); Explain still exists inside
  the card (`focus.js:1689`), harmless.
- "Power through" → "Next, please" (card Nr. 132); five form proposals for it are moot after "Nur Next, Please (4)
  als Überschrift" (12:48).
- Rust for the hub (12:49) → card Nr. 131 "stay" (Node and plain modules).

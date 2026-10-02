# QA report: web UI

Round two, 2 October 2026, 10:45 to 11:50. Many workers changed the web client while this ran, and the
user used the live board at the same time. Line numbers are those of the working tree at 11:50.

How it is tested: `node dev/ui-test.mjs` starts its own board on a free port (three scripted agents,
one session the test steers, one disconnected session, a public https address so that asset links can
be checked) and drives one headless Chromium with real mouse, touch and key events at 1440x900 and at
400x860 with touch. It never touches the live board (8790) or 8795. Screenshots of this round are in
`docs/qa-shots/r2-*.png`; each run writes its own full set into the folder it prints at the end.

## The passes

| pass | time | passing | failing | pending | what the failures were |
| - | - | - | - | - | - |
| 1 | 10:50 | 698 | 7 | 9 | all seven: the suite lagging behind (piles, crown, the menu at the logo) |
| 2 | 11:00 | 929 | 24 | 0 | a half-saved `focus.js` (`EXPLAIN_LABEL` undefined for about a minute: Focus did not open), new sidebar badge, new advice mark |
| 3 | 11:05 | 1035 | 4 | 6 | phone tag pencil (real), the slow-line check of the suite itself |
| 4 | 11:09 | 908 | 10 | 6 | a half-saved `focus.js` (`strips` undefined); then the walk became one scrolling column |
| 5 | 11:17 | 839 | 42 | 5 | a half-saved `store.js` (`foldHtml` undefined: no session shown at all), `richhtml.css` 404, the inbox lost its headings, knocks |
| 6 | 11:25 | 1046 | 10 | 6 | a half-saved `pad/pad.js` (`ICONS[name] is not iterable`) during the phone half; clean on rerun but for the tag pencil |
| 7 | 11:31 | 929 | 16 | 5 | `EXPLAIN_LABEL` again, theme switch moved into the menu, questions beside the conversation, rail replaced |
| 8 | 11:38 | 1012 | 4 | 5 | the note with "Back" on the next row's thumb (real, fixed), single square "Choose", phone tag pencil |
| 9 | 11:45 | 841 | 10 | 4 | phone tag pencil (real); the agents page and the phone composer were rebuilt during the run |

A full run takes about four minutes; in every one of them at least one file was saved half-way or a
view was rebuilt. Five times a module threw on load or on first use for about a minute (see the
table); each was gone on the rerun and is not listed as a bug. `--only modules` (one second) catches
this kind: it imports every script, opens the Focus window once, and scans the sources for German.

## State at the end (11:47)

Two things landed in the last minutes and are **not followed by the suite yet**; they make the last
partial run (`--only walk,agents`) fail:

- **Enter in the composer of the big window now hands the card back** ("Enter: Back to agent with these
  words. Ctrl+Enter: say it and stay", `client/web/js/focus.js:1145`). The card leaves. The brief for this
  round says the opposite ("a typed message in the composer does not make the card leave"), and the
  suite's check for exactly that now fails with six messages on the desktop. Either the user decided
  this anew, then the check has to be turned round (Enter leaves, Ctrl+Enter stays); or it is the bug
  the user was bitten by this morning, back again. Needs one word from the coordinator.
- **On a phone the composer has no Send button any more** (a "saved" mark stands in its place) and Enter is a
  line break there, so a typed message can only go out through "Back to agent". The fourth button of
  the row ("Shred") is cut off by the right edge of the screen (47x50 at x=389 of 400), and the two
  question marks of "What??" are drawn above and below the button. Screenshot of the state:
  `docs/qa-shots/r2-phone-composer-1147.png`.
- The agents page became a plain list with a search field; the suite's `agents` group (rename, mark,
  VIP) and the phone halves of `sidebar`, `pair` and `urls` wait on `.roster-card` and fail until the
  selectors in `SEL` follow.

## Bugs fixed by QA this round

| what | where | lines |
| - | - | - |
| `/?q=<number>` opened the walk at the first card instead of the card with that number. The address was looked up when the event stream opened, before any card had arrived. Old id links worked. | `client/web/js/app.js:443` | 1 line and a comment: `if (!arrived && isLoaded())` |
| The card of a published asset linked to `/a/…` on this address also from a plain http page (the board over the LAN), where a browser cannot decrypt; "Copy link" copied the same. Now it takes the https address the message carries, as links inside text already did. | `client/web/js/chat.js:266-287, 458` | 5 lines |
| In the walk (scrolling column) every change of the board's state (any session posting, the own draft being saved half a second after typing) scrolled the column back to the top of the card in front. The answer one was about to press moved away, by up to 170 px; a press could land on the neighbouring card. | `client/web/js/focus.js:1855` (`presentList`) | 1 line: `if (motion === 'scroll' \|\| !changed) return` |
| After an answer in the inbox, the note "Answered … Back" lay on the thumb-down of the next row: a click meant for "No" took the last answer back. It measured the tiles of the first row (one square "Choose"), not the widest. Screenshot: `r2-note-covers-thumb.png`. | `client/web/js/back.js:93-98` (`anchor`) | 5 lines |
| German strings of the microphone button in a session's composer ("Aufnahme beenden", "Nachricht diktieren", three error sentences). Never seen by the suite, because its board has no speech key. | `client/web/js/speech.js:418, 438, 439, 444` | 5 strings |

## Open bugs, most serious first

### 1. Phone: a tap on a short tag lands on its pencil (high on a phone)

- **Steps:** phone size, open a question with many short options (tags), tap the middle of "Thu".
- **Happens:** the small pencil beside the word (22 px, 8 px from the middle of a 76 px tag) takes the tap
  and opens the line "Note on Thu". Nothing is answered. About three runs in four.
- **Should:** a tap on a tag answers. The pencil needs a place of its own on a touch screen, or a long press.
- **Screenshot:** `docs/qa-shots/r2-phone-tag-hits-pencil.png`
- **Where:** `client/web/js/focus.js:1027` (the pencil of an option), `client/web/css/focus.css:615`.

### 2. Rows with more than two options: one tile, not two (medium, pending, layout ticket)

Now one square "Choose" in the place of the right-hand thumb (it was one wide tile in round one).
The suite still lists it as pending against the brief of round one ("two square tiles"); tell me if
the single square is the decision, then the pending entry goes.

### 3. Snooze is a corner 30 px wide and needs two taps on a phone (medium on a phone)

- By design the first tap of a finger unfolds the corner and the second one snoozes
  (`client/web/js/inbox.js`, the two `click` listeners of `.inbox-later`); the target is 30x46 px
  (`client/web/css/app.css:754`), below the usual 44 px. The suite taps twice.

### 4. The way back after an answer comes only when the server has replied (low)

- The row leaves at once (checked with the answer held back for 1.5 s), but the note with "Back"
  appears only after the reply: `client/web/js/inbox.js:509` (`await decide(…)`, then `onDecided`).
  On a slow line there is no "Back" for that long.

### 5. A draft is posted for a card that is gone (low)

- `POST /draft` answers 409 "card already decided" when the card was withdrawn or answered elsewhere
  while a draft was waiting to be saved (`client/web/js/focus.js:1094`). Nothing is lost; the browser
  logs a failed request. The suite waits 0.7 s before it withdraws its cards.

### 6. The pad on a phone (low)

- The hint says "Click anywhere" on a touch screen (`client/web/pad/index.html:26`), and the status line
  at the foot reads "board: 5 sessions, speech is a stub" (`client/web/pad/pad.js:467`).

### 7. The crown in the strip of sessions cannot be tapped on a phone (low)

- It is covered by the session's drawing (seen at 11:20: `<button.crown-toggle>` covered by an `<svg>`).
  The switch on the agents page works. `client/web/js/agents.js:190`, `client/web/css/app.css:510`.

### Round one's bugs, where they stand

| nr | was | now |
| - | - | - |
| 1 | Back and Forward lost places | fixed: all checks of `urls` pass |
| 2 | "I can always click" stopped at the end of a sender's group | decided ("must always hold") and built: the inbox has no headings between senders any more, the check passes as a real check |
| 3 | wide "Choose" tile | open, see 2 above |
| 4 | admin page German | fixed, the pending entry is gone |
| 5 | phone: the note over the filters and the tiles | the note stands beside the pressed answer now and is checked against the tiles and the screen edge; over the filters of a session not looked at again |
| 6 | "Later" rows two pixels smaller | passes |
| 7 | "Failed to fetch" in a row | wording fixed ("no connection to the board"); the cut-off line not looked at again |
| 8 | unfolded row says its text twice | fixed in the code (`full` only when the row had to cut it) |
| 9 | markdown tables as pipes | a table module landed (`js/table.js`, `js/richhtml.js`); not looked at |

## Phone (400x860, touch): what is unusable first

1. Tags in the big window: the pencil takes the tap (bug 1).
2. The composer of the big window as of 11:47: no Send, a button cut off at the right (see "State at the end").
3. Snooze in the inbox: a 30 px corner, two taps (bug 3).
4. The rest works with a finger: one tap answers a row, the piles unfold, the walk scrolls and its
   strips take things back, the window of one card shows all tags without scrolling, the pad opens and
   closes back to where one was, the menu at the logo stays on the screen, nothing is wider than the
   screen in any of the 60 screenshots of a run.
5. Not there on a phone by design: the sheet of keys.

## What the suite covers now

21 groups (`--only <group>[,<group>]`, `--size desktop|phone`, `--keep`, `--shots DIR`, `--script FILE`),
each at both sizes unless noted. New or changed in this round in bold.

| group | covers |
| - | - |
| login (desktop) | no cookie: 401; the link sets an HttpOnly cookie and drops the token |
| inbox | the questions of each sender together (with or without a heading), counts, equal rows, tiles in the same place, thumbs, the mark of the agent's advice, one click answers, the next tile under the unmoved pointer (**also across senders, a real check now**), **an answered row leaves at once while the answer is held back 1.5 s**, the note names the answer, lies over no tile and **is not cut off by the screen**, takes the answer back, **the title counts the knocks** |
| later | **snooze onto ONE pile at the foot, below every sender; the pile's count; "Answered" beside it; unfolded rows say who asked and wake up; survives a reload; "Take back" on the Answered pile reopens the card among its sender's questions and in the line** |
| choose | a light question unfolds in its row, a heavy one opens the window; the walk starts at the most urgent, arrows and K move and never answer |
| **modules** | every script of the page imports; every stylesheet has rules; the Focus window opens; no German string literal in the sources |
| **walk** | the circled count starts the walk (`?q=next`); it says how far it is; one composer with Send, What??/Explain, Back to agent, Snooze; a message from another session does not move the window; arrows in the field move the caret; a typed message goes out tied to its card and the card stays open, in front, on no pile; the session's reply shows under it; ← and → page and never answer; Y answers and the walk moves on; "Back" reopens the card in front and among its sender's questions; Snooze, Explain and Back to agent make the card leave onto their piles, each with what happened and the way back; with the session's reply the card returns; on a phone every control is on screen and at least 40 px |
| **number** | the row shows the card's number; "Choose" writes `?q=<number>`; `/?q=<number>`, `/?q=<id>` (old links) and `/s/<id>?q=<number>` open that one card; an unknown number opens nothing; the picture large keeps all options beside it; eight short options are tags, all on screen, the advised one marked, one tap answers |
| keys (desktop) | arrows mark a row, C unfolds, a digit picks, Y, N, U, L, Escape; typing never answers |
| session | one conversation, message and reply, open questions as rows (**beside the conversation on a wide window**), one click answers, "Questions only" (below 1200 px), "Files" |
| scribble | draw, send, back in the conversation with a picture that loads |
| sidebar | marks, **badge by state (waiting, running)**, **the inbox count beside the knocks**, disconnected last, archive and back |
| pair | drag with the mouse, hold and drag with a finger, one row, two conversations, `/s/a+b`, reload, split |
| urls | every view has an address; Back, Forward, direct load, reload; **an old `/questions` link on a wide window** |
| agents | model and machine, rename, mark, VIP (**the crown in the sidebar is the same switch**), VIP leads the inbox and its rows wear the crown |
| theme | the switch (**in the bar or in the menu at the logo**) switches and persists |
| help | **the menu at the logo: Help and Admin, inside the screen, Escape closes; the "?" opens the sheet of keys (desktop)**; the help page |
| **pad** | opens from the bar, shows its page, address `/pad`, the control says it is open, English; Escape, the browser's Back and the control close it back to the session one was in; key P; `/pad` directly, a reload stays, closed it becomes the inbox |
| **links** | a published asset as a card and as a link in a sentence: on localhost both stay on the board; on a plain http page both go to the https address; "Files" too |
| admin | 403 without the key, gate, wrong key refused, right key opens, **English** |
| images | pictures load in rows, large, and in the conversation |
| gallery | a screenshot of eight views in light and dark |

In every group: no uncaught error, no `console.error`, no failed request; at phone size nothing is
wider than the screen; visible interface strings are checked against a list of German words.

Pending (reported apart): only the row layout (open bug 2).

Changed in the suite this round, beyond new checks: the selector and text tables follow the piles, the
crown, the knocks, the snooze corner (a finger taps twice), the advice hand, the strips of the walk,
the single square "Choose", the questions beside the conversation and the theme switch in the menu;
on a phone `settle()` waits until the strip of sessions has stopped gliding (a tap into that glide
gives no click in Chromium, which looked like a dead Agents button).

## Not automated

- New since the brief and not yet checked: "Trust" (leave it to the agent), "Shred", read aloud on every
  message, reordering sessions by drag, the resting state of the walk after the last question, files
  and the scribble mode in the composer, drafts kept on the board, `revise_card` and `merge_cards`
  with a stale answer (409) as seen from the browser, rich HTML and tables in cards.
- Speech and dictation (need a key and an outside service), permission cards from Claude Code, a board
  that is really down, real iOS and Android browsers, dropping a picture on a canvas, the destructive
  admin actions.
- Flaky in the harness: at phone size the first press on "Send this view" of the scribble sometimes
  gives no click; the suite notes it and presses once more.


---

## Round one (2 October 2026, about 10:35), as written then

Snapshot of 2 October 2026, about 10:35. The UI was being rebuilt while this was written, so line
numbers are those of the working tree at that time, and a few things changed between my first look
and the last run; where that happened it says so.

How it was tested: `node dev/ui-test.mjs` (own board on a free port, three scripted agents, one
session the test steers, one disconnected session; one headless Chromium, real mouse, touch and key
events; 1440x900 and 400x860 with mobile emulation), plus clicking through by hand with the same
harness (`--script`) for the things below that the suite does not cover.

Last run (10:35): **704 checks passing, 9 failing, 12 pending** in 130 s. The nine failures are
bug 1 (three checks at each size), bug 5 (two checks, phone) and bug 6 (one check, desktop).

Screenshots are in `docs/qa-shots/`. The suite writes its own set (one per step, about 110) into the
folder it prints at the end.

### Round one: bugs, most serious first

### 1. Back and Forward lose places (high)

- **Steps A:** open `/` (inbox), click a session in the sidebar, press Back.
- **Happens:** the browser leaves the board (it goes to whatever was open before). `history.length`
  does not grow when a session or the inbox is picked in the sidebar: the entry of the inbox is
  overwritten with `/s/<id>`.
- **Steps B:** inbox, session, Agents, Back, Forward.
- **Happens:** the Agents page is shown, but the address bar says `/`. A reload then lands in the inbox.
- **Should:** every step the human takes is one history entry; Back and Forward walk exactly these
  steps and the address always names what is on screen.
- **Screenshot:** `docs/qa-shots/bug-url-forward-agents.png`
- **Likely cause:** `client/web/js/app.js:431`. The store subscriber calls `writeAddress(false)`
  (replace) on every state change. `setScope()` emits synchronously, so (A) the address is replaced
  before the click handler in line 246 gets to push, and its push then finds nothing to do; (B) in
  `followAddress()` (line 319) `setScope()` runs before `showPage()`, so the subscriber writes the
  address of a half-applied place over the entry that was just reached. The `routing` flag is not
  checked there.
- Reload on every address, direct links and filter/scribble steps work (54 of 57 checks of the
  `urls` group pass at each size).

### 2. "If I do not move the mouse I can always click" stops at the end of a sender's group (medium, undecided)

- **Steps:** answer the last row of a sender's group with the mouse and leave the mouse where it is.
- **Happens:** the heading of the next sender slides under the pointer; a second click hits nothing.
  Inside a group the promise holds (checked: same tile box to the pixel, also on a second click,
  and no other answer passes under the pointer while the rows slide).
- **Should:** the user's call. Asked on the board; the answer "within a group is enough" was given
  and taken back, so the check is listed as *pending*.
- **Screenshot:** `docs/qa-shots/q-group-boundary.png` (the pointer was on the thumb up of the row above "Web-Frontend")
- **Where:** group sections with their headings, `client/web/js/inbox.js` (the list is rebuilt per
  sender).

### 3. Rows with more than two options have one wide "Choose" tile, not two square tiles (medium, in the layout ticket)

- **Happens:** a double-wide "Choose" tile (256x124) and "Later" as a small tab hanging from the
  lower left edge of the row.
- **Should (brief):** two square tiles at the right edge, "Later" left, "Choose" right.
- The user answered "no" to the wide layout and moved it to the layout ticket; the suite reports
  it as *pending* until that is decided.
- **Screenshot:** `docs/qa-shots/q-choose-wide.png` (earlier build), `desktop-inbox-light.png` (now)
- **Where:** `client/web/js/inbox.js` (`tile('is-wide is-lead', 'choose', …)`, `.inbox-later`),
  `client/web/css/app.css:635`.

### 4. The admin page is German (medium, pending)

- **Steps:** open Admin.
- **Happens:** every label, the gate text, the buttons and `lang="de"`.
- **Should:** English, like the rest.
- **Screenshot:** `docs/qa-shots/admin-german.png`
- **Where:** `client/web/admin.html` (also line 2), `client/web/js/admin.js`.
- The function itself is fine: without the key the API answers 403 and the page shows only the
  gate; a wrong key is refused with a message; the right key opens the page with its sections; a reload stays open.

### 5. Phone: the "Answered … Back" note lies over things one wants to press (medium)

- **Steps A (phone):** in a session, answer a question in the conversation, then tap "Questions
  only" or "Files".
- **Happens:** for four seconds the note covers both filters; the tap lands on the note.
- **Steps B (phone):** answer a row in the inbox.
- **Happens:** the note lies over the answer tiles of the topmost visible row ("Choose" is half
  hidden, and the "Back" button sits where "Choose" was).
- **Desktop:** the note stands at the top left of the main view and covers the first letters of the
  page title "Inbox"; it covers no control there.
- **Should:** a place where nothing is pressed. The note is also only up for 4 s (`BACK_MS`,
  `client/web/js/back.js:27`); the brief says "an undo bar appears", the README twelve seconds. On a
  phone there is no U key to make up for it.
- **Screenshots:** `docs/qa-shots/bug-note-covers-filters-phone.png`,
  `bug-note-covers-tiles-phone.png`, `note-desktop.png`
- **Where:** `pageHost()` in `client/web/js/back.js:38` (fixed at the top left of the visible
  `main`), `client/web/css/back.css:5-7`.
- This spot changed three times while I watched: a bar at the bottom of the phone that came up
  under the finger (09:40, `bug-phone-undo-covers.png`), a tag on the row that moved up (10:15),
  and now the note. The suite accepts any of them and checks that it names the answer, takes it
  back, and covers no answer tile.

### 6. Rows in the "Later" group are two pixels smaller inside (low)

- **Happens:** their answer tile is 122 px high instead of 124 and sits 1 px further left and up.
- **Should:** the same box as in every other row.
- **Screenshot:** `docs/qa-shots/later-rows-desktop.png`
- **Cause:** `client/web/css/app.css:702`: `.inbox-row[data-later]` gets a 1 px dashed border and
  `grid-template-rows: 146px`, while normal rows have no border (their outline is a shadow).

### 7. An error in a row is cut off, and reads "Failed to fetch" (low)

- **Steps:** answer a row with a two-line title while the server cannot be reached.
- **Happens:** "Not saved: Failed to fetch" appears half hidden under the lower edge of the row
  (fixed height), in the browser's own words. The tiles are enabled again, which is right.
- **Should:** fully visible, and the wording of the composer ("no connection to the server",
  `client/web/js/chat.js:697`).
- **Screenshot:** `docs/qa-shots/offline-row-error.png` (earlier build)
- **Where:** the `catch` in `questionRow`, `client/web/js/inbox.js`; `.inbox-error` in `app.css`.

### 8. An unfolded row says its text twice (low)

- **Steps:** "Choose" on a question with a short text.
- **Happens:** the text stands in the row and again, word for word, directly below in the unfolded part.
- **Should:** once. Show it below only when the row had to cut it.
- **Screenshot:** `docs/qa-shots/desktop-inbox-unfolded-light.png`, `phone-inbox-unfolded-light.png`
- **Where:** `client/web/js/inbox.js:76` (`if (card.body) box.append(rich(card.body))`).

### 9. Markdown tables are shown as pipes (low)

- **Screenshot:** `docs/qa-shots/markdown-table.png`. Lists, bold, code and code blocks render;
  `| a | b |` stays text. Raw HTML and `javascript:` links from an agent are shown as text and do
  nothing (tried in titles, bodies, option labels and messages).
- **Where:** `rich()` in `client/web/js/ui.js`.

### Found and gone again during the session

- **In the Focus window the → key answered "yes"** on a two-option question, while the window
  shows a round "→" button that means *next* (verified at 09:45: the card was decided `yes`;
  `docs/qa-shots/bug-walk-arrow-before.png`, `bug-walk-arrow-after.png`). Since about 10:30 the
  arrows and J/K move and only Y, N and the digits answer (`client/web/js/keys.js:56-59`); the suite
  now walks through the questions with the arrow key and checks that none is answered.
- Help link pointed to `/hilfe.html`, which answered 404. Now `/help.html`, English, passes.
- The scribble toolbar had German labels ("Rückgängig", "Farbe", "Stärke"). Now English.
- `index.html` linked `/css/keys.css` before the file existed (404 for some minutes).
- The mark editor offered several drawings that looked the same, and the session's own first mark
  could not be chosen again. Replaced by a picker of 40 named drawings; passes.
- "Go through them" only marked a row for the keyboard, which did nothing visible on a phone. It
  opens the window walk again.

### The designer's eye

Good overall: one clear hierarchy, the hand-drawn circle reads at once, light and dark are both
carefully done, nothing overflows at 320, 400, 768, 900, 1024 or 1440 px.

**Inbox, desktop** (`desktop-inbox-light.png`, `desktop-inbox-dark.png`)
- The "Later" tab hangs out of the lower left corner of every row and overlaps the gap to the next
  row. It looks like a download button, and it is the smallest target on the page.
- The time ("JUST NOW") floats in the upper middle of a row and changes its place when the row has
  a picture. It wants a fixed corner.
- The advice circle shows a faint seam where its two halves meet (short vertical dashes inside the
  ring), most visible on the thumbs and on full-width options on the phone.
- Titles wrap early ("May I go on? Everything / of mine waits on this.") although the line has room.
- "Help", "Admin", "Keys" in the bottom bar are very small and pale.

**Inbox, phone** (`phone-inbox-light.png`, `phone-inbox-dark.png`)
- The "Later" tab is about 40x28 px and sits between two rows: easy to miss, easy to hit the row
  below instead. Below the usual 44 px for a touch target.
- The "Answered … Back" note (bug 5).

**Window of one question** (`desktop-window-light.png`, `phone-window-light.png`)
- Clean. On the desktop a question with little text leaves two thirds of the window empty; on the
  phone the gap between "Ask back" and the options at the bottom is large for short questions.

**Conversation** (`desktop-conversation-dark.png`, `phone-conversation-dark.png`)
- In the dark theme a sent scribble is a blinding white card, and the scribble canvas itself stays
  light (`desktop-scribble-dark.png`). The canvas as paper is defensible; the card in the dark
  conversation is not.
- When an inline question is answered, its row shrinks to one line; what was below jumps up.
- "Questions only" keeps the composer, and the last row fades out under it. Fine.

**Sidebar** (`sidebar-desktop.png`)
- Two of the five test sessions get nearly the same default mark (slanted hatch lines), told apart
  only by colour. The picker now has 40 distinct drawings; the defaults should use them without
  repeats.
- The archive button of a disconnected session appears only on hover. On a phone the strip has no
  heading "Disconnected" and no archive action (it is on the Agents page); disconnected sessions do
  stand last and greyed.

**Agents page** (`desktop-agents-light.png`, `phone-agents-light.png`)
- The VIP star is a small pale outline with no word next to it; nobody will find "VIP" there.

**Help**: good. **Admin**: German (bug 4), otherwise in the same style.

### What the suite covers

`node dev/ui-test.mjs` (also `--only <group>[,<group>]`, `--size desktop|phone`, `--keep`,
`--shots DIR`, `--script FILE`). Groups, each at desktop and phone size unless noted:

| group | covers |
| - | - |
| login (desktop) | no cookie: 401 for page, stream and scripts; the link sets an HttpOnly cookie and drops the token from the address |
| inbox | groups per sender with counts; equal row height; answer tiles in the same box in every row; thumbs down left, up right; worded pairs; the circled recommendation; one click answers; the next right-hand tile under the unmoved pointer, twice; nothing else passes under the pointer while rows slide; the way back names the answer, lies over no answer tile and takes the answer back; the title count |
| later | "Later" moves rows into ONE group at the very end; who asked is named; count goes down; survives a reload; "Fetch back"; the group goes when empty |
| choose | a light question unfolds in place with all options, the recommended one circled, a second press folds it; a heavy one opens the window with pictures, inert page behind, `?q=` in the address, closes on the answer; the walk starts at the most urgent, the arrows and K move and never answer, Escape leaves |
| keys (desktop) | arrows mark a row, C unfolds, a digit picks, Y, N, U, L, Escape; typing in the composer never answers |
| session | one conversation, only its own messages; message and scripted reply; open questions inline as the same rows; one click answers inline; "Questions only" (list, count, pressed state, toggle); "Files" (pictures and a text file, pictures load, open large) |
| scribble | canvas, send disabled when empty, a stroke enables it, send returns to the conversation, the scribble's picture loads, the agent confirms, the canvas keeps the drawing |
| sidebar | every session has a drawn mark; hand when blocked, ring and count when working; disconnected last (desktop: under their heading, archive on hover); archive, the Agents page keeps it, fetch back |
| pair | drag with the mouse, hold and drag with a finger; one row for the pair; two conversations side by side (one on the phone); `/s/a+b`; survives a reload; "Split" |
| urls | `/`, `/s/<id>`, `/s/<id>/questions`, `/s/<id>/scribble`, `/agents`: written on each step, Back and Forward, direct load, reload; unknown session falls back to the inbox |
| agents | model and machine per session; rename; choose a mark (all drawings distinct, one press chooses, persists); VIP leads the inbox and is marked; everything survives a reload |
| theme | toggle, pressed state, persists across reload and pages |
| help | link, page loads, English, headings, a way back |
| admin | API 403 without the key; gate; wrong key refused; right key opens; stays open on reload |
| images | every card with pictures shows one in its row and it loads (naturalWidth > 0); opens large; pictures in the conversation load |
| gallery | a screenshot of eight views in light and dark, for looking at |

In every group: no uncaught error, no `console.error`, no failed request (attributed to the group
in which it happened); every screenshot at phone size also checks that nothing is wider than the
screen; visible interface strings are checked against a list of German words.

Pending checks (reported apart, do not fail the run): the group-boundary promise (bug 2), the row
layout (bug 3), German strings and `lang` on the admin page (bug 4). They are listed in `PENDING`
at the top of the file with their reasons.

### Flaky, and not automated

- **Flaky in the harness:** at phone size, in roughly one full run of four, the press on "Send this view" produces
  `touchstart` and `touchend` on the button but no `click`. Nothing in the page cancels them and I
  could not tie it to anything the page does, so the suite notes it, presses once more, and fails
  only on a second miss. Worth trying on a real phone: draw, then tap Send.
- **Not automated:** speech (needs a key and an outside service); permission cards from Claude
  Code; the behaviour while the server is really down (emulated "offline" does not cut the open
  event stream, so the "Disconnected" pill was not seen); real iOS and Android browsers (keyboard,
  safe areas, long press); dropping a picture on the canvas; the destructive admin actions (forget
  a session, replace the token).
- **The UI moves under the suite.** Selectors and words are in two tables at the top of
  `dev/ui-test.mjs`; four of them had to follow the UI during this session.

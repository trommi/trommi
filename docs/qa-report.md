# QA report: web UI

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

## Bugs, most serious first

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

## The designer's eye

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

## What the suite covers

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

## Flaky, and not automated

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

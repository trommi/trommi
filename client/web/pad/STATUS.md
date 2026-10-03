# Pad status log

## Round four, 3 October 2026: the Desk is the scratchpad. Nothing committed.

The user: "mache einfach den Desk zu einem Scratchpad. Man kann die Entscheidung nach oben wegscrollen und unten scratchen. Also quasi infinite scrolling, immer 1,5 Seiten unter dem Inhalt."

- **The paper** is a tall, empty box (`#deskpad`) at the end of the Desk's scroller (`#inbox`), mounted by `js/padlink.js` (`mountDesk`), styled by `css/deskpad.css`. In it the pad's page stands in a frame as high as the window that sticks to the window's top: `/pad/?embed=1&desk=1`. The Desk's scrolling tells the frame which part of the paper to paint (`window.padDesk(s, cut)` in `pad.js`), so the canvas is never larger than the window and the paper can be as long as he writes. Same pad (`global`), same store, same sync as before: nothing moved.
- **Free paper**: the frame reports the lowest thing on the paper (`extent`), the box is that plus 1.5 windows (`grow()`), and never shorter than where he is.
- **Desk mode of the pad** (`DESK` in `pad.js`, `:root[data-desk]` in `pad.css`): no zoom, no pan of its own, no top bar; the wheel and a finger scroll the Desk (the canvas takes `touch-action: pan-y` unless a drawing tool is in hand or something is selected); two fingers scroll while the pen is in hand; sideways (a finger, two fingers, a sideways wheel) pans the paper when it is wider than the screen. The tools (select, pen, eraser, send area, colour, picture, undo) come at the first tap or stroke and go when the paper is out of sight. On a touch screen the hand starts with "select", so a finger scrolls until it picks the pen.
- **Where things are**: the paper's top left corner is 24/32 px above and left of world 0/0, or of the leftmost and topmost element if that lies further out (what was put down on the pad's own page keeps its arrangement and starts at the left edge).
- **Arrivals**: while he is on the paper (it fills the window, or the frame has the keyboard) and the list above changes its height, the scroll position follows, so what is under the pen stays (`follow()`); no hook in `inbox.js` was needed.
- **Addresses**: `/pad` opens the Desk at its paper and becomes `/`; the pad's control and the key P scroll to the paper, again back to the top. `/pad/` is still the pad as a page of its own (endless in every direction, with zoom). `?deskpad=0` gives the old layer back; the switch is one line in `padlink.js`.
- **Verified** in headless Chromium with real mouse, wheel and touch input on a demo hub, 1440x900 and 390x844, light and dark: scrolled to the paper, typed and drawn, reload shows it, 1269 px (1.5 x 846) free under the lowest stroke, a card arriving while a stroke is drawn or a note typed leaves both where they are, the wheel over the paper scrolls the Desk, a finger scrolls, with the pen it draws, two fingers scroll.
- **Later the same day** (three notes from the user):
  - No control in the bar: `padlink.js` keeps `#pad-open` hidden (the menu's "Scratchpad" jump entry in `js/bar.js` clicks it; the key P calls `togglePad`). `css/deskpad.css` hides it against the bar's own rules.
  - The tools, on the Desk and on `/pad/`: no colour button. A click on the pen (or highlighter) that is already in hand opens colour and width at that tool (`toggleStyle`), the tool carries a dot in its colour, a click elsewhere closes. A text tool (T): click on the paper and type, or into a note to edit it. The picture button wears a paperclip. Desk bar: pointer, pen, eraser, text, attach, undo, and apart, faint, send area.
  - What was sent leaves the paper (`takeAway` in `pad.js`): after a successful area send the notes and pictures in the frame go whole (also one that only reaches into it), a stroke that crosses the frame's edge is cut there and its outside parts stay as strokes of their own; after "Send to…" on a selection exactly those elements go. One undo step brings it back; a failed send removes nothing.
- **The whole Desk is paper** (the same evening; this replaces "the paper begins under the list" above):
  - The frame sticks to the top of `#inbox` UNDER heading, rows and stacks (`css/deskpad.css`: a sticky box of no height, `z-index: -1` in the isolated scroller). The Desk's scroll position is the paper's (`padDesk(s, listEnd, settled)`); a spacer at the end (`.deskpad-room`) keeps 1.5 windows free under the lower of list and drawing.
  - Who gets the pointer: with the bare pointer the cards work as always and what falls between them reaches the paper (the boxes that only hold cards let it through). With a tool in hand, a note open or something selected the pad says "front" and `#inbox[data-paper-front]` makes the cards faint and transparent to the pointer: a stroke across a card is a stroke, nothing is answered. Escape, the pointer tool, the pen switch or P end it. This is also the "cards faint behind the drawing" state; there is no separate third state.
  - Two switches at the Desk's lower left (`#deskpad-pen`, `#deskpad-eye`, built in `padlink.js`): pen in hand, and hide the cards (kept in this browser, `localStorage trommi-desk-cards-hidden`). Hidden keeps the cards' room, so nothing moves; the eye shows how many knock and one press brings them back; the edge strips for knocks stay.
  - The paper's top is fixed once per browser (`localStorage trommi-deskpad-top:global`, world y of the page's top), chosen so that what lay under the list stays there. Drawings belong to the paper: a drawing beside a card does not follow that card when the list changes. A browser that sees the pad for the first time lays the existing content under its own list.
  - While the paper is in front and the list above changes its height, a scroll adjustment made for the list is taken back (`follow()`), so what is under the pen stays. With the bare pointer the list's own anchoring is untouched.
  - For the memo: `paperPoint(clientX, clientY)` and `paperLayer()` exported from `js/padlink.js`; also `toggleCards()`.
  - `/pad` and the key P: the Desk with the pen in hand.
- **Not built / open**: on a phone the paper is as wide as it was written on the desktop, so one pans sideways; the area flight ends in the chooser, not in the sidebar; the board's keys stop while the paper has the keyboard (Escape gives them back); `dev/ui-test.mjs` group `pad` and `dev-check.mjs`'s board part still expect the layer.

## Round three, 2 October 2026: "Send area" (the pad is called Scratchpad on screen). Nothing committed.

The user: "a button where I take an area and send it to the agent, and then it is cut out with such an animation and is sent, swoosh, into the sidebar, into the agent."

- **Send area tool** in the toolbar (a dashed frame with an arrow, key **A**): drag a rectangle, outlined while dragging by a hand-drawn dashed frame. On release a chooser stands at the frame: the sessions with their marks, the one you came from first, then by most recent send, a find field when there are more than six; Enter sends to the first, arrows move, Esc drops the frame. Rectangle only; a free lasso is not built.
- **What goes**: every element that lies in the frame, whole or in part (ids, words), and a PNG of exactly the frame (`renderRect` in `elements.js`: elements are cut at its edge), through the existing `POST /pad/send`. No server change, **no restart needed**; a page reload is enough.
- **The swoosh** (`client/web/pad/fly.js`, about 650 ms): the frame is drawn through (the snip), the piece lifts off with a tilt and a shadow, flies in an arc to the session's mark, the mark bounces. With reduced motion the piece fades and the mark blinks once.
- **Where it flies**: inside the board on a wide screen the board draws the flight above the pad's frame (`fly()` in `js/padlink.js`): a slim strip of the sessions' marks comes in at the left edge, where the sidebar is, and leaves again. Chosen over a strip inside the pad because the marks are the board's own component (same scribbles and colours as the sidebar), and because the same code can end the flight at the real sidebar or dock once a layout leaves it visible. On a phone, and on the pad as a page of its own, the piece flies into the chooser's row.
- **Afterwards**: the elements stay, marked as sent; a note "Sent to <session>" for four seconds; the tool goes back to the one in hand before. **No Back**: the hub has no way to take a message back (the agent already has it), so the note only says where it went. Adding one would need a server route and an event that tells the agent to disregard it.
- "Send to…" on a selection is unchanged.
- The block over the toolbar in the user's screenshot was their own dictation tool's overlay, not the pad (coordinator). Looked for it anyway; the only real overlap found and fixed: the recording pill could cover the top edge of the toolbar by 10 px.
- **Verified** with `dev-check.mjs` on a demo board (8861): 82 of 82, with real pointer and touch input, desktop 1440x900 and phone 400x860, light and dark. A frame over strokes, a note and a picture; the fixture agent answered with the element count and the PNG path; the PNG has the frame's exact size and was looked at (picture and stroke cut at the frame's edge). Frames of the flight captured at a tenth of the speed. One earlier run had five failures in the old standalone part (a selection click) that did not repeat: a flake right after the demo board started, not understood.
- **Not verified**: more than six sessions (the find field) in a browser; reduced motion; the flight on a real phone.
- Files: `client/web/pad/pad.js`, `fly.js` (new), `elements.js`, `board.js`, `index.html`, `pad.css`, `dev-check.mjs`; `client/web/js/padlink.js` (marks in the context, `fly`), `client/web/css/padlink.css` (strip). `padlink.js` now imports `avatar` and `hueOf` from `js/agents.js`.
- Unanswered on the board (card 3571488e, chat to "Pad"): the user asks for links to the best-known canvas libraries with a pros and cons table (nothing proprietary), and how the Scratchpad gets onto iOS.

## Round two, 2 October 2026 (session "Pad"). Nothing committed.

Goal: the pad can be called up from anywhere in the board, what is on it lives on the server, and a selection really reaches a session.

- **Server routes** in `server/pad.mjs`, hooked into `server/server.mjs` behind the board's login and origin check: `GET /pad/elements?pad=&since=`, `POST /pad/elements`, `DELETE /pad/elements/<id>`, `PUT`/`GET /pad/blobs/<id>`, `GET /pad/events` (SSE), `POST /pad/send`. `/pad` (without slash) is the board with the pad open.
- **Storage: SQLite**, as the user decided on the board ("Use SQLite as the hub's store?" yes). `server/store/store.mjs` in a database of its own, `data/pad.db`; bytes in `data/pad/blobs/`. First built as an append-only JSON log, replaced the same day. Needs Node 22.13+ (`node:sqlite`); the store is loaded on first use, an older Node gets one log line and 501 with the reason on the pad's routes, everything else runs (tested with `--no-experimental-sqlite`).
- **Store changes** (`server/store/store.mjs`, its tests and README): a put with a newer revision brings a deleted element back; a deleted element's file stays until the purge takes the tombstone; `deleteElement` takes a `rev`; `sendElements` moves the elements' `seq`; `element(id, { deleted: true })`.
- **Sending**: `/pad/send` writes the PNG to `data/files/pad-<id>.png`, adds a message with words and picture to the session's conversation, notifies the agent over the channel (`kind="pad"`, `elements`, `image_path`, `message_id`), and records the links. One instruction line and one entry in the channel reference tell the agent what it got. `dev/fake-agent.mjs` answers a pad event with the path it was given.
- **Client sync** in `client/web/pad/sync.js`: IndexedDB stays the cache; changes go up one record at a time, others' changes come in over the stream; unsent changes survive a reload; a new or reset store is recognised by its `epoch`. Status line says "saved on the board", "saving…", "no connection: kept on this device", or "saved on this device only".
- **From anywhere**: `client/web/js/padlink.js` + `client/web/css/padlink.css`. A scribbled control in the bar (bottom bar on a desktop, top bar on a phone), the pad in a same-origin frame that stays mounted, address `/pad`, closes with Esc, the control, its own close button, browser Back. Exports `openPad`, `closePad`, `togglePad`, `isPadOpen` (the Keyboard worker's key P calls `togglePad`).
- **From a session** "Send to" names that session; from a pair the menu lists its two sessions first.
- **Voice notes keep only the words** (user decision): no audio blob any more.
- **Rough edges of round one fixed**: a click on a note under a highlighter stroke picks the note; a note spoken at the foot of a phone screen is moved clear of the toolbar. Also found and fixed: `db.js` returned the request object instead of `undefined` for a missing record; a shift double-click on a note opened it for editing.
- **A device's first look** at a pad that already has content fits it into view.

### Verified

- `node server/test.mjs`: green, with a new pad section (login and origin, put, conflict, type, malformed input, delete, undo of a delete, blobs, a picture's bytes surviving delete and undo, send with the agent receiving text and PNG path, the conversation message, links, the stream, the database read again from disk, a hub without SQLite).
- `node server/store/test.mjs`: 22 passed (23 with the benchmark), pad test extended.
- `node client/web/pad/dev-check.mjs` in headless Chromium, real input: 74 of 74 on a demo board (`dev/trio.sh 8861`), 45 of 45 on a plain file server (8862). Desktop 1440x900 and phone 400x860, light and dark; screenshots read.

### Not verified, not built

- Real speech on the pad inside the board (the demo board has a key; the check starts a recording with a fake microphone and discards it).
- iOS Safari and a real touch device; only Chromium was driven.
- `dev/ui-test.mjs` (the Web UI worker's suite) was not run against these changes.
- Agents placing elements (`pad_put`, `pad_get`, `pad_list`): not built.
- The live hub on 8790 runs the old server in memory: **it needs a restart** before `/pad`, the routes and the control's address work there. Until then the control opens the pad, but the pad says "saved on this device only", sending answers "Not sent", and a reload of `/pad` lands on the bare pad page instead of the board.

### Shared files touched

- `client/web/index.html`: 2 lines (stylesheet `/css/padlink.css`, module `/js/padlink.js`).
- `client/web/js/app.js`: 1 line at the top of `writeAddress()` (leave the address alone while it is `/pad`).
- `client/web/js/chat.js`: 2 lines in `messageNode()` (show the picture of a pad selection in the human's message).
- `server/server.mjs`: import, one instruction sentence, one `CHANNEL_EVENTS` entry, `APP_PATH` gains `pad$`, the `padRoutes({...})` block, one route line before the static files, one log line in `becomeHub()`.
- `server/test.mjs`: the pad section after the scribble section, `'pad'` in three reference assertions, `/pad` among the app paths, the no-SQLite hub.
- `dev/fake-agent.mjs`: 4 lines.

## Round one

A prototype in this folder with IndexedDB only, 42 checks, and `docs/pad.md`.

# All screens

Every view and state the board can show, as of 2026-10-03. The live version of this list is the page
`/screens.html` (Trommi menu, Dev, "All screens"): it fills each link from what the board holds right now (the
first session, the first open question, …). The list itself is `client/web/js/screens.js`; the page is
`client/web/screens.html` with `client/web/js/screens-page.js`. It is a static file because the hub only serves
the app's own paths (`APP_PATH` in `server/server.mjs`); with `|screens$` added there it could live at `/screens`.

123 entries: 84 current, 26 hidden, 13 dead; plus 207 design pages.

- **current**: reachable in normal use.
- **hidden**: alive, but only behind a query switch, a hash flag, an address nothing links to, or an odd path.
- **dead**: code or styles that can no longer be reached.
- In square brackets, what lies over the page: `page` (fills the screen and has an address), `anchored` (a small
  sheet or menu at what was pressed, no veil), `modal` (blocks the page), `note` (passes by itself).

Keeping it: a new view gets an entry in `SCREENS` in `js/screens.js` (and a row here). The design pages are a
snapshot of `client/web/designs/*.html`; a new one is added to `DESIGNS` by hand.

## Switches nobody sees

| Switch | What it does |
|---|---|
| `?deskpad=0` | the Desk without its paper; the pad is the old overlay at `/pad` again |
| `?marks=0` | a card with a note line per option instead of writing on the card |
| `?head=1` | a card with the answers beside the title |
| `?q=<n>`, `?q=<id>`, `?q=next` | old card links; still what `/agents` uses |
| `?pad=<name>` (on `/pad/`) | another pad than the shared one |
| `?t=<token>` | signs in |
| `#dark`, `#light` | theme for this load (board, Admin, Help, pad) |
| `#empty`, `#skeleton` | the board without a hub: no state, or never connected |
| `#offline`, `#toast`, `#undo` | samples of the disconnected pill, the error notice, the Back note |
| `#error`, `#scrolled`, `#lightbox` | samples inside a session: send error, scrolled log, first picture large |
| `#scribble`, `#decisions`, `#files` | old mode flags; read, but they change nothing visible any more |
| `#/…` | every route behind the hash (the page as plain files) |
| `#diagram` (on `/help.html`) | the diagram alone |

## Inventory

### Desk

The start page: everything that waits for you, from every session.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Desk | current | `/` | The open questions of all sessions as rows, grouped by who asks; below them the piles Later, Memos and Done. | js/inbox.js mountInbox, app.js:413 |
| Desk, empty | current | `/#empty` | "Desk is clear." with its drawing. The link shows it without the hub (hash flag #empty: no state is loaded at all). | js/inbox.js:1010 |
| Desk before anything has arrived | hidden | `/#skeleton` | Hash flag #skeleton never connects. The Desk has no loading state of its own: it says "Desk is clear." until the state is there. | js/app.js:646 |
| /inbox | hidden | `/inbox` | An old address the hub still serves as the page. The router does not know it: it shows the Desk and rewrites the address to /. | server/server.mjs:3103 APP_PATH |
| Row unfolded to choose | current | On the Desk, press "Choose" on a row with several options. Escape folds it. | A question with more than two answers: "Choose" unfolds the option tiles, Send, Whatever and the ask-back line in the row. | js/inbox.js:182-291, 670-709 |
| Pile fanned out (Later, Memos, Done) | current | On the Desk, click the pile "Later", "Memos" or "Done" below the questions. Escape gathers it. | A click on a pile under the list fans its lines out in place; one pile at a time, "N more" for the rest. | js/piles.js:41-140 |
| Shred instead of Snooze (Shift held) (wide) | current | Hold Shift over the Desk; or key X on the marked row. | While Shift is held the quiet tab at a row's edge reads "Shred". | js/bar.js:162, css/app.css body[data-shift] |
| "N new" and the knock strips | current | Scroll the Desk down while new or urgent questions arrive. | A button "N new ↑" when questions arrive above what is in view, and strips at the edges "↑ N knocks" for urgent ones out of sight. | js/inbox.js:844-909 |
| Several desks | current | Menu, "+ New desk…". | With more than one desk the Desk box names the desk in view and the menu lists the desks (D then 1, 2, …), "New desk…", Rename, Remove. | js/bar.js:260-369 |
| Desk paper: pen in hand | current | `/pad` | The pad lies under the Desk as its paper. /pad (key P) goes to the Desk with the pen in hand: the cards fade and take no pointer until Escape. A pen switch and an eye stand at the lower left. | js/padlink.js:373 mountDesk; css/deskpad.css |
| Desk paper: cards hidden | current | On the Desk, press the eye at the lower left. | The eye at the lower left hides the Desk's cards, so only the paper is left; it then carries the count of knocks. Remembered per browser. | js/padlink.js:317 toggleCards |
| Desk without the paper | hidden | `/?deskpad=0` | Query switch ?deskpad=0: the Desk as it was before the paper, with the pad's button back in the bar. | js/padlink.js:25 |

### Card

One question. On a wide screen a Desk row unfolds in place; everywhere else the card is a page of its own.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Card page [page] | current | `/q/<n>` | One question as a page: /q/<number>. Back link at the top left, Escape leaves. The rest of the page is inert under it. | js/focus.js:3140 open, app.js:323 |
| Card page inside a session [page] | current | `/s/<id>/q/<n>` | The same page reached from a session: /s/<id>/q/<number>. The back link names the session. | js/app.js:55-111 |
| Card unfolded in its Desk row (wide) | current | On the Desk (wider than 860px), click the title of a row. | On a wide screen a click on a row's text unfolds the whole card in place; the address reads /q/<number>. A reload of that address gives the card page instead. | js/focus.js:3278 openInline, app.js:345 |
| The walk ("Next, please") [page] | current | `/walk` | All open questions one after the other as card pages, the most urgent first, with arrows and "3 of 9". | js/inbox.js:994, app.js:708 (G F) |
| The walk of one session [page] | current | `/s/<id>/walk` | The same, through the questions of one session: the badge of a sidebar row starts it. | js/app.js:390 walkSession |
| Old card links (?q=) | hidden | `/?q=<n>` | Links from before /q/<n>: ?q=<number>, ?q=<card id>, ?q=next. Still followed and rewritten in place. Over /agents the question still stays in the query. | js/app.js:77, 106 |
| "All answered" at the end of the walk [page] | current | Answer the last open question in the walk. | The walk's last page: nothing left, who is still working, Close. | js/focus.js:352-360 |
| Card with pictures [page] | current | `/q/<n>` | One large picture with a thumb strip; from four pictures that pair with options, "All in a grid". | js/focus.js:497-611 |
| Picture zoom [modal] | current | On a card with a picture, press the magnifier on the picture. | The picture over the whole card with the answers beside it: real size on a click, "All in a grid", "Live" (the page in a frame). Lies over the sheet and traps Tab; Escape, X or a click beside the picture closes. | js/focus.js:2919 openZoom |
| Answered card ("past") [page] | current | `/q/<n>` | A decided, shredded or withdrawn card, read-only, with "Take back". | js/focus.js:1062-1085 |
| Earlier version of a card [page] | current | `/q/<n>` On a revised card, press the version in the byline; J/K step, Escape leaves. | A revised card keeps its versions: "third version" in the byline steps back through them, read-only. | js/focus.js:1558 viewVersion |
| Writing on the card (pen) | current | On a card page, key D, or the pen in the tools row. | Pen mode: scribble and write anywhere on the card; a pencil in the margin on hover. | js/focus-marks.js |
| Card with note rows per option | hidden | `/q/<n>?marks=0` | Query switch ?marks=0: the older way, a note line per option instead of writing on the card. | js/focus.js:2261 |
| Card with the answers beside the title | hidden | `/q/<n>?head=1` | Query switch ?head=1: an unchosen layout, the answers floated beside the title. | js/focus.js:2263 |
| Scratchpad in the card's composer | hidden | On a card, attach a picture to the ask-back line, then click its chip. | A small drawing pad inside the ask-back line. Its pen button is display:none, so it only opens through an attached picture chip. | js/focus.js:1473-1554, css/focus.css:1101 |
| Card still loading [page] | current | Reload a /q/<n> address on a slow line. | A card link followed before the board's state has arrived: the empty sheet. | js/focus.js:369 |

### Session

One session: its conversation, the two filters over it, its canvas. Sessions laid together share a page.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Conversation | current | `/s/<id>` | A session's page: /s/<id>. Messages, its open questions as answerable rows, the composer. | js/chat.js mountChat |
| Questions only | current | `/s/<id>/questions` | The filter that lays the session's questions over the conversation (key Q). | js/chat.js:455, app.js:233 |
| Files | current | `/s/<id>/files` | The filter that lists everything the session sent: pictures, files, published pages (key F). | js/history.js:48 |
| Scribble (the session's canvas) | current | `/s/<id>/scribble` | The canvas of the session. From 1200px it stands beside the conversation, below that it takes the pane, with a bar back. | js/scribble.js, app.js:266 |
| Sessions laid together | current | `/s/<id>+<id>` | Two or more sessions on one page: /s/<id>+<id>. Their questions as one list, the conversations side by side (a phone: one at a time). | js/beside.js, chat.js:1091 |
| Laid together: questions instead of the conversation (phone) | current | Open sessions laid together at phone width and press the bar. | On a phone a bar "N questions wait for you · Show" swaps the conversation for the joint list. | js/beside.js:53-66 |
| Laid together: conversations folded to a strip (wide) | current | Open sessions laid together on a wide screen, press the fold at the column's edge. | From 1200px the conversations are a column that can be dragged narrower and folded to a strip. | js/beside.js:116-179 |
| Empty conversation | current | `/s/main#empty` | A session nobody has written to: three suggestions that fill the composer. The link shows it without the hub. | js/chat.js:398-416 |
| Conversation skeleton | current | `/s/<id>#skeleton` | The grey placeholder lines before the first state arrives. The link freezes it (hash flag). | index.html:149 |
| Conversation scrolled up, with unread | hidden | `/s/<id>#scrolled` | Hash flag #scrolled: the log at its top with the button "N new messages". | js/chat.js:956, 1072 |
| Send error above the composer | hidden | `/s/<id>#error` | Hash flag #error shows the inline line a failed send leaves ("Not sent: …"). | js/chat.js:847, 1072 |
| Picture, large [page] | current | `/s/<id>/files/<n>` | A picture as a page of its own, n counting the session's pictures from the oldest. No veil. Back, Escape or the link at the top left closes it; the arrows are links to the picture before and after. | js/chat.js lightbox, followPicture |
| Answered question unfolded in the log | current | In a conversation, click a line "decided: …". | A finished question is one quiet line in the conversation; a click unfolds it in place with "Take back". | js/chat.js:346-388 |
| Old mode flags (#scribble, #decisions, #files) | hidden | `/#decisions` | Deep links from before there were addresses. Still read on arrival, but without a session in the path they change nothing one can see. | index.html:62, app.js:495 |

### Sidebar and bar

The list of sessions at the left (a strip on a phone) and the bar with the Desk and the menu.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Sidebar | current | Always there, except on a card page. | The sessions, connected first, then "Disconnected". A badge says what waits; a click on it starts that session's walk. On a phone it is a strip that scrolls sideways. | js/agents.js mountAgents |
| Sidebar folded to a rail (wide) | current | Key [ or the small button at the sidebar's foot. | Drawings and counts only; the name shows beside a row under the pointer. Remembered per browser. | js/bar.js:167-219 |
| Main agent with its helpers folded | current | Click the crown of a session that has helpers. | A crowned session with helpers: the crown folds them under it (stacked edges) or opens them (a bracket). | js/agents.js:414-450 |
| Dragging a session | current | Drag a sidebar row. | Onto the middle of another row lays the two together, onto an edge moves it, out of a group takes it out. Touch: hold first. | js/agents.js:498-637 |
| Key hint "g …" and numbered rows | current | Press G on the Desk. | After G the bar shows what may follow and the first ten sidebar rows carry their number. | js/keys.js:196-220, css/keys.css |
| Tight phone bar (phone) | current | At phone width with long counts in the Desk box. | When the counts no longer fit, the Agents button leaves the bar (it stays in the menu). | js/bar.js:381-399 |

### Agents

The page of all sessions.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Agents | current | `/agents` | Every session as a line of a ledger: state, what it asks or does, model, machine, last seen. Sortable, searchable (/), with Disconnected and the Archive below. | js/ledger.js:554 |
| A question opened over Agents [page] | current | `/agents?q=<n>` | From a ledger line the card opens as ?q=<n>: the hub serves no /agents/q/<n>. | js/ledger.js:52-57 |
| Laying together, in the ledger | current | On Agents, press the heads icon of a line (or +), then another line. Escape lets go. | A line is picked ("Laying X together with: pick the other line…"), a click on a second one joins them. | js/ledger.js:383-389 |
| Archive | current | Archive a disconnected session (sidebar or Agents), then scroll Agents to its end. | Archived sessions, at the foot of the Agents page, each with "Fetch back". The only place they come back from. | js/ledger.js:345-362 |
| Agents, nothing found | current | On Agents press / and type something no session is called. | "No session fits. Show all" under the search field. | js/ledger.js:336-341 |

### Pad and paper

The scratchpad, and the canvas of a session (Scribble).

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Scratchpad over the board (the old overlay) [page] | hidden | `/pad?deskpad=0` | Before the Desk had its paper, the pad filled the screen over the page at /pad. Still alive behind ?deskpad=0; Escape or Back closes it. | js/padlink.js:154 show |
| Scratchpad as its own page | hidden | `/pad/` | The pad without the board around it (mind the slash). Not linked from the app; the overlay loads it in a frame as /pad/?embed=1. | pad/index.html, pad/pad.js |
| A second pad by name | hidden | `/pad/?pad=test` | Query switch ?pad=<name>: another pad than the one everybody shares ("global"). | pad/pad.js:21-28 |
| Pad: send a selection [anchored] | current | On the pad, select something, "Send to…", pick a session. | A panel at the selection with a preview of what goes to the session, and Send; what was sent then leaves the paper. No veil; Escape, Close or a click beside it closes. | pad/index.html:105, pad/pad.js openSendDialog |
| Pad: keys [modal] | current | On the pad press ? or the help button. | The pad's own list of shortcuts: a sheet in the middle without a veil, like the board's; Escape, the X or a click beside it closes. | pad/index.html:130 |
| Pad: recording | current | On the pad hold the pointer down for half a second, or press M (needs the speech service). | A pill "Recording" with Done and discard while speech is taken down onto the pad. | pad/pad.js:770 |
| Scribble: colour and width [anchored] | current | On a session's Scribble, press the active pen again. | A small panel above the toolbar. Closes by its button, Escape, or a touch on the canvas. | js/scribble.js:433-444 |
| Scribble: "Clear everything?" [anchored] | current | On a session's Scribble, press the bin. | The one confirmation of the canvas, a small panel under the bin (no veil). Clearing can be undone. | js/scribble.js:402-413 |
| Scribble: send a region | current | On Scribble press R and drag a frame; Enter sends, Escape drops it. | A frame drawn with the region tool gets its own small bar: send this part, or discard. | js/scribble.js:474-482 |
| Scribble could not be loaded | current | Only when js/scribble.js fails to load. | The fallback line in the pane when the canvas module fails to load. | js/app.js:284-287 |

### Memo

The quick note that can be written from anywhere.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Memo, floating (wide) [anchored] | current | Key / or the round button at the bottom right. | A note that floats over the page, can be dragged, survives navigation and a reload. Several at once. No veil; Escape puts it on the stack. | js/quicksend.js:114 makeView |
| Memo as a sheet (phone) [modal] | current | At phone width, the round button at the bottom right. | On a phone the memo is a sheet at the lower edge with a veil over the page (css/quicksend.css:139). A tap on the veil or Escape puts it away. | js/quicksend.js:394-425 |
| Memos pile on the Desk | current | Write a memo, press Escape, then open "Memos" on the Desk. | Notes put away lie as lines in the pile "Memos" under the Desk's questions; a click floats one again. | js/memos.js:105, inbox.js:1077 |
| Memo on the paper (wide) | current | On the Desk, drag a memo by its head onto the paper. | A floating memo dropped onto the Desk's paper lies there as part of it. | js/quicksend.js:335, 366-377 |

### Menus and sheets

Small things that lie over the page: what remains of pop-ups, and how each closes.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Trommi menu [anchored] | current | Click "Trommi" at the top (a phone: the caret in the bar), or Ctrl/Cmd+K. | Jump field, desks, Agents, Help, Admin, Keys, the connection, knock sound, theme, Dev. No veil; Escape, a choice or a click beside it closes. | js/bar.js:76-115 |
| Jump results [anchored] | current | Ctrl/Cmd+K, type. | Typing in the menu's field lists sessions, "Question Nr. n", Desk, Agents, Scratchpad; Enter takes the first. | js/bar.js:117-159 |
| Keys sheet [modal] | current | Press ? or Menu, Keys. | Every key that works in the view that is up. A dialog in the middle of the page, since today without a veil; ?, Escape or a click beside it closes. Not offered on touch devices. | js/keys.js:324-375 |
| Choose a drawing [anchored] | current | In a session, click its drawing left of the name; on Agents, the drawing of a line (key D). | Forty drawings in a grid right under the session's mark; one click picks and saves. No veil. | js/agents.js:654 openMarkPicker |
| Rename a session [anchored] | current | In a session, click its name; on Agents, the name of a line (key R). | A small form right at the name that was pressed. Since today no longer a modal in the middle with a veil; Enter saves, Escape or a click beside it closes. | js/agents.js:708 openEditor |
| Row menu after a long press (phone) [anchored] | current | At phone width, hold a finger on a Desk row (or right click). | A sheet at the lower edge with a row's ways out: Snooze, Revise, Whatever, What??, Shred, Copy. Since today without a veil; a tap beside it or Escape closes. | js/inbox.js:313 holdMenu |
| Agents: sheet of one line (phone) [anchored] | current | At phone width on Agents, press "…" on a line. | What a wide line offers beside it: open, rename, drawing, crown, lay together, archive, move to a desk. Since today without a veil. | js/ledger.js:279-302 |
| Agent layout, large | current | `/large.html` In a message or card with a layout block, press "Open large". | A block of HTML an agent sent, as a page in a new tab (`/large.html#<key>`), in the same sandboxed frame. No longer a window over the board. | large.html, js/richhtml.js largeBlock |
| Share an asset | current | In a conversation, press "Share" on a published page or file. | Not a pop-up: the panel unfolds in the asset's card. "Create outside link", the link, when it ends, "Stop sharing". | js/ui.js:103-192 |
| Desk: rename, remove, new | current | Menu, on the desk in view: Rename or Remove. | In the menu, in place: a field instead of the desk's line; "Remove" asks "Really remove?" on the same button for four seconds. | js/bar.js:271-357 |

### Notes and errors

Passing notices and the ways something going wrong shows.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| "Answered" note with Back [note] | current | `/#undo` | After an answer: what was answered, and Back for five seconds (the key for ten). Beside the answer on a wide screen, a strip under the list on a phone. Blocks nothing. The link shows a sample. | js/back.js:126 say, app.js:592 |
| Error notice (toast) [note] | current | `/#toast` | The page's one passing error line, four to six seconds: canvas did not load, dictation stopped, "Not taken back". The link shows a sample that stays. | js/app.js:571-589 |
| Disconnected | current | `/#offline` | The hub does not answer: the pill in the menu's foot reads "Disconnected, reconnecting" and the menu's caret carries a dot. No pop-up; the browser reconnects by itself. The link shows a sample. | js/app.js:549-565 |
| Memo and copy notes [note] | current | Send a memo; copy a card (Ctrl+C on a marked row). | "Sent to X. Open the conversation", "Note thrown away. Take it back", "Copied — paste it into a session": quiet lines at the lower edge, a few seconds. | js/quicksend.js:48-71, cardclip.js:62-74 |
| Error on a card | current | Answer a card while the hub is down. | "Not saved: …" stands on the card itself, with a shake; the feed says "Not sent: …". | js/focus.js:815, 1104 |
| Error on a row, in the menu, in the ledger | current | Any action while the hub is down or older than the page. | Each where the action was: under the row, under the Desk's head (5 s), in the menu ("Needs the hub restart.", "Not saved: …"), in the ledger's note line. | js/inbox.js:382, 796; bar.js:231, 268; ledger.js:126 |
| Microphone and passkey prompts [modal] | current | Press a microphone button for the first time. | The browser's own: the microphone on the first dictation (never on load), the passkey sheet on sign-in. No notification prompt, no "leave this page?" prompt anywhere. | js/speech.js:578, pad/pad.js:784 |
| Not found | current | `/no-such-page` | An address the hub does not know: the bare line {"error":"not found"}. There is no 404 page. | server/server.mjs:3554 |

### Sign-in and passkeys

What somebody without a login sees, and the passkey page.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Sign-in page | current | Open the board in a private window, without the ?t= link. | What a page request without a login gets (status 401): "Sign in with a passkey" and a note about the link. Without passkeys: one plain line. | server/passkey.mjs signInPage, server.mjs:3155 |
| Passkeys | hidden | `/passkeys` | The list of passkeys with Remove, and "Add a passkey on this device". Linked from nowhere in the app. Its Remove is the one browser confirm() left (server/passkey.mjs:416). | server/passkey.mjs |
| Login link | current | The link in data/url.txt. | Any address with ?t=<token> signs in and redirects to itself without the token. | server/server.mjs:3128 |

### Assets and sharing

Published pages and files: the viewer, and the page for somebody outside.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Asset viewer | current | `/a/<id>#<key>` | /a/<id>#<key>: a published page in a sandboxed frame, a picture, video, sound, or a file to download. Decrypted in the browser. | a.html, js/asset.js |
| Asset viewer: no key | current | `/a/AAAAAAAAAAAAAAAAAAAAAA` | The viewer's problem states: no key in the address (this link), a wrong key, gone, too many requests, offline, unknown format. | js/asset.js:66-89, 156 |
| Asset viewer: gone | current | `/a/AAAAAAAAAAAAAAAAAAAAAA#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` | What a link shows whose asset was withdrawn, has run out, or never existed. | js/asset.js:68 |
| "Shared with you" | current | `/r/AAAAAAAAAAAAAAAAAAAAAA#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` | /r/<id>#<key>: the page somebody outside gets for an asset that was released. Follows the system's theme, needs no login. The link shows its "gone" state. | server/share-viewer.mjs |
| An uploaded file | current | `/files/<name>` | /files/<name>: an attachment as the browser shows it. This is what "Open the original" leads to. | server/server.mjs:3187 |

### Admin and help

The two side doors of the menu.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Admin | current | `/admin.html` | Behind a key of its own (data/admin-token): overview, sessions (discard, forget), cleanup, access links, export, diagnosis. Its confirmations are inline. | admin.html, js/admin.js |
| Help | current | `/help.html` | How the board works, the keys, and for agents: events and tools, read from the hub. | help.html, js/help.js |
| Help: the keys | current | `/help.html#keys` | The whole table of keys as a section of a page (the "?" sheet lists only those of the view that is up). | js/help.js:183 |
| Help: the diagram alone | hidden | `/help.html#diagram` | Hash flag #diagram: only the picture of how agents and the board talk, on white. Made for screenshots. | help.html:15 |

### Dev and workbenches

Pages and switches made for building and testing. None is linked from the app.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| All screens | current | `/screens.html` | This page. Menu, Dev, "All screens". | screens.html, js/screens.js |
| Fake decisions | current | Menu, Dev. | Menu, Dev: "Create 5 fake decisions" throws test cards onto the Desk, "Remove fake decisions" takes them away. | js/bar.js:221-258 |
| Dark or light by link | hidden | `/#dark` | Hash flags #dark and #light set the theme for this load, whatever is remembered. Also on Admin, Help and the pad. | index.html:12-17 |
| Focus workbench | hidden | `/focus-preview.html` | The card page with sample questions and no hub, with hash flags for its states. | focus-preview.html |
| Scribble workbench | hidden | `/scribble-preview.html` | The canvas alone, with hash flags for its states (style panel open, confirmation open, …). | scribble-preview.html |
| Board without a server (hash routes) | hidden | `/#/agents` | Opened as a file, or with "#/" in the address, every route stands behind the hash: #/s/<id>/q/<n>. A page opened that way keeps writing them that way. | js/app.js:67, link.js:17 |
| Old notes: layouts | hidden | `/layouts.html` | A German design note: five ways to separate decisions from the conversation. | layouts.html |
| Old notes: naming | hidden | `/naming.html` | The study of names and domains. | naming.html |
| Old notes: crypto concept | hidden | `/krypto-konzept.html` | The concept for keys and encryption (German). | krypto-konzept.html |
| Old notes: tech stack | hidden | `/tech-stack.html` | A memo on the stack. Nothing links to it. | tech-stack.html |
| Old notes: Scribble in the conversation | hidden | `/scribble-vorschlag.html` | A proposal page (German). Nothing links to it. | scribble-vorschlag.html |
| Health check | hidden | `/healthz` | {"ok":true}, for a supervisor. Needs no login. | server/server.mjs:3126 |
| Tools as data | hidden | `/api/tools` | The JSON the help page draws its reference from. | server/server.mjs:3164 |

### Design pages

Proposal pages under /designs/: drafts that were shown on cards. Static, none is part of the app.


**Whole layouts (drafts A to S, W2)** (35): `a.html`, `b.html`, `c.html`, `c1.html`, `c2.html`, `c3.html`, `c4.html`, `c5.html`, `d.html`, `e.html`, `g1.html`, `g2.html`, `g3.html`, `g4.html`, `index.html`, `interface.html`, `nosidebar-canvas.html`, `nosidebar-classic.html`, `nosidebar-crumb.html`, `nosidebar-desk.html`, `nosidebar-edge.html`, `nosidebar-fan.html`, `nosidebar-ledger.html`, `nosidebar-pill.html`, `nosidebar-shelf.html`, `nosidebar-strip.html`, `nosidebar-switcher.html`, `nosidebar-tabs.html`, `s1.html`, `s5.html`, `stand.html`, `takeovers.html`, `w2a.html`, `w2b.html`, `w2c.html`

**Desk, piles and rows** (49): `actions-under-field.html`, `actions-under-options.html`, `buttons.html`, `desk-menu.html`, `desk-tabs.html`, `deskmark.html`, `ears.html`, `group-pile.html`, `group-sheet.html`, `group-spine.html`, `group-tab.html`, `group-tiny.html`, `iphone-checks.html`, `phone-bar.html`, `phone-calm.html`, `phone-list.html`, `phone-one.html`, `phone-sheet.html`, `piles-bar.html`, `piles-folds.html`, `piles-ledger.html`, `piles-line.html`, `piles-margin.html`, `piles-pegs.html`, `piles-tabs.html`, `piles-tally.html`, `piles-today.html`, `piles-trays.html`, `piles5.html`, `rowacts-above.html`, `rowacts-below.html`, `rowacts-flag.html`, `rowacts-hover.html`, `rowacts-two.html`, `rowacts-under.html`, `rows.html`, `runs.html`, `simple-bin.html`, `simple-four.html`, `simple-keys.html`, `simple-merge.html`, `simple-one.html`, `simple-two.html`, `thumbs-choose.html`, `thumbs-labels.html`, `thumbs-now.html`, `thumbs10.html`, `trio.html`, `whatever10.html`

**Card and answers** (35): `advice-bracket.html`, `advice-circle.html`, `advice-hand.html`, `advice-handline.html`, `advice-marker.html`, `advice-star.html`, `advice-underline.html`, `advice.html`, `card-back.html`, `card-decided.html`, `card-margin.html`, `card-memo.html`, `card-unfold.html`, `current-arrow.html`, `current-bar.html`, `current-caret.html`, `current-corners.html`, `current-deeper.html`, `current-lift.html`, `handback.html`, `nextplease.html`, `trust-arrow.html`, `trust-fine.html`, `trust-initials.html`, `trust-shrug.html`, `trust-stamp.html`, `trust-sure.html`, `trust-surprise.html`, `trust-wave.html`, `trust-whatever.html`, `trust-yourcall.html`, `vip.html`, `vip2.html`, `walk-form.html`, `walk-word.html`

**Sidebar, sessions, crowns** (33): `bar-agents.html`, `bar-counts.html`, `crown-bracket.html`, `crown-caption.html`, `crown-columns.html`, `crown-fold.html`, `crown-ground.html`, `crown-line.html`, `crown-marks.html`, `crown-stack.html`, `crown-stripe.html`, `crown-tree.html`, `crown.html`, `joined-folded.html`, `joined-merged.html`, `joined-stacked.html`, `joined-tabs.html`, `rail-fold.html`, `rail-none.html`, `row-both.html`, `row-hand.html`, `row-left1.html`, `row-left2.html`, `row-left3.html`, `row-left4.html`, `row-mark.html`, `row-orbit.html`, `row-pen.html`, `row-runner.html`, `row-today.html`, `row-track.html`, `row.html`, `sessions-explained.html`

**Menu** (7): `float5.html`, `menu-cmd.html`, `menu-corner.html`, `menu-float.html`, `menu-foot.html`, `menu-split.html`, `menu-top.html`

**Memo, quick send, dictation** (18): `bubble-inside.html` (stale), `bubble-mark.html` (stale), `bubble-tick.html` (stale), `diktat-menue.html`, `diktat-stapel.html` (stale), `diktat-zeichnung.html`, `live-bubble.html`, `live-field.html`, `quick-bar.html`, `quick-chat.html`, `quick-dictaphone.html`, `quick-memo.html`, `quick-pad.html`, `quick-plane.html`, `quick-sticky.html`, `quick-telegram.html`, `quick-tray.html`, `quick-tube.html`

**Logo, name and words** (24): `brand.html`, `landing.html`, `logo-bell.html`, `logo-brush.html`, `logo-dash.html`, `logo-double.html`, `logo-flourish.html`, `logo-fold.html`, `logo-ring.html`, `logo-strike.html`, `logo-tick.html`, `logo-z.html`, `logo.html`, `logo10.html`, `names-bang.html`, `names-com.html`, `names-domains.html`, `names-inbox.html`, `names.html`, `words-directions.html`, `words-inbox.html`, `words-napkin-scratch.html`, `words-pad.html`, `words-sidebar.html`

**Architecture and concept** (5): `architecture.html`, `assets.html`, `crypto-picture.html`, `open-source.html`, `stack.html`

**Other** (1): `tabicon.html`

### Dead code

Views that can no longer be reached: the code or the styles are still in the tree.

| Screen | Status | Address or steps | What it is | Where |
|---|---|---|---|---|
| Phone tab bar (Conversation / Scribble) | dead |  | nav.tabbar at the foot of index.html is display:none at every width and in every place. Its two links still carry click listeners, and the toast still measures it. | index.html:169-183, css/app.css:499, 1206, 1575 |
| Mode switch in the session head | dead |  | "Conversation / Scribble" in the pane title is never displayed. It only lives on as the thing other code clicks. With it the unread dot (#chat-dot) can never be seen. | index.html:138-141, css/app.css:1206, app.js:204 |
| Footnav (Desk, Agents buttons) | dead |  | The two buttons in the bar are display:none for good; every place in the code that wants to go to the Desk or Agents clicks them unseen. | index.html:114-117, css/app.css:1314 |
| Focus button in the bar | dead |  | #focus-open carries the hidden attribute and nothing takes it off. It stays as the spot the pad's button is put before. | index.html:121, app.js:379 |
| The walk as a scrolling list | dead |  | LIST_WALK = false: the walk that laid all cards on one long page. Its code, its end piles, its strips and about 150 lines of styles are still there. | js/focus.js:116, 2270-2505; css/focus.css:673-736 |
| The card's old top bar | dead |  | Sender, tab, time, Close and the hint "More urgent: …" in .focus-top: display:none on the card page, so its hints are only heard by screen readers. | js/focus.js:276-313, css/focus.css:1510 |
| Card buttons never placed | dead |  | Later, Explain and Hand back as buttons of the card (laterBtn, explainBtn, handBtn) are built and never put on the page; the "Discuss" block has styles and no element. | js/focus.js:290, 294, 2197; css/focus.css:970-1023 |
| Revise by opening the card | dead |  | openFocus(…, { revise }) returns before the line that would open Discuss: Revise always hands back at once. | js/app.js:330-334 |
| The first dictation button | dead |  | mountDictation, the record-then-transcribe microphone from before live dictation (one German line: "Nicht erkannt"). Nothing imports it. | js/speech.js:410-472 |
| Toast with a button ("undo" kind) | dead |  | showToast takes an action nobody passes any more: the Back note replaced it. Its styles remain. | js/app.js:579, css/app.css:493-496 |
| The old quick-send bar | dead |  | Styles for a .quick bar with a card clip in it; the memo replaced the bar and nothing creates it. | css/cardclip.css:41-46 |
| The old "answered" group and pile parts | dead |  | Styles for an answered group on the Desk and for pile parts (fold, peek, tally) that nothing creates since the piles were rebuilt. | css/back.css:66-82, css/app.css:1027-1062 |
| "All sessions" row of the sidebar | dead |  | Styles for .agent-all; no code creates it. Of the old roster only the name is left: body[data-page="roster"] is the Agents page. | css/app.css:544-546 |

## Pop-ups

He wants none: the opened card became a page on 2026-10-03. What is left that lies over the page, and what
was done about it. Nowhere in the client is there an `alert`, `confirm` or `prompt`, a `beforeunload` prompt, or
a notification prompt. The one browser `confirm()` is on the server's `/passkeys` page (`server/passkey.mjs:416`).

| Thing | Where | Before | Now |
|---|---|---|---|
| Rename a session | `js/agents.js` openEditor | modal in the middle, dark veil, no close by a click beside it | **converted**: a small form at the name that was pressed, no veil, Escape / Cancel / click beside it |
| Keys sheet (`?`) | `js/keys.js:324` | modal, dark veil | **veil removed**; still a sheet in the middle (decision below) |
| Row menu, long press (phone) | `js/inbox.js:313` | bottom sheet, dark veil | **veil removed**; Escape or a tap beside it closes |
| Agents: sheet of a line (phone) | `js/ledger.js:279` | bottom sheet, dark veil | **veil removed**; Escape, Close or a tap beside it |
| Choose a drawing | `js/agents.js:654` | anchored under the mark, no veil | kept as it is |
| Trommi menu, jump results | `js/bar.js:76` | anchored, no veil, Escape and click beside it | kept |
| Desk: rename / remove / new | `js/bar.js:271` | in the menu, in place; "Really remove?" on the same button | kept (already a two-step button) |
| Scribble: colour and width, "Clear everything?" | `js/scribble.js:402, 433` | small panels at their buttons, no veil, Escape | kept |
| Admin confirmations | `js/admin.js:131` | inline: the button becomes the question | kept |
| Share an asset | `js/ui.js:103` | unfolds inside the asset's card | kept (not a pop-up) |
| Back note, error notice, memo and copy notes | `js/back.js`, `app.js:571`, `quicksend.js:48`, `cardclip.js:62` | pass by themselves, block nothing | kept |
| Disconnected, 401, old hub | `js/app.js:549`, `bar.js:248` | the pill in the menu; an inline line where the action was | kept (no pop-up exists for these) |
| Picture, large | `js/chat.js` lightbox | full-screen modal, dimmed and blurred | **converted**: a page with the address `/s/<id>/files/<n>`, no veil; Back, Escape or the link at the top left closes; previous and next are links |
| Agent layout, large | `js/richhtml.js`, `large.html` | modal window, dark veil | **converted**: "Open large" is a link that opens the block as a page in a new tab (`/large.html#<key>`), same sandboxed frame |
| Memo on a phone | `css/quicksend.css:139` | bottom sheet with a veil | open: file held by the memo worker |
| Pad: "Send to…" | `pad/pad.js` openSendDialog, `pad/pad.css` | modal in the middle with a veil | **converted**: a panel at the selection, no veil; select → send → flies away unchanged |
| Pad: keys | `pad/index.html:130` | modal with a veil | **veil removed**: the same sheet as the board's keys |
| Card page: picture zoom | `js/focus.js:2919` | lies over the card, traps Tab | open: file held by the card worker |
| Card page itself | `js/focus.js:265, 2756, 3166` | looks like a page, but is still `role=dialog aria-modal`, makes the page inert and traps Tab | open: file held by the card worker |
| Passkeys: Remove | `server/passkey.mjs:416` | browser `confirm()` | open: server file |
| Microphone, passkey | browser | the browser's own prompts, only after a press | cannot be removed |

### Decisions for Christopher

1. **Keys sheet.** Recommended: keep it as a sheet without a veil. It lists the keys of the view that is up, which
   a page of its own cannot know; the whole table already is a page (`/help.html#keys`).
2. **Memo on a phone.** Recommended: drop the veil like the other sheets (one line, `css/quicksend.css:139`).
3. **Card page.** Recommended: take `aria-modal`, the inert page and the Tab trap off the card page, so it is a
   page for the keyboard and for a memo too (see the error below).
4. **Passkeys Remove.** Recommended: a two-step button ("Really remove?") instead of `confirm()`.
5. **Dead code.** Recommended: one cleaning pass over the "Dead code" list above (the tab bar, the footnav buttons
   that are only clicked by code, the list walk, the old top bar of the card).

## Errors found on 2026-10-03

Every linked screen was loaded at 1440x900 and 390x844 on a test board (55 addresses, both sizes), watching the
console, uncaught exceptions, failed requests and sideways scroll.

- No uncaught exception, no console error and no sideways scroll on any page of the app.
- Expected answers only: 404 for the "not found" and "gone" samples, 403 from Admin before its key is given.
- Four design pages threw on load (`designs/bubble-*.html:47`, `designs/diktat-stapel.html:104`): guarded, and marked "stale" on the
  screens page: they decorate parts of the live board that have changed since.
- `/focus-preview.html` asks for five sample files under `/files/` that only exist on a demo board (404).
- **A memo cannot be typed into on a card page**: the card takes the keyboard back at once
  (`js/focus.js` rescueFocus, about line 2759: it only lets go for what is inside the card). For the card worker.
- On a card page the hints "More urgent: …" and other `info()` lines are written into `.focus-top`, which is
  `display:none` there (`css/focus.css:1510`): they are never seen. For the card worker.
- "Revise" from a Desk row hands back at once, though its label says "say what should change"
  (`js/app.js:330`, `js/inbox.js:560`).
- `js/app.js:51-53` holds a stray comment left by a worker ("NOT applied: the permission system refused…").
- The Desk has no loading state: it reads "Desk is clear." until the state has arrived (`js/inbox.js:1010`).

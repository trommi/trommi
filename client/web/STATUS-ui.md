# UI worker log (index.html, app/store/inbox/agents/chat/history/ui.js, app.css, tokens.css)

## House rule: hand-drawn is the accent
From the user: "Maybe a bit overdone with the hand-drawn. The buttons are often simply normal, and then something like a
circle is hand-drawn in it. We should not overdo it."
- Controls and surfaces are clean and normal: quiet rounded shapes like the option tiles. No wobbly outlines around buttons,
  inputs, menus or bar entries, no tilted controls.
- Drawn by hand is the accent only: the small drawing inside a button (`sketch()`), a circle, a mark, the session doodles,
  the crown, the marker behind an advised label, the underline under `__words__`, a slight tilt of a paper edge.
- One drawing family: everything comes from the pen functions in `js/ui.js`. No stock icons, nothing copied from other products.

Running notes, newest at the bottom. Nothing here is committed by the worker.

## 1. Later stack: done
- Was already built by the interrupted worker (store.js `putOff`, inbox.js group at the end, dashed heading).
- Verified on the demo board (1440x900): two cards put off, both left their sender, stand in ONE last group,
  rows 148px, tiles 124x124, "fetch back" tile in place of "later", each row names its session,
  big count went 45 -> 43, ids persisted in localStorage `trommi-later`.

## Added by the coordinator while working (in progress)
- A: Questions mode removed; open questions stand in the conversation as inbox rows; "Questions only" filter.
- B: "Files" filter in the pane title.
- English UI; corner tab only for Blocking/Urgent; scribbled icon family.

## State after the first full pass (all verified on a demo board, 1440x900 and 400x860, light and dark)
- **A (questions in the conversation): done.** No Questions mode any more. An open question stands in the log as the
  same row as in the inbox (148px, verified). Pane title has the toggles "Questions only (n)" and "Files"; they lay a
  list over the log (the log keeps its scroll position: 200 -> 200), the composer stays. Phones: tab bar has two tabs.
- **B (Files): done.** One list per session: attachments of messages and cards, scribbles, links in agent messages.
- **English: done** in my files (focus.js etc. belong to others).
- **Corner tab: done.** Blocking (red) / Urgent tabs only, none for normal, a scribbled hourglass for "whenever";
  the number sits in the title attribute.
- **Scribbled icons: done.** `sketch(name)` in ui.js: hand, yes, no, later, back, choose, whenever.
- **Later always possible: done.** Small arrow left of the tiles on every row (key L).
- **Thumbs / one wide "Choose": done.** Choose unfolds the row in place (options as tiles, ask-back line);
  `needsWindow(card)` in inbox.js decides when the Fokus window opens instead.
- **Multi-select: built against the contract** (`card.multiple`, `POST /decide {keys}`), verified with a fake fetch.
- **Ask back: built against the contract** (`POST /message {text, agent, card_id}`); a user message with `card_id`
  shows "About <question>" above its bubble.
- **Keyboard flow: done.** "Go through them" marks the first row; arrows, Y/N, L, C/Enter, digits, U. Verified: after
  an answer and after "later" the marked row stands at the same y.
- **2. Sidebar: done.** No status word, no dot; badge = ring+count / hand / grey; "Disconnected" group with archive
  button; twins get a second line (folder, machine, or since). Archive kept locally until the server knows `archived`.
- **Working ring: done.** Thin ring plus a filled swelling (3x), 3s per turn.
- **3. Pairs: done.** Drag a session onto another (mouse at once, touch after a hold), or "Put together with…" on the
  Agents page; one row with a joint scribbled mark; conversation in columns with own composers; filter per column;
  phone: one column, names switch. Drag out or "Split" dissolves. Kept in localStorage until the server sends `group`.
- **4. Links: done.** Help and Admin in the bottom bar (desktop) and at the foot of the Agents page (phone).
- **Real URLs: done** (History API): `/`, `/agents`, `/s/<id>[/questions|/files|/scribble]`, `/s/<a>+<b>`, `?q=<card>`.
  Back/forward verified by script. A reload on a deep path needs the server fallback.
- **VIP golden ticket: done**, label in `VIP_LABEL` (inbox.js).

## Last pass
- Address bug fixed (closing a question window by "back" left `?q=` behind). Verified: open -> back -> forward -> close.
- The demo server started from the current `server.mjs` already serves `/s/...` (reload works there) and keeps `group`.
- Dead code: `is-full` was already gone; removed the old `.ask-*` card, `.tab-badge`, `.hist-nr`, `.roster-change`,
  the avatar's online dot, `#questions`/`#history`/`#session-cards` ids, unused icons. A grep of every class and id in
  app.css/tokens.css against js/ and index.html finds none unused.
- Not verified: touch drag (long press) on a real phone, `archived` against a real server, real `card_id` round trip.

## After the server contracts landed
- Demo on 8795 restarted from the current tree. Verified against the real server: ask-back (`card_id` comes back on the
  message, "About <question>" shows), archive (server marks it, queue 29 -> 25, session leaves sidebar and inbox, is
  listed under Archive, "Fetch back" restores it), `group` (a pair survives a fresh browser).
- `recommended` may be a list: every named option is circled.
- Asset hook: a message with `asset` is a card in the conversation (type, size, title, note, Open, Copy link; dashed
  "No longer available" when gone) and a line in Files. Verified with a synthetic state only.
- Help link is `/help.html`.

## Round three (second UI worker): hooks finished, polish, and what the user said while it ran
Checked on an own demo board (trio on 8797, own data folder) with a scripted counterpart (`dev/session.mjs link/call/publish`
against that board), headless Chromium at 1440x900 and 400x860, light and dark.

- **Server contracts.** The localStorage fallbacks for `group` and `archived` are gone from store.js (old keys are removed
  once). Verified against the real server: archive (409 for an online session; offline: `archived: true`, queue 17 -> 16,
  row gone, cleared by itself on reconnect), pair made in browser A through the Agents page shows in a fresh browser B and
  "Split" in B shows in A, multi-select (`choices: [lint, e2e]`, the agent got `choices="lint,e2e"`), ask back (the agent got
  `kind: chat` with `card_id`, its `reply` with `card_id` shows "About <question>" too).
- **Assets.** Real assets published with `session.mjs publish`: card in the conversation, line in Files, revoked one dashed.
  The card is now repainted when its message changes (it used to stay as it was first drawn). A link to an asset inside any
  text is a compact card (`assetLink` in ui.js, styles in tokens.css): title and type from what the board knows, pictures
  decrypted in the page as a thumbnail (up to 4 MB, only on https or localhost), the key never printed; the collapsed row
  shows `[title]`. Other long links: host and start of path; an address in backticks is a link, not a code box.
- **Working ring.** A ring circled by hand on a soft green ground and a drop drawn on its own that goes round (4.6 s a turn,
  slower over the top, drawn twice 150 ms apart so it stretches where it is quick). Reduced motion: the ring alone.
- **Waiting hand.** Redrawn as one scribbled stroke (no palm line) in a loop circled by hand, on soft red. Ring and hand are
  both 32px on one axis (28px on a phone).
- **VIP.** No frame, no sheen, no tint. The mark stands once: gold scribble tile and a small tab at the group heading in the
  inbox, the tab in a session's title. A row carries the tab only in Later. (A design worker is redoing the label.)
- **Later.** A small tag hanging over the row's bottom edge (11px out, 16px gap between rows), word slides out on hover or
  focus, no tooltip. Row height and tiles unchanged (148 / 124).
- **Pairs.** Names on separate lines, never cut; the title uses the whole width and shows what tells twins apart; the mark is
  60x44. Pull one out by its name line or its scribble (the loop opens while it is carried clear), scissors under the badge
  cut the whole group. Verified with real pointer events: three -> two plus one -> none.
- **Drawings.** 40 named drawings (`DRAWINGS` in ui.js, mark `draw:<name>`): the eight kinds plus star zigzag eight arrow leaf
  eye key anchor kite comb ladder heart moon cloud drop flag house tree fish bird cup bell cross triangle square diamond grid
  mountain umbrella crown flame boat. Existing seeds draw as before (the iOS fixtures are byte-identical). A click on the
  picture (session title, Agents page) opens the grid; a click on the name renames.
- **Answered marker** names the question: "Answered  <question> -> <answer>". **Thumb labels**: `fitsTile` in inbox.js.
- **Advice.** The circle is drawn in one place, `adviceLoop()` in ui.js, a squarish pen loop stretched round the tile, so it
  clears two-line labels. The mark itself is waiting for the user's choice between five proposals.
- **Admin** in the bar carries a small scribbled key. **Archive** has its own box icon.
- Not verified: copying a link (headless Chromium has no clipboard), touch drag on a real phone, Safari.
- Others work in these files now: keys (inbox.js, app.js, index.html), Focus (focus.js, focus.css), the coordinator (store.js).


## Round three (third UI worker): the state at its end
Much of this round was decided by the user while it ran; this is what stands at the end, not the way there.
Checked on an own demo board (trio on 8804, restarted from the current tree, plus a scripted session "Probe" via
`dev/session.mjs` for cards with advice, urgency, info cards and underlined text), headless Chromium with real pointer, touch
and key events at 1440x900 and 400x860, light and dark. `node dev/ui-test.mjs --only inbox,later,choose,admin`: 262 passing,
0 failing, 4 pending (before the tally piles and the fixed group loop; QA follows the UI in that file).
Screenshots: `/tmp/claude-1000/ui3/` (`before-*`, `zz-*` final, `fin-*` sheets that were posted on the board).

**Sidebar**
- Marks and state have no ground. A session's mark is the drawing alone in its colour. At work the mark redraws itself
  (`avatar(agent, { working })`: a trace at half strength, a darker stroke travelling along it; still under reduced motion).
  At the right: the count of open questions, all in one column; a red `bareHand()` just before it when the session waits;
  a working session's count small and muted, a disconnected one's faint. The badge is a button of its own beside the entry
  (`.agent-row > button.agent-badge`): it goes through that session's questions (`walkSession(id)` in app.js, exported).
- A group: no "+", the names laid on sit slightly askew; scissors (`sketch('snip')`) only under the pointer or keyboard; the
  hand-drawn loop goes round the whole entry (`groupLoop()`); a row is as tall as its names.
- VIP is the crown (`crown()`); shown in the sidebar, switched in the session title and on the Agents page (`crownToggle()`).
- Dragging: middle of another row = lay together (loop opens), upper/lower quarter or between rows = move there (thin line),
  clear of the list = pull out of the group; a group moves as one. Alt+arrow moves by keyboard (heard in agents.js;
  `mountAgents().move(by)`). Order: `moveSession()` in store.js -> `POST /session { agent, before }`; a hub that sends no
  `position` gets a per-browser fallback (`trommi-order`, marked FALLBACK in store.js).
- No scrollbar on the sidebar; thin quiet ones on the panes.

**Inbox**
- One list at one pitch, no sender headings (`section.inbox-group[data-sender]` still holds a sender's rows). A row: knock tab
  if it is one, title, text, byline (`.inbox-byline`: a small mark for "can wait" / "to read", who asks `.inbox-from`,
  `.inbox-nr` "Nr. 12", age, "Trust" on thumb rows, what the card carries `.inbox-carries`).
- Tiles: 124 square, from the right, set in 31 px (the corner's strip). Exactly two options: always two tiles; labels at the
  usual size, else smaller in up to three lines, else thumbs alone with tooltips (`labelSize()`); never a word broken inside.
  More options: one tile "Choose" (class `is-wide` kept). Info card: "What??" (`.is-what`) and "Acknowledge" (`.is-ack`,
  `POST /close`); keys Y/Enter and N/E on the marked row.
- Knocks: `KNOCK_WORD`, `KNOCK_BLOCKING_WORD`, `KNOCK_PERMISSION_WORD`, `KNOCK_SKETCH`, `isKnock()`, `knockWord()`,
  `knocksText()` in ui.js; "3 knocks · 9 questions need you · 2 to read" beside the heading (the line is the way into the
  walk, `.inbox-walk`); the inbox's badge and the title show the knocks first; a new one arrives with two nudges, its
  session's mark too (`js/knock.js`); sound off by default ("Knock sound" in the logo menu).
- Snooze (`LATER_WORD`, `LATER_SKETCH`; waking `WAKE_WORD`, `WAKE_SKETCH`): the row's top right corner, `.inbox-later`, a
  30x46 strip that alone takes the click. At rest slightly bent; under pointer or keyboard it folds down as a flap with
  z z z and the word (`.inbox-later-ear/-flap`); a finger's first tap folds it down, the second snoozes. All of it in one
  CSS block, so the variant the user picks can replace it.
- Trust (`TRUST_WORD`, `trust()` in store.js -> `POST /decide { trust: true }`): a word in the byline of thumb rows, the last
  entry of an unfolded Choose row; in Answered it reads "Trusted: <advice>".
- Piles at the foot (`pile()` in inbox.js): Snoozed, With the agent (`state.handed`), Answered. Folded: a `tally()` of the
  count (five to a gate, capped at 25, then "+15"), name and number, the latest entry in one line. A click or Enter opens the
  list in place, full width, one at a time. Selectors kept: `.inbox-pile`, `.inbox-pile-head`, `.is-open`,
  `.inbox-answered-toggle`, `.inbox-group-later/-asked/-answered`.
- After an answer the next row lands where the answered one stood (`landOn()`); with one pitch that is the layout itself.
- Advice (`adviceLoop()`, also exported as `adviceMark`): a highlighter swipe behind the label, one pass per line, measured
  from the text and redrawn on resize; on a filled tile (`--advice-under: 1`, tokens.css) a light line under the words
  instead. `pointingHand()` is kept, unused. Underline: `__words__` -> `.rich-under`; more than a third underlined -> plain.
- Also: Markdown tables (`.rich-table`); an unfolded Choose row does not repeat a text the row already shows; asset cards in
  a text are drawn again when the asset is withdrawn (`refreshAssetLinks()`); the admin page is English.

**Bar** (`js/bar.js`, `js/quicksend.js`)
- Logo = menu: Help, Admin, Keys, Knock sound, Dark theme, the connection. A lost connection shows at the logo too.
- Inbox, Agents; the quick-send field to the crowned session (Enter sends a plain message, Shift+Enter a new line and the
  field grows upward, "/" jumps in, paste or drop attaches, microphone, a list to switch or crown a receiver; a phone opens
  it from one icon); the pad's control. No Focus button (`#focus-open` stays in the page, hidden, for wiring).

**Drawings**
- 52 named drawings (twelve new: browser terminal database phone brush flask lock book rocket mic bug branch), each with a
  hue of its own (`drawingHue()`), a meaning (`DRAWING_INFO`); `hueFor(agent)` in agents.js gives a session with a named
  drawing that drawing's colour. `client/web/drawings.json` is written by `node dev/drawings-json.mjs` (run it again after
  changing the drawings).
- New names for the iOS and Linux ports (no existing name or seed changed): the twelve drawings above; sketch names
  `snip unfold go moon sun frame question keycap tray heads grid knock wake tick`; functions `crown() groupLoop() bareHand()
  tally() pointingHand() sweepMark()` (the last unused now), and `adviceLoop()` draws the marker.

**Not done / not verified**
- Shred: no `POST /shred` and no `SHRED_WORD` yet. Kite and diamond still look alike (changing either would change an
  existing name's output). The working trace is not in the session title (app.js does not know there whether it works).
- Not verified: the Focus window with the new advice mark and the card number (it failed to load for part of the round: an
  error in focus.js), touch drag on a real phone, Safari, the knock sound by ear, dictation in the quick-send field, a real
  file dropped into it.

## Round four (same worker): what changed after the round-three notes above
- **Rows are "Side with Span"**: in the inbox the sender stands in a gutter at the left of the cards (`.inbox-gutter`: mark and
  name once per run of a session's rows, sticky inside a long run, a `runBracket()` down the run); each row's note
  (`.inbox-byline`: number, age, and on hover "Trust" / "Shred") stands beside it in the gutter. The cards hold the knock
  label, title, text, and the picture with what the card carries under it (`.inbox-pics`). The gutter takes the page's left
  margin from 1000 px of inbox width (cards keep 760), is made inside the list from 821 px, and below that the note is a
  line of the card (top line on a phone; later rows of a run drop mark and name). A session's own list is unchanged.
- **Shred** (`SHRED_WORD`, `SHRED_SKETCH`, `shred()` in store.js -> `POST /shred`): a quiet action in the row's note, key
  action `list.shred` (not in the key table yet), the row leaves in strips, Back note, and a fourth pile "Shredded" (today's).
- **Bar**: symbols only. Logo menu at the left; at the right a speech bubble wearing the crown (opens quick send as a small
  sheet above the bar; "/" opens it too) and the pad's drawing. No Inbox/Agents buttons (`.footnav` stays in the page,
  hidden, for the keys and the wiring); the Agents page is reached from "agents" in the inbox's line:
  "4 knocks · 16 questions need you from 4 agents · 1 to read".
- **Sidebar has no numbers**: a small `sketch('stack')` when a session has questions, the red hand alone when it waits for
  you, nothing for idle and disconnected; the Inbox entry shows the stack, or the knuckles when something knocks. The symbol
  is still the button into that session's questions; the numbers are in the tooltips.
- The working trace is in the session title too. `summary()` and `badge()` are exported for the Ledger.
- The old roster (`mountRoster`, `.roster-*`) is still built and hidden by ledger.css; `dev/ui-test.mjs` names its selectors
  in forty places, so it was left for QA and the Layout worker to retire together.

## Later the same day: what replaced parts of the notes above
- **No bar.** On wide screens `.topbar` is a small pill floating at the top centre (`js/bar.js`): the Trommi mark and name
  open a menu centred under it with a jump field (`#jump-field`: a session by name, a question by "12" / "Nr. 12", Inbox,
  Agents, Scratchpad; `openJump()` is exported for a key, action name `go.jump`), the project (one today), Agents, Help,
  Admin, Keys (`#keys-open`), Knock sound, Dark theme (`#theme-toggle`) and the connection. A lost connection shows at
  the pill. `#focus-open`, `.footnav` (`#nav-inbox`, `#nav-roster`) stay in the page, hidden, for the wiring and the keys.
  A phone keeps its top bar with the logo at the left.
- **Floating at the bottom right**, on every page: the crowned speech bubble (`.quick-open`, quick send as a small sheet above
  it, "/" opens it) and the pad's control (restyled from app.css). In a session they stand above the composer (`--float-up`).
- **Sidebar**: the Inbox entry is sticky at the top and shows its count (with the knuckles when something knocks); session
  rows show `sketch('stack')` or the red hand, no numbers; nothing for idle and disconnected.
- **Rows**: the gutter holds only who asks (mark and name beside the middle of the run's first row, sticky; `runBracket()`);
  number and age are the card's byline again. The Snooze corner is a page curl: the fold grows in from the corner
  (`.inbox-later-ear` grows from `--tip` to `--ear`), the word and z z z stand on the underside. "Shred" shows on a row only
  while Shift is held (`body[data-shift]`, set in bar.js), otherwise in the opened card (`.inbox-shred-open`). Keys:
  `list.trust`, `list.shred` are provided.
- **Heading**: "4 knocks · 16 questions need you from 4 agents · 1 to read" as a sentence ("agents" is a link), and a real
  button into the walk (`.inbox-walk.inbox-go`, word in `WALK_WORD`, "Go through them" until the word is chosen).
- **Piles**: folded, one quiet line each: the word and a `tally()` of at most three gates; nothing else. "With the agent" is
  called "Waiting".
- Suite at the end: `--only inbox,later,choose,admin` passes except "the window has no address of its own: /q/N" (the
  address is app.js routing, not this worker's).
- **Snooze is "slide"** (the user's choice on card Nr. 126; it replaces the page curl): a paper label tucked behind the
  row's right edge at the top, a nub with z z z peeking out; under pointer or keyboard it slides out with the word. In the
  inbox on a wide page (inbox width over 1000 px) it lies wholly in the right margin and the tiles sit 12 px from the edge
  again; elsewhere it sits inside the right edge, slides inward, and the tiles are set in 31 px. One CSS block, `.inbox-later`.
- **The centre menu is compact** (244 px): jump field, a quiet project line, Agents / Help / Admin / Keys two by two, and a
  foot with the connection and two small switches (knock sound, theme).

## Rings back in the sidebar, Desk head (2 Oct)

- Session rows end in a hand-drawn ring again (`agents.js` `badge()`, `ring()`): the number of open questions in it;
  while the session works a short tapered pen stroke goes round it (`.ring-drop`, 1.9 s a turn, one clock for all rings);
  a knock is the raised hand in a red loop (`data-state="waiting"`), with the stroke still going round if the session
  works. Idle with nothing open: no ring. Reduced motion: still ring with a small gap. The stack symbol is gone from rows.
- The Desk entry says "N working" under its name (`.agent-working`, only when > 0; not on the phone strip).
- Desk list: the bracket line in the sender gutter is gone, the drawing and name alone mark a run.
- The Desk's heading is the walk control itself: `h2.inbox-heading > button.inbox-walk.inbox-go` with the words
  "Next, please", the count of every open card in `.inbox-circled`, a small arrow; knocks beside it as mark and
  number (`.inbox-knocks`). No "Desk" word, no sentence (`.inbox-title p`, `.inbox-agents-link`, `.inbox-tools` are
  gone on the Desk; a session's own list keeps its sentence). Nothing open: `h2` "Desk is clear."
- No gutter beside the cards (`.inbox-gutter*`, `.run-bracket` gone). Every Desk card has `data-from` and `--hue`:
  it takes its sender's colour (`--card-color` from the hue; `--urg-color` keeps the knock label and the leading
  tile of a knock in the warning colour) and wears the sender's drawing before the title (`.inbox-sender`, name as
  tooltip). `.inbox-from` in the byline is hidden on such rows. List width 800px.
- The row shows one edge tab, Snooze. Revise, Whatever, Shred are built but `hidden` (`EDGE_TABS` in inbox.js);
  keys still work: `list.trust`, `list.shred`, and new `list.revise` (opens the card with Discuss ready).
- Picture stack on a Desk row: `onGallery` (app.js) asks the Focus window for `gallery()`; until focus.js has
  it, the pictures open in the lightbox as before.
- `mountInbox`: the inner `reveal(cardId)` is now `revealCard` (it shadowed the row scroll); the returned API is
  still `{ render, reveal }`. bar.js provides `go.jump`.
- The old roster is retired: `mountRoster`, `#roster`, `.roster-*` rules (kept: `#nav-roster`, `.roster-open`).
- Since the last section also: Desk (was Inbox), Whatever (was Trust), taller cards with picture stack and age clock,
  four edge tabs (Snooze, Revise, Whatever, Shred).

## Quick send is the memo slip (card Nr. 134; `js/quicksend.js`, `css/quicksend.css`)
- Closed: `.quick-open.memo-open` at the bottom right beside the pad's control shows the receiver's drawing with its crown
  (`data-to` = session id; `data-none` without a crown; `data-draft` = a dot while an unsent memo lies there). In a session
  it stands small at the top right (the shared placement rules stay in app.css with `.topbar .padlink-open`).
- Open: `.memo[data-state=closed|open|sending]` on `body` holds `.memo-slip` (form): `.memo-head` (MEMO, To, From),
  `.memo-body` (the cardclip bar first: chips above the field; `#quick-field.memo-field` on ruled lines), `.memo-files`
  (`.memo-file`), `.memo-foot` (`.memo-clip`, `.dictate-mic`, `.quick-send.memo-send` "Tear off and send"). Enter sends,
  Shift+Enter a new line, "/" opens, Esc or a click beside it closes and keeps the draft. Sent: it tears off (not with
  reduced motion), then `.quick-note` "Sent to <name>." (no Undo: the store cannot take a message back).
- One receiver, shown, never picked: the crowned session (of several crowns, the one crowned last in this browser). No
  crown: `.memo-none` "No session wears the crown." and `.memo-ledger` opens /agents. A phone: a sheet at the bottom.
- Gone: `.quick`, `.quick-to`, `.quick-list`, `.quick-box`, `.quick-files` (and their rules in app.css; the
  `.quick .cardclip-bar` rules in cardclip.css match nothing now).

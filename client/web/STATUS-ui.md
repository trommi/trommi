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

## Tab runs, floating Desk, hub snooze (2 Oct, afternoon)

- Card Nr. 143, Tab: every run of one sender's cards on the Desk has a divider tab above its first card
  (`.inbox-group[data-sender] > .inbox-run-tab`: drawing, crown, name, in the session's colour); cards of a run stand
  4px apart and do not repeat the drawing. The mark on a card (`.inbox-who`, was `.inbox-sender`) shows only outside
  runs (unfolded piles).
- Card Nr. 141, Float: the Desk is no row in the sidebar any more. `#desk-go` in the top pill goes to the Desk and
  shows `#desk-state` (`.agent-count.is-knock` knocks, `.agent-count.is-total` all open, `.agent-working`);
  `#brand-menu` is the caret beside it; the menu has "Switch desk" (`#desk-list`, `#project-current` is the one desk).
  The pill hides while a card is open (`.focus-lock`). The Desk heading no longer repeats the knocks.
- Snooze is on the hub: store.js posts `/snooze`, lists `snoozed_until` cards in `state.later` (and puts them back
  into `state.all.queue` for the views), migrates local snoozes once, and calls the snoozed cards back when the
  last waiting card is answered. A returned card says "Back from snooze" in its note line.
- Audit: "Trusted" reads "Whatever"; the count circle is drawn with the pen (`penCircle()`); one soft tinted card
  shadow; the empty state is the desk drawing and a sentence, no dashed box; phone Desk has room at its foot.
- Card Nr. 142, unfold in place: a click on a Desk row's text puts the whole card into the row (`.inbox-row.is-unfolded
  > .inbox-inline`, filled by focus.js `openInline`; app.js `unfoldCard`). One at a time, wider than the column where
  there is room, address `/q/<n>` while unfolded. A phone (≤ 860px), the keyboard's open, the walk and direct loads
  keep the window.

## Desk back in the sidebar, In revision (2 Oct, later)

- The Desk is a block at the top of the sidebar again (the fixed `.topbar` at the sidebar's head on wide screens:
  `#desk-go` with the desk drawing, name, `#desk-state`; `#brand-menu` is the caret, the menu opens under the block).
  Nothing floats at the top centre. The phone keeps the top bar.
- "In revision": `section.inbox-revising` after Snoozed, before Answered: `.inbox-revising-row` per card that is with
  its session (`.inbox-revising-open` with the turning ring, title, `.inbox-revising-sent`; `.inbox-revising-tail`;
  `.inbox-revising-take` → store `takeBack()` = POST /handback clear). It replaces the "Waiting" pile.
- `list.revise` (B) hands the marked card back at once (`focusMode.revise(id)` through `openFocus(id, …, { revise })`).
- Not connected: a dot on the caret, no sentence. Phone: 44px pile heads and menu entries. Dark: edge on quiet tiles.
- Desk block, one line: drawing, big "Desk", the working ring alone (`.agent-working`, count in title and `data-n`),
  `.agent-count.is-knock` and `.is-total` before the caret. A sticky spacer (`#agents::before`) keeps room under it.
- Menu: `label.jump-box` holds `#jump-field` and `kbd#jump-key`; one desk is one quiet line; `.menu-grid` is a list;
  the two switches are labelled rows (`.menu-word`, state word by CSS); `#conn` last.
- app.js: closing a card that was loaded directly cuts `/q/<n>` or `/walk` from the address and follows it; Forward
  onto a Desk card unfolds it inline on wide screens; `mountScribblePane()` caches its promise (one canvas).
- Empty Desk: "Desk is clear." plus what lies below by name ("1 in revision · 2 snoozed"), nothing otherwise.


## Web UI round from open-from-chat.md (3 Oct)

- Shift held: the row's one tab is Shred instead of Snooze (app.css `body[data-shift]`; inbox.js no longer hides the
  Shred tab with `hidden`, which `asset.css`'s `[hidden] !important` would keep hidden).
- A tap on a row tab acts at once (no "first tap slides out"): Snooze on the phone moves the card. Phone tabs 36px.
- "☞ " before a paragraph: the drawn hand points at it (ui.js `rich()`, `.rich-point`). The channel instructions
  (server.mjs) do not tell agents yet.
- Card Nr. 87 colours: rows are plain surface, grey text, neutral line, one soft shadow; the colour stays on the tiles,
  tabs and knock (`.inbox-row` tokens in app.css).
- Floats: phone Desk has quick send and pad in the top bar; wide Desk keeps a 60px lane on the right and stacks
  the two, so no tile or tab scrolls under them (checked 900/1000/1200/1440).

## Share an asset with someone outside (3 Oct)

- ui.js `assetShare({ id, key })` returns `{ button, panel }`: `.asset-share` ("Share" / "Shared", `data-shared`) folds out
  `.asset-share-panel` with `.asset-share-say` (state, "anyone who has this link can open it"), `.asset-share-go`
  (POST /asset/share), `.asset-share-link` + `.asset-share-copy`, the end (`.asset-share-ends select`: 0, 24, 168 h) and
  `.asset-share-stop`. State from `state.assets[i].share`; `refreshAssetShares()` runs with `refreshAssetLinks()`.
- It stands on the conversation's asset card (chat.js `assetCard`, two lines) and beside the compact link card inside
  a text (`assetLink()` returns `.asset-linked` for a known asset; `{ share: false }` gives the bare card).
- Viewer (asset.js): fetch with the cookie, 429 has its own message, SVG is a download.

## Rail: the folded sidebar (card Nr. 150, 3 Oct)

- bar.js `toggleRail()`: `html[data-rail="folded"]`, kept in `localStorage['trommi-rail']`; key `[` (keys.js, id `rail`)
  and `button.rail-fold` at the sidebar's foot. Wide screens only (≥ 861px); a phone has neither button nor key effect.
- Folded: 76px column, rows show the drawing with `.agent-badge` at the corner, the Desk block its drawing and the
  knocks; `.rail-tip` names the row under the pointer or the keyboard. The Desk menu's caret is hidden while folded
  (Ctrl+K still opens the menu).
- Share: the link uses `urls[0]` from `/asset/share` when the hub sends it; 404 with `code: "no-asset"` and a 404
  without code have their own messages.

## Several desks (card Nr. 149 "menu", 3 Oct)

- store.js: `state.all.desks` (`[{ id, name, created, open, knocks, sessions }]`, null on a hub without desks) and
  `state.all.desk` (the one in view, `localStorage['trommi-desk']`). `deskCut()` gives every view the board of that desk:
  its sessions, cards, work; of the other desks only the open knocks, their session marked `other_desk` and named
  "Name · Desk" (the sidebar leaves those out). `setDesk`, `createDesk`, `renameDesk`, `placeDesk`, `removeDesk`,
  `moveToDesk`. An address that names a session of another desk brings that desk into view.
- bar.js `paintDesks()`: the name in `.desk-name`; `#desk-list` holds `.menu-desk-row > button.menu-desk` per desk
  (name, "N open", key), `.menu-desk-act.is-rename` / `.is-remove` (second click confirms) on the one in view,
  `.menu-desk.new-desk`, the name typed in `.menu-desk-form`. `#brand-menu[data-other-knock]`: another desk knocks.
  `html[data-desks]` while there is more than one.
- Keys: Ctrl/Cmd+1…9 (`desk.switch`, keys.js; the range match takes "Mod+1…9").
- Agents page: `select.ledger-desk` per line on wide screens, "Move to desk …" in the phone's sheet (ledger.js).
- Rail: the caret stays as a low strip under the Desk drawing, so the menu opens there too.
- Share: the link comes from `assets[i].share.urls[0]` when the hub sends it.

## Snooze on the card, no clock on the row (3 Oct, evening)

- `.inbox-tabs` now lives inside `.inbox-when` (beside the title, after `.inbox-nr`): `.inbox-later` is a 28px square
  button with the drawn z z z ("Wake up" in the Snoozed pile), its word a tooltip. Nothing lies outside the row; the
  margin placement (`@container inboxpage (min-width: 1001px)` block) is gone. Shift shows `.inbox-shred` in the same place.
- The age clock left the row (`ageClock` no longer in `.inbox-when`); the age is the corner's tooltip and `.inbox-ago`
  for screen readers. Revise and Whatever stay built and hidden on the row (keys and the phone's long-press sheet use them).

## Floating pill menu, pad button top right, bare paths link (card Nr. 161 "pille", 3 Oct, late)

- Wide screens: `#brand-menu` (still `.brand-open`, same id) is the pill at the top centre: `.pill-name` (desk in view),
  `.pill-count` ("N open"), the caret. `#brand-doors` unfolds under it (fixed, 320px). The Desk box has no caret; the
  rail's caret strip is gone. The pill stands in a 56px band: `#inbox` and `#ledger` begin below it. It is not shown
  inside a session, on the Scribble canvas, or while a card or the walk is open (Ctrl+K opens the menu anywhere).
  `--side` (256px / 76px with the rail) and `--pill-x` place it. `[data-other-knock]` (another desk knocks) is on the pill.
- Phone: unchanged (Desk and the caret in the top bar; the pill's words are hidden).
- `#pad-open` stands at the top right of the Desk and the Agents page (in the band); the memo button is alone at the
  bottom right. In a session the pad stays the small icon in the header.
- ui.js `inline()`: a bare path to a page of the board (`/designs/x10.html?k=a#top`) is a link (`pathLink()`); cases in
  dev/richhtml-test.mjs.

## One Desk control: the pill (3 Oct, night)

- Wide screens: the Desk box left the sidebar. `.topbar` itself is the pill at the top centre, in a band (`--band: 54px`)
  above every view (`#session, #inbox, #ledger { margin-top }`): `#desk-go` (drawing, `.desk-name`, `#desk-state` with
  ring, knocks, "N open"; `aria-current` on the Desk) goes to the Desk, `#brand-menu` (the caret) opens `#brand-doors`
  under it. Same ids as before. Shown on the Desk, in a session, with Scribble and on the Agents page; covered only by
  an opened card or the walk. `#pad-open` stands at the right end of the band in every view.
- The sidebar starts with the sessions (no spacer); the rail's Desk rules are gone. bar.js no longer adds
  `.pill-name` / `.pill-count`. A phone is unchanged.

## Desk box back in the sidebar, the menu's pill is "Trommi" (3 Oct, 17:00)

- Wide screens: `.topbar` is the Desk box at the top of the sidebar again (`#desk-go`: desk drawing, "Desk", ring, knocks,
  count; no caret; small in the rail; the spacer `#agents::before` is back). `#brand-menu` alone is the pill at the top
  centre: `.pill-mark` (the bell, cloned from `#desk-go .brand-mark` by bar.js), `.pill-word` "Trommi", the caret; it
  opens `#brand-doors` under it. `[data-other-knock]` stays on it. Band (`--band`), pad button and menu placement as before.
- app.css overrides logo.css's wide rule that put the bell into the Desk button (the bell is in the pill now).
- Only this label says "Trommi"; nothing else is renamed. A phone is unchanged.
- Trommi menu: a quiet "Dev" group at its foot (bar.js): `#dev-fake` (POST /dev/fake-decisions { n: 5 }) and `#dev-fake-clear` ({ clear: true }); on success the menu closes and the page goes to the Desk, on 404 `.menu-dev-note` says "Needs the hub restart."

## Real links and pages (3 Oct, navigation)

- js/link.js: `link(cls, href)` / `linkTo(a, href)` make `a[data-nav]` with the real address; one listener at the window
  stops a modified or non-main click before the page's handlers (the browser opens its tab) and takes the default from
  a plain one (the element's own click listeners do the step). Space presses them like buttons. `go(href)`,
  `sessionPath`, `cardPath`, `walkPath`. css/links.css resets the link looks with zero specificity (`:where`).
- Links now (same classes as before, tag `a`): `.agent-entry` (/s/<id>, /s/<a>+<b>), `a.agent-badge` (/s/<id>/walk; a
  `button` where it unfolds a group, a `span` where it only shows), `#desk-go` (/), `#menu-agents` and `#roster-open`
  (/agents), `.inbox-text` (/q/<n> on the Desk, /s/<id>/q/<n> in a session), `.inbox-revising-open` (pile rows),
  `.inbox-walk` (/walk), `a.event` (a question of the conversation that still waits), on the Agents page `.ledger-q`,
  `.ledger-more`, `a.ledger-ans.is-choose`, the ring, the "open" and "questions" icons; the memo's `.memo-ledger` and
  `.quick-go`. Already links: `.inbox-gutter`, card chips, asset cards, Help, Admin.
- History (app.js): every entry carries `history.state.k` (pushState/replaceState are wrapped once); scroll positions of
  `#inbox`, `#ledger`, the logs and pane lists are kept per entry in `sessionStorage['trommi-scroll']` and put back on
  Back, Forward and reload. A badge's walk is one entry. Going elsewhere folds an unfolded Desk card (`leaveCard()`).
  A card over the Agents page keeps `?q=<n>` (the server serves no /agents/q/…). An unknown /q/<n> lands on the place.
- Title: "(5 knocks) Desk · Trommi", "(3) <session> · Trommi", "… · Scribble", "Nr. 164 · <title> · Trommi",
  "Next, please · <session>", "Agents".
- Memo slip: stays open on a wide screen while one clicks about and goes elsewhere (Esc, its button or sending close it;
  a phone's veil closes it); words and attachments are kept in `localStorage['trommi-memo-draft']`.

## Top grid on wide screens: 8 / 64 / 80 (3 Oct, spacing pass)

- Three lines, every view: **8px** is the top of everything fixed (Desk box, session heading, the "Trommi" pill, the
  pad button); **64px** is the band's end (`--band`, was 54: the Desk box's bottom, 8 + 56); **80px** is the first line
  of content (first sidebar row, "Next, please", "Agents", a conversation's first line).
- Sidebar (app.css): `.topbar` top 8 (was 30), spacer `#agents::before` 72px (was 104; rail 80, was 112).
- Session (session.css): the conversation begins below the band again (no `margin-top: 0`), so nothing can scroll
  under the pill or the heading; it fades out over the band's last 12px (mask on `.log` / `.pane-list`). The heading
  always stands in the band, left of the pill: drawing 44px, name 1.5rem, quiet line `--t-sm` (caps .68rem), 24px
  from the left; `--head-w` is the room up to the pill (max 30rem). The corner mode from 1416px and the soft blurred
  ground are gone (nothing lies under them).
- Desk and Agents: both headings 16px under the band (were 8 and 32). From 1224px the Desk's column is centred under
  the pill (the 60px lane for the memo button is only kept below that width). The pad button has one place (8 / 16
  from the top right, 38px) in every view.

## Memo: a living yellow sticky note (3 Oct, late)

- js/memos.js is the notes (`{ id, hid, text, to, files, place: 'float'|'stack'|'paper', x, y }`): kept on the hub
  (`state.all.memos`, passed through by store.js `normalize`; `POST /memo`) and mirrored in `localStorage['trommi-memos']`;
  a hub without `memos` in its state keeps nothing, the notes then live in the browser alone (`small.memo-local` says so).
  `memos()`, `onMemos(fn)`, `newMemo`, `saveMemo`, `removeMemo`, `restoreMemo`, `openMemo`, `sendMemo`, `memoPile()`.
- js/quicksend.js is the note on the page: `div.memo[data-id] > form.memo-slip` with `.memo-head` (`b.memo-title`,
  `label.memo-to` holding `select.memo-pick`, `.memo-away` = to the stack, `.memo-bin`), `textarea.memo-field`
  (`#quick-field` on the one written in last), `.memo-files`, `.memo-foot` (`.memo-clip`, mic, `i.memo-tear`,
  `button.quick-send.memo-send` with the paper plane). Several at once; carried by the head; Esc puts one on the stack;
  Enter sends, Shift+Enter is a new line (Ctrl/Cmd+Enter sends too). `.memo.is-paper` lies in padlink.js `paperLayer()` at `paperPoint()` pixels.
  A phone: one sheet at the bottom (`body[data-memo-open]`), not carried; a tap on the veil puts it away.
- Desk: a third stack `section.inbox-group-memos` (`.inbox-memos-toggle`), its lines `article.memo-line[data-memo]` with
  `.memo-line-open` (opens the note floating again). The opener `.quick-open.memo-open` makes a note (or goes to the empty one).
- Looks (css/quicksend.css): flat yellow in both themes, a hairline of shadow, lifted only while carried.
- Phone (later the same day): a floating note never opens by itself on load; it counts as lying on the Memos stack
  (memos.js `onStack`, `sheetMemo`) until tapped. The sheet has no veil (a line and a shadow); a tap beside it or Esc
  puts it on the stack. A paper note is moved on the paper by its head. Floating notes stand inside `body > .focus`
  while a card is open (quicksend.js `floor()`); new notes there are placed clear of options, ways and field (`spot()`).
  Chips are kept with the note in this browser (`note.chips`; cardclip.js `pasteChip({ initial })`, `.cards()`).

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


## Round three (third UI worker): what the user asked for while it ran, in the order it landed
Checked on an own demo board (trio on 8804, restarted once from the current tree, plus a scripted session "Probe" via
`dev/session.mjs` for cards with advice, urgency and underlined text), headless Chromium with real pointer, touch and key
events at 1440x900 and 400x860, light and dark. Screenshots: `/tmp/claude-1000/ui3/` (`before-*`, `z-*` final, `post-*` sheets).

- **Sidebar group.** No "+": names laid on sit slightly askew (`.agent-text strong + strong`; a phone's one-line strip keeps the
  plus). Scissors (`sketch('snip')`, straight blades) show only under the pointer or the keyboard, in the gap before the badge;
  a group row is as tall as its names (52 px for two). The loop round marks and names exists as a test:
  `<html data-grouploop="all">` (flag `#loop-all`, set in index.html), default is the loop round the marks. Decision filed (Nr. 117).
- **Marks and badges without a ground** (user: "Both"). `.agent-avatar` and the inbox's marks are the drawing alone in the
  session's colour; the flag is gone. Badge (`badge()` in agents.js): red `bareHand()` with the count beside it; at work a
  `sweepMark()` that turns round the count (static under reduced motion); disconnected grey. Hand and sweep share one 30 px
  place, the count beside a hand has its own 14 px. The ring with the drop is gone.
- **VIP is a crown** (`crown()`), crooked on the corner of the mark; the gold tab, `VIP_LABEL` and `--gold-hi/--gold-ink` are
  gone, `--gold-pen` is new. The crown is its own click target (`crownToggle()` in agents.js, 28 px, "Make VIP" / "Remove VIP"):
  sidebar row, session title, Agents page (there it keeps the class `roster-star`). In a group's joint mark the crown is part
  of the drawing (`pairDoodle` members with `vip: true`) and not clickable.
- **Reordering by drag.** Middle of another row = lay together (the loop opens), upper/lower quarter or between rows = move
  there (thin line), clear of the list = pull out of the group. A group moves as one. Alt+arrow moves the row that holds the
  keyboard (handled in agents.js until keys.js has an entry; `mountAgents().move(by)`). Order: `POST /session { agent, before }`
  (`moveSession` in store.js); for a hub that sends no `position` the order is kept per browser (`trommi-order`, clearly marked
  FALLBACK in store.js) and dropped as soon as positions arrive. Verified both ways.
- **Inbox list.** One continuous list at one pitch, no sender headings; `section.inbox-group[data-sender]` still holds a
  sender's rows. Who asks stands in the byline of each row (`.inbox-byline`: mark and name `.inbox-from`, `.inbox-nr` "Nr. 12",
  age, and what the card carries `.inbox-carries`, e.g. "6 pictures"). The count beside the heading is the way into the walk
  (`.inbox-walk`); the "Go through them" pill and the "?" beside it are gone (the "?" is `#keys-open` in the bar).
  After an answer the next row lands where the answered one stood (`landOn()` scrolls by what is missing, also at the end of the list).
- **Knocks.** Urgent and blocking questions: label "Knock" / "Knock! Blocking" / "Knock! Permission" with `sketch('knock')`,
  "3 knocks · 9 questions need you", the inbox's badge shows the knocks first, the title reads "(3 knocks) Trommi". A new one
  arrives with two small nudges, its session's mark too (`js/knock.js`); sound off by default, switch "Knock sound" in the logo menu.
  Constants in ui.js: `KNOCK_WORD`, `KNOCK_BLOCKING_WORD`, `KNOCK_PERMISSION_WORD`, `KNOCK_SKETCH`, `isKnock()`, `knockWord()`, `knocksText()`.
- **Snooze.** The word is `LATER_WORD` ("Snooze", `sketch('snooze')`); waking is `WAKE_WORD` ("Wake up", `sketch('wake')`).
  The control is a dog-ear at the row's top right (`.inbox-later`, a 30x46 strip right of the tiles, which are set in by 31 px):
  it unfolds under the pointer or keyboard (flap turns back, a tab with the word turns up from the top edge); a finger's first
  tap unfolds, the second snoozes.
- **Piles at the foot** (`pile()` in inbox.js, exported): Snoozed, With the agent (cards handed back, `state.handed`), Answered.
  Side by side, small (top card, up to three edges, drawing and count); a click or Enter fans one open in place, full width,
  one at a time. Answered rows are built when the pile first opens. Rows in a folded pile are out of the keyboard's reach.
- **Bar.** Logo is a menu (`js/bar.js`: Help, Admin, Knock sound; arrows, Escape, click beside it), places with drawings, the
  two tools as plain quiet controls (the pad's hand-drawn box is overridden in app.css), connection as a dot that speaks only
  when it is not there, keys "?", theme as scribbled moon/sun.
- **Advice** is a highlighter swipe behind the label (`adviceLoop()`, one pass per line, measured from the text, redrawn on
  resize; darker band on filled tiles; a bare thumb gets a short swipe). The pointing hand stays as the unused export `pointingHand()`.
  **Underline**: `__words__` in a text get a drawn underline (`.rich-under`); a text that underlines more than a third of itself is shown plainly.
- **Also**: Markdown tables render (`.rich-table`); an unfolded "Choose" row does not repeat a text the row already shows;
  snoozed rows are the same size as open ones; asset cards inside a text are drawn again when the asset is withdrawn
  (`refreshAssetLinks()`); the admin page is English.
- New drawing names (for the iOS port; no existing name or seed changed): sketch `snip unfold go moon sun frame question
  keycap tray heads grid knock wake` (`snooze`, `pen`, `clip` came from the Focus worker), functions `crown() groupLoop()
  bareHand() sweepMark() pointingHand()`, and `adviceLoop()` now draws the marker.
- Not done: kite and diamond still look alike (changing either would change an existing name's output). The `info` card kind
  (no contract yet). Not verified: the Focus window (it did not load while this was checked: an error in focus.js), touch
  drag on a real phone, Safari, the knock sound by ear.

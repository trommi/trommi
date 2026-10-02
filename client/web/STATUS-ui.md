# UI worker log (index.html, app/store/inbox/agents/chat/history/ui.js, app.css, tokens.css)

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


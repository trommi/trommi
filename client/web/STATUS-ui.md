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

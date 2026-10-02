# Layout worker log

Files of this work: `css/beside.css`, `js/beside.js`, `css/ledger.css`, `js/ledger.js`; four lines in `index.html`
(two stylesheet links, two module scripts). Nothing here was committed by the worker.

## Course of the work
1. Built "Stack + Table" behind a switch (`data-layout="stack"`, `?layout=stack`, a dock of session marks in the
   bottom bar, a Table page). Verified on an own demo board (port 8850) with real pointer and key events.
2. The user tried it and decided: the dock at the bottom goes, the sidebar stays; what stays is the session view
   where the questions lie beside the conversation. No workspace switcher.
3. So: the Stack shell is removed (`js/stack.js`, `css/stack.css`, `js/layout-boot.js` deleted, the switch, the
   menu entry and `?layout=` are gone). Two things were kept and moved into the sidebar layout, see below.

## What is in the app now
### A session's questions beside its conversation (`css/beside.css`, `js/beside.js`)
- From 1200px window width. Below that nothing changed (questions in the conversation, "Questions only" filter).
- One session: left the head (large mark, name, a line with its task, model and machine) and under it the
  session's questions as inbox rows (answerable, with its piles and its answered ones at the foot); right a
  column `clamp(340px, 30vw, 440px)` with the tabs Conversation / Scribble, the Files toggle, the log, the composer.
- It is CSS over what `js/chat.js` already builds: every pane holds `.pane-questions` (the list the "Questions
  only" filter used to show); it is laid next to `.log` with a grid on `.chat-pane`. No change in `chat.js`.
- "Questions only" (`#filter-questions`, key `Q`, `/s/<id>/questions`) has nothing to do there: the button is
  hidden, and the filter is taken back in place when something asks for it (`beside.js`).
- An open question inside the conversation is one small line ("QUESTION title ←"); a click scrolls the column to
  its card and marks it for a moment. It opens nothing.
- Sessions laid together: the columns side by side as before, each with its own questions folded above its
  conversation (at most 44% of the height, scrolls on its own; hidden when it has none). The answered history is
  not shown in that form.
- Scribble takes the whole width under the head. Files replaces the log in the right column.

### Ledger: the Agents page (`css/ledger.css`, `js/ledger.js`)
The user chose "Ledger" (draft `designs/g3.html`) over the Table; `js/table.js`, `css/table.css` and the "List | Table"
switch are removed. `/agents` now shows the Ledger; the list of cards (`mountRoster`, `#roster`) is still built but hidden
by `ledger.css`.
- One line per session: grip, mark (opens the drawings; redraws itself while the session works, `avatar(…, { working })`),
  crown switch, name (renames), "with X" chip with scissors for one of a group, state (red hand + count when it waits
  for you; else working / asks / idle / away, with the count), its first question (a yes/no is answered in the line with
  two small thumbs via `decide`, with the note that takes it back; else "Choose" opens the question as a window; "+n"
  walks through the rest) or its task, model, machine, last seen, and actions: open, its questions, lay together, archive.
- A click on a column head sorts (again: reversed); "Back to your order" returns. In your order a line is dragged by
  its grip: between two lines it moves (`moveSession`, the sidebar follows), onto the middle of a line the two are laid
  together (`pair`). Disconnected sessions are a group of their own; the archive stands below with "Fetch back".
- Narrower windows drop columns (machine below 1500px, model and last seen below 1240px). Phone: mark, name, state
  and count; a tap opens the session.
- Keys (heard in `ledger.js`, not yet in `keys.js`): `/` find, ↑↓ line, Enter open, `Q` its questions, `Y` `N` answer
  the first question, `R` rename, `D` drawing, `C` crown, `+` lay together / take out, `A` archive (disconnected),
  Shift+↑↓ move, Esc let go. (The draft's `P` for pairing is the pad's key in the app, hence `+`.)
- Not exported by `agents.js`, so kept as a few lines of my own: the rule of what a session needs (`summary`) and the
  hand-plus-count (`badge`). With `export` on those two, `ledger.js` could import them.
- Verified on the demo board with real pointer and key events (1440x900 and 400x860, light and dark): sort both ways,
  back to own order, find, answer in the line, arrows, Shift+arrow, C, R, D, Enter, Back, move by grip (sidebar
  follows), lay together by drop and by key, take out, question as a window and back; phone tap opens.

## Verified (own demo board, headless Chromium, real pointer and key events; 1440x900 and 400x860, light and dark)
- Session view: questions left of the log, sidebar in place; answer there; reference in the log scrolls to its card;
  `/s/<id>/questions` is taken back to `/s/<id>`; Files in the right column; pair shows both logs and both lists.
- Agents page: list by default; the switch shows the Table; remembered after a reload; second click opens the
  session; Back returns to the Table; phone: a tap opens.
- Earlier, in the Stack shell, the Table's own flows: find, state filter, answer in the slip, arrows, Enter,
  reorder by drag, Shift+arrow, pair by drag, pull apart, pairing by key, a question as a window from the slip.

## Open
- `dev/ui-test.mjs` checks that assume inline question rows and the "Questions only" filter at desktop width need
  updating by QA (see the report).
- Real URLs (`/q/102`, `/walk`, `#/…`): not built. The edit of `js/app.js` and `server/server.mjs` was refused to
  this worker by the permission system; the ready block is in the report.
- Seen in headless Chromium: a rich-HTML frame (`.rh-frame`) scrolled above the top of the log still takes the
  pointer over the session's title (the tabs cannot be clicked then). Not from this work; for whoever owns `richhtml.js`.
- Static hosting later: paths need a fallback to `index.html` (Caddy: `try_files {path} /index.html`; nginx:
  `try_files $uri /index.html;`), or the hash form `#/s/<id>/q/102` once `app.js` reads it.

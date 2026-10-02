# Layout worker log

Files of this work: `css/beside.css`, `js/beside.js`, `css/table.css`, `js/table.js`; four lines in `index.html`
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

### Table: a second form of the Agents page (`css/table.css`, `js/table.js`)
- `/agents` shows today's list of cards by default. A small switch "List | Table" in the page's head flips to the
  Table and is remembered in this browser (`localStorage trommi-agents-view`, `<html data-agents="table">`).
- Table: marks on a table top, sized by open questions, in zones Needs you / Working / Idle / Away (or tidied by
  machine or name); find; state chips; a slip beside the table for the picked session (its questions as real rows
  via `mountInbox`, rename, drawing, VIP crown, model, machine, folder, program, tasks, open, lay together, take
  out, archive); archive shelf with "Fetch back".
- Push a mark onto another's picture: laid together. Pull one out of its loop: it leaves. Push it between two
  marks of its zone: moved (the server's order, so the sidebar follows). The marks settle into the order; there are
  no free positions.
- Phone: a plain list of marks with name, state and count; a tap opens the session. No slip, no drag.
- Keys (heard in `table.js`, not yet in `keys.js`): `/` find, arrows to the next mark, Enter open, `+` lay
  together (then pick the partner) or take out, Shift+arrow move, Esc let go.

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

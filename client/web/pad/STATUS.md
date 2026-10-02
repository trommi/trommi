# Pad status log

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

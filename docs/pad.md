# The global pad

2 October 2026. The pad is built: the page in `client/web/pad/`, its routes in `server/pad.mjs`, its elements in SQLite (`data/pad.db`, through `server/store/store.mjs`), and a control in the board's bar that opens it from anywhere (`client/web/js/padlink.js`). This document answers three things: whether to adopt a whiteboard library, what an element is, and what the server has to offer so that single elements can be sent to an agent.

**In short.** Keep building our own canvas. tldraw may not run in production without a licence key (sold through sales, or granted at discretion for hobby use with a watermark) and reports unlicensed use to its maker; Excalidraw is MIT but is a React application of 1.1 MB plus React with about 28 imports to map, which a client without a build step and without third-party code cannot take in honestly. Neither stores what we need (who sent which element to which session). The pad stores one record per element, the same shape in the browser's IndexedDB (the cache a device works on) and in the server's `pad_elements` table (what counts).

There is one global pad (id `global`), and every session keeps its own canvas (`js/scribble.js`), as decided.

## 1. Build or adopt

### What the client may take in

From `docs/krypto-konzept.md`, section 9: whoever delivers the JavaScript can use the keys. The web client is therefore static, has no build step, and is meant to be served byte for byte from a signed Git tag, with no code from other hosts at runtime. A library is acceptable only if it can be vendored as files that someone can read, and if it makes no network requests of its own.

### The candidates

Figures were measured on 2 October 2026: versions and licences from the npm registry, "min" and "gzip" from bundlephobia (React excluded), file sizes with `wc -c` on the unpacked npm tarball, behaviour by reading the shipped files.

| | Version | Licence | Size (min / gzip) | Usable without a build step | Needs | Stores | Network on its own |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **tldraw** SDK | 5.5.1 | proprietary "tldraw license"; production needs a key | 1,778 KB / 530 KB, 17 dependencies | No. 333 unbundled modules with bare imports, references `process.env` | React 18 or 19, radix-ui, TipTap | one record per shape, ids like `shape:…`, own sync server | yes: fonts, icons and translations from `cdn.tldraw.com` by default; a tracking request when unlicensed or watermarked |
| **Excalidraw** | 0.18.1 | MIT | 1,125 KB / 353 KB, 31 dependencies; fonts 13 MB | No. ESM with about 28 bare imports and code-split chunks; no UMD build in 0.18 | React 17 to 19, jotai, roughjs, radix | flat `elements` array, each with `id`, `version`, `versionNonce`, `isDeleted` | yes: fonts from a CDN by default (can be self-hosted) |
| **Konva** | 10.7.0 | MIT | 193 KB / 57 KB, none | Yes, one UMD file (`konva.min.js`); no single-file ESM | nothing | scene graph JSON, ids optional and set by hand | no |
| **Fabric.js** | 7.4.0 | MIT | 299 KB / 92 KB, none | Yes, one ESM file (`dist/index.min.mjs`) | nothing | `{version, objects}`, no built-in ids | no |
| **PixiJS** | 8.22.0 | MIT | 841 KB / 237 KB | Yes, one ESM file | nothing | nothing: a renderer | no |
| **Paper.js** | 0.12.18 (July 2024, no release since) | MIT | 208 KB / 70 KB | one global script, no ESM | nothing | nested arrays, runtime ids | no |
| **perfect-freehand** | 1.2.3 | MIT, © 2021 Stephen Ruiz Ltd | 4.5 KB / 2.0 KB, none | Yes, `dist/esm/index.mjs` | nothing | nothing: points in, outline out | no |
| **Our canvas** | `js/scribble.js`, 1,260 lines; the pad prototype is about 1,700 lines of JavaScript | ours | 56 KB unminified | it is the client | nothing | our own record per element | no |

React is not small either: `react-dom`'s client runtime is 625 KB as shipped (110 KB gzip), and React 19 publishes no single-file ESM or UMD build (this last point from memory, not re-checked).

### tldraw

The best infinite canvas there is, and its data model is the one we want: one record per shape with a typed id, in a reactive store. It is ruled out by its terms and by how it is packaged.

- **Licence.** `LICENSE.md` grants use "in Development Environments" and requires "Not to use the Software in Production Environments" and "Not to disable, change, or interfere with the Software's License Key enforcement". The licence page: "The SDK will work in production only when provided with a valid and active license key." A production environment is "any production deployment … where the software is used to provide functionality to end users". Production keys have been required since 4.0 (September 2025).
- **What a key costs.** No price is published; commercial licences are "value-based pricing" through sales. There is a 100-day trial and a hobby licence for non-commercial projects, granted at tldraw's discretion, which requires the "made with tldraw" watermark. A figure of about 6,000 dollars a year circulates in third-party reports and is unverified.
- **What the check does** (read in `@tldraw/editor` 5.5.1). The key is verified offline against an embedded public key and names the allowed hosts and an expiry. "Development" means `http:`, or https on localhost. In production without a valid key the editor is replaced by an empty element after five seconds. When unlicensed, in evaluation, or licensed with watermark, it requests `https://cdn.tldraw.com/<version>/watermarks/watermark-track.svg?…&url=<the page's address>`, which tells tldraw where it runs.
- **Packaging.** No single file. It needs React, an import map for the whole tree or a bundler, and by default fetches fonts, icons and translations from tldraw's CDN.

A Trommi board on a tailnet under https counts as production. We would need a key tied to our host names, per installation, for an open tool that people run themselves.

### Excalidraw

MIT, no key, no watermark, and its element array is close to our model: stable ids, a version per element, tombstones (`isDeleted`), and whole-element last-writer-wins when two edits meet (`reconcile.ts`: the higher `version` wins, the lower `versionNonce` breaks a tie). That rule is worth copying; the package is not.

- It is a React application, not a library of parts: toolbar, menus, dialogs and its hand-drawn look come with it. Our tokens, our toolbar and "click, then speak" would be built against it, not with it.
- Without a build step it needs an import map for about 28 packages plus React, or a bundle we build ourselves. A bundle of 1.1 MB of other people's minified code is exactly what the crypto concept says not to ship: nobody will read it, and it must be re-audited with every update.
- Its bundle contains addresses of excalidraw.com services (libraries, share links, collaboration, AI). They look feature-triggered; whether any fires without user action was not traced.
- It has no notion of "this element was sent to that session", so that part is ours either way.

### Konva and Fabric.js

Both are honest, dependency-free, MIT, and could be vendored as one file. They would give us transform handles (Fabric also editable text) and take nothing else off our hands: neither has pan and zoom as a concept, ids, records, sync, or pen pressure (the word does not occur in either). We would trade 190 to 300 KB of foreign code for parts the prototype already has (selection frame, handles, hit testing), and then fight their object model to keep one record per element. PixiJS is a renderer and solves a problem we do not have; a pad of a few thousand elements paints fine on Canvas 2D.

### perfect-freehand

The one candidate small enough to audit: 4.5 KB, no imports, no DOM, no network, pure geometry (points with pressure in, outline polygon out). Excalidraw depends on it, tldraw ships a derived copy. It would make mouse strokes look inked by simulating pressure from speed. Our strokes already vary with real stylus pressure (`buildGeom`), and mouse strokes are an even line, which reads well for notes.

**Not now.** If stroke quality becomes a wish, this is the piece to vendor, and nothing else:

- file: `dist/esm/index.mjs` from `perfect-freehand@1.2.3` (4,532 bytes), as `client/web/js/vendor/perfect-freehand-1.2.3.mjs`, with its `LICENSE` (MIT, "Copyright (c) 2021 Stephen Ruiz Ltd") beside it and its SHA-256 in the commit message;
- the npm package ships only minified code. The readable source is 1,051 lines of TypeScript in the repository (`steveruizok/perfect-freehand`); the minified file should be checked against it once, by building the tag and comparing. That check has not been done.

### Recommendation

Extend our own canvas. What decided it:

1. tldraw's licence forbids production use without a key, and the SDK reports unlicensed use to tldraw. Both are incompatible with a self-hosted, zero-trust tool.
2. Excalidraw and tldraw need React and a bundler. That would end "no build step" for the whole client, and with it the property that the served files are the files in the Git tag.
3. The hard part of this feature is not drawing. It is the element model, per-element sync, and sending elements to agents; no library has that.
4. The prototype shows the size of the alternative: about 1,700 lines of JavaScript, no dependency, working in a day.

What we give up: shapes with connectors, rich text, rotation handles, and the polish of years. If the pad ever needs to be a diagram tool, revisit Excalidraw as a separate page with its own origin, not as part of the client that holds the keys.

## 2. The element

Every element is one record with its own id. Nothing is nested, nothing is stored as "the document".

```json
{
  "id": "0muqnb5cchmsr9cse",
  "pad": "global",
  "type": "stroke",
  "x": -83, "y": -269.87, "w": 296, "h": 76.6,
  "rotation": 0,
  "z": 2,
  "group": null,
  "author": "human",
  "created": 1790926352076,
  "updated": 1790926362934,
  "rev": 5,
  "blob": null,
  "data": { "tool": "pen", "color": "ink", "size": 4, "box": [296, 76.6], "pts": [3, 39.87, 9.8, 35.34] },
  "sent": [{ "session": "web", "at": 1790926400000, "message_id": 412, "rev": 5 }]
}
```

| Field | Meaning |
| --- | --- |
| `id` | 17 characters: milliseconds in base 36, then randomness. Ids sort by creation time. Made by the client, so an element exists before the server has heard of it. |
| `pad` | `global` today. The same model would carry `session:<id>` if session canvases move to it. |
| `type` | `stroke`, `image`, `text`, `voice`. An element never changes its type. `frame` (a named region) is left for later. |
| `x, y, w, h` | The box in world units: CSS pixels at 100 % zoom, y down. Enough to ask "what is in view" without reading `data`. |
| `rotation` | Degrees. Always 0 in the prototype (stored and kept, not yet editable or painted). |
| `z` | Integer stacking order; ties break by `id`. "To front" writes only the moved elements (highest other `z` plus one), never the whole pad. |
| `group` | A group id or null. Selecting one member selects all. A group is not an element: nothing else to sync or to orphan. |
| `author` | Who made it: `human` today, a device id once devices have keys, a session id for elements an agent placed. |
| `created`, `updated` | Milliseconds. `updated` is set by the hub's clock when it takes a write, and comes back in the answer; until then the record carries the device's time. |
| `rev` | Counts up with every write of this element, undo and delete included. The basis for conflict handling. |
| `blob` | Id of the element's bytes in the blob store (the picture, the audio of a voice note), or null. Outside `data`, so a server can keep and delete the file without reading `data`. |
| `data` | What the element is, by type (below). The only part that needs encrypting. |
| `sent` | Where it went: session, time, the message it travelled in, and the revision that was sent. Lets the pad mark sent elements and notice "changed since". Written by the server only; whatever a client sends in this field is ignored. |
| `seq` | The hub's running number of the last news about this element (a change, a delete, a send). What a device remembers to catch up. |

`data` by type:

| Type | `data` |
| --- | --- |
| `stroke` | `tool` (`pen`, `hl`), `color`, `size`, `box` `[w0, h0]`, `pts` `[x0, y0, …]`, optional `pr` (pressure per point). Points are relative to the box as drawn; moving changes only `x, y`, scaling only `w, h`. |
| `text` | `text`, `size`, `color`, `wrap` (width at which lines break; null is the default). |
| `voice` | A text that was spoken: as `text`, plus `ms` (length of the recording) and `stub` (true if it is sample text). Only the words are kept; the recording is discarded once it is transcribed (decided 2 October). |
| `image` | `mime`, `nw`, `nh`, `name`. The bytes are `blob`. |

The colour `ink` follows the theme (dark on light paper, light on dark); every other colour is stored as hex. What an agent receives is always painted on white.

**Deleting** writes a tombstone: `{ id, pad, deleted: true, author, updated, rev }`. It keeps the id and the revision so that a deletion can win against an older edit from another device, and it drops `data`.

**Selection** is a set of ids on one device and is never stored. **Undo** does not roll anything back: it writes the earlier state again as a new revision, so for the store and for other devices an undo is one more change.

## 3. Sending a selection to a session

The human selects elements and picks a session. The client builds the message; the server stores it, links it and notifies the agent.

```json
POST /pad/send
{
  "pad": "global",
  "session": "web",
  "elements": [{ "id": "0muq…", "type": "text", "rev": 3, "text": "Ship the pad prototype" }, { "id": "0muq…", "type": "stroke", "rev": 5 }],
  "text": "Ship the pad prototype\n\none element = one record",
  "bbox": { "x": -420, "y": -269.87, "w": 860, "h": 439.87 },
  "png": "data:image/png;base64,…"
}
→ { "ok": true, "message_id": "5e1f09ab", "seq": 57, "elements": [the records, with "sent" filled in] }
```

- `png`: the bounding box of the selection plus a margin, only the selected elements, on white, without grid or selection frame, at most 2,000 px on the long side. Rendered by the client, because only the client can paint (and, later, decrypt).
- `text`: the words of the `text` and `voice` elements in reading order (top to bottom, then left to right), separated by blank lines. So the agent does not have to read handwriting off a picture when the words exist.
- `elements`: ids, types and revisions, so the agent can refer to an element, ask for it again, or answer next to it.

The agent receives, in the form the channel already uses for scribbles:

```
<channel source="board" kind="pad" pad="global" message_id="5e1f09ab" elements="0muq…,0muq…" image_path="/abs/data/files/pad-9f2c41d07a3e.png">Ship the pad prototype

one element = one record</channel>
```

`message_id` is the id of the message that shows the selection in the session's conversation (words and picture). The picture is stored with the attachments (`data/files/pad-<id>.png`), so it is served, cleaned up and forgotten like any other attachment. The server sends what it has: an element that has not reached it yet cannot be sent (409), so the page waits until its changes are saved before it posts. An element is marked as sent only by the server's answer; with no board behind the page the dialog reports "Not sent" with the reason. With no words in the selection the agent is told to look at `image_path`.

**What the agent can do in return** (tools for the channel, not built):

- `pad_get(ids)` and `pad_list({ pad, box })`: read elements as records, to look again or to read what is near a selection.
- `pad_put({ pad, type: "text" | "image", text | path, near | x, y, reply_to })`: place an element. `author` is the session. With `reply_to: message_id` and no position, the server places it to the right of that selection's `bbox`; `near: id` places it under that element. An agent adds elements and may change its own; it does not move or delete the human's.
- Agent-made elements arrive like any other change (section 4). The pad should show whose they are (the session's mark at the corner). Not in the prototype.

## 4. Sync

One element is one record; a change sends that record and nothing else.

- **Conflict rule: last writer wins, per element.** Each write carries `rev`. The server accepts a write only if its `rev` is higher than the stored one; a stale write is refused and answered with the current record, which the client then shows. The arbiter is the order in which writes reach the hub, not a device clock. Two devices editing different elements never conflict; two devices dragging the same element see the later arrival win. No merging inside an element: a stroke or a note is small enough to be one unit (the same choice Excalidraw makes).
- **Catching up.** Every write gets the hub's running number (`seq`). A client remembers the highest it has seen and asks for everything after it, tombstones included.
- **Offline.** The local store is the same record shape; changes made offline are sent when the hub is back. A refused write is dropped in favour of the server's record. A queue of unsent ids is all the client needs to add.

The API, all under the board's login:

| Call | Does |
| --- | --- |
| `GET /pad/elements?pad=global` | all live elements, bottom first, and the current `seq` |
| `GET /pad/elements?pad=global&since=<seq>` | what changed after that number, tombstones included |
| `POST /pad/elements` `{ pad, elements: [record], client_id }` | create or change; per element `{ id, rev, seq }` or `{ id, error: "conflict", current }` |
| `DELETE /pad/elements/<id>` | tombstone |
| `PUT /pad/blobs/<id>` (raw bytes, `Content-Type`) and `GET /pad/blobs/<id>` | picture and audio bytes |
| `POST /pad/send` | section 3 |
| `GET /pad/events?pad=global&since=<seq>` (SSE) | changed records as they happen, for other devices and for agent-made elements |

The pad should not ride on `/events`, which sends the whole board state on every change.

`POST /pad/elements` answers `{ ok, seq, epoch, results }`. `epoch` names the store: a page that meets another one than last time (its first visit, a board that started over) fetches everything and sends up what only it has. An element that names a `blob` the server does not have is answered with `error: "blob"`; the page uploads the bytes again and retries. With `client_id` in a write, the change carries it on the stream, so a page can tell its own echo.

In the client: `db.js` is the device's cache (`list`, `put`, `putBlob`, `getBlob`, `meta`), `sync.js` is the link to the server (`push`, `take`, `putBlob`, `getBlob`, `settled`, `pause`, `resume`). A change is written to the cache at once and sent a moment later; what could not be sent waits in a list of ids that survives a reload. While the pad is out of sight inside the board its stream is closed, and it catches up when it is shown.

### Storage: `server/store/store.mjs`

The pad uses the SQLite store, in a database of its own (`data/pad.db`; bytes in `data/pad/blobs/`), through `server/pad.mjs`. The board's state stays in `state.json` until it moves over. `node:sqlite` needs Node 22.13 or newer: the store is loaded when the pad is first used, so a hub on an older Node starts and serves everything else, logs one line, and answers the pad's routes with 501 and the reason.

The three places where store and page differed, and how they were settled (in the store, with tests):

| Topic | Now |
| --- | --- |
| Undo of a delete | `putElement` with a newer `rev` and its data brings a deleted element back. `deleteElement` no longer gives up the element's file; the file goes when the purge takes the tombstone (after the retention, 30 days), unless another element shows it. `deleteElement` takes the `rev` the delete counts as. |
| `sent` | Stays in `pad_links`. `sendElements` also moves the elements' `seq` (not their `rev`), so devices that catch up learn where an element went. `pad.mjs` folds the links into `sent` on every record it hands out; `message_id` is kept in the `pad.sent` event. |
| `updated` | The hub's time, returned in the answer to a write; the page takes it over. |

Not settled: a `frame` type needs a migration (CHECK constraint); a device that was away longer than the retention does not learn of deletions that were purged in the meantime.

## 5. Onto the encrypted event log

The model was chosen so that step 4 of the crypto concept (hash chain and encryption) changes the envelope, not the pad.

- **One change, one event.** A put is an event `pad.put` whose header names pad, element id and `rev` in the clear and signed; the body is the record, encrypted with the sender's key for the epoch. A delete is `pad.deleted`. The table `pad_elements` is then a view: the latest valid event per element id. A client can rebuild it from the log and need not trust it.
- **Who wins.** Among validly signed events for one id, the highest `rev`; the hub's `seq` only orders arrival. The server cannot forge a change (signature), reorder one sender's changes (sequence and predecessor hash), or bring back an old revision unnoticed (a client never accepts a lower `rev` than it has seen). It can withhold the newest change, which the "seen" markers in other envelopes expose.
- **What the server sees.** The store keeps (and `docs/storage.md` lists as its open decision 4) `x, y, w, h, z, group, type` as columns so it can answer "what is in this rectangle", and `data` as an opaque payload. Under encryption that makes positions, sizes and types of elements visible metadata, while the crypto concept lists "Canvas" as hidden. Either they join the list of deliberate plaintext, or geometry moves into the encrypted body and the server serves a pad only as a whole. For a pad of a few thousand elements the second is affordable. Open.
- **Blobs.** As for attachments: a random key per file, encryption in 64 KiB pieces, key and hash inside the encrypted record, only the blob id in the header.
- **Sending.** `pad.sent` is an envelope addressed to one agent, signed by a human device, in the same class as chat and scribble ("never refused, but marked if late"). It carries the ids and revisions, the text, and the PNG as an encrypted blob; the agent's channel process decrypts and writes the PNG to a file for Claude Code. An element an agent puts on the pad is signed by that agent; clients accept `author` only if it matches the signer.
- **Deleting for real.** After the purge period the ciphertext of old revisions goes; header and hash stay, as for messages.
- **Speech.** Recorded audio is plaintext, so under the concept the browser sends it straight to the speech service, not through the hub. The pad calls one function (`transcribe` in `board.js`), which is where that changes.

## 6. What is built

`client/web/pad/`: `index.html`, `pad.css`, `pad.js` (input, view, selection, chrome), `elements.js` (record, geometry, painting, hit testing, the PNG), `db.js` (IndexedDB, one record per element), `sync.js` (the server), `board.js` (sessions, speech, sending), `name.js` (the one visible word for the pad, while its name is under decision). Hand-written ES modules, no dependency, no font or script from another host.

**From anywhere.** `client/web/js/padlink.js` puts one control in the board's bar (and exports `openPad`, `closePad`, `togglePad`, `isPadOpen`; the key P calls `togglePad`). It lays the pad over whatever is shown: the inbox, a session, a pair, the agents page, the Focus window. The pad is the page `/pad/?embed=1` in a frame of the same origin that is mounted once and then only shown and hidden, so opening it again is instant. A frame, because the pad is a page of its own (its keys, ids, dialogs and paste handling must not meet the board's). The address is `/pad`: a reload stays there; Esc, the control, the pad's close button and the browser's Back go back to exactly where the human was (the history entry the pad was opened from). Opened from a session, "Send to" names that session; from a pair, the menu lists its two sessions first. The theme is shared both ways. `/pad/` on its own still works as a page.

How input is read:

| Input | Result |
| --- | --- |
| Click or tap on empty paper | a cursor there; typing makes a text element. `Esc` or a click elsewhere finishes it. An empty cursor leaves nothing behind. |
| Drag | pen and highlighter draw; with the select tool, or with Shift held, a frame selects |
| Hold still for half a second | records; letting go transcribes, and the words land there as a `voice` element. Also: the microphone button, the "Speak" chip under the cursor, `M`. |
| Click on an element | selects it; Shift adds or removes. What is selected moves when dragged, with any tool, and scales from its corners. |
| Drop, paste, `I` | pictures; pasted words become a note |
| Wheel, Ctrl-wheel or trackpad pinch, two fingers, Space-drag | pan and zoom; the dot grid moves with the paper |

Speech uses `transcribe()` from `/js/store.js` when the board has a speech key. Otherwise the same flow runs with nothing recorded and a sample sentence that says so (`data.stub: true`), and the status line reads "speech is a stub".

`client/web/pad/dev-check.mjs` drives the page in headless Chromium with real pointer, touch, wheel and key events, on a desktop and a phone screen, in light and dark: 45 checks against a plain file server, 74 against a demo board, where it goes on to the board itself (the pad opened from the inbox, a session, a pair, the agents page and the Focus window, closed with Esc, Back and its button, a reload, a selection sent to a demo agent that answers with the path of the PNG it got, a second browser as another device). On a board with a speech key it starts a real recording with a fake microphone and discards it; the transcription of real speech was not exercised.

Not built: rotation, frames, text styles beyond size and colour, elements placed by agents and the tools for it (`pad_get`, `pad_list`, `pad_put`). The two rough edges of the first round are gone: a click on a note under a highlighter stroke picks the note (the stroke is picked where nothing lies under it), and a note spoken at the foot of the screen is moved clear of the toolbar.

## 7. Open questions

1. ~~Keep the audio of a voice note, or only its words?~~ Decided: only the words.
2. Should the PNG show only the selected elements (today), or everything inside the selection's rectangle, for context?
3. Positions and sizes of elements in the clear on the server, or inside the encrypted record (section 5)?
4. Should session canvases move to the same element model (`pad: "session:<id>"`), so that there is one canvas implementation? The conversion from the `{ v: 1, images, strokes }` document is mechanical.
5. May an agent change or remove elements it did not make?

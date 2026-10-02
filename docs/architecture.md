# Architecture, as built

Where the data flows from the web app to the backend and back. Read from the code on 2 October 2026 (`server/server.mjs`, `server/pad.mjs`, `server/asset-envelope.mjs`, `client/web/`, `dev/session.mjs`). The iOS and Linux clients are left out. The same content as pictures: `client/web/designs/architecture.html` (on a running board: `/designs/architecture.html`).

What is planned and not built is in the last section and is marked as such.

## 1. The whole

| Process | What it is | Talks to |
| --- | --- | --- |
| Browser | The web app: static files from `client/web/`, served by the hub. `js/store.js` is the one place that talks to the hub for state. | The hub, over HTTP |
| `tailscale serve` | HTTPS on port 443, tailnet only, in front of the hub | The hub, as plain HTTP from `127.0.0.1` |
| Hub | One Node process, `server/server.mjs`, port 8790 (`BOARD_PORT`). Holds the whole state in memory, writes it to `data/`, serves the pages. | `data/`, Tinfoil, every channel process |
| Channel process | The same `server/server.mjs`, started by Claude Code over stdio, once per session (`.mcp.json`). | Claude Code (MCP over stdio), the hub (HTTP on loopback) |
| Claude Code | The agent | Its channel process |
| Helper session | `dev/session.mjs`: a script or subagent on the board without Claude Code | The hub, by the same two routes as a channel process |
| Tinfoil | `https://inference.tinfoil.sh/v1`: speech to text, text to speech | The hub only |

**Who becomes the hub.** Every `server.mjs` tries to listen on the port. The one that gets it is the hub (`becomeHub`); every other one links to it as a spoke (`joinHub`) and takes over when the link drops. With `BOARD_HUB_ONLY=1` a process is only the hub, registers no session of its own and needs no stdin; spokes then wait for it instead of taking the port.

**Who gets in.**

| Door | Check | Routes |
| --- | --- | --- |
| Agents | Remote address is loopback, the request did not come through a proxy (`x-forwarded-for`, `tailscale-user-login`), header `x-board-token` equals the token | `/agent/link`, `/agent/tool`, `/agent/asset`, `/agent/profile`, `/agent/permission` |
| Browser | `GET /?t=<token>` once sets the cookie `board_<port>` (HttpOnly, SameSite=Lax, one year). Every other request needs the cookie; every request that is not a GET must come from the page's own origin. | Everything else |
| Admin | The cookie, plus the admin key (`data/admin-token`) exchanged for a session cookie | `/admin/api/*` |
| No login | Nothing | `/a/<id>`, `/a/<id>/blob`, `/a/-/…` (the asset viewer and ciphertext), `/healthz` |

**The state.** One object: `agents`, `messages`, `cards`, `tasks` (status lines), `assets`, `queue` (ids of open cards in the order the human sees them), `pending` (events waiting for sessions that are away), `next_number`, `hub`. `commit()` recomputes the queue, writes `data/state.json` (temp file, then rename) and writes one frame to every open `GET /events` stream: the whole state as JSON, without `pending`. A page that is behind gets the latest state once it has caught up.

Weak spots:

- The whole state goes to every page on every change (312 KB on this machine today), also for a draft that changed by one tick.
- One token is both the browser login and the agents' credential.
- On this machine the hub is started by hand during development (`sleep 86400 | BOARD_AGENT=Hub node server/server.mjs`), the systemd unit from `deploy/` is installed but inactive, and the hub binds `0.0.0.0`, not loopback as `docs/operations.md` draws it.

## 2. One question, there and back

1. The agent calls the MCP tool `create_decision` (title; `options`, or `sections`, or `text`; `attachments` as absolute paths; `urgency`, `multiple`, `recommended`).
2. The channel process forwards it: `POST /agent/tool` with `{id, instance, name, args}`. If it is the hub itself, it calls `runTool` directly.
3. `runTool` on the hub copies each attachment from its path to `data/files/<id>.<ext>`, adds the card (`status: open`, `version: 1`, the next `number`) and an `asked` marker to `messages`, and commits.
4. Every page gets the new state on `GET /events` and redraws.
5. While the human ticks and types: `POST /draft` `{card_id, keys, note, notes}`. The draft is kept on the open card (`card.draft`), written to the file within a second, pushed to all pages at once. The agent never sees it.
6. The answer: `POST /decide` `{card_id, key | keys, note, notes, revised, attachments}`. `revised` is the card's revision stamp as the page last saw it; an answer to an older wording, or within 1.5 s of a rewording, is refused with 409. Instead of answering, the human can ask back or hand the card back: `POST /message` with `card_id` and `handback: true` or `explain: true`; the card then carries `with_agent` until the agent replies or revises.
7. `decide()` stores `choice`, `choices`, `note`, `option_notes`, `note_attachments`, `answered_version`, sets `status: decided` and commits. Status lines that waited on the card turn to `working`.
8. `deliver()` writes `{method: "notifications/claude/channel", params: {content, meta}}` onto the session's open `GET /agent/link` stream (SSE). `meta`: `kind: decision`, `card_id`, `choice`, `choices` (multiple only), `option_notes`, `files`, `image_path`. If the session is away, the event is appended to `state.pending[<session>]` (at most 100, dropped after 30 days) and flushed when it links again.
9. The channel process hands it to Claude Code as an MCP notification: `<channel source="board" kind="decision" card_id="…" choice="…">note</channel>`.
10. The agent acts: `close_card` (`status: done`, `summary`), or after a hand-back `revise_card`, or `reply` with `card_id` to answer a question back.
11. `revise_card` rewrites the card in place. If the wording changed, the old one is pushed to `card.versions` (at most 20; files only an evicted version showed are deleted), `version` counts up, a `revised` marker is added, and `with_agent` is cleared: the card is presented again.
12. `POST /reopen` `{card_id}` takes an answer back: the card is open again, the old answer becomes its draft, the agent gets `kind: decision_reopened` with `previous_choice`.

Other card tools on the same road: `merge_cards`, `set_urgency`, `withdraw_card`, `list_cards`. Status lines: `set_status`, `clear_status`. Profile: `introduce`.

Tool approvals: Claude Code sends `notifications/claude/channel/permission_request`; the channel process posts it to `/agent/permission`; it becomes a card of kind `permission` with Allow and Deny, always first in the queue; the answer goes back as `notifications/claude/channel/permission` `{request_id, behavior}`.

Weak spots:

- An event counts as delivered once it is written to the link; nothing acknowledges it.
- Helper sessions do not read what is sent to them: `dev/session.mjs link` appends every frame to `data/sessions/<id>.log`, and `answers` prints it when asked.

## 3. Chat, files, drawings

Browser to agent:

- `POST /message` `{text, agent, card_id?, handback?, explain?, attachments: [{name, data}]}`. `data` is a base64 data URL; at most 12 files and 96 MB per request. The hub writes each file to `data/files/<id>.<ext>`, adds the message (`from: user`) and delivers `notifications/claude/channel` with `meta` `kind: chat`, `card_id`, `handback`, `explain`, `files` (absolute paths, comma-separated), `image_path` (the first picture). The agent receives text and paths, not bytes.
- `POST /canvas` `{agent, doc}` saves a session's lasting canvas while the human draws (`data/scribbles/canvas-<session>.json`); `GET /canvas?agent=` reads it.
- `POST /scribble` `{agent, doc, png, view, text}` stores `data/scribbles/<id>.png` (what the human was looking at), `<id>.json`, and `canvas-<session>.png`, adds a message, and delivers `kind: scribble` with `scribble_id`, `image_path`, `canvas_path`, `canvas_doc`.

Agent to browser:

- `reply` `{text, details, attachments, card_id}` through `/agent/tool`. The hub copies each attachment from the agent's path (up to 1 GB, `BOARD_MAX_ATTACHMENT_MB`) into `data/files/` and adds the message (`from: agent`).
- The page gets the state on `/events` and fetches the files with `GET /files/<id>` (cookie; Range requests; served with a sandbox policy) and `GET /scribbles/<id>.png`.

Weak spots:

- Files travel as paths in both directions, so the agent and the hub must see the same disk. That ties every session to the hub's machine (see `docs/operations.md`, "Sessions on other machines").
- Chat messages, their files and drawings are never deleted.

## 4. Speech

The key is `TINFOIL_API_KEY` or `data/tinfoil.key` and stays on the hub. The state carries `speech: true | false`; without a key the page offers no microphone.

Dictation (live):

1. `POST /speech/live`: the response is an event stream, first `ready {id, rate: 16000, max_seconds}`.
2. The hub opens `wss://inference.tinfoil.sh/v1/realtime?intent=transcription` (model `voxtral-mini-4b-realtime`, bearer key).
3. The page posts PCM16 mono 16 kHz every 200 ms to `POST /speech/live/<id>`; the hub forwards it as `input_audio_buffer.append` and keeps the recording in memory.
4. Tinfoil's `…input_audio_transcription.delta` goes to the page as `event: delta {text}`.
5. `POST /speech/live/<id>/stop`. The polish pass: the whole recording goes as a WAV file to `POST /audio/transcriptions` (`whisper-large-v3-turbo`).
6. `event: final {text, polished, reason, seconds}` replaces the provisional words. The text stays in the field; nothing is sent by itself.

At most 4 dictations at once, 180 s each. `POST /speech/transcribe` turns one whole recording into text (the pad's voice notes).

Read aloud: `POST /speech/say` `{text, lang}` in pieces, or `GET /speech/card/<id>` for a whole card. The hub asks `POST /audio/speech` (`qwen3-tts`) and caches the result as `data/speech/<hash>.mp3`. The agent tool `create_voiceover` uses the same function and returns the path.

Weak spots:

- Speech is not end-to-end encrypted, and the crypto concept keeps it that way: the hub and Tinfoil get audio and text in the clear.
- `data/speech/` is only cleaned by the "orphans" action on the admin page.

## 5. Scratchpad

The pad is the page `/pad/` (`client/web/pad/`), shown in a frame by `js/padlink.js`; the two talk by `postMessage` (sessions, theme, close). Elements (`stroke`, `image`, `text`, `voice`) are saved in the browser's IndexedDB first (`pad/db.js`); `pad/sync.js` sends what changed.

- `PUT /pad/blobs/<id>`: bytes of pictures and voice notes, before the element that names them (up to 30 MB). Stored as `data/pad/blobs/<id>`.
- `POST /pad/elements` `{pad, client_id, elements: [{id, rev, type, x, y, w, h, rotation, z, group, data, blob}]}`. Per element the higher `rev` wins; otherwise the answer says `conflict` with the current record. A delete is a record with `deleted: true` (or `DELETE /pad/elements/<id>`): a tombstone.
- `GET /pad/elements?pad=global&since=<seq>`: everything, or what changed after a running number.
- `GET /pad/events?pad=global&since=<seq>`: the pad's own event stream. It carries only the changed elements, each change with the running number `seq` and the `epoch` of the store.
- `POST /pad/send` `{session, elements, png, text}`: the picture of the selection is written to `data/files/pad-<id>.png`, a message is added to the conversation in `state.json`, the agent gets `kind: pad` with `pad`, `message_id`, `elements`, `image_path`, and the pad records the link.

Storage is SQLite, `data/pad.db`, through `server/store/store.mjs`, opened when the pad is first used.

Weak spots:

- Two stores side by side: the pad in SQLite with small updates, everything else in one JSON file with whole-state pushes. A sent selection crosses from one into the other.
- The pad needs Node 22.13 or newer (`node:sqlite`); on an older hub its routes answer 501.

## 6. Encrypted pages (assets)

1. `publish_asset` runs in the process beside the agent (the channel process, or `dev/session.mjs publish`). `server/asset-envelope.mjs` makes a 128-bit id and a 256-bit key and encrypts: `"ZWA1" | nonce | AES-256-GCM ciphertext | tag`, associated data `ZWA1/<id>`, plaintext padded.
2. `POST /agent/asset?id=<session>&instance=…`: the body is the ciphertext; the header `x-asset` is `{id, keep, silent, type, title, note, key}`, base64url. With `silent: true` type, title, note and key are left out.
3. The hub writes `data/assets/<id>` and a record in `state.assets`. Unless silent, it adds a message to the conversation whose text and `asset.url` contain the link with the key.
4. The link is `<address>/a/<id>#<key>`; addresses are `BOARD_PUBLIC_URL` and `http://localhost:<port>`.
5. `GET /a/<id>` needs no login and returns the same viewer (`a.html`) for every id. `GET /a/<id>/blob` returns the ciphertext. `js/asset.js` decrypts with WebCrypto using the key from the fragment, which a browser never sends. An HTML asset is written into `/a/-/frame.html`, a sandboxed frame whose policy allows no network.
6. `revoke_asset`, or 30 days without `keep`: blob and record are deleted, and the message keeps only the title.

Weak spots:

- For an asset shown on the board the hub does hold the key: it is in the message in `state.json` and is pushed to every logged-in page. Only a silent asset is unknown to the hub.
- The link is the only lock.

## 7. Where the data rests

| Under `data/` | What | Deleted after 30 days (`BOARD_RETENTION_DAYS`) |
| --- | --- | --- |
| `state.json` | The whole state | Answered and closed cards, their markers in the conversation, events queued for sessions that never came back. Not: chat messages. |
| `files/` | Attachments in both directions, pad selections | Only the files of deleted cards (all their versions and note attachments) |
| `scribbles/` | Sent drawings, one canvas per session | No |
| `assets/` | Ciphertext of published assets | Yes, unless `keep` |
| `speech/` | Spoken MP3s | No |
| `pad.db`, `pad/blobs/` | The pad | Tombstones of deleted elements and their bytes |
| `token`, `admin-token`, `tinfoil.key`, `url.txt` | Secrets, mode 0600 | No |
| `admin-log.jsonl`, `sessions/<id>.log` | Admin actions; what helper sessions were sent | No |

`purge()` runs when a process becomes the hub and every six hours. In the browser: `localStorage` (cards put off for later, unsent chat text, theme) and IndexedDB (the pad, the drawing in progress).

Weak spots:

- The state is one JSON file, rewritten in full on every change.
- Everything is clear text: whoever reads `data/` or a backup of it reads the board.
- `server/store/` has tables for cards, messages, deliveries and files, tested, with a migration from `state.json`. Only the pad uses it.

## 8. Planned, not built

End-to-end encryption and pairing are designed (`docs/krypto-konzept.md`, `docs/pairing.md`) and exist as a tested library (`crypto/zcrypto.mjs`, `crypto/hub.mjs`) and as tables in `server/store/` (`member_log`, `devices`, `wrapped_keys`, `invites`). Nothing of it is called from `server/server.mjs`; the only trace there is the empty field `wrapped_key` on an asset record.

- A room is a signed, append-only member list. Each device and each agent has its own Ed25519 and X25519 keys. One room key per epoch encrypts the content; it is renewed only when a member is removed.
- Every message is an envelope: header in clear text, AES-256-GCM ciphertext, Ed25519 signature of the sending device. An agent's channel process checks the signature before Claude Code sees anything.
- The hub would store the member list, sealed room keys, open invites and sealed envelopes. It would read sender, recipient, numbers, time, size, and of a card its id, status, urgency and answer time. It could not read text, options, the chosen option, status lines, attachments or file names.
- Pairing: an invite link `https://<app>/join#v1.<hub>.<room>.<secret>` whose secret never reaches the hub; a request proven with that secret; a six-digit check code a human compares (not for agents); a signed entry in the member list with the room key sealed for the newcomer.
- Speech stays outside it.

Until this is built, the token and the disk of the hub's machine are the whole protection.

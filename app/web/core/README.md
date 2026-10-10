# The client layer

The room as one human device sees it, for the web app. It runs in a Web Worker (the app's build, `../dev/build.mjs`,
bundles it); the page holds an exact copy of its model and calls it by name. Every rule and every key of the
protocol is in the Rust core (`trommi-core`, loaded as WebAssembly); this layer owns the device's store, talks to
the hub, and turns what the core accepted into the model the views render.

**TypeScript.** Strict (`tsconfig.json` at the repository root, `npx tsc -p .`). Modules import each other with
their real extension (`'./codec.ts'`). Nothing is compiled ahead: Node 26 runs `.ts` itself (type stripping, hence
`erasableSyntaxOnly`), and the build erases the types for the browser.

The bytes on the wire are [`spec/v2.md`](../../../spec/v2.md), the hub's routes
[`spec/hub-api.md`](../../../spec/hub-api.md). This file is the contract **between the client layer and its
users**: the model the views read and the calls they make. Names are snake_case, ids lowercase hex, times in ms.
(The core and the hub's JSON speak base64url and bytes; `ids.ts` converts.)

## Files

| File | What |
| --- | --- |
| `core-api.ts` | THE ONE FILE that names the core: the binding's typings, and Part 2, the calls the binding lacks (below) |
| `core-wasm.ts` | Loads the binding and its `.wasm` (fetched with its SHA-256); provisional calls refuse with `core-missing` |
| `ids.ts` | hex ↔ base64url ↔ bytes |
| `hub.ts` | The hub client: sign-in by signed challenge, every route of a human device, outbox entries to their routes, catch-up, the event stream, files. Checks every answer's shape |
| `engine.ts` | Owns the `Device`: outbox pump, catch-up in the hub's order, live stream, upkeep ("Engine invariants") |
| `client.ts` | The `Client`: the model, the human actions, timelines, files, invites, sessions, push, the local cache |
| `room.ts` | How a device comes to hold a room: `foundRoom`, `openRoom`, `joinRoom`, `joinWithCode` |
| `model.ts`, `model-shape.ts`, `types.ts` | The model's builder (no rules of its own), an empty model, the shapes |
| `codec.ts` | Bodies: the JSON of spec/v2.md 9.1 and 10.5 ↔ the model's fields; register names; attachment references |
| `scribble.ts`, `ink.ts`, `palette.ts` | The Scribble Board: merge of items, snapshot file, packed points, colour tokens |
| `work.ts` | A turn's work trail as the views fold it |
| `store-idb.ts`, `tabs.ts` | The device's store and the cache on IndexedDB; one owner per browser profile ("Storage and tabs") |
| `core-worker.ts`, `worker-protocol.ts` | The worker's entry and its messages |
| `remote.ts`, `mirror.ts`, `core-start.ts` | The page's side: `RemoteClient`, the model's copy by patches, the worker started early |
| `account.ts`, `account-remote.ts`, `passkey.ts`, `passwords.ts`, `wordlist.ts` | The account ("The account") |
| `check-emoji.ts` | The 64 emoji of the check code (the core's list, index by index) |
| `proof-worker.ts` | The worker behind the "MLS proof" screen: the core's self test |
| `qr-decode.mjs` | A QR reader for browsers without BarcodeDetector (third party, bundled) |
| `index.ts` | What the build hands the views as `gen/vendor/index.mjs` |

## Tests

All under `tests/web/` at the repository root. None of them shows that a client is safe against a hub unless it
says "real hub".

| Suite | Runs | Against |
| --- | --- | --- |
| `model/` | `node --test` | hand-made core results (`factory.mjs`): the builder, codec, board merge, cache and mirror |
| `hub/` | `node --test` | `hub.ts` against the fake hub; `real-hub.test.mjs` against the real hub binary (`TROMMI_HUB_BIN`), as far as that goes without a room |
| `client/` | `node --test` | engine, client and room on the STAND-IN core (real binding for devices, groups, recovery, files; plain JSON content and invites) and the fake hub |
| `account/` | `node --test` | `account.ts` with the real binding and the fake hub; `real-hub.test.mjs` with the real hub binary |
| `store/` | `node run.mjs`, Chromium | `store-idb.ts` and `tabs.ts` on real IndexedDB, Web Locks, BroadcastChannel, with the real binding |
| `build/`, `proof/` | Chromium | the build with the real `.wasm` under the app's CSP; the self test in a worker |
| `e2e/` | Chromium | the built app and its worker, on the stand-in core and the fake hub |
| `views/` | `node --test` | what the views take from this layer, read from their sources; the demo room |
| `shots/` | Chromium | pictures of the demo's screens, before and after |
| `stand-in/` | | `hub.mjs` (fake hub, no cryptography), `core.ts` (stand-in core), `agent.ts` (an agent device for tests) |

## Opening a room

```ts
// room.ts. Every client comes back NOT started; a step that fails leaves nothing stored.
interface DeviceOptions { storage: { name: string }; client?: string | null; device_name?: string; device_info?: unknown; fetch?; store?: Store }
foundRoom(o & { hub_url, recovery_code?, found_token?, account?: (room_id: Uint8Array) => body }): Promise<{ client, recovery_code: Uint8Array }>
openRoom(o & { hub_url? }): Promise<Client | null>                 // null: nothing stored
openRoomOver(o & { hub_url? }, store): Promise<Client | null>      // over a store whose lock the caller holds (tabs.ts)
joinRoom(o & { link, poll_ms?, timeout_ms? }): { check_code: Promise<string>, client: Promise<Client>, cancel() }
joinWithCode(o & { hub_url, room_id /* hex */, code: Uint8Array, recover?, account?: (new_code) => body | null }): Promise<{ client }>
roomLink(hub_url, room_id, app?) / parseRoomLink(text)             // '<app>#r1.<hub>.<room>': an address, no secret
```

- `foundRoom`: `account(room_id)` is called before the founding is posted (the account's sealed copies bind the room
  id); the hub makes room and account in one request. A store that holds anything is `room-exists`. A founding
  whose answer was lost is retried; if it stays unanswered the device is kept and posts the same bytes at its
  next start.
- `joinRoom`: `check_code` is `'nn-nn-nn-nn-nn-nn'` (`check-emoji.ts` draws it); `client` resolves once the person
  confirmed on the inviting device and the Welcome was taken; "they do not match" rejects with `code-mismatch`.
- `joinWithCode`: signing in on a new device (spec 8.4): the room group, then every live session group. With
  `recover` the recovery of 8.7; `account(new_code)` is called once, before the hub's recovery is opened.
- The hub's address is not in the device's state: it is kept in the cache (`client/room`); `hub_url` on `openRoom`
  is for a cache that was lost (`no-hub` without either).
- In the page: `openRemote({ url, storage: { name }, client })` (`remote.ts`) starts the worker and gives a
  `RemoteClient` with the same `model`, `on`/`off` and every call of `worker-protocol.ts` `CALLS` as a Promise.

## The model

`client.model` (`types.ts` is the truth; `Map`s keyed by id). Mutated in place; read it, never write it.

```
room         { room_id, hub_url, my_device_id, my_role, key_epoch, last_envelope_number, connection, outbox_blocked }
members      Map<device_id, Member>          human devices, agent devices, helper devices (shown as agents)
sessions     Map<session_id, Session>
cards        Map<object_id, Card>            permissions  Map<object_id, PermissionRequest>
notes        Map<object_id | local_id, Note> published    Map<object_id, Published>   (Artifacts)
timelines    Map<timeline_key, Timeline>     'chat:session/<id>', 'chat:card/<id>', 'scribble:desk/<board>'
human        { drafts, snoozes, ducks, crown, desks, session_settings, scribble_snapshots, raw }
invites      Map<invite_id, Invite>          alerts [Alert]       outbox [OutboxItem]
stack        [object_id]                     open_permission_ids [object_id]         newer { count, what, envelope_number }
```

What the fields mean under protocol v2:

- `envelope_number`, everywhere: the hub's **change** number under which the item arrived. `room.last_envelope_number`
  is how far this device has taken the hub's order. `room.key_epoch` is the room group's epoch.
- `room.connection`: `offline | connecting | catching_up | live`, and `removed` once this device is no member.
- **Member**: `device_role` `human` or `agent` (also a helper device); `added_entry_number` / `removed_entry_number`
  are room epochs (only their order is shown); `device_name`, `platform`, `folder`, `host` come from the device's
  own register `device/<id>`; `is_online`, `link` from the hub's presence.
- **Session**: one session group. `group_id`; `agent_device_ids` are its leaves that are no human device;
  `agent_device_id` its agent (a helper session: its helper device, else its opener); `parent_session_id` and
  `creator_device_id` (the opener) for a helper session; `session_key_epoch` the group's epoch; `stale` (a leaf the
  room no longer allows); `group_archived`; `is_active` = not archived and an agent present. `profile`,
  `status_lines`, `heard_up_to`, `agent_alerts` are the agent's registers; `settings` the human register
  `session/<id>`.
- **Card**: `agent_device_id` is the object's owner now, as the core says (it moves when the owner leaves);
  `version_hash` and `answer.envelope_hash` are envelope hashes; `object_state` `open | answered | closed` is the
  core's replay (9.2.1); `closed_how`, `in_revision`, `versions`, `answers` as before. `content_state` other than
  `ok` means the body is not readable here (pruned, no key, a newer schema).
- **PermissionRequest**: `permission_state` `pending | allowed | denied | expired`.
- **Timeline**: `items` is a window (`Map<envelope_number | local_id, TimelineItem>`), filled by `loadTimeline`;
  `item_count`, `newest_envelope_number`, `loaded_down_to`, `has_more`. An item fetched out of the hub's order
  carries `provisional: true` until its chain confirms it. A turn's work trail stands in the session's Chat as
  items with `content.terminal === 'work'` (`work.ts` folds them); a stroke still being drawn as
  `live:<sender>/<stroke>` with `content_type: 'stroke_piece'`.
- **Shape ids** on a board: `<sender hex>/<seq>/<index>`, from the signed header of the item that adds the shape
  (`item.sender_sequence`).
- **Registers**: the model's keys are `draft/<object>`, `snooze/<object>`, `duck/<object>`, `crown`, `desk/<id>`,
  `session/<session>`, `scribble_snapshot/desk/<board>` (the wire's `board_snapshot/<board>`), with hex ids;
  `human.raw` holds each with `pending` while it is an echo. Which write is current is the core's word (9.3.2).
- **Attachments** in a body: `{ attachment_id (hex; the wire's file_id), file_key, sha256, total_size, file_name?,
  media_type?, width?, height?, caption?, poster_attachment_id?, marks? }`.
- **Invite**: `{ invite_id, device_role, link, label, expires_at, check_code, invite_state: open | confirm_code |
  adding | joined | expired | failed, newcomer, error, session_id, takeover, with_history, desk }`.
- **OutboxItem**: `{ local_id, envelope_kind, object_id, timeline_key, recipient_device_id, content, outbox_state:
  sending | blocked | failed, error }`.
- `stack` is the open cards by urgency, then age, without snoozed cards and archived sessions (`stackOf(model, {
  desk_id })` for one desk). `newer` counts what only a newer Trommi understands.

## Change notifications

```js
client.on('change', change => { ... })
change = { cards, sessions, permissions, notes, published, timelines, registers, invites: Set<id or key>,
           items: Map<timeline_key, [TimelineItem]>,   // exactly the items added or replaced in this batch
           members, alerts, outbox, stack, room: boolean }
```

One `change` per batch (a catch-up page, one live event, one action's echo). Every field is always present. Other
events: `'alert'` (each new `model.alerts` entry), `'device-closed'` (the device closed itself; `tabs.ts` takes
over). The worker adds `'error'` and, through `tabs.ts`, `'reset'` (the model object was replaced: take all of it
again).

## Human actions

Each shows its effect at once (an **echo**, `pending: true`, well under 50 ms), seals one envelope per item into the
core's outbox and resolves when that is stored. The hub's answer comes later: the echo is replaced in place when
the hub's copy comes back (same `local_id`, now with `envelope_number`). Local refusals throw `ClientError` with a
`code` (`card-closed`, `needs-update`, `card-pruned`, `not-found`, `forbidden`, `bad-argument`, …); the core's and
the hub's codes pass through.

```js
await client.sendMessage({ session_id? | agent_device_id? | object_id?, text, details?, html?, attachments?, hand_back?, explain?, present_card?, copied_cards?, marks?, note? })
await client.answer({ object_id, choices, note?, option_notes?, attachments?, marks?, trusted? })
await client.trust({ object_id, note? })  ·  markRead({ object_id })  ·  shred({ object_id, note? })  ·  decideAgain({ object_id })
await client.verdict({ object_id, allow })
await client.setRegisters({ '<key>': value | null, ... }, { session_id? })   // one envelope per key
// shorthands: setDraft(object_id, draft), snooze(object_id, until), duck(object_id, value), setCrown(value), setDesk(desk_id, value)
await client.sendStrokes({ timeline_id: 'desk/<board>', content_type: 'strokes' | 'erase' | 'move' | 'send_away', strokes? | stroke_ids?, offset? })
        // all of the above → { local_id, envelope_hash, seq }
await client.sendStrokePiece({ timeline_id, stroke, number, tool, color?, width?, points })   // live, not stored, no echo
const object_id = await client.saveNote({ object_id?, text, ...app fields })   // a new note stands under its local_id until sealed
await client.deleteNote(object_id)                                             // a closed version
await client.loadTimeline(timeline_key, { limit })           // → { loaded, has_more }: the next older page into the window
await client.timelineWindow(timeline_key, { before_envelope_number, limit })   // → [TimelineItem], oldest first; the window does not grow
await client.loadTimelineAfter(timeline_key, envelope_number)                  // → { loaded, items, has_more: false }: a board's tail
const ref = await client.uploadAttachment(bytes | ArrayBuffer | Blob, { file_name, media_type, ... })
const bytes = await client.fetchAttachment(ref)  ·  const blob = await client.attachmentBlob(ref)
const { share_id, link, expires_at } = await client.shareAttachment(ref, { expires_at?, app_url?, keep_link? })
await client.myShares()  ·  client.revokeShare(share_id)
await client.pushSubscribe(subscription.toJSON(), remove?, level?)  ·  client.pushStates()   // → { devices, vapid_public_key, apns }
await client.settle({ timeout_ms })   // outbox empty and the hub's copies back; rejects chain-halted, timeout
```

- An answer whose every choice is an option marked `final`, with nothing said beside it, closes the card in the
  same step; `read` and `shred` close it; anything else leaves it `answered`.
- `sendStrokes` with `content_type: 'selection_sent'` is two writes: a Chat message to that session, then
  `send_away` of the shapes on the board they came from.
- **`failed`**: the hub refused the envelope for good and kept a void record (or the group is archived, or this
  device is out). The echo is rolled back in the same `change` in which the item shows `failed`; then the item is
  gone; an alert carries the code. Later envelopes are sent as usual.
- **`blocked`**: the hub refused an envelope WITHOUT keeping a void record. Its number may never be signed again
  and is not taken at the hub, so everything behind it would meet `gap`: the pump halts on it, `room.outbox_blocked
  = { local_id, code, message }`, alert `chain-halted`, and the same bytes are tried again now and then.
- Not reached, busy, throttled, a sign-in to make again: neither. The same entry is sent again; the item stays
  `sending`. After a restart the stored outbox is sent again unchanged (the echoes of before are not shown again;
  the items arrive as the hub's copies).
- Files are encrypted by the core in 64 KiB pieces (spec 11); a reference travels only inside a body. A Share link
  (`<app>/a/<share id>#<secret>.<file key>.<sha256>`) is for one file of an open Artifact; the page `/a/…` opens it
  with `openShared(hub, link)` (`index.ts`), no room and no sign-in.

## Sessions and devices

```js
const invite = await client.createInvite({ device_role: 'human' | 'agent', app_url?, label?, desk?, takeover?, session_id?, with_history? })
await client.confirmInvite(invite_id, true | false)
await client.removeDevices([device_id, ...])              // → { key_epoch }
await client.leaveRoom()                                  // → { key_epoch, humans_left, removed: false }
```

- **Invite** (spec 12.1). The inviter watches for the Request (the stream's event, and a look every second), shows
  `check_code` in state `confirm_code` (five minutes), and on `confirmInvite(id, true)` the core commits the
  newcomer in the same write that finishes the invite; the state is `adding`. What follows is listed by the core
  (`inviteSteps`) and taken by the engine step by step, also after a restart: the Commit again if it lost its
  epoch, the key handover (7.1) and the recovery key's tag (7.4), the Adds into the live session groups (5.2.7),
  an agent's new main session (named `label`, on `desk`) or its takeover. `joined` for a human device means it is
  in and was handed the keys; the session Adds follow as its KeyPackages reach the hub. `false` burns the invite
  and throws `code-mismatch`.
- **Takeover** (5.3, 13.5): `createInvite({ device_role: 'agent', takeover: true, session_id })`, the only way a
  session changes hands. The Commit that enrols the new agent device takes the old one out of `agents`; the new
  one then takes its leaf in the main session and is handed its keys unless `with_history: false`.
- **Removal** (5.2.8): one room Commit with each human device's Cut (agents: the `agents` change), then the Remove
  in every session group that still holds a removed leaf. Any human device that sees a stale group finishes it.
- **`leaveRoom` removes nothing.** The core lets no device commit its own removal. It sends what is in the outbox,
  stops the client and answers `removed: false`: the device stays a member until another human device removes it.
  The caller wipes the local storage.
- **Archive** (5.2.10): writing `session/<id>` with `archived: true` also tells the hub (`archiveGroup`) and the
  device; the hub then takes nothing more for that group. It is not undone by writing `false`.
- **Goals** (9.3.4): for each live main session on a desk the client keeps the session register `goals` equal to
  `{ desk_id, desk_name, goals }` of that desk.
- The recovery code, for `account.ts`: `client.checkRecoveryCode(code)` (resolves only for the code in force, sends
  nothing) and `client.replaceRecoveryCode({ code, account: new_code => body })` (8.6, one request).

## The account

`account.ts` (in the worker) and `account-remote.ts` (what the page calls): e-mail and password, passkeys, the
Emergency Kit, each a sealed copy of the room's recovery code (spec/v2.md 8.8), made and opened by the core. The
steps that make a room (`createAccount`, `createAccountWithPasskey`, `loginWithPassword`, `loginWithPasskey`,
`recoverWithKit`, `resetPassword`, `recoverWithCode`) run in a new worker that then holds the room; the others
(`accountStatus`, `addAccount`, `makeEmergencyKit`, `changePassword`, `setPassword`, `checkUnlock`,
`passkeyChallengeFor`, `addPasskey`, `removePasskey`, `replaceRecoveryCode`) run on the signed-in client. A new
recovery code is said to the page as the event `recovery-code`, and the worker goes on only when the page has
taken it. Their headers are the contract.

## Storage and tabs

Three IndexedDB databases per `name` (`store-idb.ts`):

- `<name>`: the device's state. It is the binding's own `IdbStore`: one strict transaction per write, the revision
  compared inside it, and a **Web Lock** on the name from `load()` until `close()`. A device resolves a call only
  once its write is stored.
- `<name>:wrap`: one non-extractable AES-GCM key under which every stored value is wrapped at rest. What that is
  worth: it keeps private keys out of anything that reads the database as data without this origin's WebCrypto. It
  does not protect against a copy of the browser profile or against script running in the origin.
- `<name>:cache`: the app's own records, safe to lose: the model's records (one per card, session, note, timeline
  item, …, written after each batch in one transaction together with the device's cursor, `client/at`), the hub's
  address, invites in progress, kept share links, the engine's small records, the receipts of forwarded calls.

The cache is **not authoritative**. A start shows the cached model at once if it was written at exactly the cursor
the device holds (so a stored room opens offline). A cache at another cursor is dropped: the model is then built
from the device's groups, the hub's Desk (`GET /v2/desk`, read back through the core) and one more reading of the
room's changes.

**One owner** (`tabs.ts`). The tab whose worker gets the store's lock runs the real client. Every other tab is a
follower: it mirrors the owner's model (a snapshot, then patches, over a BroadcastChannel) and forwards each call
by name. When the owner goes, the next follower's `load()` returns and it becomes the owner from what is stored.
A forwarded call runs at most once: the owner keeps a receipt per call in the cache, and a call that was in
flight when its owner died is answered `outcome-unknown` instead of run again. A device that closed itself (a
failed write, another owner wrote) makes the client say `device-closed`; the tab drops it and stands in line for
the lock again. That is the one recovery path in a browser; the engine reopens a device in place only where its
host hands it a store factory (Node, tests).

## Engine invariants

1. **One queue.** Every step with a meaning (an action, one page, one stream event, one hub answer, one piece of
   upkeep) is one job; jobs never interleave.
2. **No network inside the queue**, except fetching this device's Welcomes or a missing stretch of a log or chain
   when an item needs it.
3. **The pump** posts the outbox's head outside the queue and reports the answer inside it: strictly in outbox
   order, one in flight. An entry leaves only by `outboxAccepted` or `outboxRefused`. Transient failures are the
   same entry again with backoff: never dropped, never reordered.
4. **A definitive refusal** goes to the core and rolls the echo back; an envelope refused without a void record
   blocks the pump instead (above).
5. **`epoch-taken`, `room-behind`, `wrong-epoch`, `stale-session`**: the group moved on. The log is processed and
   whoever asked for the Commit or message builds it again.
6. **The position moves only when an item is taken, in the hub's order**, upwards. An item at or below it is
   skipped. Change numbers are not consecutive for one device, so there is no "next expected number"; what a hub
   withholds shows in chains and `heads`.
7. **An item that does not process halts the batch**: a duplicate is skipped; one that came early is tried again
   after Welcomes and the missing Commits; a bad one raises `bad-group`, is reported to the hub and leaves state
   and position as they were; a local fault means the device is opened again.
8. **Nothing survives `stop()`**: no timer, no waiter. Nothing is logged; errors travel as events with a code.

Upkeep: joining by Welcome, adding a human device a live session lacks (5.2.7), cleaning stale sessions (5.2.8),
the own-leaf update (5.2.9), `heads` (9.0.7), KeyPackages. A `gap` in a sender's chain is filled from the chain
route; if it stays, the alert is `withheld`.

## What the core's binding lacks today

Stored content, joining by link, stroke pieces and recovery are the binding's own calls, in the binding's shapes
(`core-api.ts` Part 1 re-exports them). What is still open:

- **`servedChainCut(served, device, envelopes) → Cut`** (`core-api.ts` Part 2, the one provisional call): the
  verified end of a removed device's chain for a device that is no member yet. `core-wasm.ts` answers it with
  `core-missing`, and so `joinWithCode({ recover: true })` refuses as soon as a device it removes has written
  anything.
- **A device that is joining by link cannot sign in at the hub** with the binding the tests were last run on
  (`hubSignIn` answers `no-room` until `joinInvited` / `joinObserve`, which need a token first). The tests' core
  bridges exactly that for the fake hub; on the real core a join by link stops there.
- **What was written before a device joined** is not read by the binding yet. The engine reads the room's changes
  once more after keys arrive (`rescan`), which is what will open them.
- **Helper sessions in a takeover**: the invite's steps name the main session only; the helper sessions that
  session opened are held back from the generic cleaning while the takeover is open, but nothing installs their
  new opener yet.
- The tests of `tests/web/client/` still run stored content on the stand-in's plain JSON, because the fake hub
  files an envelope by reading its header as JSON.

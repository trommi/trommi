# shared/: the Trommi client library

One plain-ES-module library that every Trommi client uses: the app (`app/web`, copied into `public/vendor/` by its build, `app/web/dev/build.mjs`) and the agent connector (`connector/connector.mjs`). WebCrypto and `fetch` only; runs unchanged in browsers and Node 26. The only client-specific parts are the **storage adapter** (which also keeps the device keys).

The wire contract is the README section "Hub v1: the wire protocol" of this repository. This file is the contract **between the core and its users**: the model the app renders from (stream C) and the API the connector drives (stream D). Names follow the README: snake_case, ids as lowercase hex, times in ms.

> Status: this document was written first, as the contract. Where the code differs, the code is wrong. Changes to the shape are announced to the app and connector before they land.

## Files

| File | What |
| --- | --- |
| `index.mjs` | re-exports everything below; import this |
| `crypto/` | the pure crypto, no dependencies: `zcrypto.mjs` (the library; bytes: `FORMAT.md`, design: `CRYPTO.md`), `argon2.mjs`, `escrow.mjs` (password escrow, version 2), `session-grants.mjs` (per-session keys), `hub.mjs` (what the hub checks), their tests and `vectors.json` |
| `transport.mjs` | `Hub`: every route, sign-in and token refresh, SSE reader with resume and backoff |
| `room.mjs` | `foundRoom`, `openRoom`, `joinRoom`, `recoverRoom`; invites, removal |
| `client.mjs` | the `Client`: sync engine (one cursor, verify every header, decrypt heads, lazy timelines), outbox, membership, sessions, human actions |
| `snapshot.mjs` | room snapshots (fast first start) |
| `codec.mjs` | body payloads (`schema_version` 1) for the seven kinds, attachment references |
| `model.mjs` | the board model reducer and the projections |
| `agent.mjs` | what an agent does: objects, messages, status, permission requests, `authoriseCommand` |
| `storage-memory.mjs`, `storage-idb.mjs`, `storage-file.mjs` | storage adapters (memory for tests, IndexedDB for browsers, a directory for Node) |
| `test.mjs` | `node shared/test.mjs` (Node, against `hub/server.mjs` in-process) |
| `browser-test.mjs` | the same files in headless Chromium with IndexedDB |
| `load.mjs` | load generator on the real core (stream F): `createLoadRoom({ hub_url, humans, agents, fetch })`, `runMix(room, { total, mix, rate, concurrency })` -> rate, send -> verified latency p50/p95/p99 |

## Opening a room

```js
import { foundRoom, openRoom, joinRoom, recoverRoom, idbStorage, fileStorage } from './vendor/index.mjs'

const storage = idbStorage({ name: 'trommi', prefix: 'room-1/' })     // browser
// const storage = await fileStorage({ dir: '~/.local/share/trommi/rooms/<name>' })   // Node: dir 0700, key file 0600

// 1. Found (first device). recovery_code is returned ONCE; show it, never store it.
const { client, recovery_code } = await foundRoom({ hub_url: 'https://hub.trommi.com', device_name: 'Laptop', storage, found_token })

// 2. Later starts: everything from storage, then the delta from the hub.
const client = await openRoom({ storage })           // null if this storage holds no room

// 3. Join from an invite link (human or agent; the role is in the signed offer).
const join = await joinRoom({ link, device_name: 'Phone', storage })
join.check_code        // Promise<'07-33-12-05-60-01'>: six numbers 0–63, resolves when the inviter revealed. Show it as emoji:
                       // checkEmoji(code) -> [{ emoji, word }] (check-emoji.mjs); a human device shows them, an agent logs checkEmojiLine(code)
const client = await join.client                      // resolves when the inviter added this device

// 4. Recover with the code: removes every human device, keeps the agents. A NEW code comes back once.
const { client, recovery_code } = await recoverRoom({ hub_url, room_id, code, device_name, storage, on_recovery_code })
//    on_recovery_code(code) is called BEFORE the recovery entry is posted: show it there. After the entry is in, nothing loses it:
//    sessions it could not re-key are re-keyed at the next start of any human device (stale grants, README R6).

await client.start()        // sign in, catch up (storage + delta), open the live stream
client.stop()               // close the stream; state stays in storage
```

## The model

`client.model` is one object, **mutated in place** by the reducer. Do not copy it; read what you need inside the change handler. All maps are `Map`s keyed by hex ids (or register keys). Every object below is plain data (JSON-able except `Map`s and the `Uint8Array`s explicitly marked).

```js
model = {
  room: {
    room_id, hub_url,
    my_device_id, my_role,            // 'human' | 'agent'
    key_epoch,                        // current epoch
    last_entry_number,                // newest verified member entry
    last_envelope_number,             // THE cursor: last envelope processed, in hub order
    connection,                       // 'offline' | 'connecting' | 'catching_up' | 'live'
    agent_session_id,                 // agents only, after claimSession
  },

  members: Map<device_id, {
    device_id, device_role,           // 'human' | 'agent'
    device_name,                      // name from the member list (readable by the hub)
    is_active, added_entry_number, removed_entry_number,   // removed_entry_number null while active
    is_me, fingerprint,               // fingerprint: 'ab12 cd34 ef56 7890' (first 8 bytes of device_id), shown next to every name (R8)
    is_online, offline_since,         // from GET devices (on start, on member_entry, every minute) and from the stream's `presence` events, at once
    link,                             // agents: the connector's link report, or null: { hears: 'live' | 'oncall', attached, last_call_at, working, since, cut_since, exit: { reason, claude } | null }
    agent_session_id,
  }>,

  sessions: Map<session_id, Session>,            // R6: one per session (32 hex, random, made by a human device's first grant)
  cards: Map<object_id, Card>,
  permissions: Map<object_id, PermissionRequest>,
  notes: Map<object_id, Note>,
  published: Map<object_id, Published>,
  timelines: Map<timeline_key, Timeline>,          // timeline_key = `${timeline_kind}:${timeline_id}`, e.g. 'chat:card/<object_id>'
  human: HumanRegisters,                           // shared by all human devices; empty on agents
  invites: Map<invite_id, Invite>,                 // invites THIS device made (inviter side)
  alerts: [Alert],                                 // newest last, capped at 200
  outbox: [OutboxItem],                            // own envelopes not yet confirmed by the hub

  // projections (recomputed after every batch, cheap):
  stack: [object_id],               // open cards in board order (below)
  open_permission_ids: [object_id], // pending permission requests, oldest first
}
```

### Session (R6: a session has its own key; agents are assigned to it by grants)

```js
Session = {
  session_id,                            // 32 hex; timelines 'chat:session/<session_id>', registers session/<session_id>, read_up_to/<session_id>
  agent_device_ids,                      // assigned now (latest grant); agent_device_id = the first of them
  ever_agent_ids,                        // every agent ever assigned (their envelopes in this session stay valid history)
  agent_device_id, agent_session_id,     // agent_session_id = agent_device_id.slice(0, 16) (v1.1)
  session_key_epoch, with_history,       // the session key epoch; whether the current agents may read the earlier history
  device_name, is_active, is_online,     // of the current agent: device_name from its encrypted device/<id> register (names are not in the member list, R8)
  offline_since, link,                   // of the current agent, as on its member (a child session carries its agent's)
  heard_up_to, heard_at,                 // agent register 'heard' = { up_to, at }: every command of this session up to envelope number heard_up_to was handed to the agent; null: its connector writes no receipts
  profile: { model, task, icon, agent_name, parent_session, is_main } | null,   // agent register 'profile'
  status_lines: [{ id, label, state, detail, object_id, envelope_number, updated_at }],    // 'status_line/<id>', in order of first appearance; updated_at = sent_at
  agent_alerts: [{ key, value, envelope_number }],    // agent registers 'alert/<n>' (refused commands)
  registers: Map<key, { value, envelope_number }>,   // all of this agent's registers, raw
  settings: { name, desk, archived, group, icon } | null,   // human register 'session/<agent_device_id>'
  read_up_to: envelope_number | 0,                    // human register 'read_up_to/<agent_device_id>'
  card_ids: [object_id],          // all cards of this agent, by first_envelope_number
  open_card_ids: [object_id],     // the ones with object_state 'open'
  timeline_key,                   // 'chat:session/<agent_device_id>'
  unread_count,                   // items from the agent in its session timeline and its cards' timelines with envelope_number > read_up_to
  last_activity_at,               // sent_at of the newest envelope from or to this agent
}
```

### Card (object_type `card`)

```js
Card = {
  object_id, agent_device_id,               // the creator; only it writes versions
  session_id,                               // the session the card belongs to (its key scope)
  object_state,                             // 'open' | 'answered' | 'closed'  (from the newest head's header)
  urgency,                                  // 'low' | 'normal' | 'high' | 'critical'
  // content of the current version (body fields, README names):
  card_type,                                // 'decision' | 'info'
  title, teaser, body, options,             // teaser: the Desk row's two lines or null; options: [{ key, label, detail, short?, final? }] (final: true = choosing it settles the card)
  sections, html, allows_multiple, recommended, urgency_reason, attachments,
  change_note, close_summary, withdraw_reason, merged_into_object_id, merged_from_object_ids,
  object_version,                           // 1, 2, ...
  version_hash,                             // hex envelope hash of the current version (an answer binds to it)
  envelope_number,                          // of the current version
  first_envelope_number,                    // of version 1: the stack order (oldest first)
  created_at, updated_at,                   // sent_at of version 1 / of the newest head
  versions: [CardVersion],                  // every version, oldest first (current = last), linked by previous_version_hash
  answer: Answer | null,                    // the answer in force
  answers: [Answer],                        // every valid answer, also those taken back (taken_back_at set)
  closed_how: null | 'answered' | 'settled' | 'read' | 'shredded' | 'withdrawn' | 'merged' | 'closed',
  in_revision: null | { by: 'hand_back' | 'explain', envelope_number },   // projection, README rule
  timeline_key,                             // 'chat:card/<object_id>'
  content_state: 'ok' | 'pruned' | 'newer_schema' | 'undecryptable',
}
CardVersion = { object_version, version_hash, previous_version_hash, envelope_number, sent_at, object_state, urgency, content }   // content = the decoded body
Answer = {
  answer_action,                            // 'answer' | 'read' | 'shred'
  choices, note, option_notes, attachments, marks, trusted,
  bound_version_hash, bound_object_version, // the version it answered
  envelope_number, envelope_hash, by_device_id, answered_at,
  taken_back_at: null | envelope_number,    // the decide_again that took it back
  taken_back_sent_at: null | sent_at,       // and when it was sent (display only)
}
```

**Rules the reducer applies, identically on every client** (so humans and agents agree):

- R1: a new object's `object_id` must be H("trommi/v1/object-id", creator ‖ `sender_sequence` of version 1) (first 16 bytes); version 1 names no predecessor (`previous_version_hash` zeros). Timeline items follow the authority table of the README (a session's chat: the agent or a human addressing it; a card's chat: its creator or a human addressing the creator; desk canvas: humans). Refusals are `Alert`s and change nothing.
- R2: registers and note versions are settled by one total order from signed data, (`lamport`, `sender_device_id`, `sender_sequence`), never by hub order; inflated lamports are refused (`lamport-inflated`). A deleted register stays in `human.raw` as `value: null` (tombstone). The stack is ordered by `created_at` (`sent_at` of version 1), not by `envelope_number`.
- A card version counts only from the card's creator (the sender of version 1), with `object_version` = previous + 1 and `previous_version_hash` = the current `version_hash`. Anything else becomes an `Alert` and is ignored.
- An answer counts only from an active human device, addressed to the owning agent, while the card is open, bound to the **current** `version_hash`, and (for `answer_action: 'answer'` without `trusted`) with every choice an option key. An answer to an older version is ignored (alert `answer-stale`): the agent refuses it too, the card stays open.
- An answer whose header says closed settles the card (`closed_how: settled`): it counts only if every choice is an option with `final: true` and it is not `trusted` (else `bad-answer`). `client.answer` sends it that way by itself when every choice is final and nothing is said beside the choice (no note, option note, attachment or mark); `choicesFinal(card, choices)` is the test.
- `decide_again` counts only if it names the answer in force and the card is not closed by its agent (`closed`, `withdrawn`, `merged`): what the human closed with an answer (answered, settled, read, shredded) they may take back. It reopens the card (`answer` → null, `taken_back_at` set). On the human side the taken-back choices become the draft (the app writes `draft/<object_id>`, the core does not).
- `object_state` and `urgency` come from the newest counted head of that object.
- `closed_how`: `answered` (answer), `settled` (an answer that closed the card: final options), `read`/`shredded` (answer actions), `withdrawn` (`withdraw_reason`), `merged` (`merged_into_object_id`), `closed` (`close_summary` or a closed state otherwise).

### Permission request, note, published

```js
PermissionRequest = { object_id, agent_device_id, tool_name, description, input_preview, expires_at,
  version_hash, envelope_number, sent_at,
  permission_state: 'pending' | 'allowed' | 'denied' | 'withdrawn' | 'expired',   // expired is computed against the local clock when the model is read via isExpired()
  withdraw_reason: null | string,   // withdrawn: the agent took its pending request back (answered elsewhere); a verdict after it is refused
  verdict: null | { allow, by_device_id, envelope_number } }
Note = { object_id, by_device_id, text, object_version, version_hash, envelope_number, object_state }   // any human device may write a new version
Published = { object_id, agent_device_id, attachments, title, note, released_until, object_version, version_hash, envelope_number, object_state }
```

### Timeline (conversations and canvases, loaded lazily)

The sync engine sees every timeline item's header (pruned form) and counts it; bodies are fetched when the timeline is opened.

```js
Timeline = {
  timeline_key, timeline_kind,             // 'chat' | 'canvas'
  timeline_id,                             // 'card/<object_id>' | 'session/<agent_device_id>' | 'desk/<desk_id>'
  object_id,                               // for card/…; agent_device_id for session/…; desk_id for desk/…
  item_count,                              // all items known from headers
  newest_envelope_number,
  items: Map<envelope_number | local_id, TimelineItem>,   // ONLY the window in memory (newest page(s) opened, live items, own pending echoes);
                                           // iterate sorted via timelineItems(timeline). Older pages: client.timelineWindow()
  loaded_down_to,                          // oldest envelope_number whose body is loaded (Infinity = none yet)
  has_more,                                // older items exist that are not in memory (in storage or still on the hub)
}
TimelineItem = {
  envelope_number,                         // null while pending (own optimistic echo; then local_id is set)
  sender_sequence,                         // the sender's chain number (on an echo once sealed): stroke ids are `${sender_device_id}/${sender_sequence}/${index}` (R1)
  local_id, pending,                       // own sends: shown at once (< 50 ms), replaced in place when the hub confirms
  envelope_hash, sender_device_id, recipient_device_id, sent_at,
  item_state: 'header' | 'loading' | 'loaded' | 'pruned' | 'undecryptable' | 'newer_schema',
  content_type,                            // when loaded: 'message' | 'strokes' | 'erase' | 'move' | 'send_away' | 'selection_sent'
  content,                                 // the decoded body (README fields: text, details, html, attachments, hand_back, explain, present_card, copied_cards, marks, published_object_id, note, strokes, stroke_ids, offset)
}
```

Live items that arrive over the stream come in full and are decrypted at once (`item_state: 'loaded'`). For a card's conversation the app merges `card.versions` and `card.answers` into the items by `envelope_number` ("question revised", "decided"); `timelineEvents(model, timeline_key)` returns that merged, sorted list.

### Human registers

```js
HumanRegisters = {
  drafts: Map<object_id, value>,            // 'draft/<object_id>'
  snoozes: Map<object_id, value>,           // 'snooze/<object_id>'   value e.g. { until }
  ducks: Map<object_id, value>,             // 'duck/<object_id>'
  crown: value | null,                      // 'crown'
  desks: Map<desk_id, value>,               // 'desk/<desk_id>'
  session_settings: Map<agent_device_id, value>,   // 'session/<agent_device_id>'
  read_up_to: Map<agent_device_id, envelope_number>,
  canvas_snapshots: Map<timeline_id, value>,       // 'canvas_snapshot/<timeline_id>' { attachment, last_envelope_number }
  raw: Map<key, { value, envelope_number, by_device_id }>,   // every human key, including unknown ones
}
```

Agent keys sent by humans, and human keys sent by agents, are ignored (alert).

### Invite (inviter side), alert, outbox

```js
Invite = { invite_id, device_role, link, label, expires_at,
  check_code,                                    // from 'confirm_code' on: the same code the new device shows (show it with checkEmoji);
                                                 // the human compares the two and calls confirmInvite(invite_id, true | false)
  invite_state: 'open' | 'confirm_code' | 'adding' | 'joined' | 'expired' | 'failed',
  newcomer: null | { device_id, device_name },   // after the request arrived
  error: null | code }
Alert = { alert_id, code, message, envelope_number, sender_device_id, at, source: 'local' | 'agent' }
OutboxItem = { local_id, envelope_kind, object_id, timeline_key, recipient_device_id, content, outbox_state: 'sending' | 'blocked' | 'failed', error }
```

### The stack (projection)

**The link.** `linkState(member_or_session, now?, { asleep_ms? })` gives `{ state, since, idle_ms, reason }` from `is_online`, `offline_since` and `link`:

| state | when |
|---|---|
| `gone` | no stream, and no word that its Claude Code lives on (it ended, was killed, or is off the network) |
| `cut` | no stream but `link.exit.claude` is `alive`; or a stream and `link.cut_since` (a Claude Code session of its folder lost its connector, `reason: 'folder'`); or a stream and `attached: false` |
| `live` | a stream and `hears: 'live'`, or no report at all (an older connector) |
| `oncall` | a stream and `hears: 'oncall'`: it hears on its next tool call |
| `asleep` | `oncall`, and `last_call_at` (else `since`) is `asleep_ms` or more ago (`ASLEEP_MS`, 10 minutes) |

`since` is when it was cut off or went (null after a hub restart), for `oncall` and `asleep` its last tool call; `idle_ms` how long ago that was; `reason` the connector's exit reason. `cleanLink(report)` is what the model keeps of a report.

**The receipt.** `heardBy(session, envelope_number)` is true, false, or null when the session has no mark. `cardWaitsOn(card)` is the envelope number the agent has to hear of a card (the answer in force, else the message that handed it back), `cardHeard(model, card)` whether it has. The mark only rises; a human device cannot write it (`foreign-key`).

`model.stack`: cards with `object_state: 'open'`, not snoozed (`snoozes` value with `until` in the future), whose session is not archived (`session_settings.archived`), ordered by urgency (critical, high, normal, low), then `created_at` (oldest first, R2). Permission requests are not in it; they are `open_permission_ids` and the app shows them first. `stackOf(model, { desk_id })` filters to the sessions on a desk.

## Change notifications

```js
client.on('change', change => { ... })
change = {
  cards: Set<object_id>, sessions: Set<agent_device_id>, permissions: Set<object_id>,
  notes: Set<object_id>, published: Set<object_id>,
  timelines: Set<timeline_key>,            // items added, bodies loaded
  items: Map<timeline_key, [TimelineItem]>,// exactly the items added or replaced in this batch (echo, confirmed, loaded)
  registers: Set<key>,                     // human and agent register keys that changed
  members: boolean, invites: Set<invite_id>, alerts: boolean, outbox: boolean,
  stack: boolean,                          // model.stack or open_permission_ids changed order or content
  room: boolean,                           // model.room fields (connection, epoch, cursor jumps)
}
```

One `change` per applied batch (catch-up pages are batched; live envelopes come one by one). **Every field is always present** (empty `Set`, `false`), so `change.cards.has(id)` never throws. Other events: `client.on('alert', alert)`, `client.on('command', command)` (agents, below), `client.on('error', error)`.

## Human actions

All return a Promise that resolves once the envelope is sealed and in the (persisted) outbox. **Optimistic echo:** before sealing, the model already shows the change (`pending: true`, a `change` event fires synchronously-soon, budget < 50 ms): a message or stroke as a pending `TimelineItem`, an answer as `card.answer` with `pending: true` and `object_state: 'answered'`, a register value at once. When the hub's copy comes back through the stream, the echo is replaced in place (same `local_id`, now with `envelope_number`); if the hub refuses it, the echo is rolled back and the `OutboxItem` shows `outbox_state: 'failed'`. They throw a `ZError` for local refusals.

```js
await client.sendMessage({ agent_device_id, object_id?, text, details?, html?, attachments?, hand_back?, explain?, present_card?, copied_cards?, marks? })
await client.answer({ object_id, choices, note?, option_notes?, attachments?, marks? })
await client.trust({ object_id, note? })              // answer_action 'answer', trusted: true, choices = the recommendation
await client.markRead({ object_id })                  // info cards: answer_action 'read'
await client.shred({ object_id, note? })              // answer_action 'shred'
await client.decideAgain({ object_id })
await client.verdict({ object_id, allow })            // to a permission request
await client.setRegisters({ 'draft/<object_id>': { keys, note, notes, marks } | null, ... })   // human keys only
// shorthands: setDraft(object_id, draft|null), snooze(object_id, until|null), duck(object_id, value|null), setCrown(value),
//             setDesk(desk_id, value|null), setSessionSettings(agent_device_id, value|null), markReadUpTo(agent_device_id, envelope_number)
const note_id = await client.saveNote({ object_id?, text, ...app fields (place, session, to, attachments, held, …) })
        // new note or new version; optimistic (model.notes at once, pending: true; a new note first under its local_id, then its object_id);
        // quick edits chain on the version THIS client sealed last
await client.deleteNote(object_id)                     // a closed version (object_state 'closed'), optimistic too
await client.sendStrokes({ timeline_id, content_type, strokes?, stroke_ids?, offset?, text?, attachments? })  // canvas items
const ref = await client.uploadAttachment(bytes, { file_name, media_type, width?, height?, caption?, page?, object_id? })  // encryptAsset + PUT; returns the README reference
const bytes = await client.fetchAttachment(ref)        // GET + decrypt + sha256 check; cached in memory
const { share_id, link, expires_at } = await client.shareAttachment(ref, { expires_at?, app_url? })   // uploader only; link for outsiders, ≤ 30 days
await client.revokeShare(share_id, { attachment_id? })  // attachment_id needed only for a share another device made
const bytes = await openShared(new Hub({ hub_url }), link)   // the viewer page: no room, no sign-in; parseShareLink(link) too
const blob = await client.attachmentBlob(ref)          // browsers: a Blob with ref.media_type
await client.loadTimeline(timeline_key, { limit: 50 }) // next older page into the window, newest first: from storage if cached, else GET threads; returns { loaded, has_more }
await client.timelineWindow(timeline_key, { before_envelope_number, limit })   // windowed read for scrolling, does not grow the in-memory window; [TimelineItem] oldest first
await client.loadTimelineAfter(timeline_key, envelope_number)   // canvas tail after a snapshot: { items (oldest first), loaded }, all pages
roomLink(hub_url, room_id) / parseRoomLink(text)       // '<app>#r1.<b64u hub>.<b64u room>': what a fresh device needs for passphrase sign-in or recovery
```

Password escrow (optional, `escrow.mjs`, v2): the blob is addressed by an id derived from the passphrase (PBKDF2-SHA-256, 2,000,000 iterations -> key + id), so the room id alone fetches nothing and every guess costs a slow derivation plus a rate-limited request. Whoever holds the hub's database can still guess offline (PBKDF2 is not memory-hard; WebCrypto has no Argon2), so only a generated passphrase is accepted (review 3); the paper code stays the root. Replacing or removing the escrow is compare-and-swap on the hub's revision:

```js
generatePassphrase()                                   // 'k7m2-x9qp-…' six groups of four (120 bits): offer this, show it once
passphraseProblem(text)                                // null for a generated passphrase, else 'only a generated passphrase'
await client.setPassphrase(passphrase, { recovery_code })   // the code once; writes escrow v2; 'weak-passphrase', 'bad-recovery-code', 'escrow-changed'
await client.removePassphrase()
await client.checkPassphrase()                         // -> model.room.has_passphrase (asked as a signed-in human)
const { client } = await loginWithPassphrase({ room_link, passphrase, storage, device_name, client: 'app/x' })   // fresh device; v2 only; 'wrong-passphrase'
// every human device gets the alert 'recovery-add' when the recovery key adds a device (passphrase sign-in or someone with the code)
```

## Sessions and keys (R6, v1.1)

Agents hold no room key; everything an agent sends is under a session key. Human devices hold every session key.

```js
// human side
const session_id = await client.createSession({ agent_device_id })                    // first grant: a new session for an agent
await client.assignSession({ session_id, agent_device_id, with_history })             // hand over / add an agent
        // always a new session key epoch when an agent leaves (handover); with_history true: the agents NEW in this call get the
        // history key and read back through the back links; agents already there never get it this way (per agent, review 2)
const invite = await client.createInvite({ device_role: 'agent', label, session_id?, with_history? })
        // once the agent joined, the core posts the grant itself: a new session, or the handover of session_id
await client.confirmInvite(invite_id, matches)        // the human compared the six emoji: true adds the newcomer, false burns the
        // invite (code-mismatch, nobody added). Only on the device that made the link; anything but a boolean is refused
client.sessionOfAgent(agent_device_id)                // the session an agent is assigned to now
// removeDevices() also rotates every session key (without the removed agents); a new human device gets every
// session key re-sealed by its inviter; recovery and passphrase login re-key the sessions too.
await client.leaveRoom()                              // log out: this human device removes itself (signed by itself, new room key for
        // the humans who stay and the recovery key), then stops; -> { key_epoch, humans_left }. The sessions are re-keyed
        // by the next start of a human that stays, or by the next login. The caller wipes the storage.

// agent side
client.session_ids, client.session_id                 // assigned sessions (grants), the first is the default
await client.whenSession()                            // resolves once a grant assigns this agent
client.on('session', ({ session_id, with_history }) => …)
// every agent send takes an optional session_id (default client.session_id); without any: ZError 'no-session'
```

When keys arrive for epochs whose envelopes this device already saw unopened (a handover with history, a re-seal after a join), the core replays the room from the start once (`client.stats.resyncs`) so those heads are read.

## Agent API (the connector drives this)

```js
const client = await openRoom({ storage })   // or (await joinRoom({ link, device_name, storage })).client
await client.start()
const { agent_session_id, lease_generation } = await client.claimSession({ process_instance })
        // v1.1 lease: a newer process takes over; this one then gets client 'error' code 'lease-lost' and stops

const object_id = await client.sendCard({ card_type: 'decision', title, body?, options?, sections?, html?, allows_multiple?, recommended?, urgency?, urgency_reason?, attachments? })
await client.revise(object_id, { ...changed fields, change_note? })     // new version; present again after a hand back
await client.setUrgency(object_id, urgency, urgency_reason?)
await client.withdraw(object_id, withdraw_reason)
const new_id = await client.merge([object_id, ...], { title, options, ... })   // closes the old ones with merged_into_object_id
await client.close(object_id, close_summary)                          // after an answer
await client.sendMessage({ text, details?, html?, attachments?, object_id?, present_card? })   // agent -> everyone
await client.setStatus({ 'status_line/tests': { label, state, detail, object_id } | null, profile: { model, task, icon, agent_name } })
await client.markHeard(up_to, { session_id? })                        // the receipt: writes register 'heard' when the mark rises; false when it does not
await client.hub.agentLink({ hears, attached, last_call_at, working, since, cut_since?, exit? })   // the link report (README "The link"); agentLinkLast for a leaving process
const object_id = await client.requestPermission({ tool_name, description, input_preview, expires_in_ms })
await client.withdrawPermission(object_id, withdraw_reason)            // a pending own request; false when it is not pending any more
await client.publish({ attachments, title, note?, released_until? })   // a published object

client.on('command', command => { ... })
command = {
  command: 'message' | 'answer' | 'read' | 'shred' | 'trust' | 'decide_again' | 'verdict' | 'selection_sent',
  envelope_number, sender_device_id, object_id, timeline_key,
  content,                 // the decoded body
  choices, previous_choices, allow,   // as fitting
  settled,                 // answer: true when the answer closed the card itself (final options); nothing is left to close
  late,                    // the human had not seen the agent's newest envelope
  history,                 // R4: sent before the history boundary (first start without sync state, persisted): context, not a prompt
  envelope_hash, sender_sequence, sent_at,
  card,                    // answer / decide_again / message on a card: the card as it is now (model shape)
  permission,              // verdict: the request
}
client.ledger.has(envelope_hash) / await client.ledger.mark(envelope_hash)   // R4 executed-command ledger, persisted (5000 newest)
client.on('error', e => e.code === 'log-fork' ...)   // R3: the member list forked or rolled back: no command is delivered until client.resumeCommands()
```

Before handing out any answer, verdict or decide-again the core refreshes the member list (R3) and drops commands whose sender was removed meanwhile. Delivery is once per (human sender, `sender_sequence`), persisted with the cursor.

Every envelope addressed to the agent passes `authoriseCommand` (active human sender, addressed to this agent, current epoch or the previous one for two minutes, the bind matches the current version or request) before it becomes a `command`. A refused one is not delivered; the core writes the agent register `alert/<envelope_hash>` (`{ code, message, sender_device_id, envelope_number }`) and emits `alert`. Commands are delivered once: the core persists the number of the last delivered command and, after a restart, delivers what arrived meanwhile (fetching thread bodies addressed to it).

## Storage adapter

```js
storage = {
  get(key) -> Promise<value | undefined>, set(key, value) -> Promise, delete(key) -> Promise, keys(prefix) -> Promise<[key]>,
  saveDevice(device) -> Promise, loadDevice() -> Promise<device | null>,   // browsers: IndexedDB, keys wrapped (see below); Node: key file 0600
  extractable_keys: boolean,
  wraps_keys?: boolean,   // IndexedDB: the core generates extractable keys, saveDevice wraps them (pkcs8, AES-GCM under a
                          // non-extractable AES key stored beside them), reads them back and swaps in non-extractable ones;
                          // WebKit stores an X25519 CryptoKey but reads it back as null, so plain CryptoKeys lost the device
}
```

Plus `setMany([[key, value | undefined]...])` (one transaction; `undefined` deletes) and `range(prefix, { after?, before?, limit?, reverse? })` (ordered by key) for windowed reads.

**Incremental persistence, no whole-model rewrite.** The reducer marks what it touched; after each batch (debounced ~200 ms, one `setMany` transaction) the core writes only those records: `card/<object_id>`, `session/<agent_device_id>`, `perm/<id>`, `note/<id>`, `pub/<id>`, `reg/<key>`, `tlmeta/<timeline_key>`, `tl/<timeline_key>/<envelope_number zero-padded>` (item header + decoded body when loaded), plus `sync` (cursor + chains of the senders touched, written in the same transaction, so cursor and records never disagree) and `room` (hub, room id, log entries, pin, epoch secrets; on membership changes only). `outbox` is written before an envelope is posted. A warm start reads the records (not the timelines' items; those are windowed reads) and catches up from the cursor. Epoch secrets are sensitive: in the browser they sit in IndexedDB next to the non-extractable device keys; in Node in a file of mode 0600.

## Performance design

- Verification runs in two phases: signatures and decryption for windows of 64 envelopes at once (WebCrypto works them in parallel, off the JavaScript thread), then the sender chains strictly in hub order. The loop yields every ~12 ms, so no long task. A Worker turned out unnecessary so far (measured below); if it becomes one, `_precheck` is the piece that moves.
- Measured (4 October 2026, this PC): Node catch-up 21,500 envelopes/s processing (17,000/s incl. HTTP to the local hub); Chromium headless catch-up of 20,000 envelopes in 1.4 s (14,000/s incl. HTTP, IndexedDB writes included), **0 long tasks**; warm start from IndexedDB 8 ms open + 9 ms start (delta 1 envelope); newest 50 items of a timeline fetched and decrypted in 15 ms. Local load (`load.mjs`, 2 humans + 8 agents, mixed kinds, paced at 150/s): send -> verified on another device p50 2 ms, p95 5.5 ms, p99 12 ms. Unpaced the senders outrun the hub's 50/s per device limit and latency becomes outbox queueing. Tests: `node shared/test.mjs`, `node shared/browser-test.mjs --n=20000` (needs Chromium outside the sandbox).
- Thread items are verified from their pruned header at sync time (one signature each, no decryption); bodies are fetched and decrypted only for opened timelines and items addressed to an agent.
- Projections (`stack`, counts) are recomputed only for the sessions and cards a batch touched.

## Room snapshot (fast first start)

A human device writes a snapshot every 5000 envelopes (counted from the newest anyone wrote): the model records (no timeline items), the chain head per sender and the cursor, gzipped, as an encrypted attachment; the human register `room_snapshot` = `{ attachment, encoding, envelope_number, log_seq, log_hash, written_at }` points at it. A new human device scans the newest pages for that register (signature and sender checked, from a human device), checks the log entry it names, loads it and verifies only the tail with full chain checks. Stated trust, like canvas snapshots: the snapshot's content cannot be checked without replaying. Thread items from before it are checked by their signature when opened. `client.options.snapshot = false` (before `start()`) disables reading and writing; `client.writeSnapshot()` writes one now; `client.stats.snapshot` says whether a start used one. Measured (Node, local hub): 20,000 envelopes, first start 29 ms with the snapshot (65 KiB) vs 1,039 ms full replay.

## Review-2 behaviour (4 October 2026)

- **Sending never re-signs a number.** A hub refusal with `voided: true` (the hub kept a void record) marks the item `failed` and sending goes on; any other final refusal sets `model.room.outbox_blocked = { local_id, code, message }`, alerts `chain-halted`, makes `settle()` throw `chain-halted`, and retries the same bytes every 60 s. Status bodies over 4 KiB throw `too-large` before signing.
- **Write-ahead.** `storage.setMany(entries, { durable: true })` (IndexedDB: strict durability) holds the outbox and the own chain head before a post; `fileStorage` fsyncs file and directory on every write. A failed write stops sending (`storage-failed`).
- **Registers and notes** carry a signed `lamport` (`compareWrites` in `model.mjs`): one total order on every device.
- **Removal/recovery** re-key every stale session in one atomic `POST session_grants`; `_healStaleSessions` runs at start, on member entries and after a removal; nobody seals under a stale session key (agents wait up to a minute for the re-key, `client.rekey_wait_ms`, then the send is refused with `stale-session-key`).
- **Agent history boundary** `sync.history_before`: every command sent before the first start without sync state is `history: true`. Commands are held (not dropped) while the member list cannot be refreshed or the log forked; `resumeCommands()` delivers them.
- **Ids** that reach URLs are checked hex (`checkId`); a body whose attachment ids are not hex or not in the header's blob list counts as undecryptable. Bodies with bad UTF-8 or a BOM are refused. A trusted answer's choices must be the card's recommendation.
- **Snapshots** only from human devices still members, not from before the newest removal/recovery, tail read from an overlap window (see README R2).
- **Live epoch cutoff (B03)**: live envelopes in an older room or session key epoch count only within EPOCH_GRACE after this device saw the change; agent writes into a session are authorised by the agents of that session key epoch (`session.epoch_agent_ids`), not by "ever assigned".

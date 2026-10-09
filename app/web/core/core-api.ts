// core-api.ts: the Rust core (`trommi-core`, spec/v2.md) as the web app sees it. THE ONE FILE that names the WASM
// binding's interface: every other module of the client layer imports its types from here, and only core-wasm.ts
// touches the generated glue. When the binding's own typings land (core/wasm, branch v2-bindings), this file becomes
// a re-export of them and core-wasm.ts the only place that adapts a name.
//
// It mirrors core/README.md one to one: `Device` is the one stateful object over a store (`load` once,
// `apply(expected_revision, batch)` all or nothing), everything to send leaves through `outbox()`, the hub's log is
// fed to `process_log_entry` in the hub's order. Names are the Rust names (snake_case).
//
// How values cross: byte strings (MLS messages, envelopes, keys, file bytes) as Uint8Array; ids as the strict
// base64url text of core `ids` (ids.ts turns them into the model's lowercase hex and back); numbers that are u64 in
// Rust as JavaScript numbers (change numbers, epochs and times stay below 2^53). A refusal is thrown as a CoreError
// whose `code` is the stable code of spec/v2.md section 16.
//
// State of the core behind each part (core/README.md "State"): built = callable in the binding as soon as its facade
// exists; PROVISIONAL = the core is still wiring it into `Device`, so the shape here is this file's best reading of
// the spec and is the first thing to check against the real typings.

/** Strict base64url text of an id (core `ids`): DeviceId 32 bytes, RoomId 32, GroupId 32 or 48, SessionId, ObjectId,
 *  FileId, RegisterId, BoardId, InviteId, ShareId, TurnId 16, Hash32 32. */
export type Id = string

/** A refusal of the core: `code` is the stable code (spec/v2.md 16; the account's own codes, 8.8). */
export interface CoreError extends Error { code: string }

// ---------------------------------------------------------------------------------------------------------------------
// Store (core `store`, spec 13.2)

/** One stored entry. A value may be a private key: never log it. */
export interface StoreEntry { key: Uint8Array; value: Uint8Array }
/** Everything a store holds, read once before the device is opened. */
export interface Loaded { revision: number; entries: StoreEntry[] }
/** All changes of one operation: applied whole or not at all. */
export interface Batch { put: StoreEntry[]; delete: Uint8Array[] }
/**
 * Where the core hands its batches. The core is synchronous and IndexedDB is not, so `apply` only takes the batch;
 * the caller (engine.ts) awaits the store's durable write of everything taken BEFORE it uses what the operation
 * returned, and drops the device and loads it again when that write failed (store-idb.ts).
 * Throwing 'conflict' tells the core that another owner wrote (core `StorageError::Conflict`).
 */
export interface StoreSink { apply(expected_revision: number, batch: Batch): void }

// ---------------------------------------------------------------------------------------------------------------------
// Outbox (core `store::OutboxEntry`)

export type OutboxKind =
  | 'room_founding' | 'group_founding' | 'commit' | 'external_commit' | 'message' | 'relay_message' | 'envelope'
  | 'key_packages' | 'sealed_key' | 'recovery_code'
/** One request waiting to be sent, or sent and not yet answered. `parts`: the exact bytes, in the order its kind names
 *  (core/src/store.rs `OutboxKind`); a part a request does not have is empty. */
export interface OutboxEntry { id: number; kind: OutboxKind; group: Id | null; epoch: number; parts: Uint8Array[] }

// ---------------------------------------------------------------------------------------------------------------------
// Groups and the log (core `device`)

export interface TrommiSession { session_id: Id; parent: Id | null; opener: Id | null }
export interface GroupSummary {
  group: Id
  /** For a session group, its extension; null for the room group. */
  session: TrommiSession | null
  epoch: number
  leaves: Id[]
  /** Leaves the newest room state does not allow: not empty means stale (5.2.8). */
  disallowed: Id[]
  archived: boolean
  /** A Commit of this device waits for the hub's answer. */
  pending: boolean
}
/** The room's roles as this device knows them now. */
export interface RoomRoles { epoch: number; humans: Id[]; agents: Id[] }

export type LogEntry =
  | { change: number; group: Id; kind: 'commit'; bytes: Uint8Array; recovery_auth: Uint8Array | null }
  | { change: number; group: Id; kind: 'message'; bytes: Uint8Array }

/** What a Commit did, as far as the app shows it. */
export interface CommitFacts { group: Id; epoch: number; committer: Id; added: Id[]; removed: Id[]; time: number }

/** An application message as its receiver takes it (section 7). */
export type Received =
  | { type: 'keys'; from: Id; taken: number; last: boolean }
  | { type: 'stroke_piece'; from: Id; board: Id; piece: string }
  | { type: 'work_trail'; from: Id; turn: Id; number: number; time: number; step: string }
  | { type: 'recovery_auth'; from: Id }
  | { type: 'dropped' }
  | { type: 'newer_version'; from: Id }

export type Processed =
  | { type: 'commit'; facts: CommitFacts; superseded: number | null; removed: boolean }
  | { type: 'own_commit' }
  | { type: 'observed'; facts: CommitFacts }
  | { type: 'message'; received: Received }
  | { type: 'skipped' }

/** What an error of `process_log_entry` means for the caller (core `log_finding`). */
export type LogFinding = 'early' | 'duplicate' | 'bad_group' | 'local'

// ---------------------------------------------------------------------------------------------------------------------
// Stored content (spec 9). PROVISIONAL: core `envelope`, `chain`, `objects`, `registers` are built as pure modules
// and are being wired into `Device`.

export type EnvelopeKind = 'item' | 'version' | 'answer' | 'request' | 'verdict' | 'register' | 'take_back' | 'reserved'
export type ObjectType = 'card' | 'note' | 'request' | 'artifact'
export type ObjectState = 'open' | 'answered' | 'closed'
export type Urgency = 'low' | 'normal' | 'high' | 'critical'
export type TimelineRef =
  | { kind: 'chat'; scope: 'card'; ref: Id }       // ref: the card's object id
  | { kind: 'chat'; scope: 'session'; ref: Id }    // ref: the session id
  | { kind: 'board'; scope: 'desk'; ref: Id }      // ref: the board id

/** The readable header of an envelope (spec 9), with the hub's change number it arrived under. */
export interface EnvelopeHeader {
  change: number
  envelope_hash: Id
  group: Id
  /** The session of `group`; null in the room group. */
  session_id: Id | null
  epoch: number
  sender: Id
  seq: number
  recipient: Id | null
  time: number
  kind: EnvelopeKind
  push: boolean
  timeline: TimelineRef | null
  register_id: Id | null
  object: { object_id: Id; object_type: ObjectType; object_state: ObjectState; urgency: Urgency; answered_at: number; object_ref: Id | null } | null
  file_ids: Id[]
}

/**
 * What became of a received envelope (spec 9.0.5, 9.0.6, 9.0.8).
 * - `applied`: it passed all nine checks; `payload` is its JSON text, `bind` what its kind binds.
 * - `chained`: it took its place in the sender's chain but is not applied (`code`: forbidden, wrong-epoch, no-key,
 *   pruned, decrypt-failed, bad-format, newer-version). A pruned or newer one still counts for the object's state.
 * - `void`: the hub's void record (`code`: its void_code).
 * - `provisional`: fetched out of order (a page of a Chat); shown, and confirmed when its chain reaches it.
 * - `refused`: it consumed nothing (`code`: replay, gap, equivocation, bad-signature, not-member, …).
 */
export interface ReceivedEnvelope {
  header: EnvelopeHeader
  outcome: 'applied' | 'chained' | 'void' | 'provisional' | 'refused'
  code: string | null
  /** The body's payload, UTF-8 JSON text of one object (9.0.2); null when it did not open. */
  payload: string | null
  bind: Bind | null
  /** The state the object is in after this envelope, by the core's replay of headers (9.2.1); null for items and registers. */
  object_after: { object_id: Id; owner: Id; object_state: ObjectState; current_version: Id } | null
  /** For a register: whether this value is now the current one of its name (9.3.2), and the name. */
  register: { name: string; current: boolean } | null
}

export type Bind =
  | { kind: 'answer'; object_id: Id; version_hash: Id; choices: string[] }
  | { kind: 'request'; request_id: Id; expires_at: number }
  | { kind: 'verdict'; request_id: Id; request_hash: Id; expires_at: number; allow: boolean }
  | { kind: 'take_back'; object_id: Id; previous_hash: Id; version_hash: Id }

/** What a human device writes (spec 9.2). `payload` is the JSON text of the body; the core adds nothing to it. */
export type Draft =
  | { kind: 'session_chat'; session: Id; payload: string }
  | { kind: 'card_chat'; session: Id; card: Id; payload: string }
  | { kind: 'board_item'; board: Id; payload: string }
  | { kind: 'register'; group: Id; name: string; value: string | null }          // value: JSON text; null deletes
  | { kind: 'note_first'; payload: string }
  | { kind: 'note_version'; object_id: Id; closed: boolean; payload: string }
  | { kind: 'answer'; session: Id; object_id: Id; choices: string[]; closes: boolean; payload: string }
  | { kind: 'take_back'; session: Id; object_id: Id; payload: string }
  | { kind: 'verdict'; session: Id; request_id: Id; allow: boolean; payload: string }
/** What sealing made: the envelope sits in the outbox under `outbox_id`; its hash and number are final. */
export interface Sealed { outbox_id: number; envelope_hash: Id; seq: number; group: Id; object_id: Id | null; time: number }

// ---------------------------------------------------------------------------------------------------------------------
// Joining by link (core `invite`, spec 12.1). The module is built; its use from `Device` is PROVISIONAL.

export type InviteRole = 'human' | 'agent'
export interface InviteOpened { invite_id: Id; link: string; expires_at: number; signed_offer: Uint8Array }
export interface InviteAccepted { new_device: Id; check_code: number[]; signed_reveal: Uint8Array; request_hash: Id }
export interface InviteLinkParts { app: string; hub: string; room_id: Id; invite_id: Id }
export interface JoinRequest { signed_request: Uint8Array; role: InviteRole; inviter: Id; expires_at: number }

// ---------------------------------------------------------------------------------------------------------------------
// Files (core `files`, spec 11): built.

/** What a body says about a file (9.1.1), as far as the core needs it. */
export interface FileRef { file_id: Id; file_key: string; sha256: string }
export interface SealedFile extends FileRef { stored: Uint8Array }
export interface ShareLinkParts { app: string; share_id: Id; secret: string; file_key: string; sha256: string }

// ---------------------------------------------------------------------------------------------------------------------
// The account (core `account`, spec 8.8): built. Secrets cross as Uint8Array and are zeroed by their user.

export type AccountWay =
  | { way: 'password' }
  | { way: 'recovery' }
  | { way: 'passkey'; credential_id: Uint8Array }
export interface PasswordKeys { auth_key: Uint8Array; wrap_key: Uint8Array }
export interface AccountApi {
  normalise_email(email: string): string
  check_password(password: string): void
  /** The one accepted key derivation record, as JSON text. */
  kdf_record(): string
  accept_kdf(record: string | null): void
  /** Argon2id, 64 MiB: slow (hundreds of ms), runs in the worker. */
  password_keys(email: string, password: string): PasswordKeys
  kit_keys(email: string, words: string): PasswordKeys
  passkey_wrap_key(prf: Uint8Array, room_id: Id, credential_id: Uint8Array): Uint8Array
  passkey_prf_input(): Uint8Array
  seal_code(wrap_key: Uint8Array, room_id: Id, way: AccountWay, code: Uint8Array): Uint8Array
  open_code(wrap_key: Uint8Array, room_id: Id, way: AccountWay, sealed: Uint8Array): Uint8Array
  generate_user_handle(): Uint8Array
  generate_kit_words(): string
  parse_kit_words(text: string): string
  format_recovery_code(code: Uint8Array): string
  parse_recovery_code(text: string): Uint8Array
}

// ---------------------------------------------------------------------------------------------------------------------
// Recovery (core `recovery`, spec 8). PLANNED in the core: every call here is PROVISIONAL.

/** The public keys a room is founded with, and the code they come from (shown once, never stored by the device). */
export interface RecoveryKeys { code: Uint8Array; recovery_signature_key: Uint8Array; recovery_hpke_key: Uint8Array }
/** What a device that holds the code needs from the hub before it joins (8.4, 8.5), as the hub served it. */
export interface RecoveryMaterial {
  groups: { group: Id; kind: 'room' | 'main' | 'helper'; group_info: Uint8Array; founding_group_info: Uint8Array | null; log: LogEntry[] }[]
  sealed_keys: Uint8Array[]
  recovery_links: Uint8Array[]
}

// ---------------------------------------------------------------------------------------------------------------------
// The Scribble Board (core `board`, and `board_items` on branch v2-core-content). PROVISIONAL until merged: until
// then scribble.ts reduces a board's items itself, and this part of the facade is not called.

export interface BoardApi {
  /** The board as its items leave it: the JSON text of `{ shapes }` in strokes.json's form. */
  reduce(snapshot_json: string | null, items_json: string[]): string
}

// ---------------------------------------------------------------------------------------------------------------------
// The self test (the "MLS proof" screen): built in the binding (`self_test()`), no network, no stored state.

export interface SelfTestStep { name: string; ok: boolean; ms: number; detail: string | null }
export interface SelfTestSuite { suite: string; steps: SelfTestStep[] }
export interface SelfTestReport { ok: boolean; ms: number; suites: SelfTestSuite[] }
export interface Versions { core: string; openmls: string; rust: string; wasm_bindgen: string }

// ---------------------------------------------------------------------------------------------------------------------
// The device

export interface Device {
  // ---- what it is (built)
  id(): Id
  room(): Id | null
  cursor(): number
  is_human(): boolean
  /** False once a write met a conflict: another owner wrote; drop this object and load again. */
  is_owner(): boolean
  groups(): GroupSummary[]
  group(group: Id): GroupSummary
  /** PROVISIONAL (core `room_history`): the roles of the room's current epoch. */
  room_roles(): RoomRoles | null

  // ---- the outbox (built)
  outbox(): OutboxEntry[]
  outbox_accepted(id: number, answer: { change: number | null }): void
  outbox_refused(id: number, code: string): void

  // ---- groups (built)
  key_packages_to_upload(unused_at_hub: number, now_ms: number): number | null
  key_package(now_ms: number): Uint8Array
  found_room(recovery_signature_key: Uint8Array, recovery_hpke_key: Uint8Array, now_ms: number): Id
  found_session(agent: Id, key_packages: Uint8Array[], now_ms: number): Id
  add_human_device(device: Id, key_package: Uint8Array, now_ms: number): number
  add_to_session(group: Id, device: Id, key_package: Uint8Array, now_ms: number): number
  change_agents(enrol: Id[], remove: Id[], now_ms: number): number
  /** The Cut of each device is taken from the chains this device accepted (9.0.10). */
  remove_human_devices(devices: Id[], now_ms: number): number
  clean_session(group: Id, replacement: { device: Id; key_package: Uint8Array } | null, now_ms: number): number
  update(group: Id, forced: boolean, now_ms: number): number | null
  archive(group: Id): void
  join_welcome(welcome: Uint8Array, expected: { room: Id; committer: Id | null }, now_ms: number): { group: Id; epoch: number; added_by: Id; offending: Id[] }
  process_log_entry(entry: LogEntry): Processed
  /** Sorts what `process_log_entry` threw. */
  log_finding(error: unknown): LogFinding

  // ---- application messages (built)
  send_handover(group: Id, recipient: Id): number[]
  send_stroke_piece(board: Id, piece: string): number
  send_recovery_auth(recipient: Id | null): number

  // ---- signing in to the hub (core `hub_auth`, built)
  /** `HubAuth` and its signature for the hub's challenge (12.3): { auth, signature }. */
  sign_hub_auth(hub: string, challenge: Uint8Array): { auth: Uint8Array; signature: Uint8Array }

  // ---- stored content (PROVISIONAL)
  /** Seals one item into the outbox; the envelope's number is used for good. */
  seal(draft: Draft, opts: { recipient: Id | null; file_ids: Id[]; now_ms: number }): Sealed
  /** One envelope from the hub, in the hub's order (`ordered`) or fetched out of order (a page, an object). */
  receive_envelope(bytes: Uint8Array, change: number, mode: 'ordered' | 'out_of_order', void_code: string | null, now_ms: number): ReceivedEnvelope
  /** The `heads` value to write in `group` now, or null when nothing changed since the last one (9.0.7). */
  heads_due(group: Id, now_ms: number): string | null

  // ---- joining by link (PROVISIONAL)
  invite_open(terms: { role: InviteRole; session_id: Id | null; app: string; hub: string }, now_ms: number): InviteOpened
  invite_accept(invite_id: Id, signed_request: Uint8Array, now_ms: number): InviteAccepted
  /** The human said the six emoji match (true) or not (false: the invite is burned). On true the Add (a human
   *  device) or the `agents` change (an agent device) is committed into the outbox. */
  invite_confirm(invite_id: Id, matches: boolean, now_ms: number): { new_device: Id; role: InviteRole; session_id: Id | null; key_package: Uint8Array } | null
  /** The new device's side: checks the Offer and makes the Request with a fresh KeyPackage. */
  join_request(link: string, signed_offer: Uint8Array, now_ms: number): JoinRequest
  /** Checks the Reveal and gives the six numbers of the check code. */
  join_reveal(signed_reveal: Uint8Array): number[]

  // ---- recovery and signing in on a new device (PROVISIONAL)
  /** Joins the room group and every live session group with the code (8.4, 8.5): the external Commits go to the outbox. */
  join_with_code(code: Uint8Array, material: RecoveryMaterial, now_ms: number): { groups: Id[] }
  /** Replaces the code (8.6): the room Commit, its RecoveryLink; with `remove_others` also the removal of every other human device (8.7). */
  replace_recovery_code(remove_others: boolean, now_ms: number): RecoveryKeys
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

export interface Core {
  versions(): Versions
  self_test(): SelfTestReport
  /** A new device in an empty store: a fresh signature key, no room yet. */
  create_device(sink: StoreSink): Device
  /** The device a store holds. */
  open_device(loaded: Loaded, sink: StoreSink): Device
  account: AccountApi
  /** PROVISIONAL: fresh recovery keys from a fresh code, for founding. */
  recovery_generate(): RecoveryKeys
  /** PROVISIONAL: the keys of a code in hand (signing in with it, 8.4): the signature for the hub's challenge. */
  recovery_sign_hub_auth(code: Uint8Array, room_id: Id, hub: string, challenge: Uint8Array): { auth: Uint8Array; signature: Uint8Array }
  invite_link_parse(text: string): InviteLinkParts
  /** The 64 emoji and words of the check code (core `invite::CHECK_EMOJI`). */
  check_emoji(): [emoji: string, word: string][]
  encrypt_file(plaintext: Uint8Array): SealedFile
  decrypt_file(file: FileRef, stored: Uint8Array): Uint8Array
  share_link_create(app: string, file: FileRef): { link: string; share_id: Id; secret_hash: Id }
  share_link_parse(text: string): ShareLinkParts
  /** The canonical form of a hub address (v1 8.1 as kept by 12.1.1); throws for any other spelling. */
  hub_address(text: string): string
  board: BoardApi | null
}

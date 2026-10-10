// The types of trommi-core for the browser (trommi-core.js). Hand-written; tests/bindings/manifest.mjs checks them
// against the facade's own declarations (core/swift/src), so that this file, the module and the Swift API name the
// same calls with the same arguments.
//
// Conventions. Bytes are a Uint8Array of their own (never a view of the module's memory). Ids are bytes: a device
// 32, a room 32, a session 16, a group 32 (the room group) or 48 (a session group), a hash 32. A count or a time is
// a number: a whole number from 0 to 2^53 - 1, anything else is refused. `nowMs` is the host's clock, milliseconds
// since 1970. A value that may be absent is `null` in what the core returns, and may be `null` or left out in what
// it takes. Arguments are copied when a call is made; what a call returns is the caller's own. Keys that reach
// JavaScript (a content key, a file key, the account's keys) are ordinary bytes there: the caller overwrites them
// (`fill(0)`) when it is done, and does not log or post them.

/** The stable code of a refusal or finding (specification, section 16; the account's; the four local ones). */
export type ErrorCode =
  | 'bad-format' | 'newer-version' | 'bad-commit' | 'bad-signature' | 'bad-invite' | 'bad-key-package'
  | 'wrong-room' | 'incomplete' | 'chain-break' | 'unauthorised' | 'bad-challenge' | 'wrong-login'
  | 'wrong-recovery' | 'forbidden' | 'not-member' | 'removed-sender' | 'wrong-sender' | 'not-found' | 'no-room'
  | 'gone' | 'invite-expired' | 'invite-burned' | 'epoch-taken' | 'wrong-epoch' | 'room-behind' | 'group-behind'
  | 'stale-session' | 'epoch-full' | 'replay' | 'gap' | 'equivocation' | 'room-exists' | 'invite-used'
  | 'lease-lost' | 'account-exists' | 'last-way-in' | 'account-changed' | 'range' | 'bad-passkey' | 'too-large'
  | 'quota-exceeded' | 'client-too-old'
  | 'too-many' | 'rate-limited' | 'overloaded' | 'withheld' | 'hub-voided-other' | 'bad-group' | 'no-key'
  | 'pruned' | 'decrypt-failed' | 'code-not-confirmed' | 'hash-mismatch' | 'cut'
  | 'bad-email' | 'weak-password' | 'bad-kdf' | 'bad-recovery-words' | 'bad-recovery-code' | 'no-prf'
  | 'internal' | 'storage' | 'entropy' | 'busy'

/** What every call fails with. `message` is for a log and never holds key material. */
export class TrommiError extends Error {
  constructor(code: ErrorCode, message?: string, cause?: unknown)
  readonly name: 'TrommiError'
  readonly code: ErrorCode
  /** For `storage`: what the store threw. A StoreConflict means another tab or worker has, or wrote to, the state. */
  readonly cause?: unknown
}

/** What a store's `apply` throws when the stored revision is not the one the write names, and `load` when another
 *  owner holds the state. */
export class StoreConflict extends Error {
  constructor(message?: string)
}

/**
 * Loads the WebAssembly module; every other call needs it finished. `source`: where the .wasm comes from (a URL, a
 * Response or a promise of one, bytes, a compiled module). Without it the file next to the glue is fetched.
 */
export function init(source?: string | URL | Request | Response | Promise<Response> | BufferSource | WebAssembly.Module): Promise<void>

// ---- the store ----------------------------------------------------------------------------------------------------

/** One stored entry. Key and value are opaque to a store; the value may be a private key. */
export interface StoreEntry {
  key: Uint8Array
  value: Uint8Array
}

/** Everything a store holds. */
export interface StoredState {
  /** How many writes were ever applied; 0 for an empty store. */
  revision: number
  entries: StoreEntry[]
}

/** The changes of one operation: applied together or not at all. Deletions first, then the puts in order. */
export interface StoreWrite {
  /** The revision the device believes is stored. The write makes it this plus one. */
  expectedRevision: number
  put: StoreEntry[]
  delete: Uint8Array[]
}

/**
 * The store a host gives a device. What must hold of it: `apply` writes all of a write or nothing and resolves only
 * once that is durable; it writes only if the stored revision is `expectedRevision` (compared in the same atomic
 * step) and throws StoreConflict otherwise; one owner at a time, by a lock held from before `load` until `close`.
 * IdbStore (idb-store.js) is such a store.
 */
export interface Store {
  /** Rejects when it cannot load, and then holds nothing: no lock, no connection. */
  load(): Promise<StoredState>
  /** The bytes of `write` are the device's: a store copies what it keeps, they are overwritten afterwards. Like
   *  `load`, it must not call its device, nor wait for a call of it: the device waits for the store. */
  apply(write: StoreWrite): Promise<void>
  /** Optional: several writes of one call, in order, in ONE atomic and durable step; each names the revision the
   *  one before it left. Without it they are applied one by one. */
  applyAll?(writes: StoreWrite[]): Promise<void>
  /** Called once when the device closes, also when it closes itself after a failed write. */
  close?(): void | Promise<void>
}

// ---- records ------------------------------------------------------------------------------------------------------

export interface SessionInfo {
  roomId: Uint8Array
  sessionId: Uint8Array
  /** The main session a helper session hangs under; zeros for a main session. */
  parent: Uint8Array
}

/** One group as the device holds it. */
export interface GroupSummary {
  group: Uint8Array
  session: SessionInfo | null
  epoch: number
  leaves: Uint8Array[]
  /** The leaves the newest room state does not allow: not empty means stale. */
  disallowed: Uint8Array[]
  /** The opener a helper session lacks although its main session has an agent leaf: stale until it is added. */
  missingOpener: Uint8Array | null
  /** Whether the group is stale: a disallowed leaf or a missing opener. */
  stale: boolean
  archived: boolean
  /** Whether a Commit of this device waits: for the hub's answer, or for its place in the log. */
  pending: boolean
  /** The epoch this device's own records of the group begin at: the one it joined at. */
  ownFrom: number
  /** Whether it holds the group's epochs before that one too (`learnHistory`); while false, an envelope of an
   *  earlier epoch is `group-behind`. */
  pastLearned: boolean
}

/** The room's roles at its newest epoch. */
export interface RoomRoles {
  epoch: number
  state: Uint8Array
  humans: Uint8Array[]
  agents: Uint8Array[]
  recoverySignatureKey: Uint8Array
  recoveryHpkeKey: Uint8Array
}

/** What an outbox entry asks the hub for. The parts of each kind, in order, are listed in core/swift/src/records.rs. */
export type OutboxKind =
  | 'roomFounding' | 'groupFounding' | 'commit' | 'externalCommit' | 'message' | 'relayMessage' | 'envelope'
  | 'keyPackages' | 'sealedKey' | 'recoveryCode' | 'recoveryCommit' | 'recoveryFinish'

/** One request waiting to be sent, or sent and not yet answered. */
export interface OutboxEntry {
  id: number
  kind: OutboxKind
  group: Uint8Array | null
  epoch: number
  parts: Uint8Array[]
}

/** A device's last envelope in a group that the remover accepted. */
export interface Cut {
  device: Uint8Array
  /** 0 if none. */
  seq: number
  /** Zeros if none. */
  hash: Uint8Array
}

export interface Replacement {
  device: Uint8Array
  keyPackage: Uint8Array
}

export interface Joined {
  group: Uint8Array
  epoch: number
  addedBy: Uint8Array
  /** Not empty: the group failed its first contact; no key of it is handed out until these leaves are removed. */
  offending: Uint8Array[]
}

export type LogEntryKind = 'commit' | 'message'

/** One entry of the hub's ordered log. */
export interface LogEntry {
  change: number
  group: Uint8Array
  kind: LogEntryKind
  bytes: Uint8Array
  recoveryAuth?: Uint8Array | null
}

export interface CommitSummary {
  group: Uint8Array
  /** The epoch the Commit builds on. */
  epoch: number
  committer: Uint8Array
  external: boolean
  adds: Uint8Array[]
  removes: Uint8Array[]
  cuts: Cut[]
  agents: Uint8Array[] | null
  roomEpoch: number | null
  time: number | null
}

export type ReceivedKind =
  | 'keys' | 'strokePiece' | 'workTrail' | 'recoveryAuth' | 'recoveryAuthConflict' | 'dropped' | 'newerVersion'

/** An application message as its receiver takes it. The fields are filled as `kind` says. */
export interface ReceivedMessage {
  kind: ReceivedKind
  from: Uint8Array | null
  keysTaken: number
  last: boolean
  board: Uint8Array | null
  turn: Uint8Array | null
  number: number
  time: number
  payload: Uint8Array
}

export type ProcessedKind = 'commit' | 'ownCommit' | 'observed' | 'joinSuperseded' | 'message' | 'skipped'

/** What processing a log entry did. */
export interface Processed {
  kind: ProcessedKind
  commit: CommitSummary | null
  superseded: number | null
  removed: boolean
  message: ReceivedMessage | null
}

/** What a refusal of `processLogEntry` means for the caller. */
export type LogFinding = 'early' | 'duplicate' | 'badGroup' | 'local'

export interface HandoverSent {
  recipient: Uint8Array
  group: Uint8Array
}

export interface KeyPackageInfo {
  device: Uint8Array
  lastResort: boolean
  reference: Uint8Array
  notAfterMs: number
}

export interface SignedHubAuth {
  auth: Uint8Array
  signature: Uint8Array
}

/** What opens a stored file. `fileKey` is a secret. */
export interface FileRef {
  fileId: Uint8Array
  fileKey: Uint8Array
  sha256: Uint8Array
}

export interface FileEnd {
  /** The last bytes of the stored file. */
  stored: Uint8Array
  file: FileRef
  plainLen: number
  storedLen: number
}

export interface FileLayout {
  chunks: number
  plainLen: number
  storedLen: number
}

export interface FileChunk {
  offset: number
  length: number
  last: boolean
}

/** A Share link, taken apart. `text`, `secret` and `fileKey` are secrets. */
export interface ShareLink {
  text: string
  app: string
  shareId: Uint8Array
  secret: string
  secretHash: Uint8Array
  fileKey: Uint8Array
  sha256: Uint8Array
}

/** The two keys of one way in to the account. Both are secrets. */
export interface AccountKeys {
  authKey: Uint8Array
  wrapKey: Uint8Array
}

/** What names an account for its Emergency Kit's keys: its e-mail, or its account id. Exactly one of the two. */
export interface AccountName {
  email?: string | null
  id?: string | null
}

export type AccountWay = 'password' | 'kit' | 'passkey'

export interface PushNote {
  roomId: Uint8Array
  change: number
  urgency: number
  ticket: Uint8Array
}

export interface Versions {
  core: string
  openmls: string
  provider: string
  binding: string
}

export interface SelfTestStep {
  name: string
  ok: boolean
  micros: number
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  steps: SelfTestStep[]
  micros: number
  versions: Versions
}

// ---- joining by link ----------------------------------------------------------------------------------------------
// Every signed part travels as its bytes with the signature beside it.

export type InviteRole = 'human' | 'agent'

/** An invite as its inviter opened it. `link` holds the invite's secret. */
export interface InviteOpened {
  inviteId: Uint8Array
  link: string
  expiresAt: number
  offer: Uint8Array
  signature: Uint8Array
  /** The MAC that binds the Offer to the link, 32 bytes: published with the Offer and its signature. */
  mac: Uint8Array
}

/** An Offer as the hub takes and serves it, with the MAC it serves beside it. */
export interface SignedOffer {
  offer: Uint8Array
  signature: Uint8Array
  mac: Uint8Array
}

/** A Request as the hub takes and serves it. */
export interface SignedRequest {
  request: Uint8Array
  mac: Uint8Array
  signature: Uint8Array
}

/** A Reveal as the hub takes and serves it. */
export interface SignedReveal {
  reveal: Uint8Array
  signature: Uint8Array
}

/** An invite link, taken apart; its secret is not among the parts. */
export interface InviteLinkParts {
  app: string
  hub: string
  roomId: Uint8Array
  inviteId: Uint8Array
  /** The link's deadline, ms by the inviter's clock: its fifth part. */
  expiresAt: number
}

/** What a link names, as the new device reads it before it fetches anything. */
export interface JoinLink {
  hub: string
  roomId: Uint8Array
  inviteId: Uint8Array
  expiresAt: number
}

export interface EmojiWord {
  emoji: string
  word: string
}

/** The check code both sides show: six of 64 emoji. */
export interface CheckCode {
  /** Six numbers, 0 to 63: what `inviteConfirm` takes. */
  numbers: Uint8Array
  emoji: string[]
  words: string[]
}

export interface InviteAccepted {
  newDevice: Uint8Array
  code: CheckCode
  reveal: Uint8Array
  signature: Uint8Array
  requestHash: Uint8Array
}

export interface InviteConfirmed {
  newDevice: Uint8Array
  role: InviteRole
  sessionId: Uint8Array | null
  outboxId: number
}

export type InviteStepKind = 'wait' | 'commit' | 'handover' | 'addToSession' | 'foundSession' | 'takeOver' | 'checkHelpers'

/** One thing to do next for an invite. The fields are filled as `kind` says. */
export interface InviteStep {
  inviteId: Uint8Array
  kind: InviteStepKind
  group: Uint8Array | null
  device: Uint8Array | null
  /** Null on a `takeOver` of a helper session: claim a fresh KeyPackage of `device` at the hub. */
  keyPackage: Uint8Array | null
  cuts: Cut[]
  /** For `checkHelpers`: the main session that was taken over. */
  session: Uint8Array | null
}

export interface JoinRequest {
  inviteId: Uint8Array
  request: Uint8Array
  mac: Uint8Array
  signature: Uint8Array
  role: InviteRole
  inviter: Uint8Array
  expiresAt: number
  /** For an agent device, the session its invite takes over. */
  sessionId: Uint8Array | null
  roomId: Uint8Array
  /** An agent device follows the room from the GroupInfo of this epoch (`joinObserve`). */
  roomEpoch: number
  roomState: Uint8Array
}

// ---- stored content -----------------------------------------------------------------------------------------------
// No content key reaches JavaScript: a body is sealed by `seal` and opened by `receiveEnvelope`, after the checks
// of its sender's chain. A payload is the UTF-8 JSON of one object, as bytes.

export type Urgency = 'low' | 'normal' | 'high' | 'critical'
export type ObjectType = 'card' | 'note' | 'request' | 'artifact'
export type ObjectState = 'open' | 'answered' | 'closed'
export type DraftKind =
  | 'sessionChat' | 'cardChat' | 'boardItem' | 'register' | 'noteFirst' | 'noteVersion' | 'answer' | 'takeBack'
  | 'verdict' | 'cardFirst' | 'cardVersion' | 'permissionRequest' | 'artifactFirst' | 'artifactVersion'

/**
 * What a device writes: its `kind` and the fields that kind names; the others are left out.
 * sessionChat {session, payload} · cardChat {session, card, payload} · boardItem {board, payload} ·
 * register {group, name, value (null deletes)} · noteFirst {payload} · noteVersion {objectId, closed, payload} ·
 * answer {session, objectId, choices, closes, payload} · takeBack {session, objectId, payload} ·
 * verdict {session, requestId, allow, payload} · cardFirst {session, urgency, push, payload} ·
 * cardVersion {session, objectId, closed, urgency, push, payload} ·
 * permissionRequest {session, urgency, expiresAt, push, payload} · artifactFirst {session, payload} ·
 * artifactVersion {session, objectId, closed, payload}
 * A field its kind names and does not find is `bad-format`: nothing is filled in for it.
 */
export interface Draft {
  kind: DraftKind
  session?: Uint8Array | null
  card?: Uint8Array | null
  board?: Uint8Array | null
  group?: Uint8Array | null
  name?: string | null
  value?: Uint8Array | null
  objectId?: Uint8Array | null
  requestId?: Uint8Array | null
  choices?: string[] | null
  closes?: boolean | null
  closed?: boolean | null
  allow?: boolean | null
  urgency?: Urgency | null
  push?: boolean | null
  expiresAt?: number | null
  payload?: Uint8Array | null
}

export interface Sealed {
  outboxId: number
  envelopeHash: Uint8Array
  seq: number
  group: Uint8Array
  objectId: Uint8Array | null
  time: number
}

export type EnvelopeKind = 'item' | 'version' | 'answer' | 'request' | 'verdict' | 'register' | 'takeBack' | 'reserved'
export type TimelineKind = 'sessionChat' | 'cardChat' | 'board'

/** The timeline of an item: `id` is the session, the card or the board. */
export interface TimelineRef {
  kind: TimelineKind
  id: Uint8Array
}

export interface ObjectHeader {
  objectId: Uint8Array
  objectType: ObjectType
  objectState: ObjectState
  urgency: Urgency
  answeredAt: number
  objectRef: Uint8Array
}

/** The readable, signed header of an envelope. `time` is the sender's claim. */
export interface EnvelopeHeader {
  group: Uint8Array
  sessionId: Uint8Array | null
  epoch: number
  sender: Uint8Array
  seq: number
  prev: Uint8Array
  recipient: Uint8Array | null
  time: number
  kind: EnvelopeKind
  push: boolean
  timeline: TimelineRef | null
  registerId: Uint8Array | null
  object: ObjectHeader | null
  fileIds: Uint8Array[]
  /** For a kind a newer Trommi defines: its number and its object block, unread. */
  reservedKind: number | null
  reservedBlock: Uint8Array | null
}

export type BindKind = 'answer' | 'request' | 'verdict' | 'takeBack'

/** What the body of an answer, a request, a verdict or a take back binds. The fields are filled as `kind` says. */
export interface Bind {
  kind: BindKind
  objectId: Uint8Array | null
  requestId: Uint8Array | null
  versionHash: Uint8Array | null
  previousHash: Uint8Array | null
  requestHash: Uint8Array | null
  choices: string[]
  expiresAt: number
  allow: boolean
}

/** An object as the envelopes accepted so far leave it. */
export interface ObjectView {
  objectId: Uint8Array
  objectType: ObjectType
  owner: Uint8Array
  objectState: ObjectState
  current: Uint8Array
  answer: Uint8Array | null
}

export interface RegisterChange {
  name: string
  of: Uint8Array | null
  current: boolean
}

export type EnvelopeOutcome = 'applied' | 'chained' | 'void' | 'provisional' | 'refused'

/** A received envelope and what became of it. `payload` is decrypted content. */
export interface ReceivedEnvelope {
  change: number
  envelopeHash: Uint8Array
  header: EnvelopeHeader
  outcome: EnvelopeOutcome
  /** Why it is not applied. */
  code: ErrorCode | null
  /** A finding to show beside it: `hub-voided-other`. */
  finding: ErrorCode | null
  payload: Uint8Array | null
  bind: Bind | null
  objectAfter: ObjectView | null
  register: RegisterChange | null
  /** For one that was shown as provisional before: true when its chain took it, false when it is to be dropped. */
  confirmed: boolean | null
  dropped: ErrorCode | null
  /** The group's objects and registers were built again in the hub's order: read them again. */
  replayed: boolean
  /** On an agent or helper device: `command` decides whether to act on it. */
  command: boolean
}

export interface ChainHead {
  seq: number
  hash: Uint8Array
}

export interface WriterHead {
  writer: Uint8Array
  seq: number
  hash: Uint8Array
}

export type Standing = 'held' | 'behind' | 'equivocation' | 'unknown'

export interface HeadStanding {
  sender: Uint8Array
  standing: Standing
  have: number
}

export interface ServedItem {
  sender: Uint8Array
  seq: number
  hash: Uint8Array
}

/** A Scribble Board, loaded and verified: `fresh` and `covered` are places in what was served, from 0. */
export interface BoardLoaded {
  frontier: WriterHead[]
  fresh: number[]
  covered: number[]
}

export type Gate = 'act' | 'refused' | 'done' | 'uncertain'
export type CommandKind = 'chat' | 'answer' | 'verdict' | 'takeBack'
export type AnswerKind = 'answer' | 'read' | 'shred'

export interface CommandDecision {
  gate: Gate
  command: CommandKind | null
  action: AnswerKind | null
  choices: string[]
  allow: boolean | null
  refusal: string | null
}

export interface Finding {
  group: Uint8Array
  sender: Uint8Array
  code: ErrorCode
}

/** One thing of the hub's one order for `feed`: a log entry, or a stored envelope. Exactly one of the two. */
export interface FeedItem {
  entry?: LogEntry | null
  envelope?: ServedEnvelope | null
}

export interface FeedOutcome {
  processed: Processed | null
  envelope: ReceivedEnvelope | null
}

export interface Fed {
  outcomes: FeedOutcome[]
  /** The place of the refused item, from 0; null when all were taken. */
  refusedAt: number | null
  code: ErrorCode | null
  message: string | null
}

/** An envelope's readable part, read without a device. */
export interface EnvelopeInfo {
  envelopeHash: Uint8Array
  header: EnvelopeHeader
  pruned: boolean
}

/** One item of a board for `boardReduce`. `payload` is decrypted content. */
export interface BoardItem {
  sender: Uint8Array
  seq: number
  payload: Uint8Array
}

// ---- recovery -----------------------------------------------------------------------------------------------------
// The recovery code is 32 bytes the host holds only while it founds a room, joins with the code, recovers or
// replaces the code. What the hub serves for a join with the code is handed over as it came: nothing in it is trusted.

/** One Commit of a group's log, as the hub serves it. */
export interface ServedCommit {
  change: number
  commit: Uint8Array
  recoveryAuth?: Uint8Array | null
}

/** One group as the hub serves it to a device that verifies it from its founding. */
export interface ServedGroup {
  /** The founding GroupInfo (epoch 0). */
  founding: Uint8Array
  /** Every Commit since, in the hub's order. */
  commits: ServedCommit[]
  /** The GroupInfo the hub offers as current. */
  current: Uint8Array
}

/** A room as the hub serves it to a device that joins with the code. */
export interface ServedRoom {
  room: Uint8Array
  group: ServedGroup
  /** The GroupInfo of the anchor's epoch (`recoveryAnchor` names the epoch). */
  anchor: Uint8Array
  /** Every SealedKey of the room. */
  rows: Uint8Array[]
  /** Every RecoveryLink of the room. */
  links: Uint8Array[]
  /** Every live session group, main sessions before helper sessions. */
  sessions: ServedGroup[]
}

export interface UnverifiedSession {
  /** Its place among the sessions that were served, from 0. */
  index: number
  code: ErrorCode
}

/** What a join with the code, or a recovery, leaves behind. */
export interface CodeJoin {
  /** The outbox entries to post, in order. */
  outbox: number[]
  /** Not null: the finding `withheld`; the content of the older codes' time stays closed. */
  missingLink: Uint8Array | null
  unverified: UnverifiedSession[]
}

/** One envelope of a chain as the hub's chain route serves it. */
export interface ServedEnvelope {
  bytes: Uint8Array
  change: number
  voidCode?: ErrorCode | null
}

export interface Learned {
  /** How many epochs were recorded; 0 when there was nothing to learn. */
  epochs: number
}

/** Where a device's knowledge of a group begins. */
export interface GroupPast {
  /** The epoch its own knowledge begins at: the one it joined at, or began to follow at. */
  fromEpoch: number
  /** Whether it holds every epoch before that one too; true for a group it founded. */
  learned: boolean
}

export interface Removals {
  group: Uint8Array
  devices: Uint8Array[]
}

/** A recovery, prepared. `newCode` is a secret. */
export interface RecoveryPlan {
  newCode: Uint8Array
  removals: Removals[]
}

export interface Anchor {
  group: Uint8Array
  epoch: number
  groupInfo: Uint8Array
}

// ---- the device ---------------------------------------------------------------------------------------------------

/**
 * One device over the host's store. Every call runs after the ones made before it, and resolves only once what it
 * wrote is stored. A device whose write failed, or that another owner wrote behind, is closed: every later call
 * rejects with `storage` or `internal`, and the stored state is opened again.
 */
export class Device {
  private constructor()
  static create(store: Store): Promise<Device>
  static open(store: Store): Promise<Device>
  close(): Promise<void>

  id(): Promise<Uint8Array>
  room(): Promise<Uint8Array | null>
  cursor(): Promise<number>
  isHuman(): Promise<boolean>
  isOwner(): Promise<boolean>
  roomRoles(): Promise<RoomRoles | null>
  groups(): Promise<GroupSummary[]>
  group(group: Uint8Array): Promise<GroupSummary>
  /** Whether the content key of a group and epoch is held. The key itself never leaves the device. */
  holdsKey(group: Uint8Array, epoch: number): Promise<boolean>
  outbox(): Promise<OutboxEntry[]>
  outboxAccepted(id: number, change?: number | null): Promise<void>
  outboxRefused(id: number, code: ErrorCode): Promise<void>
  keyPackagesToUpload(unusedAtHub: number, nowMs: number): Promise<number | null>
  keyPackage(nowMs: number): Promise<Uint8Array>
  foundRoom(recoveryCode: Uint8Array, nowMs: number): Promise<Uint8Array>
  foundSession(agent: Uint8Array, keyPackages: Uint8Array[], nowMs: number): Promise<Uint8Array>
  foundHelper(parent: Uint8Array, keyPackages: Uint8Array[], nowMs: number): Promise<Uint8Array>
  addToSession(group: Uint8Array, device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  removeAgents(remove: Uint8Array[], nowMs: number): Promise<number>
  removeHumanDevices(cuts: Cut[], nowMs: number): Promise<number>
  cleanSession(group: Uint8Array, cuts: Cut[], replacement: Replacement | null | undefined, nowMs: number): Promise<number>
  readmitHelper(group: Uint8Array, old: Cut, device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  /**
   * Lets a human device into a session group again whose Welcome it could not use: one Commit removes its leaf
   * with its Cut and adds the same key with the fresh KeyPackage it asked with. `forbidden` in the room group and
   * for a device that is no human device; `bad-commit` for this device itself, a device that is no human device of
   * the room, and when the hub holds an envelope of it beyond the Cut. Returns the outbox entry's id.
   */
  readmitHuman(group: Uint8Array, device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  update(group: Uint8Array, forced: boolean, nowMs: number): Promise<number | null>
  archive(group: Uint8Array): Promise<void>
  joinWelcome(welcome: Uint8Array, room: Uint8Array, committer: Uint8Array | null | undefined, nowMs: number): Promise<Joined>
  observeRoom(groupInfo: Uint8Array, expectedState?: Uint8Array | null): Promise<void>
  observeSession(groupInfo: Uint8Array): Promise<void>
  processLogEntry(entry: LogEntry, nowMs: number): Promise<Processed>
  /**
   * Catching up: several log entries and stored envelopes, in the order of their change numbers, in one call. It
   * stops at the first that is refused (`refusedAt`, `code`); nothing after it was touched. The writes of the
   * whole call are stored in one transaction before it resolves. A few hundred items per call is a good size.
   */
  feed(items: FeedItem[], nowMs: number): Promise<Fed>
  sendHandover(group: Uint8Array, recipient: Uint8Array): Promise<number[]>
  handoversSent(): Promise<HandoverSent[]>
  handoverRead(group: Uint8Array, recipient: Uint8Array): Promise<void>
  sendStrokePiece(board: Uint8Array, piece: Uint8Array): Promise<number>
  sendWorkTrail(group: Uint8Array, turn: Uint8Array, number: number, step: Uint8Array, nowMs: number): Promise<number>
  /** Signs the hub's challenge with this device's key, for the room it belongs to; while joining by link, after
   *  `joinReveal`, for the invite's room at the invite's hub (`bad-invite` for another hub). */
  hubSignIn(hub: string, challenge: Uint8Array): Promise<SignedHubAuth>
  inviteOpen(role: InviteRole, sessionId: Uint8Array | null | undefined, app: string, hub: string, nowMs: number): Promise<InviteOpened>
  inviteAccept(inviteId: Uint8Array, request: SignedRequest, nowMs: number): Promise<InviteAccepted>
  /** `code`: the six numbers the person confirmed. Null when `matches` is false: the invite is burned. */
  inviteConfirm(inviteId: Uint8Array, code: Uint8Array, requestHash: Uint8Array, matches: boolean, nowMs: number): Promise<InviteConfirmed | null>
  inviteRecommit(inviteId: Uint8Array, nowMs: number): Promise<number>
  /** Every step left for every invite; an invite with nothing left is finished and listed no more. */
  inviteSteps(): Promise<InviteStep[]>
  inviteHandover(inviteId: Uint8Array): Promise<number[]>
  /** Answers a `checkHelpers` step with the helper sessions' groups the hub lists under the session taken over. */
  inviteChecked(inviteId: Uint8Array, helpers: Uint8Array[]): Promise<void>
  /** A takeover without history: drops the invite's handover steps only. */
  inviteForget(inviteId: Uint8Array): Promise<void>
  /**
   * Reads a link before anything is fetched for it, its deadline held against `nowMs`: `room-exists`, `bad-format`,
   * `newer-version`, `invite-expired` (more than two minutes past it), `bad-invite` (further ahead than any invite
   * lives).
   */
  joinLink(link: string, nowMs: number): Promise<JoinLink>
  /** Answers the Offer served for `link`, with the MAC served beside it: `bad-invite` for an Offer that is not the
   *  link's (a missing, short or wrong MAC) and nothing is stored; `invite-expired` by the Offer's kind. */
  joinRequest(link: string, offer: SignedOffer, nowMs: number): Promise<JoinRequest>
  joinReveal(reveal: SignedReveal): Promise<CheckCode>
  joinObserve(groupInfo: Uint8Array): Promise<void>
  joinInvited(welcome: Uint8Array, nowMs: number): Promise<Joined>

  /** Seals one item into the outbox (kind `envelope`, one part). Its number is used for good. */
  seal(draft: Draft, recipient: Uint8Array | null | undefined, fileIds: Uint8Array[], nowMs: number): Promise<Sealed>
  /** The hub refused the envelope with `voided: true`: the entry goes, the number stays used. */
  outboxVoided(id: number): Promise<void>
  /** Gives up on an envelope the hub refused without taking its number, for a device that is out of the group. */
  envelopeAbandon(id: number): Promise<void>
  /**
   * One envelope from the hub. `ordered`: at its place in the hub's order (the cursor moves to `change`), or read
   * back at or below the cursor; not `ordered`: fetched out of order, at most provisional. Only bytes that are no
   * envelope at all reject; every other finding is an outcome.
   */
  receiveEnvelope(envelope: Uint8Array, change: number, ordered: boolean, voidCode: ErrorCode | null | undefined, nowMs: number): Promise<ReceivedEnvelope>
  /** A relayed stroke piece: no cursor movement. Null for one that does not open; `bad-format` for anything else. */
  receiveRelay(group: Uint8Array, message: Uint8Array, nowMs: number): Promise<ReceivedMessage | null>
  /** The `heads` value (JSON) to write in `group` now as a register named `heads`, or null when nothing is due. */
  headsDue(group: Uint8Array, nowMs: number): Promise<Uint8Array | null>
  compareHeads(group: Uint8Array, writer: Uint8Array): Promise<HeadStanding[]>
  /** The Cut of `device` in `group` for a Commit that removes it: its last accepted envelope; 0 and zeros if none. */
  cutOf(group: Uint8Array, device: Uint8Array): Promise<Cut>
  chainHead(group: Uint8Array, sender: Uint8Array): Promise<ChainHead>
  chainCut(group: Uint8Array, device: Uint8Array): Promise<ChainHead | null>
  object(group: Uint8Array, objectId: Uint8Array): Promise<ObjectView | null>
  objects(group: Uint8Array): Promise<ObjectView[]>
  objectOwner(group: Uint8Array, objectId: Uint8Array): Promise<Uint8Array | null>
  /** The current value of a shared register, JSON text as bytes. */
  register(group: Uint8Array, name: string): Promise<Uint8Array | null>
  registerOf(group: Uint8Array, name: string, sender: Uint8Array): Promise<Uint8Array | null>
  /** Verifies a board's served items against the snapshot register and the writers' chains this device holds. */
  boardLoad(board: Uint8Array, served: ServedItem[]): Promise<BoardLoaded>
  command(envelopeHash: Uint8Array, nowMs: number): Promise<CommandDecision>
  commandFinished(envelopeHash: Uint8Array): Promise<void>
  commandsPending(): Promise<Uint8Array[]>
  commandsUncertain(): Promise<Uint8Array[]>
  findings(): Promise<Finding[]>
  findingsRead(): Promise<void>
  holdsRecoveryMac(): Promise<boolean>
  keyIsConfirmed(group: Uint8Array, epoch: number): Promise<boolean>
  sendRecoveryAuth(recipient: Uint8Array): Promise<number | null>
  postSealedKey(group: Uint8Array, groupInfo: Uint8Array, listed: Uint8Array[]): Promise<number | null>
  verifyFounding(group: Uint8Array, served: ServedGroup): Promise<void>
  joinRoomWithCode(recoveryCode: Uint8Array, served: ServedRoom, nowMs: number): Promise<CodeJoin>
  joinSessionWithCode(recoveryCode: Uint8Array, served: ServedGroup, nowMs: number): Promise<number>
  /** The new code, 32 bytes, kept in the device's memory until `replaceCode`. */
  newRecoveryCode(recoveryCode: Uint8Array): Promise<Uint8Array>
  replaceCode(recoveryCode: Uint8Array, account: Uint8Array, nowMs: number): Promise<number>
  prepareRecovery(recoveryCode: Uint8Array, served: ServedRoom): Promise<RecoveryPlan>
  /** `chains`: the envelopes of the devices the plan removes, as the hub's chain route serves them, in its order.
   *  The device verifies each chain from number 1 and takes the Cuts itself. */
  recover(recoveryCode: Uint8Array, served: ServedRoom, chains: ServedEnvelope[], account: Uint8Array, nowMs: number): Promise<CodeJoin>
  /**
   * For a device that joined by link: learns the past of a group from its founding GroupInfo and its Commits. The
   * room group first, then main sessions, then helper sessions. Afterwards the envelopes of the earlier epochs,
   * `group-behind` until then, are handed to `receiveEnvelope` again.
   */
  learnHistory(group: Uint8Array, founding: Uint8Array, commits: ServedCommit[]): Promise<Learned>
  /** Where this device's knowledge of a group begins, also for a followed group (not in `groups`); null for a
   *  group it neither is a leaf of nor follows. */
  groupPast(group: Uint8Array): Promise<GroupPast | null>
}

// ---- files --------------------------------------------------------------------------------------------------------

/** Encrypts one file piece by piece. Everything `update` and `finish` return, in order, is the stored file. */
export class FileEncryptor {
  constructor()
  fileId(): Uint8Array
  update(plaintext: Uint8Array): Uint8Array
  finish(): FileEnd
  /** Gives the object up without finishing. After `finish` or `close` every call is refused with `internal`. */
  close(): void
}

/** Decrypts a stored file piece by piece. What `update` handed out counts only once `finish` succeeded. */
export class FileDecryptor {
  constructor(file: FileRef)
  update(stored: Uint8Array): Uint8Array
  finish(): Uint8Array
  /** Gives the object up without finishing. After `finish` or `close` every call is refused with `internal`. */
  close(): void
}

// ---- everything without state -------------------------------------------------------------------------------------

export function versions(): Versions
/** Runs the core's self-test. Its last step derives password keys (Argon2id over 64 MiB): call it in a worker. */
export function selfTest(nowMs: number): SelfTestReport
export function logFinding(code: ErrorCode): LogFinding
export function errorCodeText(code: ErrorCode): string
export function errorCodeFromText(text: string): ErrorCode | null
export function keyPackageInfo(keyPackage: Uint8Array): KeyPackageInfo
export function roomGroupId(room: Uint8Array): Uint8Array
export function sessionGroupId(room: Uint8Array, session: Uint8Array): Uint8Array
export function base64urlEncode(bytes: Uint8Array): string
export function base64urlDecode(text: string): Uint8Array
export function fileLayout(storedLen: number): FileLayout
export function fileChunk(storedLen: number, index: number): FileChunk
export function openFileChunk(fileKey: Uint8Array, fileId: Uint8Array, index: number, last: boolean, sealed: Uint8Array): Uint8Array
export function shareLinkCreate(app: string, file: FileRef): ShareLink
export function shareLinkParse(text: string): ShareLink
export function checkShareExpiry(expiresAt: number, nowMs: number): void
export function normaliseEmail(email: string): string
export function checkPassword(password: string): void
export function kdfRecord(): string
/** The slow step (Argon2id over 64 MiB): call it in a worker. */
export function passwordKeys(email: string, password: string, kdf?: string | null): AccountKeys
export function kitKeys(email: string, words: string): AccountKeys
/** The kit's keys for an account named by e-mail or, when it has none, by its id (as `accountIdParse` gives it). */
export function kitKeysFor(name: AccountName, words: string): AccountKeys
/** An account id as typed (any case, spaces, hyphens) in its one text form; `bad-format` otherwise. */
export function accountIdParse(text: string): string
export function passkeyWrapKey(prf: Uint8Array, roomId: Uint8Array, credentialId: Uint8Array): Uint8Array
export function passkeyPrfInput(): Uint8Array
export function sealRecoveryCode(wrapKey: Uint8Array, roomId: Uint8Array, wayIn: AccountWay, credentialId: Uint8Array | null | undefined, recoveryCode: Uint8Array): Uint8Array
export function openRecoveryCode(wrapKey: Uint8Array, roomId: Uint8Array, wayIn: AccountWay, credentialId: Uint8Array | null | undefined, sealed: Uint8Array): Uint8Array
export function generateRecoveryCode(): Uint8Array
export function formatRecoveryCode(recoveryCode: Uint8Array): string
export function parseRecoveryCode(text: string): Uint8Array
export function generateKitWords(): string
export function parseKitWords(text: string): string
export function generateUserHandle(): Uint8Array
export function generatePushKey(): Uint8Array
export function openApnsPush(key: Uint8Array, sealed: Uint8Array): PushNote
export function readWebPush(payload: Uint8Array): PushNote
/** The Scribble Board's merge, without state: the snapshot file's JSON after `items` on `snapshot`. */
export function boardReduce(snapshot: Uint8Array | null | undefined, snapshotFrontier: WriterHead[], items: BoardItem[], frontier: WriterHead[]): Uint8Array
/** The header of an envelope (full or pruned form), with the sender's signature verified and nothing else:
 *  membership and the place in the chain are a device's to check (`receiveEnvelope`). */
export function envelopeHeader(envelope: Uint8Array): EnvelopeInfo
/** The parts of a link, nothing held against a clock; `bad-format` for a link without its deadline. */
export function inviteLinkParse(text: string): InviteLinkParts
/** The parts of a link after its deadline was held against `nowMs`: `invite-expired` more than two minutes past it,
 *  `bad-invite` further ahead than any invite lives. */
export function inviteLinkCheck(text: string, nowMs: number): InviteLinkParts
/** How long an invite for `role` may be answered: 10 minutes for a human device, 15 for an agent device. */
export function inviteLifeMs(role: InviteRole): number
/** How far the new device's clock may stand from the inviter's around a deadline, either way: 2 minutes. */
export function inviteClockToleranceMs(): number
export function checkEmoji(): EmojiWord[]
/** The address if `text` spells it canonically; `bad-format` otherwise. Never normalised. */
export function hubAddress(text: string): string
export function recoveryAnchor(recoveryCode: Uint8Array, room: Uint8Array, rows: Uint8Array[]): Anchor
/** The hub's sign-in under the recovery code, for a device that is not yet a member. */
export function recoverySignIn(recoveryCode: Uint8Array, room: Uint8Array, hub: string, challenge: Uint8Array): SignedHubAuth

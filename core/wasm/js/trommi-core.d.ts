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
  | 'lease-lost' | 'account-exists' | 'last-way-in' | 'too-large' | 'quota-exceeded' | 'client-too-old'
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
  archived: boolean
  /** Whether a Commit of this device waits for the hub's answer. */
  pending: boolean
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

export interface GroupCut {
  group: Uint8Array
  cut: Cut
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
  /** The content key of a group and epoch, 32 bytes. Hand it to the code that seals and opens, nothing else. */
  contentKey(group: Uint8Array, epoch: number): Promise<Uint8Array>
  outbox(): Promise<OutboxEntry[]>
  outboxAccepted(id: number, change?: number | null): Promise<void>
  outboxRefused(id: number, code: ErrorCode): Promise<void>
  keyPackagesToUpload(unusedAtHub: number, nowMs: number): Promise<number | null>
  keyPackage(nowMs: number): Promise<Uint8Array>
  foundRoom(recoveryCode: Uint8Array, nowMs: number): Promise<Uint8Array>
  foundSession(agent: Uint8Array, keyPackages: Uint8Array[], nowMs: number): Promise<Uint8Array>
  foundHelper(parent: Uint8Array, keyPackages: Uint8Array[], nowMs: number): Promise<Uint8Array>
  addHumanDevice(device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  addToSession(group: Uint8Array, device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  changeAgents(enrol: Uint8Array[], remove: Uint8Array[], nowMs: number): Promise<number>
  removeHumanDevices(cuts: Cut[], nowMs: number): Promise<number>
  cleanSession(group: Uint8Array, cuts: Cut[], replacement: Replacement | null | undefined, nowMs: number): Promise<number>
  readmitHelper(group: Uint8Array, old: Cut, device: Uint8Array, keyPackage: Uint8Array, nowMs: number): Promise<number>
  update(group: Uint8Array, forced: boolean, nowMs: number): Promise<number | null>
  archive(group: Uint8Array): Promise<void>
  joinWelcome(welcome: Uint8Array, room: Uint8Array, committer: Uint8Array | null | undefined, nowMs: number): Promise<Joined>
  observeRoom(groupInfo: Uint8Array, expectedState?: Uint8Array | null): Promise<void>
  observeSession(groupInfo: Uint8Array): Promise<void>
  processLogEntry(entry: LogEntry): Promise<Processed>
  sendHandover(group: Uint8Array, recipient: Uint8Array): Promise<number[]>
  handoversSent(): Promise<HandoverSent[]>
  handoverRead(group: Uint8Array, recipient: Uint8Array): Promise<void>
  sendStrokePiece(board: Uint8Array, piece: Uint8Array): Promise<number>
  sendWorkTrail(group: Uint8Array, turn: Uint8Array, number: number, step: Uint8Array, nowMs: number): Promise<number>
  hubSignIn(room: Uint8Array, hub: string, challenge: Uint8Array): Promise<SignedHubAuth>
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
  recover(recoveryCode: Uint8Array, served: ServedRoom, cuts: GroupCut[], account: Uint8Array, nowMs: number): Promise<CodeJoin>
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
export function recoveryAnchor(recoveryCode: Uint8Array, room: Uint8Array, rows: Uint8Array[]): Anchor
/** The hub's sign-in under the recovery code, for a device that is not yet a member. */
export function recoverySignIn(recoveryCode: Uint8Array, room: Uint8Array, hub: string, challenge: Uint8Array): SignedHubAuth

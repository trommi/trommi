// zcrypto.d.mts: the TypeScript view of zcrypto.mjs (the audited crypto library stays JavaScript, byte for byte; this
// file only says what its exports take and give, for the typed core). Bytes are Uint8Array; the member-list state, an
// invite and the like are zcrypto's own objects (FORMAT.md): their fields that callers read are named, the rest open.
// Keep it in step with zcrypto.mjs: a new export or a changed argument is written here too.

export type Bytes = Uint8Array
type Obj = { [field: string]: any }

export const VERSION: number
export class ZError extends Error {
  constructor(code: string, message?: string, extra?: Record<string, unknown>)
  code: string
  status?: number
  [field: string]: any
}

// ---- bytes ----
export function b64u(bytes: Uint8Array): string
export function unb64u(str: string): Uint8Array<ArrayBuffer>
export function hex(bytes: Iterable<number> | ArrayLike<number>): string
export function unhex(str: string): Uint8Array<ArrayBuffer>
export function utf8(s: string): Uint8Array<ArrayBuffer>
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer>
export function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean
export const OBJ: Readonly<Record<string, number>>
export const LABEL: Readonly<Record<string, string>>
export function requireRuntime(): Promise<void>
export function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>>
export function hash(label: string, ...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>>
export function hkdf(ikm: Uint8Array, salt: Uint8Array, label: string, context: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>>

// ---- devices ----
export const ROLE: Readonly<{ HUMAN: 1; AGENT: 2 }>
/** A device: its id and public keys, and its private keys (CryptoKeys). */
export interface Device { id: Bytes; signPub: Bytes; kexPub: Bytes; signKey: CryptoKey; kexKey: CryptoKey; [field: string]: unknown }
export function deviceId(signPub: Bytes, kexPub: Bytes): Promise<Bytes>
export function generateDevice(opts?: { extractable?: boolean }): Promise<Device>
export function deviceFromSeeds(signSeed: Bytes, kexSeed: Bytes, opts?: { extractable?: boolean }): Promise<Device>
export function publicDevice(d: Device): { id: Bytes; signPub: Bytes; kexPub: Bytes }
export function exportDeviceSecret(d: Device): Promise<Uint8Array<ArrayBuffer>>
export function importDeviceSecret(bytes: Bytes, opts?: { extractable?: boolean }): Promise<Device>
export function sign(device: Device, label: string, message: Bytes): Promise<Bytes>
export function verify(signPub: Bytes, label: string, message: Bytes, signature: Bytes): Promise<boolean>
export function seal(recipientKexPub: Bytes, plaintext: Bytes, aad?: Bytes, opts?: Obj): Promise<Bytes>
export function openSealed(device: Device, sealed: Bytes, aad?: Bytes): Promise<Bytes>

// ---- the member list ----
export const ENTRY: Readonly<{ GENESIS: 1; ADD: 2; REMOVE: 3; RECOVER: 5 }>
export const SIGNER: Readonly<{ DEVICE: 1; RECOVERY: 2 }>
/** A member as the log state keeps it (key: b64u of its id). */
export interface LogMember { id: Bytes; role: number; signPub: Bytes; kexPub: Bytes; addedSeq: number; removedSeq: number | null; cut?: { seq: number; hash: Bytes } | null; [field: string]: any }
/** A verified member list (applyEntry, verifyLog). */
export interface LogState {
  roomId: Bytes
  head: { seq: number; hash: Bytes }
  hashes: Bytes[]
  members: Map<string, LogMember>
  recovery: { id: Bytes; [field: string]: any }
  epoch: number
  entries: Obj[]
  lastRecoverSeq: number
  [field: string]: any
}
/** What a device pins of a log it trusts (pinOf). */
export interface Pin { seq: number; hash: Bytes; hashes: Bytes[]; lastRecoverSeq: number }
export function decodeEntry(bytes: Bytes): Obj
export function applyEntry(state: LogState | null, entryBytes: Bytes): Promise<LogState>
export function verifyLog(entries: Bytes[], roomId?: Bytes): Promise<LogState>
export function pinOf(state: LogState): Pin
export function checkLogAgainstPin(state: LogState, pin: Pin | null): { status: string; [field: string]: any }
export function activeMembers(state: LogState): LogMember[]
export function memberAt(state: LogState, id: Bytes, logSeq?: number): LogMember | null
export function epochAt(state: LogState, logSeq?: number): number

// ---- keys ----
/** An epoch's key, and the history key that opens the back link to the epoch before. */
export interface Secret { epoch: number; key: Bytes; hist: Bytes | null; [field: string]: any }
export function newEpochSecret(epoch: number, opts?: Obj): Secret
export function epochCommits(secret: Secret): Promise<Obj>
export function wrapEpochKey(state: LogState, secret: Secret, recipientId: Bytes, opts?: Obj): Promise<Bytes>
export function unwrapEpochKey(state: LogState, device: Device, sealed: Bytes, epoch: number): Promise<Secret>
export function wrapForAll(state: LogState, secret: Secret, opts?: Obj): Promise<{ id: Bytes; sealed: Bytes }[]>
export function makeBackLink(roomId: Bytes, secret: Secret, previous: Secret): Promise<Bytes>
export function openBackLink(state: LogState, secret: Secret, link: Bytes): Promise<Secret>

// ---- rooms, recovery ----
export function createRoom(args: { device: Device; recovery?: Obj; time?: number; _rng?: unknown; [field: string]: unknown }): Promise<Obj>
export function addMember(state: LogState, signer: Obj, args: { member: Obj; inviteId?: Bytes; time?: number }): Promise<Obj>
export function removeMembers(state: LogState, signer: Obj, args: { ids: Bytes[]; cuts?: unknown; previous?: Secret | undefined; time?: number; _rng?: unknown }): Promise<Obj>
export function formatRecoveryCode(bytes: Bytes): string
export function parseRecoveryCode(text: string): Uint8Array<ArrayBuffer>
export function generateRecoveryCode(opts?: Obj): string
export function recoveryDevice(code: string): Promise<Device>
export function recoverRoom(args: Obj): Promise<Obj>

// ---- invites ----
export const INVITE_TTL_MS: number
export const INVITE_CONFIRM_MS: number
export function checkHubAddress(hub: string): string
export function inviteLink(app: string, hub: string, roomId: Bytes, secret: Bytes): string
export function parseInviteLink(link: string): Obj
export function createInvite(args: { state: LogState; inviter: Device; hub: string; role: number; app?: string; ttlMs?: number; now?: number; _rng?: unknown }): Promise<Obj>
export function verifyInviteOffer(state: LogState, offer: Bytes, now?: number): Promise<Obj>
export function verifyInviteRequest(request: Bytes): Promise<Obj>
export function verifyInviteReveal(state: LogState, reveal: Bytes, inviterId: Bytes): Promise<Obj>
export function joinRequestSigner(bytes: Bytes): string | null
export function inviteOfferHash(offer: Obj): Promise<Bytes>
export function inviteRequestHash(request: Obj): Promise<Bytes>
export const CHECK_CODE_SYMBOLS: number
export function createJoinRequest(args: Obj): Promise<Obj>
export function acceptJoinRequest(args: Obj): Promise<Obj>
export function checkReveal(args: Obj): Promise<string>
export function finalizeInvite(args: Obj): Promise<Obj>
export function completeJoin(args: Obj): Promise<Obj>
export function signHubAuth(args: { device: Device; roomId: Bytes; hub: string; challenge: Bytes }): Promise<Uint8Array<ArrayBuffer>>
export function verifyHubAuth(bytes: Bytes, args: { state: LogState; hub: string }): Promise<Obj>

// ---- envelopes ----
export const KIND: Readonly<Record<string, number>>
export function isKnownKind(kind: unknown): boolean
export function isThreadKind(kind: unknown): boolean
export const TIMELINE: Readonly<{ CHAT: 1; SCRIBBLE: 2 }>
export const TIMELINE_SCOPE: Readonly<{ CARD: 1; SESSION: 2; DESK: 3 }>
export const TIMELINE_ID_MAX: number
export const KEY_SCOPE: Readonly<{ ROOM: 0; SESSION: 1 }>
export const SEEN_MAX: number
export function parseTimelineId(text: string): { scope: number; ref: Bytes } | null
export function timelineIdOf(scope: number, ref: Bytes): string
export const CARD_STATE: Readonly<{ OPEN: 1; ANSWERED: 2; CLOSED: 3 }>
export const URGENCY: Readonly<{ LOW: 0; NORMAL: 1; HIGH: 2; CRITICAL: 3 }>
export function objectIdOf(creatorId: Bytes, senderSequence: number): Promise<Bytes>
export function deriveSenderKey(roomId: Bytes, secret: Secret, senderId: Bytes, opts?: { keyScope?: number; sessionId?: Bytes | null }): Promise<CryptoKey>
export function paddedLength(n: number): number

/** An envelope's cleartext header (FORMAT.md "Envelope"). */
export interface Header {
  push: boolean; keyScope: number; sessionId: Bytes | null; roomId: Bytes; epoch: number; sender: Bytes; seq: number; prev: Bytes
  logSeq: number; logHash: Bytes; recipient: Bytes; time: number; kind: number; seen: { sender: Bytes; seq: number; hash: Bytes }[]
  card: { id: Bytes; state: number; urgency: number; answeredAt: number } | null; timelineKind: number | null; timelineId: string | null; blobs: Bytes[]
  isHead: boolean
  [field: string]: any
}
/** A chain set: sender (b64u id) -> its verified head. */
export type Chains = Map<string, { seq: number; hash: Bytes; hashes: Map<number, Bytes>; told?: Map<string, number> }>
export function pruneEnvelope(bytes: Bytes): Promise<Bytes>
export function peekEnvelope(bytes: Bytes, opts?: { strictKinds?: boolean }): { header: Header; headerBytes: Bytes; nonce: Bytes; ciphertext: Bytes | null; ciphertextHash: Bytes | null; signature: Bytes; pruned: boolean }
export function newChains(): Chains
export function sealEnvelope(args: Obj): Promise<{ bytes: Uint8Array<ArrayBuffer>; hash: Bytes; seq: number; header: Header; [field: string]: any }>
/** A verified envelope: its header, hash, the sender as a member, and whether only the pruned form came. */
export interface Verified { header: Header; hash: Bytes; member: LogMember; pruned: boolean; [field: string]: any }
export function verifyEnvelope(bytes: Bytes, opts: { state: LogState; chains: Chains | Map<string, any>; allowChainStart?: boolean; allowRemovedSender?: boolean; commit?: boolean; freshness?: Obj | null; strictKinds?: boolean }): Promise<Verified>
/** An opened envelope: verified, decrypted (bind and payload). */
export interface Opened extends Verified { kind: number; bind: Bytes | null; payload: Bytes | null; quarantined: string | null; forMe: boolean }
export function openEnvelope(bytes: Bytes, opts: Obj): Promise<Opened>
export function openVerifiedEnvelope(bytes: Bytes, opts: { state: LogState; secrets: unknown; envelopeHash: Bytes; self?: Bytes | null }): Promise<Opened>
export function joinEnvelope(parts: { headerBytes: Bytes; nonce: Bytes; ciphertext?: Bytes | null; ciphertextHash?: Bytes | null; signature: Bytes }): Uint8Array<ArrayBuffer>
export function encodeAnswerBind(args: Obj): Uint8Array<ArrayBuffer>
export function encodeVerdictBind(args: Obj): Uint8Array<ArrayBuffer>
export function encodeDecideAgainBind(args: Obj): Uint8Array<ArrayBuffer>
export const encodeRedecideBind: typeof encodeDecideAgainBind
export function encodeRequestBind(args: Obj): Uint8Array<ArrayBuffer>
export function decodeBind(kind: number, bind: Bytes): Obj
export const EPOCH_GRACE_MS: number
export function authoriseCommand(opened: Opened | Obj, ctx: Obj): Obj

// ---- assets ----
export const ASSET_CHUNK: number
export function encryptAsset(data: Uint8Array, opts?: Obj): Promise<{ blob: Uint8Array<ArrayBuffer>; key: Bytes; blobId: Bytes; sha256: Bytes; size: number }>
export function decryptAssetChunk(blob: Bytes, key: Bytes, index: number): Promise<Uint8Array<ArrayBuffer>>
export function decryptAsset(blob: Bytes, key: Bytes, expectedSha256?: Bytes | null): Promise<Uint8Array<ArrayBuffer>>

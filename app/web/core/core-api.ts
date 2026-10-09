// core-api.ts: the Rust core (`trommi-core`, spec/v2.md) as the web app sees it. THE ONE FILE that names the WASM
// binding's interface: every other module of the client layer imports the core's types from here, and only
// core-wasm.ts touches the binding's module.
//
// Part 1 is the binding itself: the typings of core/wasm/js/trommi-core.d.ts, re-exported unchanged. Their
// conventions hold for everything here: bytes are a Uint8Array of their own; ids are bytes (a device 32, a room 32,
// a session 16, a group 32 or 48, a hash 32; ids.ts turns them into the model's lowercase hex and back); counts and
// times are whole numbers below 2^53; an absent value is null; every refusal is a TrommiError whose `code` is the
// stable code of spec/v2.md section 16. A `Device` is asynchronous: each call runs after the ones before it and
// resolves only once what it wrote is stored, so a result in hand is always durable (spec 13.2).
//
// Part 2 is PROVISIONAL: what the web app needs and the binding does not have yet, because the core is still
// wiring it into its `Device` (core/README.md "State": stored content, joining by link, recovery). Its shapes are
// this file's reading of the spec in the binding's conventions, and are the first thing to check when the
// binding grows them. core-wasm.ts answers each of them with the refusal `core-missing` until then; the tests run
// them on a stand-in (tests/web/stand-in/core.ts).
import type * as Binding from '../../../core/wasm/js/trommi-core.js'

// ---------------------------------------------------------------------------------------------------------------------
// Part 1: the binding

export type {
  ErrorCode, TrommiError, StoreConflict, StoreEntry, StoredState, StoreWrite, Store, SessionInfo, GroupSummary, RoomRoles,
  OutboxKind, OutboxEntry, Cut, Replacement, Joined, LogEntry, CommitSummary, ReceivedMessage, Processed, LogFinding,
  HandoverSent, KeyPackageInfo, SignedHubAuth, FileRef, FileEnd, FileLayout, FileChunk, ShareLink, AccountKeys, AccountWay,
  PushNote, Versions, SelfTestStep, SelfTestReport, FileEncryptor, FileDecryptor,
} from '../../../core/wasm/js/trommi-core.js'

/** Everything of the binding's module that has no state: versions, the self test, the account, files, share links,
 *  ids, push. (`init` and the `Device` class are core-wasm.ts's.) */
export type Stateless = Omit<typeof Binding, 'init' | 'Device' | 'TrommiError' | 'StoreConflict'>

// ---------------------------------------------------------------------------------------------------------------------
// Part 2 (PROVISIONAL): stored content, spec 9. Core modules `envelope`, `chain`, `objects`, `registers`: built,
// being wired into `Device`.

export type EnvelopeKind = 'item' | 'version' | 'answer' | 'request' | 'verdict' | 'register' | 'takeBack' | 'reserved'
export type ObjectType = 'card' | 'note' | 'request' | 'artifact'
export type ObjectState = 'open' | 'answered' | 'closed'
export type Urgency = 'low' | 'normal' | 'high' | 'critical'
export type TimelineRef =
  | { kind: 'chat'; scope: 'card'; ref: Uint8Array }       // ref: the card's object id
  | { kind: 'chat'; scope: 'session'; ref: Uint8Array }    // ref: the session id
  | { kind: 'board'; scope: 'desk'; ref: Uint8Array }      // ref: the board id

/** The readable header of an envelope (spec 9), with the hub's change number it arrived under. */
export interface EnvelopeHeader {
  change: number
  envelopeHash: Uint8Array
  group: Uint8Array
  /** The session of `group`; null in the room group. */
  sessionId: Uint8Array | null
  epoch: number
  sender: Uint8Array
  seq: number
  recipient: Uint8Array | null
  time: number
  kind: EnvelopeKind
  push: boolean
  timeline: TimelineRef | null
  registerId: Uint8Array | null
  object: { objectId: Uint8Array; objectType: ObjectType; objectState: ObjectState; urgency: Urgency; answeredAt: number; objectRef: Uint8Array | null } | null
  fileIds: Uint8Array[]
}

export type Bind =
  | { kind: 'answer'; objectId: Uint8Array; versionHash: Uint8Array; choices: string[] }
  | { kind: 'request'; requestId: Uint8Array; expiresAt: number }
  | { kind: 'verdict'; requestId: Uint8Array; requestHash: Uint8Array; expiresAt: number; allow: boolean }
  | { kind: 'takeBack'; objectId: Uint8Array; previousHash: Uint8Array; versionHash: Uint8Array }

/**
 * What became of a received envelope (spec 9.0.5, 9.0.6, 9.0.8).
 * - `applied`: it passed all nine checks; `payload` is its body's JSON, `bind` what its kind binds.
 * - `chained`: it took its place in the sender's chain but is not applied (`code`: forbidden, wrong-epoch, no-key,
 *   pruned, decrypt-failed, bad-format, newer-version). A pruned or newer one still counts for the object's state.
 * - `void`: the hub's void record (`code`: its void code).
 * - `provisional`: fetched out of order (a page of a Chat); shown, and confirmed when its chain reaches it.
 * - `refused`: it consumed nothing (`code`: replay, gap, equivocation, bad-signature, not-member, …).
 */
export interface ReceivedEnvelope {
  header: EnvelopeHeader
  outcome: 'applied' | 'chained' | 'void' | 'provisional' | 'refused'
  code: Binding.ErrorCode | null
  /** The body's payload: the UTF-8 JSON text of one object (9.0.2), as bytes; null when it did not open. */
  payload: Uint8Array | null
  bind: Bind | null
  /** The object after this envelope, by the core's replay of headers (9.2.1); null for items and registers. */
  objectAfter: { objectId: Uint8Array; owner: Uint8Array; objectState: ObjectState; currentVersion: Uint8Array } | null
  /** For a register: its name, and whether this value is now the current one of that name (9.3.2). */
  register: { name: string; current: boolean } | null
}

/** What a human device writes (spec 9.2). `payload` is the body's JSON as bytes; the core adds nothing to it. */
export type Draft =
  | { kind: 'sessionChat'; session: Uint8Array; payload: Uint8Array }
  | { kind: 'cardChat'; session: Uint8Array; card: Uint8Array; payload: Uint8Array }
  | { kind: 'boardItem'; board: Uint8Array; payload: Uint8Array }
  | { kind: 'register'; group: Uint8Array; name: string; value: Uint8Array | null }     // value: JSON; null deletes
  | { kind: 'noteFirst'; payload: Uint8Array }
  | { kind: 'noteVersion'; objectId: Uint8Array; closed: boolean; payload: Uint8Array }
  | { kind: 'answer'; session: Uint8Array; objectId: Uint8Array; choices: string[]; closes: boolean; payload: Uint8Array }
  | { kind: 'takeBack'; session: Uint8Array; objectId: Uint8Array; payload: Uint8Array }
  | { kind: 'verdict'; session: Uint8Array; requestId: Uint8Array; allow: boolean; payload: Uint8Array }
/** What sealing made: the envelope waits in the outbox under `outboxId`; its hash and number are final. */
export interface Sealed { outboxId: number; envelopeHash: Uint8Array; seq: number; group: Uint8Array; objectId: Uint8Array | null; time: number }

// ---- joining by link, spec 12.1. Core module `invite`: built; its use from `Device` is not.

export type InviteRole = 'human' | 'agent'
export interface InviteOpened { inviteId: Uint8Array; link: string; expiresAt: number; signedOffer: Uint8Array }
export interface InviteAccepted { newDevice: Uint8Array; checkCode: number[]; signedReveal: Uint8Array; requestHash: Uint8Array }
export interface InviteConfirmed { newDevice: Uint8Array; role: InviteRole; sessionId: Uint8Array | null; keyPackage: Uint8Array }
export interface InviteLinkParts { app: string; hub: string; roomId: Uint8Array; inviteId: Uint8Array }
export interface JoinRequest { signedRequest: Uint8Array; role: InviteRole; inviter: Uint8Array; expiresAt: number }

// ---- recovery and signing in on a new device, spec 8. Core module `recovery`: planned.

/** What a device that holds the code needs from the hub before it joins (8.4, 8.5), as the hub served it. */
export interface RecoveryMaterial {
  groups: { group: Uint8Array; kind: 'room' | 'main' | 'helper'; groupInfo: Uint8Array; foundingGroupInfo: Uint8Array | null; log: Binding.LogEntry[] }[]
  sealedKeys: Uint8Array[]
  recoveryLinks: Uint8Array[]
}

/** The calls on a device that the binding does not have yet. */
export interface ProvisionalDevice {
  /** Seals one item into the outbox; the envelope's number is used for good. */
  seal(draft: Draft, recipient: Uint8Array | null, fileIds: Uint8Array[], nowMs: number): Promise<Sealed>
  /** One envelope from the hub: in the hub's order (`ordered`), or fetched out of order (a page, an object). */
  receiveEnvelope(bytes: Uint8Array, change: number, ordered: boolean, voidCode: Binding.ErrorCode | null, nowMs: number): Promise<ReceivedEnvelope>
  /** The `heads` value (JSON) to write in `group` now, or null when nothing changed since the last one (9.0.7). */
  headsDue(group: Uint8Array, nowMs: number): Promise<Uint8Array | null>
  /** The Cut of `device` in `group`, from the chains this device accepted (9.0.10). */
  cutOf(group: Uint8Array, device: Uint8Array): Promise<Binding.Cut>

  inviteOpen(role: InviteRole, sessionId: Uint8Array | null, app: string, hub: string, nowMs: number): Promise<InviteOpened>
  inviteAccept(inviteId: Uint8Array, signedRequest: Uint8Array, nowMs: number): Promise<InviteAccepted>
  /** The person said the six emoji match (true) or do not (false: the invite is burned, null comes back). On true
   *  the Add of a human device, or the `agents` change for an agent device, is committed into the outbox. */
  inviteConfirm(inviteId: Uint8Array, matches: boolean, nowMs: number): Promise<InviteConfirmed | null>
  /** The new device's side: checks the Offer and makes the Request with a fresh KeyPackage. */
  joinRequest(link: string, signedOffer: Uint8Array, nowMs: number): Promise<JoinRequest>
  /** Checks the Reveal and gives the six numbers (0 to 63) of the check code. */
  joinReveal(signedReveal: Uint8Array): Promise<number[]>

  /** Signs in to the hub with the code's signature key (8.4), before this device is a member. */
  recoverySignIn(recoveryCode: Uint8Array, room: Uint8Array, hub: string, challenge: Uint8Array): Promise<Binding.SignedHubAuth>
  /** Joins the room group and every live session group with the code (8.4, 8.5): the joins go to the outbox. */
  joinWithCode(recoveryCode: Uint8Array, material: RecoveryMaterial, nowMs: number): Promise<{ groups: Uint8Array[] }>
  /** Replaces the code (8.6) with `newCode`; with `removeOthers` also removes every other human device (8.7). */
  replaceRecoveryCode(newCode: Uint8Array, removeOthers: boolean, nowMs: number): Promise<void>
  /** Sends `recovery_mac` (7.4) to one device, or to all with null. */
  sendRecoveryAuth(recipient: Uint8Array | null): Promise<number>
}

/** Module-level calls the binding does not have yet. */
export interface ProvisionalStateless {
  inviteLinkParse(text: string): InviteLinkParts
  /** The 64 emoji and words of the check code (core `invite::CHECK_EMOJI`). */
  checkEmoji(): [emoji: string, word: string][]
  /** The canonical form of a hub address (12.1.1); throws `bad-format` for any other spelling. */
  hubAddress(text: string): string
  /** The Scribble Board's merge of items (core `board_items`): the board as JSON after `items` on `snapshot`. */
  boardReduce(snapshot: Uint8Array | null, items: Uint8Array[]): Uint8Array
}

// ---------------------------------------------------------------------------------------------------------------------
// What the client layer holds

export type Device = Binding.Device & ProvisionalDevice

/** The loaded core: core-wasm.ts makes it from the binding; the tests' stand-in implements it whole. */
export interface Core extends Stateless, ProvisionalStateless {
  /** A new device in an empty store: a fresh signature key, no room yet. */
  createDevice(store: Binding.Store): Promise<Device>
  /** The device a store holds. */
  openDevice(store: Binding.Store): Promise<Device>
  /** Whether a thrown value is a refusal of the core, and which. */
  errorCode(error: unknown): Binding.ErrorCode | 'core-missing' | null
}

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
// Part 2 is PROVISIONAL: what the web app needs and the binding does not have yet. Today it is EMPTY: stored
// content, joining by link and recovery are all the binding's own, in the binding's shapes. A call the binding lacks
// is named there (and in core-wasm.ts' table, which answers it with the refusal `core-missing`) until it is bound.
import type * as Binding from '../../../core/wasm/js/trommi-core.js'

// ---------------------------------------------------------------------------------------------------------------------
// Part 1: the binding

export type {
  ErrorCode, TrommiError, StoreConflict, StoreEntry, StoredState, StoreWrite, Store, SessionInfo, GroupSummary, RoomRoles,
  OutboxKind, OutboxEntry, Cut, Replacement, Joined, LogEntry, CommitSummary, ReceivedMessage, Processed, LogFinding,
  HandoverSent, KeyPackageInfo, SignedHubAuth, FileRef, FileEnd, FileLayout, FileChunk, ShareLink, AccountKeys, AccountWay,
  PushNote, Versions, SelfTestStep, SelfTestReport, FileEncryptor, FileDecryptor,
  ServedCommit, ServedGroup, ServedRoom, ServedEnvelope, Learned, UnverifiedSession, CodeJoin, Removals, RecoveryPlan, Anchor,
  InviteRole, InviteOpened, SignedOffer, SignedRequest, SignedReveal, InviteLinkParts, EmojiWord, CheckCode, InviteAccepted,
  InviteConfirmed, InviteStepKind, InviteStep, JoinRequest,
  Urgency, ObjectType, ObjectState, DraftKind, Draft, Sealed, EnvelopeKind, TimelineKind, TimelineRef, ObjectHeader,
  EnvelopeHeader, BindKind, Bind, ObjectView, RegisterChange, EnvelopeOutcome, ReceivedEnvelope, ChainHead, WriterHead,
  Standing, HeadStanding, ServedItem, BoardLoaded, Gate, CommandKind, AnswerKind, CommandDecision, Finding, BoardItem,
} from '../../../core/wasm/js/trommi-core.js'

/** Everything of the binding's module that has no state: versions, the self test, the account, files, share links,
 *  ids, push, invite links, the check code's emoji, the hub's address, the board's merge. (`init` and the `Device`
 *  class are core-wasm.ts's.) */
export type Stateless = Omit<typeof Binding, 'init' | 'Device' | 'TrommiError' | 'StoreConflict'>

// ---------------------------------------------------------------------------------------------------------------------
// Part 2 (PROVISIONAL)

/** The calls on a device that the binding does not have yet: none. */
export interface ProvisionalDevice {}

// ---------------------------------------------------------------------------------------------------------------------
// What the client layer holds

export type Device = Binding.Device & ProvisionalDevice

/** The loaded core: core-wasm.ts makes it from the binding; the tests' stand-in implements it whole. */
export interface Core extends Stateless {
  /** A new device in an empty store: a fresh signature key, no room yet. */
  createDevice(store: Binding.Store): Promise<Device>
  /** The device a store holds. */
  openDevice(store: Binding.Store): Promise<Device>
  /** Whether a thrown value is a refusal of the core, and which. */
  errorCode(error: unknown): Binding.ErrorCode | 'core-missing' | null
}

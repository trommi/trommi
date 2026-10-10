// Core.swift: trommi-core as Swift sees it. One file, one call for one call of core/README.md ("API at a glance"):
// `CoreDevice` is `Device`, `CoreStorage` is `Storage`, `CoreTools` is the stateless modules (account, invite, files,
// hub_auth, push, envelope reading). Bytes, ids and plain structs cross the edge, as in the core.
//
// Nothing here computes. The implementation is TrommiCoreLive (UniFFI over the Rust library); the tests use a core
// that seals nothing (Tests/TrommiClientTests/FakeCore.swift). Every call that needs time takes `nowMs`.
//
// The shapes are the binding's (core/swift/src/*.rs, branch v2-bindings at b2e5b98): records and calls keep its
// names in Swift's spelling, and a record with a `kind` and optional fields there is an enum with values here. What
// the app never does as a human device (an agent's drafts, the command gate, helper sessions) is left out.
import Foundation

// ---- ids (core `ids`): raw bytes; the model shows them as lower-case hex --------------------------------

public typealias DeviceId = Bytes    // 32: the device's Ed25519 public key
public typealias RoomId = Bytes      // 32
public typealias SessionId = Bytes   // 16
public typealias GroupId = Bytes     // 32 (the room group) or 48 (a session group)
public typealias ObjectId = Bytes    // 16
public typealias BoardId = Bytes     // 16
public typealias FileId = Bytes      // 16
public typealias Hash32 = Bytes      // 32

/** The board of "All desks" (spec/v1.md 10.1). */
public let ALL_DESKS_BOARD: BoardId = (try? unhex("616c6c2d6465736b7300000000000009")) ?? []

/** A refusal of the core: `code` is the stable code of spec/v1.md section 16 (core `Error::code()`). */
public typealias CoreError = TrommiError

// ---- store (core `store`, section 13.2) ------------------------------------------------------------------

public struct StoreEntry: Equatable {
  public var key: Bytes
  public var value: Bytes
  public init(key: Bytes, value: Bytes) { self.key = key; self.value = value }
}
/** The changes of one operation: deletions first, then the puts; of two puts of one key the later counts. */
public struct StoreBatch: Equatable {
  public var put: [StoreEntry]
  public var delete: [Bytes]
  public init(put: [StoreEntry] = [], delete: [Bytes] = []) { self.put = put; self.delete = delete }
}
public struct StoreLoaded: Equatable {
  public var revision: UInt64
  public var entries: [StoreEntry]
  public init(revision: UInt64, entries: [StoreEntry]) { self.revision = revision; self.entries = entries }
}
public enum StoreError: Error, Equatable {
  /** The stored revision is not the one named: another owner wrote to this state. Nothing was written. */
  case conflict
  /** The platform's store failed; the text holds no stored value. Nothing was written. */
  case failed(String)
}
/**
 * A device's store, the Swift side of the core's `Storage`. `apply` writes all of the batch or none of it, makes the
 * revision `expectedRevision + 1`, and returns only once that survives a crash; it refuses with `.conflict` when
 * the stored revision differs. One owner at a time: DeviceStore.swift says how that is held on iOS.
 */
public protocol CoreStorage: AnyObject {
  func load() throws -> StoreLoaded
  func apply(expectedRevision: UInt64, batch: StoreBatch) throws
}

/** What an outbox entry asks the hub for; the parts of each kind in the order core/src/store.rs names. */
public enum OutboxKind: UInt8 {
  case roomFounding = 1, groupFounding, commit, externalCommit, message, relayMessage, envelope, keyPackages, sealedKey, recoveryCode
  case recoveryCommit, recoveryFinish
}
public struct OutboxEntry: Equatable {
  public var id: UInt64
  public var kind: OutboxKind
  public var group: GroupId?
  public var epoch: UInt64
  public var parts: [Bytes]
  public init(id: UInt64, kind: OutboxKind, group: GroupId?, epoch: UInt64, parts: [Bytes]) {
    self.id = id; self.kind = kind; self.group = group; self.epoch = epoch; self.parts = parts
  }
}

// ---- device (core `device`, sections 3 to 7, 13): groups and messages -------------------------------------

public struct SessionInfo: Equatable {
  public var session: SessionId
  /** The main session a helper session hangs under; nil for a main session. */
  public var parent: SessionId?
  public var agents: [DeviceId]
  public init(session: SessionId, parent: SessionId?, agents: [DeviceId]) { self.session = session; self.parent = parent; self.agents = agents }
}
public struct GroupSummary: Equatable {
  public var group: GroupId
  /** nil: the room group. */
  public var session: SessionInfo?
  public var epoch: UInt64
  public var leaves: [DeviceId]
  /** Leaves that may no longer be there (a session whose agent left `agents`: stale until cleaned, 5.2.8). */
  public var disallowed: [DeviceId]
  public var archived: Bool
  /** An own Commit is waiting for the hub's answer. */
  public var pending: Bool
  public init(group: GroupId, session: SessionInfo?, epoch: UInt64, leaves: [DeviceId], disallowed: [DeviceId] = [], archived: Bool, pending: Bool) {
    self.group = group; self.session = session; self.epoch = epoch; self.leaves = leaves; self.disallowed = disallowed; self.archived = archived; self.pending = pending
  }
}
/** A removed device's last envelope the remover accepted (spec 9.0.10): 0 and zeros if none. */
public struct Cut: Equatable {
  public var device: DeviceId
  public var seq: UInt64
  public var hash: Hash32
  public init(device: DeviceId, seq: UInt64, hash: Hash32) { self.device = device; self.seq = seq; self.hash = hash }
}
public enum LogKind: Equatable {
  case commit(bytes: Bytes, recoveryAuth: Bytes?)
  case message(bytes: Bytes)
}
/** One entry of the hub's ordered log (GET /v1/groups/{group}/log, the stream's `log`). */
public struct LogEntry: Equatable {
  public var change: UInt64
  public var group: GroupId
  public var kind: LogKind
  public init(change: UInt64, group: GroupId, kind: LogKind) { self.change = change; self.group = group; self.kind = kind }
}
/** What an application message held (core `Received`). */
public enum ReceivedMessage: Equatable {
  case keys(from: DeviceId, taken: Int, last: Bool)
  case strokePiece(from: DeviceId, board: BoardId, piece: Bytes)
  case workTrail(from: DeviceId, turn: Bytes, number: UInt32, time: UInt64, step: Bytes)
  case recoveryAuth(from: DeviceId)
  /** A second, different key for the sealed keys under a recovery key this device holds one for: `equivocation`. */
  case recoveryAuthConflict(from: DeviceId)
  case dropped
  case newerVersion(from: DeviceId)
}
/** One Commit of a group's log as the hub serves it: its change number, its bytes and, for a join from outside, its RecoveryAuth. */
public typealias PastCommit = (change: UInt64, commit: Bytes, recoveryAuth: Bytes?)
/** What processing a log entry did (core `Processed`). */
public enum Processed: Equatable {
  /** Another device's Commit was merged. `superseded`: the own outbox entry dropped for it, to be built again. */
  case commit(group: GroupId, epoch: UInt64, superseded: UInt64?, removed: Bool)
  case ownCommit
  case observed
  /** An own join from outside lost its epoch to this Commit: `superseded` is its dropped outbox entry, to be built again. */
  case joinSuperseded(group: GroupId, epoch: UInt64, superseded: UInt64?)
  case message(ReceivedMessage)
  case skipped
}
/** How to go on after `processLogEntry` threw (core `log_finding`). */
public enum LogFinding: Equatable { case early, duplicate, badGroup, local }
public struct Joined: Equatable {
  public var group: GroupId
  public var epoch: UInt64
  public var addedBy: DeviceId
  /** The leaves that do not belong (the finding of first contact). Not empty: the device holds the group but opens nothing of it until they are removed. */
  public var offending: [DeviceId]
  public init(group: GroupId, epoch: UInt64, addedBy: DeviceId, offending: [DeviceId] = []) { self.group = group; self.epoch = epoch; self.addedBy = addedBy; self.offending = offending }
}

// ---- stored content (sections 9 and 10): the binding's records of core/swift/src/content.rs ----------------

/** The kind of an envelope. `reserved`: a kind a newer Trommi defines (its number, 8 or above): chained, never applied. */
public enum EnvelopeKind: Equatable { case item, version, answer, request, verdict, register, takeBack, reserved(UInt8) }
/** The timeline an item stands on. */
public enum TimelineRef: Equatable {
  case sessionChat(SessionId)
  case cardChat(ObjectId)
  case board(BoardId)
}
public enum ObjectType: Equatable { case card, note, request, artifact }
public enum ObjectState: Equatable { case open, answered, closed }
/** How pressing a card or a permission request is; the raw value is the header's number. */
public enum Urgency: Int, Equatable { case low = 0, normal, high, critical }
/** What an envelope's header says of the object it belongs to. */
public struct ObjectHeader: Equatable {
  public var objectId: ObjectId
  public var type: ObjectType
  /** The state this envelope gives the object. */
  public var state: ObjectState
  public var urgency: Urgency
  /** When it was answered, in ms; 0 while open. For display only. */
  public var answeredAt: UInt64
  /** A version: the hash of the version before it (zeros for the first). An answer, a take back: the version answered. A verdict: the request. */
  public var objectRef: Hash32
  public init(objectId: ObjectId, type: ObjectType, state: ObjectState = .open, urgency: Urgency = .normal, answeredAt: UInt64 = 0, objectRef: Hash32 = ZERO32) {
    self.objectId = objectId; self.type = type; self.state = state; self.urgency = urgency; self.answeredAt = answeredAt; self.objectRef = objectRef
  }
}
/** The readable header of an envelope. Everything in it is signed by its sender; `time` is a claim. */
public struct EnvelopeHeader: Equatable {
  public var group: GroupId
  /** The session of that group; nil in the room group. */
  public var sessionId: SessionId?
  public var epoch: UInt64
  public var sender: DeviceId
  /** The envelope's number in its sender's chain in this group, from 1; `prev` is the hash of the one before. */
  public var seq: UInt64
  public var prev: Hash32
  /** nil: addressed to nobody. */
  public var recipient: DeviceId?
  public var time: UInt64
  public var kind: EnvelopeKind
  public var push: Bool
  public var timeline: TimelineRef?    // an item
  public var registerId: Bytes?        // a register value
  public var object: ObjectHeader?     // a version, an answer, a request, a verdict, a take back
  public var fileIds: [FileId]
  public init(group: GroupId, sessionId: SessionId? = nil, epoch: UInt64, sender: DeviceId, seq: UInt64, prev: Hash32 = ZERO32, recipient: DeviceId? = nil, time: UInt64,
              kind: EnvelopeKind, push: Bool = false, timeline: TimelineRef? = nil, registerId: Bytes? = nil, object: ObjectHeader? = nil, fileIds: [FileId] = []) {
    self.group = group; self.sessionId = sessionId; self.epoch = epoch; self.sender = sender; self.seq = seq; self.prev = prev; self.recipient = recipient
    self.time = time; self.kind = kind; self.push = push; self.timeline = timeline; self.registerId = registerId; self.object = object; self.fileIds = fileIds
  }
}
/** What the body of an answer, a request, a verdict or a take back binds beside its payload. */
public enum EnvelopeBind: Equatable {
  case answer(objectId: ObjectId, versionHash: Hash32, choices: [String])
  case request(requestId: ObjectId, expiresAt: UInt64)
  case verdict(requestId: ObjectId, requestHash: Hash32, expiresAt: UInt64, allow: Bool)
  case takeBack(objectId: ObjectId, previousHash: Hash32, versionHash: Hash32)
}
/** An object as the envelopes accepted so far leave it. */
public struct ObjectView: Equatable {
  public var objectId: ObjectId
  public var type: ObjectType
  /** The device that wrote its newest version. */
  public var owner: DeviceId
  public var state: ObjectState
  /** The hash of its current version; of a permission request, of the request. */
  public var current: Hash32
  /** The answer in force, while the state is answered or an answer closed the card. */
  public var answer: Hash32?
  public init(objectId: ObjectId, type: ObjectType, owner: DeviceId, state: ObjectState, current: Hash32, answer: Hash32? = nil) {
    self.objectId = objectId; self.type = type; self.owner = owner; self.state = state; self.current = current; self.answer = answer
  }
}
/** A register value that was taken: its name, the sender for a name each device writes for itself, whether it is the current one now. */
public struct RegisterChange: Equatable {
  public var name: String
  public var of: DeviceId?
  public var current: Bool
  public init(name: String, of: DeviceId? = nil, current: Bool) { self.name = name; self.of = of; self.current = current }
}
/** What became of a received envelope. */
public enum EnvelopeOutcome: Equatable {
  /** It passed all nine checks of 9.0.5 and what it carries was taken. */
  case applied
  /** It took its place in its sender's chain and is not applied; `code` says why. */
  case chained
  /** The hub's void record: chained, never applied; `code` is its void code. */
  case void
  /** Fetched out of order: it may be shown, marked as not yet confirmed. */
  case provisional
  /** It consumed nothing; `code` is the check that refused it. */
  case refused
}
/** A received envelope and what became of it (the binding's `ReceivedEnvelope`, without the command gate's flag: the app is a human device). */
public struct ReceivedEnvelope: Equatable {
  public var change: UInt64
  public var hash: Hash32
  public var header: EnvelopeHeader
  public var outcome: EnvelopeOutcome
  /** Why it is not applied (a code of section 16). */
  public var code: String?
  /** A finding to show beside it: `hub-voided-other`. */
  public var finding: String?
  /** The body's JSON; nil when the body did not open. */
  public var payload: Bytes?
  public var bind: EnvelopeBind?
  /** The object after this envelope; nil for items and registers and for an envelope that changed no object. */
  public var objectAfter: ObjectView?
  public var register: RegisterChange?
  /** For an envelope that came through its chain and had been shown as provisional: true when the chain took that
   *  very envelope, false when what was shown is to be dropped (`dropped` says why). */
  public var confirmed: Bool?
  public var dropped: String?
  /** The group's object states and registers were built again in the hub's order: what was read from them is read again. */
  public var replayed: Bool
  public init(change: UInt64, hash: Hash32, header: EnvelopeHeader, outcome: EnvelopeOutcome, code: String? = nil, finding: String? = nil, payload: Bytes? = nil,
              bind: EnvelopeBind? = nil, objectAfter: ObjectView? = nil, register: RegisterChange? = nil, confirmed: Bool? = nil, dropped: String? = nil, replayed: Bool = false) {
    self.change = change; self.hash = hash; self.header = header; self.outcome = outcome; self.code = code; self.finding = finding; self.payload = payload
    self.bind = bind; self.objectAfter = objectAfter; self.register = register; self.confirmed = confirmed; self.dropped = dropped; self.replayed = replayed
  }
}
/**
 * What a human device writes (the binding's `Draft`; an agent's kinds are not here: the app is a human device). A
 * payload is the body's JSON as its writer made it. The device adds group, epoch, number, chain link, time and the
 * recipient the rules ask for, seals and signs.
 */
public enum EnvelopeDraft: Equatable {
  case sessionChat(session: SessionId, payload: Bytes)
  case cardChat(session: SessionId, card: ObjectId, payload: Bytes)
  /** An item of a Scribble Board, in the room group. */
  case boardItem(board: BoardId, payload: Bytes)
  /** `value` is JSON text, nil deletes the name; the lamport and the register id are the device's. */
  case register(group: GroupId, name: String, value: Bytes?)
  /** The first version of a Note, in the room group. */
  case noteFirst(payload: Bytes)
  /** A later version of a Note; it follows the version its payload names as `previous_version_hash`. */
  case noteVersion(object: ObjectId, closed: Bool, payload: Bytes)
  case answer(session: SessionId, object: ObjectId, choices: [String], closes: Bool, payload: Bytes)
  case takeBack(session: SessionId, object: ObjectId, payload: Bytes)
  case verdict(session: SessionId, request: ObjectId, allow: Bool, payload: Bytes)
}
/** What sealing made: the envelope waits in the outbox; its hash and number are final. */
public struct Sealed: Equatable {
  public var outboxId: UInt64
  public var hash: Hash32
  public var seq: UInt64
  public var group: GroupId
  /** The object it belongs to, for the kinds that have one; of a first version, the new object's id. */
  public var objectId: ObjectId?
  public var time: UInt64
  public init(outboxId: UInt64, hash: Hash32, seq: UInt64, group: GroupId, objectId: ObjectId? = nil, time: UInt64) {
    self.outboxId = outboxId; self.hash = hash; self.seq = seq; self.group = group; self.objectId = objectId; self.time = time
  }
}
/** The last envelope of one writer: its number and hash (a frontier, a `heads` entry). */
public struct WriterHead: Equatable {
  public var writer: DeviceId
  public var seq: UInt64
  public var hash: Hash32
  public init(writer: DeviceId, seq: UInt64, hash: Hash32) { self.writer = writer; self.seq = seq; self.hash = hash }
}
/** How this device's chain of one sender compares with a head another device names in its `heads` (9.0.7). */
public enum HeadStanding: Equatable {
  case held
  /** This device holds less (`have` is its last number): if the hub then has nothing more, the finding is `withheld`. */
  case behind(have: UInt64)
  /** This device holds another envelope under the named number. */
  case equivocation
  case unknown
}
/** A finding the device made while it processed a Commit (`equivocation`: a Cut names another envelope than the one accepted). */
public struct ChainFinding: Equatable {
  public var group: GroupId
  public var sender: DeviceId
  public var code: String
  public init(group: GroupId, sender: DeviceId, code: String) { self.group = group; self.sender = sender; self.code = code }
}
/** A Scribble Board, loaded and verified: the frontier now applied, and which of the served items (by their place) are to be added to the snapshot. */
public struct BoardLoaded: Equatable {
  public var frontier: [WriterHead]
  public var fresh: [Int]
  public var covered: [Int]
  public init(frontier: [WriterHead], fresh: [Int], covered: [Int]) { self.frontier = frontier; self.fresh = fresh; self.covered = covered }
}

// ---- joining by link (12.1): the binding's records of core/swift/src/invite.rs ----------------------------

public enum InviteRole: Equatable { case human, agent }
/** The check code both sides show: six of the core's 64 emoji. The person compares them. */
public struct CheckCode: Equatable {
  public var numbers: [UInt8]     // six, 0 to 63: what `inviteConfirm` takes
  public var emoji: [String]
  public var words: [String]
  public init(numbers: [UInt8], emoji: [String], words: [String]) { self.numbers = numbers; self.emoji = emoji; self.words = words }
}
/** A signed part as the hub takes and serves it: the bytes with the signature beside them. */
public struct SignedOffer: Equatable {
  /** `mac`: the Offer's MAC under the link's secret (32 bytes), published and served beside it. */
  public var offer: Bytes, signature: Bytes, mac: Bytes
  public init(offer: Bytes, signature: Bytes, mac: Bytes) { self.offer = offer; self.signature = signature; self.mac = mac }
}
/** What a link names to fetch its Offer by, its deadline checked (`CoreDevice.joinLink`). */
public struct JoinLink: Equatable {
  public var hub: String
  public var room: RoomId
  public var invite: Bytes
  public var expiresAt: UInt64
  public init(hub: String, room: RoomId, invite: Bytes, expiresAt: UInt64) { self.hub = hub; self.room = room; self.invite = invite; self.expiresAt = expiresAt }
}
public struct SignedRequest: Equatable {
  public var request: Bytes, mac: Bytes, signature: Bytes
  public init(request: Bytes, mac: Bytes, signature: Bytes) { self.request = request; self.mac = mac; self.signature = signature }
}
public struct SignedReveal: Equatable {
  public var reveal: Bytes, signature: Bytes
  public init(reveal: Bytes, signature: Bytes) { self.reveal = reveal; self.signature = signature }
}
/** An invite as its inviter opened it. The link holds the invite's secret: handed to the new device only, never logged. */
public struct InviteOpened: Equatable {
  public var inviteId: Bytes
  public var link: String
  public var expiresAt: UInt64
  public var offer: SignedOffer
  public init(inviteId: Bytes, link: String, expiresAt: UInt64, offer: SignedOffer) { self.inviteId = inviteId; self.link = link; self.expiresAt = expiresAt; self.offer = offer }
}
/** What the inviter publishes and shows once it accepted a Request. */
public struct InviteAccepted: Equatable {
  public var newDevice: DeviceId
  public var code: CheckCode
  public var reveal: SignedReveal
  /** The hash of the accepted Request: with the code, what the person's confirmation names. */
  public var requestHash: Hash32
  public init(newDevice: DeviceId, code: CheckCode, reveal: SignedReveal, requestHash: Hash32) { self.newDevice = newDevice; self.code = code; self.reveal = reveal; self.requestHash = requestHash }
}
/** A confirmed invite whose Commit is in the outbox. */
public struct InviteConfirmed: Equatable {
  public var newDevice: DeviceId
  public var role: InviteRole
  /** For an agent device, the session it takes over. */
  public var sessionId: SessionId?
  public var outboxId: UInt64
  public init(newDevice: DeviceId, role: InviteRole, sessionId: SessionId? = nil, outboxId: UInt64) { self.newDevice = newDevice; self.role = role; self.sessionId = sessionId; self.outboxId = outboxId }
}
/** One thing to do next for a device that was committed by link, until all of it is done (the binding's `InviteStep`). */
public enum InviteStep: Equatable {
  /** Nothing yet: a Commit of this device waits for the hub or the log. */
  case wait(invite: Bytes)
  /** The Commit that lets the device in was dropped for another: `inviteRecommit`. */
  case commit(invite: Bytes)
  /** `inviteHandover`; or, for a takeover without history, `inviteForget`. */
  case handover(invite: Bytes, group: GroupId, device: DeviceId)
  /** Claim one KeyPackage of the human device at the hub and call `addToSession`. */
  case addToSession(invite: Bytes, group: GroupId, device: DeviceId)
  /** `foundSession` with this KeyPackage of the agent device and one of every other human device. */
  case foundSession(invite: Bytes, agent: DeviceId, keyPackage: Bytes)
  /** `cleanSession` with these cuts and the agent device as the replacement: one such step for the main session's
   *  group, then one for every live helper session under it. `keyPackage` nil (a helper session): claim a fresh one
   *  of `agent` at the hub. */
  case takeOver(invite: Bytes, group: GroupId, cuts: [Cut], agent: DeviceId, keyPackage: Bytes?)
  /** A takeover has nothing more to do in the groups this device holds: take the Welcomes still waiting and hand
   *  the live helper sessions the hub lists under `session` to `inviteChecked`. */
  case checkHelpers(invite: Bytes, session: SessionId)
  public var invite: Bytes {
    switch self {
    case .wait(let i), .commit(let i), .handover(let i, _, _), .addToSession(let i, _, _), .foundSession(let i, _, _), .takeOver(let i, _, _, _, _), .checkHelpers(let i, _): return i
    }
  }
}
/** A Request as the new device made it, with what its Offer says of the room. */
public struct JoinRequest: Equatable {
  public var inviteId: Bytes
  public var request: SignedRequest
  public var role: InviteRole
  public var inviter: DeviceId
  public var expiresAt: UInt64
  /** For an agent device, the session its invite takes over. */
  public var sessionId: SessionId?
  public var roomId: RoomId
  /** The room epoch the Offer names, and the hash that names the room's state there. */
  public var roomEpoch: UInt64
  public var roomState: Hash32
  public init(inviteId: Bytes, request: SignedRequest, role: InviteRole, inviter: DeviceId, expiresAt: UInt64, sessionId: SessionId? = nil, roomId: RoomId, roomEpoch: UInt64, roomState: Hash32) {
    self.inviteId = inviteId; self.request = request; self.role = role; self.inviter = inviter; self.expiresAt = expiresAt; self.sessionId = sessionId
    self.roomId = roomId; self.roomEpoch = roomEpoch; self.roomState = roomState
  }
}

/**
 * The one stateful object a client holds (core `Device<S: Storage>`). Every operation writes its new state and
 * everything to send in one batch of the store; nothing is handed back for sending except through `outbox()`. Post
 * each outbox entry, then report the hub's answer with `outboxAccepted`, `outboxRefused` or `outboxVoided`; after a
 * restart the same entries are there again and are sent again unchanged. Feed the hub's log and its envelopes in
 * one order, by change number. The binding lets one caller in at a time; `Room` calls it from one queue to keep
 * the order of its operations.
 */
public protocol CoreDevice: CoreSigner {
  // (`id` and the signing of a hub challenge: CoreSigner)
  var room: RoomId? { get }
  var cursor: UInt64 { get }
  /** false once a write met `StoreError.conflict`: another owner wrote; this object stops (core `is_owner`). */
  var isOwner: Bool { get }
  func groups() throws -> [GroupSummary]
  /** Whether this device holds the content key of that group and epoch. The key itself never leaves the core. */
  func holdsKey(group: GroupId, epoch: UInt64) throws -> Bool

  func keyPackagesToUpload(unusedAtHub: Int, nowMs: UInt64) throws -> UInt64?
  func keyPackage(nowMs: UInt64) throws -> Bytes

  /** Founds the room with the recovery code (32 bytes), whose public halves the room group names (8.1, 8.2). */
  func foundRoom(recoveryCode: Bytes, nowMs: UInt64) throws -> RoomId
  /** `keyPackages`: exactly one of the agent device and of every other human device (`incomplete` otherwise). */
  func foundSession(agent: DeviceId, keyPackages: [Bytes], nowMs: UInt64) throws -> SessionId
  func addToSession(group: GroupId, device: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64
  /** Takes agent devices out of the room's enrolled ones; their sessions are stale from then on. (One is enrolled by invite alone.) */
  func removeAgents(_ remove: [DeviceId], nowMs: UInt64) throws -> UInt64
  func removeHumanDevices(_ cuts: [Cut], nowMs: UInt64) throws -> UInt64
  func cleanSession(group: GroupId, cuts: [Cut], replacement: (device: DeviceId, keyPackage: Bytes)?, nowMs: UInt64) throws -> UInt64
  func update(group: GroupId, forced: Bool, nowMs: UInt64) throws -> UInt64?
  func archive(group: GroupId) throws

  /** A Welcome into a group of the room this device already belongs to (a session it was added to). A device that
   *  joins by invite uses `joinInvited`. */
  func joinWelcome(_ welcome: Bytes, room: RoomId, committer: DeviceId?, nowMs: UInt64) throws -> Joined
  func processLogEntry(_ entry: LogEntry) throws -> Processed
  /**
   * Learns the past of a group this device came into later (by link, or by a Welcome into a session group), from its
   * public history, in steps (PastWalk.swift): `learnStart` with the founding GroupInfo (epoch 0), `learnSlice` with
   * the next Commits of the group's log in the hub's order (at most 256 and 16 MiB a slice: `too-large`, and the walk
   * stands), `learnFinish`, which alone compares with the device's own state and writes. The room group first, then
   * main sessions, then helper sessions (`room-behind`, `group-behind` otherwise). Taken only if it arrives at this
   * device's own state (`bad-group`, and nothing is written). The walk is held in memory only, one at a time: any
   * refusal but `too-large` ends it (`not-found` after), and so does a restart. `learnFinish`: how many epochs were
   * recorded; 0 when there was nothing to learn. Envelopes of those epochs, `group-behind` until then, are handed
   * to `receiveEnvelope` again afterwards, `ordered`, in the hub's order.
   */
  func learnStart(group: GroupId, founding: Bytes) throws -> LearnProgress
  func learnSlice(group: GroupId, commits: [PastCommit]) throws -> LearnProgress
  func learnFinish(group: GroupId) throws -> UInt64
  func learnAbandon(group: GroupId)
  func logFinding(_ error: Error) -> LogFinding

  func sendHandover(group: GroupId, recipient: DeviceId) throws -> [UInt64]
  /** `epoch-full` when the epoch took its share of pieces: an update of the room group is due first (`update`, forced). */
  func sendStrokePiece(board: BoardId, piece: Bytes) throws -> UInt64
  /**
   * A stroke piece the hub only passed on (the stream's `relay`, 7.2): in no log, with no change number, so the
   * cursor stays. nil for a message this device cannot open or of a group it is no leaf of; `bad-format` for a
   * message that opens to anything but a stroke piece.
   */
  func receiveRelay(group: GroupId, message: Bytes, nowMs: UInt64) throws -> ReceivedMessage?

  func outbox() -> [OutboxEntry]
  /** The hub accepted the entry: it goes. An accepted Commit is NOT merged here: it takes effect when
   *  `processLogEntry` reaches it in the log, at its place among the entries of every group. */
  func outboxAccepted(_ id: UInt64, change: UInt64?) throws
  /**
   * The hub refused the entry with a code of its table (`CoreTools.isFinalRefusal`). The core undoes what the entry
   * was for, or holds a Commit back until the log decided it (`epoch-taken`). An ENVELOPE's entry stays whatever
   * the code: the device signed that number and sends the same bytes again (9.0.8); it goes only by `outboxVoided`
   * or `envelopeAbandon`.
   */
  func outboxRefused(_ id: UInt64, code: String) throws
  /** The hub refused the envelope with `voided: true` and keeps its number as a void record: the entry goes. */
  func outboxVoided(_ id: UInt64) throws
  /** Gives up on an envelope the hub refused without taking its number, for a device that is out of the group
   *  (`not-member`, `removed-sender`). The number stays used. */
  func envelopeAbandon(_ id: UInt64) throws
  /** Ends the device: it answers no more and lets go of its store. */
  func close()

  // stored content (section 9)
  /**
   * Seals and signs the next envelope of this device's chain in the draft's group and puts it into the outbox.
   * Refused before anything is signed, without using a number: what the hub would refuse, `busy` while a Commit
   * of this device in the group waits for the hub, `gone` in an archived session, `not-found` for an unknown object.
   */
  func seal(_ draft: EnvelopeDraft, files: [FileId], nowMs: UInt64) throws -> Sealed
  /**
   * Takes one envelope from the hub and writes what follows from it in one write. `ordered`: it comes at its place
   * (the changes route, the stream); above the cursor it moves the cursor, except when refused with `group-behind`
   * for a group this device is a leaf of (process the log first). At or below the cursor only the next envelope
   * of its sender's chain is new (`replay` otherwise). Not `ordered`: fetched out of order (a page of a Chat, a
   * board's items, or one read again for display): the chain is not touched; the outcome is what the chain made
   * of that very envelope if it holds it, else at most `provisional`. Throws only for a failure of this device
   * or for bytes that are no envelope at all.
   */
  func receiveEnvelope(_ bytes: Bytes, change: UInt64, ordered: Bool, voidCode: String?, nowMs: UInt64) throws -> ReceivedEnvelope
  /** The current value (JSON) of a shared register name in a group by the rule of 9.3.2; nil: none or deleted. */
  func register(group: GroupId, name: String) throws -> Bytes?
  /** The Cut of a device in a group for a Commit that removes it: its last envelope this device accepted there. */
  func cutOf(group: GroupId, device: DeviceId) throws -> Cut
  /** The value of the register `heads` to write in `group` now (9.0.7), as JSON; nil when nothing is due. */
  func headsDue(group: GroupId, nowMs: UInt64) throws -> Bytes?
  /** The `heads` that `writer` wrote in `group`, compared with this device's own chains there, per named sender. */
  func compareHeads(group: GroupId, writer: DeviceId) throws -> [(sender: DeviceId, standing: HeadStanding)]
  /** The findings made while Commits were processed, until `findingsRead` clears them. */
  func findings() throws -> [ChainFinding]
  func findingsRead() throws
  /**
   * Verifies a Scribble Board against what this device holds: the newest snapshot register, the Cuts of the room
   * group and every writer's chain after the snapshot's frontier. `served`: the board's items as the hub gave
   * them. `not-found` without a snapshot; refused with `withheld`, `hash-mismatch`, `equivocation`, `replay`,
   * `removed-sender`, `gap`, `chain-break`, `forbidden`.
   */
  func boardLoad(board: BoardId, served: [WriterHead]) throws -> BoardLoaded

  // joining by link (12.1), the inviting side
  /** A new invite, for a human device or an agent device (which founds a new main session or, with `session`,
   *  takes that one over). `app` is the app's origin, `hub` the hub's canonical address. It lives ten minutes. */
  func inviteOpen(role: InviteRole, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> InviteOpened
  /** The first valid Request of an invite: the Reveal to publish and the code to show. Asked again with the same Request, the same. */
  func inviteAccept(invite: Bytes, request: SignedRequest, nowMs: UInt64) throws -> InviteAccepted
  /**
   * The person compared the six emoji. `matches` false: the invite is burned, nil. True: `numbers` and
   * `requestHash` are what this device showed; the core computes both again and commits the new device only if
   * they are the same (`code-not-confirmed`). The Commit is in the outbox; `inviteSteps` says what follows.
   */
  func inviteConfirm(invite: Bytes, numbers: [UInt8], requestHash: Hash32, matches: Bool, nowMs: UInt64) throws -> InviteConfirmed?
  /** What is left to do for every device this one committed by link, read from the state of the groups (the same
   *  after a restart). An invite with nothing left is finished and listed no more. */
  func inviteSteps() throws -> [InviteStep]
  /** Sends the key handover of the invite's first `handover` step; `busy` when none is to be sent now. */
  func inviteHandover(invite: Bytes) throws -> [UInt64]
  func inviteRecommit(invite: Bytes, nowMs: UInt64) throws -> UInt64
  /** A takeover without history: no handover is sent for this invite. Only the handover steps go. */
  func inviteForget(invite: Bytes) throws
  /** Answers `checkHelpers`: the groups of the live helper sessions the hub lists under the session taken over.
   *  `group-behind` when this device does not hold one of them yet; `busy` when another step is left. */
  func inviteChecked(invite: Bytes, helpers: [GroupId]) throws

  // joining by link (12.1), the new device: the joining side's state is kept in the device's store
  /** Checks the Offer served for `link` and answers it with a fresh KeyPackage. A device joins one room, once (`room-exists`). */
  /** What to fetch a link's Offer by, before anything else: its deadline checked, `room-exists` for a device in a room. */
  func joinLink(_ link: String, nowMs: UInt64) throws -> JoinLink
  /** `offer` with the MAC the hub serves beside it: a missing or wrong one, or a changed deadline, is `bad-invite`. */
  func joinRequest(link: String, offer: SignedOffer, nowMs: UInt64) throws -> JoinRequest
  /** Checks the Reveal against this device's Request; the code to show. Nothing of a Reveal that does not check is shown. */
  func joinReveal(_ reveal: SignedReveal) throws -> CheckCode
  /** An invited agent device starts following the room group from the GroupInfo of the epoch its Offer names. */
  func joinObserve(groupInfo: Bytes) throws
  /** An invited human device joins the room group from the Welcome that answers its Request (the Offer's room,
   *  committed by the inviter, for the Request's KeyPackage: read from the stored invite). */
  func joinInvited(_ welcome: Bytes, nowMs: UInt64) throws -> Joined

  // recovery (section 8)
  /** Whether this device holds the key that authenticates the room's sealed keys under the code in force (8.3). */
  func holdsRecoveryMac() throws -> Bool
  /** Whether the content key of that epoch is vouched for; content of an unconfirmed epoch is shown as such (8.5). */
  func keyIsConfirmed(group: GroupId, epoch: UInt64) throws -> Bool
  /** Sends that key to one human device, or to all with nil (7.4); nil while an own room Commit is pending. */
  func sendRecoveryAuth(recipient: DeviceId?) throws -> UInt64?
  /** A new code to replace the one in force (8.6); nothing is stored or sent until `replaceCode`. */
  func newRecoveryCode(current: Bytes) throws -> Bytes
  /** Puts that new code in force: one `recoveryCode` entry whose fifth part is `account` (the JSON of the hub's `account` object). */
  func replaceCode(current: Bytes, account: Bytes, nowMs: UInt64) throws -> UInt64
}

// ---- the stateless modules ------------------------------------------------------------------------------

/** The two keys of one way in to the account: of the password, or of the Emergency Kit's words. Both are secrets. */
public struct PasswordKeys: Equatable {
  /** What the hub checks the login with (base64url). */
  public var authKey: String
  /** Opens the account's sealed copy of the recovery code. */
  public var wrapKey: Bytes
  public init(authKey: String, wrapKey: Bytes) { self.authKey = authKey; self.wrapKey = wrapKey }
}
/**
 * What names an account where its Emergency Kit's keys are derived (spec/v1.md 8.8.2): its e-mail address, or, for an
 * account without one, its account id in the canonical text. An account with an e-mail is always named by the e-mail
 * here, although its kit shows its id as well: the two give unrelated keys.
 */
public enum AccountName: Equatable {
  case email(String)
  case id(String)
}
/** Which sealed copy of the recovery code (core `account::Way`), with the key that seals it. */
public enum AccountWay: Equatable {
  case password(wrapKey: Bytes)
  case kit(wrapKey: Bytes)
  case passkey(prf: Bytes, credentialId: Bytes)
}
/** An invite link, taken apart. The link's secret is not among the parts. */
public struct InviteLinkParts: Equatable {
  public var app: String
  public var hub: String
  public var room: RoomId
  public var invite: Bytes
  /** The link's deadline (ms), its fifth part. */
  public var expiresAt: UInt64
  public init(app: String, hub: String, room: RoomId, invite: Bytes, expiresAt: UInt64) { self.app = app; self.hub = hub; self.room = room; self.invite = invite; self.expiresAt = expiresAt }
}
/** One item of a Scribble Board for `boardReduce`: the sender and number of its signed header, and its body. */
public struct BoardItemBody: Equatable {
  public var sender: DeviceId
  public var seq: UInt64
  public var payload: Bytes
  public init(sender: DeviceId, seq: UInt64, payload: Bytes) { self.sender = sender; self.seq = seq; self.payload = payload }
}
public struct SealedFile: Equatable {
  public var fileId: FileId
  public var fileKey: Bytes
  public var sha256: Bytes
  public var stored: Bytes
  public init(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) { self.fileId = fileId; self.fileKey = fileKey; self.sha256 = sha256; self.stored = stored }
}
public struct ShareLinkParts: Equatable {
  public var link: String
  public var shareId: Bytes
  public var secretHash: Bytes
  public init(link: String, shareId: Bytes, secretHash: Bytes) { self.link = link; self.shareId = shareId; self.secretHash = secretHash }
}
/** One step of the core's own check of itself. */
public struct SelfTestStep: Equatable {
  public var suite: String
  public var name: String
  public var ok: Bool
  public var micros: UInt64
  public var detail: String
  public init(suite: String, name: String, ok: Bool, micros: UInt64, detail: String = "") { self.suite = suite; self.name = name; self.ok = ok; self.micros = micros; self.detail = detail }
}

/**
 * The core without a device: making and opening one, and the modules that hold no state.
 */
public protocol CoreTools: AnyObject {
  /** The version of the core this library was built from (core `VERSION`). */
  var version: String { get }
  /** The core's check of itself through this binding, both cipher suites (core/swift `self_test()`). */
  func selfTest() -> [SelfTestStep]

  /** A new device over an empty store (core `Device::create`), and an existing one (`Device::open`). */
  func createDevice(store: CoreStorage) throws -> CoreDevice
  func openDevice(store: CoreStorage) throws -> CoreDevice

  // account (8.8)
  func normaliseEmail(_ email: String) throws -> String
  func checkPassword(_ password: String) throws
  func passwordKeys(email: String, password: String, kdf: String?) throws -> PasswordKeys
  /** The two keys of the Emergency Kit's words, as typed, for the account `name` names (core `kit_keys_for`). */
  func kitKeysFor(_ name: AccountName, words: String) throws -> PasswordKeys
  /**
   * An account id as a person typed it, in its one text form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lower case);
   * `bad-format` for anything else (core `account_id_parse`). The id is a public value.
   */
  func accountIdParse(_ text: String) throws -> String
  func generateKitWords() throws -> String
  func parseKitWords(_ text: String) throws -> String
  func generateRecoveryCode() throws -> Bytes
  func formatRecoveryCode(_ code: Bytes) -> String
  func parseRecoveryCode(_ text: String) throws -> Bytes
  func sealCode(_ code: Bytes, room: RoomId, way: AccountWay) throws -> Bytes
  /** `wrong-recovery` when the kit's copy does not open, `wrong-login` for the others. */
  func openCode(_ sealed: Bytes, room: RoomId, way: AccountWay) throws -> Bytes

  // hub_auth (12.3)
  func canonicalHub(_ text: String) throws -> String
  /** Whether a code the hub answered an outbox entry with is its last word on those bytes (else: send again). */
  func isFinalRefusal(_ code: String) -> Bool

  // invite (12.1): what needs no device
  func parseInviteLink(_ text: String) throws -> InviteLinkParts
  /**
   * A link held against the clock, without a device: `invite-expired` more than the tolerance past its deadline,
   * `bad-invite` for a deadline further ahead than any invite lives. For refusing a pasted link before any request.
   */
  func inviteLinkCheck(_ text: String, nowMs: UInt64) throws -> InviteLinkParts
  /** How long an invite of that kind lives (ms): 10 minutes for a device, 15 for an agent. */
  func inviteLifeMs(_ role: InviteRole) -> UInt64
  /** The clock difference a deadline is given (ms). */
  func inviteClockToleranceMs() -> UInt64
  /** The core's 64 emoji of the check code with their words, in the order of their numbers (`invite::CHECK_EMOJI`). */
  func checkEmoji() -> [(emoji: String, word: String)]

  // the Scribble Board (10.7, 10.8)
  /**
   * The board's merge, without state: the board that `items` make of a snapshot file (decompressed JSON; nil: an
   * empty board), written as the snapshot file's JSON for `frontier`. Items the snapshot covers are skipped; one
   * malformed item refuses the whole (`bad-format`); an item of a newer version makes the result `newer-version`.
   */
  func boardReduce(snapshot: Bytes?, snapshotFrontier: [WriterHead], items: [BoardItemBody], frontier: [WriterHead]) throws -> Bytes

  // files (11)
  func encryptFile(_ plain: Bytes) throws -> SealedFile
  func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes
  /** The link carries the file's key and the hash of its stored bytes after the # (11.5). */
  func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts

  // push (15.2)
  func generatePushKey() throws -> Bytes

  // recovery (section 8). `hub` is signed in as the recovery key (`recoverySigner`) unless a call says otherwise:
  // the calls read from it what the core checks, and post what the core built.
  func recoverySigner(code: Bytes) throws -> CoreSigner
  /**
   * Signing in on a new device with the code, first step (8.4, 8.5): checks the room the hub serves and joins the
   * room group from outside, authorised by the recovery key. Until it returns the device is in no room, and a
   * failure leaves it so. Returns a recovery key whose link to the code it replaced the hub did not serve (the
   * content of the older codes' time stays closed), or nil.
   */
  func joinRoomWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> Bytes?
  /**
   * Second step, for a device that is in the room group: joins every live session group it is not a leaf of yet the
   * same way, main sessions before helper sessions. `hub` may be signed in as the device itself. `notJoined`: the
   * sessions left out, each with its code. `again`: one of them may be joined by calling this once more (the hub
   * did not answer, a join waits in the outbox, a Commit came in between); until then the caller keeps the code.
   */
  func joinSessionsWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> (notJoined: [(group: GroupId, code: String)], again: Bool)
  /**
   * The whole recovery when every device is lost (8.7), on a new device that is in no room: opens the recovery at
   * the hub (the room takes nothing else meanwhile), checks the room, and asks `confirm` with the human devices it
   * will remove (false: nothing is published, `cancelled`). Then it reads the removed devices' chains, asks
   * `account` for the account's new sealed copies of the new code it hands over (the JSON of the hub's `account`
   * object), builds the joins, the removals and the replacement of the code, and posts them through the recovery's
   * routes; the hub publishes all of it at the end or none of it. A failure throws, the recovery is dropped at the
   * hub, and the device is in no room. `removed`: the human devices that are out.
   */
  func recoverWithCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64, confirm: @escaping ([DeviceId]) async -> Bool,
                       account: @escaping (Bytes) async throws -> Bytes) async throws -> (removed: [DeviceId], missingLink: Bytes?)
}

/** Who signs a hub challenge (12.3): a device, or the recovery key while it joins. */
public protocol CoreSigner: AnyObject {
  var id: DeviceId { get }
  /** The `HubAuth` bytes and the signature, as POST /v1/rooms/{room}/tokens takes them. */
  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes)
}

/** The core this process uses: set once at launch (the app: `LiveCore()`), read by `Room` and the account calls. */
public enum Core {
  public static var tools: CoreTools {
    get { lock.lock(); defer { lock.unlock() }; guard let t = installed else { fatalError("Core.tools is not set: install the core at launch") }; return t }
    set { lock.lock(); installed = newValue; lock.unlock() }
  }
  public static var isInstalled: Bool { lock.lock(); defer { lock.unlock() }; return installed != nil }
  private static var installed: CoreTools?
  private static let lock = NSLock()
}

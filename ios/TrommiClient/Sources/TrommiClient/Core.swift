// Core.swift: trommi-core as Swift sees it. One file, one call for one call of core/README.md ("API at a glance"):
// `CoreDevice` is `Device`, `CoreStorage` is `Storage`, `CoreTools` is the stateless modules (account, invite, files,
// hub_auth, push, envelope reading). Bytes, ids and plain structs cross the edge, as in the core.
//
// Nothing here computes. The implementation is TrommiCoreLive (UniFFI over the Rust library); the tests use a core
// that seals nothing (Tests/TrommiClientTests/FakeCore.swift). Every call that needs time takes `nowMs`.
//
// What the core has today and what is still to come is said per block: "built" is in core/src today, "awaited" is
// spec/v2.md behaviour that core/README.md lists as in work or planned; the names of awaited calls are this file's
// guess and are corrected when the binding lands (core/swift on branch v2-bindings).
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

/** The board of "All desks" (spec/v2.md 10.1). */
public let ALL_DESKS_BOARD: BoardId = (try? unhex("616c6c2d6465736b7300000000000009")) ?? []

/** A refusal of the core: `code` is the stable code of spec/v2.md section 16 (core `Error::code()`). */
public typealias CoreError = TrommiError

// ---- store (core `store`, section 13.2): built ----------------------------------------------------------

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

// ---- device (core `device`, sections 3 to 7, 13): built for groups and messages --------------------------

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
/** One entry of the hub's ordered log (GET /v2/groups/{group}/log, the stream's `log`). */
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
  case dropped
  case newerVersion(from: DeviceId)
}
/** What processing a log entry did (core `Processed`). */
public enum Processed: Equatable {
  /** Another device's Commit was merged. `superseded`: the own outbox entry dropped for it, to be built again. */
  case commit(group: GroupId, epoch: UInt64, superseded: UInt64?, removed: Bool)
  case ownCommit
  case observed
  case message(ReceivedMessage)
  case skipped
}
/** How to go on after `processLogEntry` threw (core `log_finding`). */
public enum LogFinding: Equatable { case early, duplicate, badGroup, local }
public struct Joined: Equatable {
  public var group: GroupId
  public var epoch: UInt64
  public var addedBy: DeviceId
  public init(group: GroupId, epoch: UInt64, addedBy: DeviceId) { self.group = group; self.epoch = epoch; self.addedBy = addedBy }
}

// ---- stored content (core `envelope`, `chain`, `objects`, `registers`, section 9): awaited on the device --

/** The readable header of an envelope, as the model needs it (spec/v2.md section 9). */
public struct EnvelopeHeader: Equatable {
  public var kind: Int                 // KIND
  public var push: Bool
  public var group: GroupId
  public var epoch: UInt64
  public var sender: DeviceId
  public var seq: UInt64
  public var recipient: DeviceId?      // nil: zeros
  public var time: UInt64
  public var timelineKind: Int?        // item: TIMELINE
  public var timelineScope: Int?       // item: TIMELINE_SCOPE
  public var timelineRef: Bytes?       // item: object id, session id or board id
  public var registerId: Bytes?        // register
  public var objectId: ObjectId?       // version, answer, request, verdict, take back
  public var objectType: Int?
  public var objectState: Int?
  public var urgency: Int?
  public var answeredAt: UInt64?
  public var objectRef: Hash32?
  public var fileIds: [FileId]
  public init(kind: Int, push: Bool = false, group: GroupId, epoch: UInt64, sender: DeviceId, seq: UInt64, recipient: DeviceId? = nil, time: UInt64,
              timelineKind: Int? = nil, timelineScope: Int? = nil, timelineRef: Bytes? = nil, registerId: Bytes? = nil, objectId: ObjectId? = nil,
              objectType: Int? = nil, objectState: Int? = nil, urgency: Int? = nil, answeredAt: UInt64? = nil, objectRef: Hash32? = nil, fileIds: [FileId] = []) {
    self.kind = kind; self.push = push; self.group = group; self.epoch = epoch; self.sender = sender; self.seq = seq; self.recipient = recipient
    self.time = time; self.timelineKind = timelineKind; self.timelineScope = timelineScope; self.timelineRef = timelineRef; self.registerId = registerId
    self.objectId = objectId; self.objectType = objectType; self.objectState = objectState; self.urgency = urgency; self.answeredAt = answeredAt
    self.objectRef = objectRef; self.fileIds = fileIds
  }
}
/** The bind of a body (spec/v2.md section 9), for the kinds that have one. */
public enum EnvelopeBind: Equatable {
  case none
  case answer(objectId: ObjectId, versionHash: Hash32, choices: [String])
  case request(requestId: ObjectId, expiresAt: UInt64)
  case verdict(requestId: ObjectId, requestHash: Hash32, expiresAt: UInt64, allow: Bool)
  case takeBack(objectId: ObjectId, previousHash: Hash32, versionHash: Hash32)
}
/** How an envelope stands after the receiver checks of 9.0.5 and 9.0.6. */
public enum EnvelopeStanding: Equatable {
  /** All nine checks passed in chain order. */
  case accepted
  /** Fetched out of order (a page of a Chat, an object): shown, and no command acts on it, until its chain arrives. */
  case provisional
  /** Chained, never applied: the code of the check that failed (7, 8 or 9), or a void record's code. */
  case notApplied(code: String)
}
public struct ReceivedEnvelope: Equatable {
  public var header: EnvelopeHeader
  public var hash: Hash32
  public var standing: EnvelopeStanding
  public var bind: EnvelopeBind
  /** The body's JSON; nil when it did not open (pruned, no key, void). */
  public var payload: Bytes?
  /** The sender's role in that group and epoch: ROLE.HUMAN or ROLE.AGENT. */
  public var senderRole: Int
  public init(header: EnvelopeHeader, hash: Hash32, standing: EnvelopeStanding, bind: EnvelopeBind = .none, payload: Bytes?, senderRole: Int) {
    self.header = header; self.hash = hash; self.standing = standing; self.bind = bind; self.payload = payload; self.senderRole = senderRole
  }
}
/** What to store (core `envelope::Draft`): the device adds group, epoch, number, chain link and time, seals and signs. */
public enum EnvelopeDraft: Equatable {
  /** The recipient is the session's agent device (a helper session: its opener), or a card's owner: the core names it. */
  case sessionChat(session: SessionId, payload: Bytes, files: [FileId])
  case cardChat(card: ObjectId, payload: Bytes, files: [FileId])
  case boardItem(board: BoardId, payload: Bytes, files: [FileId])
  /** `value` is JSON or nil (delete); the device keeps the register id of the name and the lamport. */
  case register(group: GroupId, name: String, value: Bytes?)
  /** A Note's first version, or with `object` a later one. `closed`: the Note is deleted. */
  case note(object: ObjectId?, payload: Bytes, closed: Bool, files: [FileId])
  case answer(object: ObjectId, choices: [String], closes: Bool, payload: Bytes, files: [FileId])
  case takeBack(object: ObjectId, payload: Bytes)
  case verdict(request: ObjectId, allow: Bool, payload: Bytes)
}
/** What `sendEnvelope` made. */
public struct SentEnvelope: Equatable {
  public var outboxId: UInt64
  public var hash: Hash32
  public var seq: UInt64
  /** The object a first version or a request made (9: derived from group, sender and number). */
  public var objectId: ObjectId?
  public init(outboxId: UInt64, hash: Hash32, seq: UInt64, objectId: ObjectId? = nil) { self.outboxId = outboxId; self.hash = hash; self.seq = seq; self.objectId = objectId }
}
/** How an envelope came to the device: decides which of the checks of 9.0.5 can be made (core `chain::Mode`). */
/**
 * `live` and `catchUp`: in the hub's order, the chain advances. `page`: fetched out of order (a page of a Chat, an
 * object, or an item at or below the device's cursor read again for display): nothing advances; the standing is
 * `accepted` when the chain already holds that envelope under its number, else `provisional` (9.0.6).
 */
public enum EnvelopeSource: Equatable { case live, catchUp, page }

/**
 * The one stateful object a client holds (core `Device<S: Storage>`). Every operation writes its new state and
 * everything to send in one batch of the store; nothing is handed back for sending except through `outbox()`. Post
 * each outbox entry, then report the hub's answer with `outboxAccepted` or `outboxRefused`; after a restart the same
 * entries are there again and are sent again unchanged. Feed the hub's log to `processLogEntry` in the hub's order.
 * Not thread-safe: `Room` calls it from one actor.
 */
public protocol CoreDevice: CoreSigner {
  // built (`id` and the signing of a hub challenge: CoreSigner)
  var room: RoomId? { get }
  var cursor: UInt64 { get }
  /** false once a write met `StoreError.conflict`: another owner wrote; this object stops (core `is_owner`). */
  var isOwner: Bool { get }
  func groups() throws -> [GroupSummary]
  func contentKey(group: GroupId, epoch: UInt64) throws -> Bytes

  func keyPackagesToUpload(unusedAtHub: Int, nowMs: UInt64) throws -> UInt64?
  func keyPackage(nowMs: UInt64) throws -> Bytes

  /** Founds the room with the recovery code (32 bytes), whose public halves the room group names (8.1, 8.2). */
  func foundRoom(recoveryCode: Bytes, nowMs: UInt64) throws -> RoomId
  func foundSession(agent: DeviceId, keyPackages: [Bytes], nowMs: UInt64) throws -> SessionId
  func addHumanDevice(_ device: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64
  func addToSession(group: GroupId, device: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64
  func changeAgents(enrol: [DeviceId], remove: [DeviceId], nowMs: UInt64) throws -> UInt64
  func removeHumanDevices(_ cuts: [Cut], nowMs: UInt64) throws -> UInt64
  func cleanSession(group: GroupId, cuts: [Cut], replacement: (device: DeviceId, keyPackage: Bytes)?, nowMs: UInt64) throws -> UInt64
  func update(group: GroupId, forced: Bool, nowMs: UInt64) throws -> UInt64?
  func archive(group: GroupId) throws

  func joinWelcome(_ welcome: Bytes, room: RoomId, committer: DeviceId?, nowMs: UInt64) throws -> Joined
  func processLogEntry(_ entry: LogEntry) throws -> Processed
  func logFinding(_ error: Error) -> LogFinding

  func sendHandover(group: GroupId, recipient: DeviceId) throws -> [UInt64]
  func sendStrokePiece(board: BoardId, piece: Bytes) throws -> UInt64
  /**
   * awaited: a message the hub only passed on (the stream's `relay`: a piece of a stroke being drawn, 7.2). It has
   * no change number and is not in the log, so it cannot go through `processLogEntry`.
   */
  func processRelay(group: GroupId, bytes: Bytes) throws -> ReceivedMessage

  func outbox() -> [OutboxEntry]
  func outboxAccepted(_ id: UInt64, change: UInt64?) throws
  /**
   * Only for the hub's last word on those bytes (`CoreTools.isFinalRefusal`); for anything else the entry stays
   * and is sent again unchanged. `voided`: the hub kept the envelope's number as a void record (9.0.8).
   */
  func outboxRefused(_ id: UInt64, code: String, voided: Bool) throws
  /** Ends the device: it answers no more and lets go of its store. */
  func close()

  // awaited: section 9 on the device (core/README.md: "envelopes … are being wired in")
  /** Seals and signs the next envelope of this device's chain in the draft's group and puts it into the outbox. */
  func sendEnvelope(_ draft: EnvelopeDraft, nowMs: UInt64) throws -> SentEnvelope
  /** The receiver checks of 9.0.5 / 9.0.6 on one envelope, the chain, object and register state written in one batch. */
  func receiveEnvelope(_ bytes: Bytes, change: UInt64, source: EnvelopeSource, voidCode: String?, nowMs: UInt64) throws -> ReceivedEnvelope
  /** The current value (JSON) of a register name in a group by the rule of 9.3.2; nil: none or deleted. */
  func register(group: GroupId, name: String) throws -> Bytes?
  /** The accepted cut of a device in a group: its last envelope this device accepted (for removing it). */
  func cut(group: GroupId, device: DeviceId) throws -> Cut

  // awaited: joining by link on the device (12.1; core `invite` is built, its wiring into the device is not)
  /** A new invite for a human device (role 1) or an agent device (role 2); the link to hand over and the Offer to post. */
  func openInvite(role: Int, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> OpenedInvite
  /** The first valid Request of an invite: the Reveal to publish and the six numbers to compare. */
  func acceptInviteRequest(invite: Bytes, request: Bytes, mac: Bytes, signature: Bytes, nowMs: UInt64) throws -> InviteAccepted
  /** The human confirmed the six emoji: commits the Add (or the agents change) and sends the key handover; the Commit's outbox id. */
  func confirmInvite(invite: Bytes, numbers: [UInt8], nowMs: UInt64) throws -> UInt64
  /** "They don't match": the invite is burned. */
  func burnInvite(invite: Bytes) throws

  // awaited: recovery (section 8; core `recovery` is planned)
  /** Replaces the recovery code (8.6): the new code's 32 bytes; the Commit is in the outbox. */
  func replaceRecoveryCode(nowMs: UInt64) throws -> Bytes
}

public struct OpenedInvite: Equatable {
  public var invite: Bytes        // the invite id
  public var link: String
  public var offer: Bytes
  public var offerSignature: Bytes
  public var expiresAt: UInt64
  public init(invite: Bytes, link: String, offer: Bytes, offerSignature: Bytes, expiresAt: UInt64) {
    self.invite = invite; self.link = link; self.offer = offer; self.offerSignature = offerSignature; self.expiresAt = expiresAt
  }
}
public struct InviteAccepted: Equatable {
  public var reveal: Bytes
  public var revealSignature: Bytes
  public var numbers: [UInt8]     // six, 0 to 63
  public var newDevice: DeviceId
  public init(reveal: Bytes, revealSignature: Bytes, numbers: [UInt8], newDevice: DeviceId) {
    self.reveal = reveal; self.revealSignature = revealSignature; self.numbers = numbers; self.newDevice = newDevice
  }
}

// ---- the stateless modules ------------------------------------------------------------------------------

public struct PasswordKeys: Equatable {
  /** What the hub checks the login with (base64url). */
  public var authKey: String
  /** Opens the account's sealed copy of the recovery code. */
  public var wrapKey: Bytes
  public init(authKey: String, wrapKey: Bytes) { self.authKey = authKey; self.wrapKey = wrapKey }
}
/** Which sealed copy of the recovery code (core `account::Way`). */
public enum AccountWay: Equatable {
  case password(wrapKey: Bytes)
  case kit(words: String)
  case passkey(prf: Bytes, credentialId: Bytes)
}
/** The joining side of an invite (core `invite::Joiner`), kept as its stored bytes between the steps. */
public struct JoinRequest: Equatable {
  public var joiner: Bytes
  public var invite: Bytes
  public var hub: String
  public var room: RoomId
  /** The Offer's role (ROLE) and its inviter: a Welcome is accepted only if that device committed it (12.1.5). */
  public var role: Int
  public var inviter: DeviceId
  public var request: Bytes
  public var mac: Bytes
  public var signature: Bytes
  public init(joiner: Bytes, invite: Bytes, hub: String, room: RoomId, role: Int, inviter: DeviceId, request: Bytes, mac: Bytes, signature: Bytes) {
    self.joiner = joiner; self.invite = invite; self.hub = hub; self.room = room; self.role = role; self.inviter = inviter
    self.request = request; self.mac = mac; self.signature = signature
  }
}
public struct InviteLinkParts: Equatable {
  public var hub: String
  public var room: RoomId
  public var invite: Bytes
  public init(hub: String, room: RoomId, invite: Bytes) { self.hub = hub; self.room = room; self.invite = invite }
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
 * The core without a device: making and opening one, and the modules that hold no state. All built in core/src
 * except where a line says awaited.
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
  func kitAuthKey(email: String, words: String) throws -> String
  func generateKitWords() throws -> String
  func parseKitWords(_ text: String) throws -> String
  func generateRecoveryCode() throws -> Bytes
  func formatRecoveryCode(_ code: Bytes) -> String
  func parseRecoveryCode(_ text: String) throws -> Bytes
  func sealCode(_ code: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes
  func openCode(_ sealed: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes

  // hub_auth (12.3)
  func canonicalHub(_ text: String) throws -> String
  /** Whether a code the hub answered an outbox entry with is its last word on those bytes (else: send again). */
  func isFinalRefusal(_ code: String) -> Bool

  // invite, the joining side (12.1)
  func parseInviteLink(_ text: String) throws -> InviteLinkParts
  func inviteRequest(link: String, offer: Bytes, offerSignature: Bytes, device: CoreDevice, nowMs: UInt64) throws -> JoinRequest
  /** Checks the Reveal against invite, request hash and commitment; the six numbers 0 to 63. */
  func inviteReveal(joiner: Bytes, reveal: Bytes, signature: Bytes) throws -> [UInt8]
  /** The 64 emoji and their words (core `invite::CHECK_EMOJI`). */
  func checkEmoji(_ numbers: [UInt8]) -> [(emoji: String, word: String)]

  // files (11)
  func encryptFile(_ plain: Bytes) throws -> SealedFile
  func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes
  /** The link carries the file's key and the hash of its stored bytes after the # (11.5). */
  func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts

  // push (15.2)
  func generatePushKey() throws -> Bytes

  // awaited: recovery (section 8). Signing in on a new device with the code: a join from outside into the room
  // group and every live session group, authorised by the recovery key, published all or nothing (8.4, 8.7).
  func recoverySigner(code: Bytes) throws -> CoreSigner
  /**
   * Joins the room group and every live session group from outside, authorised by the recovery key, and takes the
   * old content keys from the sealed copies. The Commits are in the device's outbox as `externalCommit`, in the
   * order to post them; the `RecoveryLink` for `finish` is returned.
   */
  func joinWithRecoveryCode(device: CoreDevice, code: Bytes, groupInfos: [(group: GroupId, groupInfo: Bytes)], sealedKeys: [Bytes], nowMs: UInt64) throws -> Bytes
}

/** Who signs a hub challenge (12.3): a device, or the recovery key while it joins. */
public protocol CoreSigner: AnyObject {
  var id: DeviceId { get }
  /** The `HubAuth` bytes and the signature, as POST /v2/rooms/{room}/tokens takes them. */
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

// LiveDevice.swift: `CoreDevice` (TrommiClient/Core.swift) on the Rust core's device, one call for one call. The list
// of what is real and what is stubbed is in LiveCore.swift.
//
// THREADS. The binding's device is safe to call from any thread: inside the core one caller is in at a time and a
// second waits; a call made from the store's own callback is refused instead of waiting for itself; a panic inside
// the core is caught and closes the device for good (every later call is `internal`, and the stored state is opened
// again). This class keeps two things of its own: the device id, which never changes, and the last finding
// Core.swift has no word for (`recoveryAuthConflict`, behind a lock). The client calls a device from one serial
// queue (Room.swift), which the core does not need but which keeps the order of its operations.
//
// WHERE Core.swift CANNOT SAY WHAT THE CORE SAYS (each is in the report to the owner of Core.swift):
//   - `room`, `cursor`, `isOwner`, `outbox()` cannot throw there and can in the core (a closed or failed device).
//     Here: nil, 0, false, [].
//   - `Processed` has no case for a join from outside that lost its epoch; here it is `.commit` with `superseded`.
//   - `Joined` has no `offending`: it is dropped here.
//   - `OutboxKind` has no `recoveryCommit` and `recoveryFinish` (11 and 12 in core/src/store.rs), which only a whole
//     recovery (`recover`, LiveRecovery.swift) makes. `outbox()` ends in front of the first entry whose kind
//     Core.swift cannot name, so that nothing is posted to a wrong route or out of order; the entry stays stored,
//     and `heldBack()` lists what waits. Once Core.swift has the two cases (with those numbers) they pass through.
//   - `InviteAccepted` has no hash of the accepted Request, which the core's confirmation names beside the code:
//     it is kept here per invite from `acceptInviteRequest` to `confirmInvite`.
//   - what follows a confirmed invite (`inviteSteps`, `inviteHandover`, `inviteRecommit`, `inviteForget`) and the
//     new device's own calls (`joinRequest`, `joinReveal`, `joinObserve`, `joinInvited`) are not in Core.swift.
//   - `ReceivedMessage` has no `recoveryAuthConflict` (a second, different key for the sealed keys under one
//     recovery key: the finding `equivocation`). Here it is `.dropped`, and `recoveryAuthConflict` names its sender.
import Foundation
import TrommiClient
import TrommiCoreRust

public final class LiveDevice: TrommiClient.CoreDevice {
  let device: TrommiCoreRust.CoreDevice
  public let id: DeviceId
  private let lock = NSLock()
  private var conflictFrom: DeviceId?
  /// Per invite the hash of the Request this object accepted, from `acceptInviteRequest` until `confirmInvite`.
  private var requestHashes: [Bytes: Bytes] = [:]
  /// The human device that last sent this device a second, different key for the room's sealed keys under a recovery
  /// key it already holds one for (the finding `equivocation`; nothing was replaced). nil: none since it was opened.
  public var recoveryAuthConflict: DeviceId? { lock.withLock { conflictFrom } }

  init(store: CoreStorage, create: Bool) throws {
    let adapter = StoreAdapter(store)
    let opened = try core { create ? try TrommiCoreRust.CoreDevice.create(store: adapter) : try TrommiCoreRust.CoreDevice.open(store: adapter) }
    device = opened
    id = try core { try opened.id() }.bytes
  }

  /// Closes the device and wipes what it holds in memory. Every later call is refused; the stored state is untouched.
  /// Call it before the store's lock is given back.
  public func close() { device.close() }

  // ---- real: what the device is ---------------------------------------------------------------------------

  public var room: RoomId? { (try? device.room())?.map(\.bytes) }
  public var cursor: UInt64 { (try? device.cursor()) ?? 0 }
  public var isOwner: Bool { (try? device.isOwner()) ?? false }

  /// The agents of a session are the leaves of its group that the room group enrols as agent devices: a main
  /// session's agent device, and for a helper session its opener. (A helper device is enrolled nowhere and is none.)
  public func groups() throws -> [TrommiClient.GroupSummary] {
    try core {
      let enrolled = Set(try device.roomRoles()?.agents ?? [])
      return try device.groups().map { group in
        let session = group.session.map { s in
          TrommiClient.SessionInfo(session: s.sessionId.bytes, parent: s.parent.allSatisfy { $0 == 0 } ? nil : s.parent.bytes,
                                   agents: group.leaves.filter(enrolled.contains).map(\.bytes))
        }
        return TrommiClient.GroupSummary(group: group.group.bytes, session: session, epoch: group.epoch, leaves: group.leaves.map(\.bytes),
                                         disallowed: group.disallowed.map(\.bytes), archived: group.archived, pending: group.pending)
      }
    }
  }

  /// Whether this device holds the content key of that group and epoch. The key itself never leaves the core.
  public func holdsKey(group: GroupId, epoch: UInt64) throws -> Bool { try core { try device.holdsKey(group: group.data, epoch: epoch) } }

  // ---- real: KeyPackages ----------------------------------------------------------------------------------

  public func keyPackagesToUpload(unusedAtHub: Int, nowMs: UInt64) throws -> UInt64? {
    try core { try device.keyPackagesToUpload(unusedAtHub: UInt32(clamping: unusedAtHub), nowMs: nowMs) }
  }
  public func keyPackage(nowMs: UInt64) throws -> Bytes { try core { try device.keyPackage(nowMs: nowMs) }.bytes }

  // ---- real: founding and changing groups -----------------------------------------------------------------

  /// The core's own call: founds the room with the recovery code (32 bytes) and puts its founding into the outbox.
  public func foundRoom(recoveryCode: Bytes, nowMs: UInt64) throws -> RoomId {
    try core { try device.foundRoom(recoveryCode: recoveryCode.data, nowMs: nowMs) }.bytes
  }

  public func foundSession(agent: DeviceId, keyPackages: [Bytes], nowMs: UInt64) throws -> SessionId {
    try core { try device.foundSession(agent: agent.data, keyPackages: keyPackages.map(\.data), nowMs: nowMs) }.bytes
  }
  public func addHumanDevice(_ added: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64 {
    // A device comes into the room by invite only (`confirmInvite`): this call has no counterpart in the core.
    try notBuilt()
  }
  public func addToSession(group: GroupId, device added: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.addToSession(group: group.data, device: added.data, keyPackage: keyPackage.data, nowMs: nowMs) }
  }
  public func changeAgents(enrol: [DeviceId], remove: [DeviceId], nowMs: UInt64) throws -> UInt64 {
    // An agent device is enrolled by invite only (`confirmInvite`); taking agents out is the core's removeAgents.
    guard enrol.isEmpty else { return try notBuilt() }
    return try core { try device.removeAgents(remove: remove.map(\.data), nowMs: nowMs) }
  }
  public func removeHumanDevices(_ cuts: [TrommiClient.Cut], nowMs: UInt64) throws -> UInt64 {
    try core { try device.removeHumanDevices(cuts: cuts.map(Self.cut), nowMs: nowMs) }
  }
  public func cleanSession(group: GroupId, cuts: [TrommiClient.Cut], replacement: (device: DeviceId, keyPackage: Bytes)?, nowMs: UInt64) throws -> UInt64 {
    try core {
      try device.cleanSession(group: group.data, cuts: cuts.map(Self.cut),
                              replacement: replacement.map { Replacement(device: $0.device.data, keyPackage: $0.keyPackage.data) }, nowMs: nowMs)
    }
  }
  public func update(group: GroupId, forced: Bool, nowMs: UInt64) throws -> UInt64? {
    try core { try device.update(group: group.data, forced: forced, nowMs: nowMs) }
  }
  public func archive(group: GroupId) throws { try core { try device.archive(group: group.data) } }

  private static func cut(_ cut: TrommiClient.Cut) -> TrommiCoreRust.Cut {
    TrommiCoreRust.Cut(device: cut.device.data, seq: cut.seq, hash: cut.hash.data)
  }

  // ---- real: stored content (section 9) --------------------------------------------------------------------

  /// Seals and signs the next envelope of this device's chain in the draft's group and puts it into the outbox. The
  /// core addresses it as the rules ask. A draft of Core.swift names a card or a request without its session, which
  /// the core asks for: it is the session group that holds that object (`not-found` if this device knows none).
  public func sendEnvelope(_ draft: EnvelopeDraft, nowMs: UInt64) throws -> SentEnvelope {
    func make(_ kind: DraftKind, session: SessionId? = nil, card: ObjectId? = nil, board: BoardId? = nil, group: GroupId? = nil, name: String? = nil,
              value: Bytes? = nil, object: ObjectId? = nil, request: ObjectId? = nil, choices: [String]? = nil, closes: Bool? = nil, closed: Bool? = nil,
              allow: Bool? = nil, payload: Bytes? = nil) -> Draft {
      Draft(kind: kind, session: session?.data, card: card?.data, board: board?.data, group: group?.data, name: name, value: value?.data,
            objectId: object?.data, requestId: request?.data, choices: choices, closes: closes, closed: closed, allow: allow, urgency: nil, push: nil,
            expiresAt: nil, payload: payload?.data)
    }
    let theirs: Draft, files: [FileId]
    switch draft {
    case .sessionChat(let session, let payload, let f): theirs = make(.sessionChat, session: session, payload: payload); files = f
    case .cardChat(let card, let payload, let f): theirs = make(.cardChat, session: try session(of: card), card: card, payload: payload); files = f
    case .boardItem(let board, let payload, let f): theirs = make(.boardItem, board: board, payload: payload); files = f
    case .register(let group, let name, let value): theirs = make(.register, group: group, name: name, value: value); files = []
    case .note(nil, let payload, _, let f): theirs = make(.noteFirst, payload: payload); files = f
    case .note(let object?, let payload, let closed, let f): theirs = make(.noteVersion, object: object, closed: closed, payload: payload); files = f
    case .answer(let object, let choices, let closes, let payload, let f):
      theirs = make(.answer, session: try session(of: object), object: object, choices: choices, closes: closes, payload: payload); files = f
    case .takeBack(let object, let payload): theirs = make(.takeBack, session: try session(of: object), object: object, payload: payload); files = []
    case .verdict(let request, let allow, let payload): theirs = make(.verdict, session: try session(of: request), request: request, allow: allow, payload: payload); files = []
    }
    let sealed = try core { try device.seal(draft: theirs, recipient: nil, fileIds: files.map(\.data), nowMs: nowMs) }
    return SentEnvelope(outboxId: sealed.outboxId, hash: sealed.envelopeHash.bytes, seq: sealed.seq, objectId: sealed.objectId?.bytes)
  }
  /// The session whose group holds that object (a card, a permission request).
  private func session(of object: ObjectId) throws -> SessionId {
    for group in try core({ try device.groups() }) {
      guard let session = group.session, try core({ try device.object(group: group.group, objectId: object.data) }) != nil else { continue }
      return session.sessionId.bytes
    }
    throw TrommiError("not-found", "no session of this device holds that object")
  }

  /// The receiver checks on one envelope; chain, object and register state are written with it. `.page` is an
  /// envelope fetched out of order: at most provisional, the chain is not touched. An envelope that consumed
  /// nothing (the core's `refused`) is thrown as its code, so that `logFinding` sorts it like a refused log entry.
  /// Core.swift has no place for these, which are dropped here: the finding to show beside an envelope, the object
  /// after it, whether a register value became the current one, whether a provisional envelope was confirmed or is
  /// to be dropped, that a group's state was built again, and the command gate's flag.
  public func receiveEnvelope(_ bytes: Bytes, change: UInt64, source: EnvelopeSource, voidCode: String?, nowMs: UInt64) throws -> TrommiClient.ReceivedEnvelope {
    let void = try voidCode.map { text -> ErrorCode in
      guard let code = errorCodeFromText(text: text) else { throw TrommiError("bad-format", "a void code this core does not know") }
      return code
    }
    let got = try core { try device.receiveEnvelope(envelope: bytes.data, change: change, ordered: source != .page, voidCode: void, nowMs: nowMs) }
    let code = got.code.map { errorCodeText(code: $0) }
    let standing: EnvelopeStanding
    switch got.outcome {
    case .applied: standing = .accepted
    case .provisional: standing = .provisional
    case .chained: standing = .notApplied(code: code ?? "chained")
    case .void: standing = .notApplied(code: code ?? "void")
    case .refused: throw TrommiError(code ?? "bad-format", "the envelope was refused and consumed nothing")
    }
    // The sender's role as the room names it now: a device the room group does not list as human writes as an agent.
    let humans = try core { try device.roomRoles() }?.humans ?? []
    return TrommiClient.ReceivedEnvelope(header: Self.header(got.header), hash: got.envelopeHash.bytes, standing: standing, bind: Self.bind(got.bind),
                                         payload: got.payload?.bytes, senderRole: humans.contains(got.header.sender) ? ROLE.HUMAN : ROLE.AGENT)
  }

  /// The header in the numbers of spec/v2.md section 9, which Core.swift and the model read (Wire.swift). A kind a
  /// newer Trommi defines has no number here that says which: 255, the last of the reserved ones.
  private static func header(_ h: TrommiCoreRust.EnvelopeHeader) -> TrommiClient.EnvelopeHeader {
    let kind: Int
    switch h.kind {
    case .item: kind = KIND.TIMELINE_ITEM
    case .version: kind = KIND.OBJECT_VERSION
    case .answer: kind = KIND.ANSWER
    case .request: kind = KIND.PERMISSION_REQUEST
    case .verdict: kind = KIND.VERDICT
    case .register: kind = KIND.STATUS
    case .takeBack: kind = KIND.DECIDE_AGAIN
    case .reserved: kind = 255
    }
    var timeline: (kind: Int, scope: Int)?
    switch h.timeline?.kind {
    case .sessionChat: timeline = (TIMELINE.CHAT, TIMELINE_SCOPE.SESSION)
    case .cardChat: timeline = (TIMELINE.CHAT, TIMELINE_SCOPE.CARD)
    case .board: timeline = (TIMELINE.CANVAS, TIMELINE_SCOPE.DESK)
    case nil: timeline = nil
    }
    var type: Int?, state: Int?, urgency: Int?
    if let object = h.object {
      switch object.objectType { case .card: type = OBJECT_TYPE.CARD; case .note: type = OBJECT_TYPE.NOTE; case .request: type = OBJECT_TYPE.REQUEST; case .artifact: type = OBJECT_TYPE.ARTIFACT }
      switch object.objectState { case .open: state = CARD_STATE.OPEN; case .answered: state = CARD_STATE.ANSWERED; case .closed: state = CARD_STATE.CLOSED }
      switch object.urgency { case .low: urgency = 0; case .normal: urgency = 1; case .high: urgency = 2; case .critical: urgency = 3 }
    }
    return TrommiClient.EnvelopeHeader(kind: kind, push: h.push, group: h.group.bytes, epoch: h.epoch, sender: h.sender.bytes, seq: h.seq, recipient: h.recipient?.bytes,
                                       time: h.time, timelineKind: timeline?.kind, timelineScope: timeline?.scope, timelineRef: h.timeline?.id.bytes,
                                       registerId: h.registerId?.bytes, objectId: h.object?.objectId.bytes, objectType: type, objectState: state, urgency: urgency,
                                       answeredAt: h.object?.answeredAt, objectRef: h.object?.objectRef.bytes, fileIds: h.fileIds.map(\.bytes))
  }

  private static func bind(_ bind: TrommiCoreRust.Bind?) -> EnvelopeBind {
    guard let b = bind else { return .none }
    switch b.kind {
    case .answer: return .answer(objectId: b.objectId?.bytes ?? [], versionHash: b.versionHash?.bytes ?? [], choices: b.choices)
    case .request: return .request(requestId: b.requestId?.bytes ?? [], expiresAt: b.expiresAt)
    case .verdict: return .verdict(requestId: b.requestId?.bytes ?? [], requestHash: b.requestHash?.bytes ?? [], expiresAt: b.expiresAt, allow: b.allow)
    case .takeBack: return .takeBack(objectId: b.objectId?.bytes ?? [], previousHash: b.previousHash?.bytes ?? [], versionHash: b.versionHash?.bytes ?? [])
    }
  }


  /// The current value (JSON) of a shared register name in a group; nil: never written, or deleted.
  public func register(group: GroupId, name: String) throws -> Bytes? { try core { try device.register(group: group.data, name: name) }?.bytes }
  /// The last envelope of `device` this device accepted in `group` (number 0 and zeros if none), for removing it.
  public func cut(group: GroupId, device cutDevice: DeviceId) throws -> TrommiClient.Cut {
    let cut = try core { try device.cutOf(group: group.data, device: cutDevice.data) }
    return TrommiClient.Cut(device: cut.device.bytes, seq: cut.seq, hash: cut.hash.bytes)
  }

  // ---- real: joining and the hub's log --------------------------------------------------------------------

  public func joinWelcome(_ welcome: Bytes, room: RoomId, committer: DeviceId?, nowMs: UInt64) throws -> TrommiClient.Joined {
    let joined = try core { try device.joinWelcome(welcome: welcome.data, room: room.data, committer: committer?.data, nowMs: nowMs) }
    return TrommiClient.Joined(group: joined.group.bytes, epoch: joined.epoch, addedBy: joined.addedBy.bytes)
  }

  public func processLogEntry(_ entry: TrommiClient.LogEntry) throws -> TrommiClient.Processed {
    let theirs: TrommiCoreRust.LogEntry
    switch entry.kind {
    case .commit(let bytes, let recoveryAuth):
      theirs = TrommiCoreRust.LogEntry(change: entry.change, group: entry.group.data, kind: .commit, bytes: bytes.data, recoveryAuth: recoveryAuth?.data)
    case .message(let bytes):
      theirs = TrommiCoreRust.LogEntry(change: entry.change, group: entry.group.data, kind: .message, bytes: bytes.data, recoveryAuth: nil)
    }
    let done = try core { try device.processLogEntry(entry: theirs, nowMs: nowMs()) }
    // The core names the epoch a Commit builds on; Core.swift's `epoch` is where the group stands after it.
    func commit(superseded: UInt64?, removed: Bool) -> TrommiClient.Processed {
      guard let c = done.commit else { return .skipped }
      return .commit(group: c.group.bytes, epoch: c.epoch + 1, superseded: superseded, removed: removed)
    }
    switch done.kind {
    case .commit: return commit(superseded: done.superseded, removed: done.removed)
    case .ownCommit: return .ownCommit
    case .observed: return .observed
    case .joinSuperseded: return commit(superseded: done.superseded, removed: false)
    case .message:
      if done.message?.kind == TrommiCoreRust.ReceivedKind.recoveryAuthConflict { lock.withLock { conflictFrom = done.message?.from?.bytes } }
      return .message(done.message.map(Self.message) ?? .dropped)
    case .skipped: return .skipped
    }
  }

  private static func message(_ m: TrommiCoreRust.ReceivedMessage) -> TrommiClient.ReceivedMessage {
    let from = m.from?.bytes ?? []
    switch m.kind {
    case .keys: return .keys(from: from, taken: Int(m.keysTaken), last: m.last)
    case .strokePiece: return .strokePiece(from: from, board: m.board?.bytes ?? [], piece: m.payload.bytes)
    case .workTrail: return .workTrail(from: from, turn: m.turn?.bytes ?? [], number: m.number, time: m.time, step: m.payload.bytes)
    case .recoveryAuth: return .recoveryAuth(from: from)
    case .recoveryAuthConflict: return .recoveryAuthConflict(from: from)
    case .dropped: return .dropped
    case .newerVersion: return .newerVersion(from: from)
    }
  }

  /// What a refusal of `processLogEntry` means for the caller, by the core's own table. An error that carries no code
  /// of the core (a stubbed call, a store's own error) is the device's fault, not the entry's: `.local`, so the
  /// caller stops and reads the entry again later instead of passing over it.
  public func logFinding(_ error: Error) -> TrommiClient.LogFinding {
    guard let code = (error as? TrommiError).flatMap({ errorCodeFromText(text: $0.code) }) else { return .local }
    switch TrommiCoreRust.logFinding(code: code) {
    case .early: return .early
    case .duplicate: return .duplicate
    case .badGroup: return .badGroup
    case .local: return .local
    }
  }

  // ---- real: application messages -------------------------------------------------------------------------

  public func sendHandover(group: GroupId, recipient: DeviceId) throws -> [UInt64] {
    try core { try device.sendHandover(group: group.data, recipient: recipient.data) }
  }
  public func sendStrokePiece(board: BoardId, piece: Bytes) throws -> UInt64 {
    try core { try device.sendStrokePiece(board: board.data, piece: piece.data) }
  }

  // ---- real: the outbox -----------------------------------------------------------------------------------

  /// What waits to be sent, in order, up to the first entry whose kind Core.swift cannot name (see the head of this
  /// file): that one and all behind it stay stored and are listed by `heldBack()`.
  public func outbox() -> [TrommiClient.OutboxEntry] {
    var named = [TrommiClient.OutboxEntry]()
    for entry in (try? device.outbox()) ?? [] {
      guard let kind = TrommiClient.OutboxKind(rawValue: Self.number(entry.kind)) else { break }
      named.append(TrommiClient.OutboxEntry(id: entry.id, kind: kind, group: entry.group?.bytes, epoch: entry.epoch, parts: entry.parts.map(\.bytes)))
    }
    return named
  }
  /// The entries `outbox()` does not hand out, in order, with the kind's number of core/src/store.rs (11: one Commit
  /// of a recovery, 12: its finish). Empty once Core.swift's `OutboxKind` names every kind of the core.
  public func heldBack() -> [(id: UInt64, kind: UInt8, group: GroupId?, epoch: UInt64, parts: [Bytes])] {
    let all = (try? device.outbox()) ?? []
    guard let first = all.firstIndex(where: { TrommiClient.OutboxKind(rawValue: Self.number($0.kind)) == nil }) else { return [] }
    return all[first...].map { ($0.id, Self.number($0.kind), $0.group?.bytes, $0.epoch, $0.parts.map(\.bytes)) }
  }
  /// The number core/src/store.rs gives the kind, which is also the raw value of Core.swift's `OutboxKind`.
  private static func number(_ kind: TrommiCoreRust.OutboxKind) -> UInt8 {
    switch kind {
    case .roomFounding: return 1
    case .groupFounding: return 2
    case .commit: return 3
    case .externalCommit: return 4
    case .message: return 5
    case .relayMessage: return 6
    case .envelope: return 7
    case .keyPackages: return 8
    case .sealedKey: return 9
    case .recoveryCode: return 10
    case .recoveryCommit: return 11
    case .recoveryFinish: return 12
    }
  }
  public func outboxAccepted(_ id: UInt64, change: UInt64?) throws { try core { try device.outboxAccepted(id: id, change: change) } }

  /// The hub refused the entry. A code that judges the request (`LiveCore.isFinalRefusal(_:)`) undoes what the
  /// entry was for; `epoch-taken` holds a Commit back until the log decided it. A code that says nothing about the
  /// request (`internal`, `overloaded`, `rate-limited`, `unauthorised`, `bad-challenge`, `client-too-old`,
  /// `lease-lost`) changes nothing and returns: the entry stays and is sent again unchanged. A code no hub answers
  /// with, or one this core does not know, throws `bad-format` and changes nothing.
  /// `voided`: the hub kept an envelope's number as a void record (9.0.8): the entry goes, the number stays used.
  public func outboxRefused(_ id: UInt64, code: String, voided: Bool) throws {
    guard let known = errorCodeFromText(text: code) else {
      throw TrommiError("bad-format", "outboxRefused: a code this core does not know is not a refusal for good: send the entry again")
    }
    if voided { return try core { try device.outboxVoided(id: id) } }
    // An envelope the hub refused without taking its number, because this device is out of the group, is given up.
    // (After any other refusal the core keeps an envelope's entry: its number is used for good.)
    let isEnvelope = try core { try device.outbox() }.contains { $0.id == id && $0.kind == .envelope }
    if isEnvelope && (code == "not-member" || code == "removed-sender") { return try core { try device.envelopeAbandon(id: id) } }
    try core { try device.outboxRefused(id: id, code: known) }
  }

  /// A stroke piece the hub only passed on: in no log, with no change number, so the cursor stays. `.dropped` for a
  /// message this device cannot open or of a group it is no leaf of; `bad-format` for anything but a stroke piece.
  public func processRelay(group: GroupId, bytes: Bytes) throws -> TrommiClient.ReceivedMessage {
    try core { try device.receiveRelay(group: group.data, message: bytes.data, nowMs: nowMs()) }.map(Self.message) ?? .dropped
  }

  // ---- real: invites by link (12.1), the inviting side ----------------------------------------------------

  /// `app` is the app's origin ("https://app.trommi.com"): the core puts the link's path behind it.
  public func openInvite(role: Int, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> OpenedInvite {
    guard role == ROLE.HUMAN || role == ROLE.AGENT else { throw TrommiError("bad-format", "an invite is for a human device or an agent device") }
    let opened = try core { try device.inviteOpen(role: role == ROLE.HUMAN ? .human : .agent, sessionId: session?.data, app: app, hub: hub, nowMs: nowMs) }
    return OpenedInvite(invite: opened.inviteId.bytes, link: opened.link, offer: opened.offer.bytes, offerSignature: opened.signature.bytes, expiresAt: opened.expiresAt)
  }

  /// Asked again with the same Request, the same comes back. The hash of the accepted Request stays here until
  /// `confirmInvite`: Core.swift's `InviteAccepted` has no place for it.
  public func acceptInviteRequest(invite: Bytes, request: Bytes, mac: Bytes, signature: Bytes, nowMs: UInt64) throws -> TrommiClient.InviteAccepted {
    let signed = SignedRequest(request: request.data, mac: mac.data, signature: signature.data)
    let accepted = try core { try device.inviteAccept(inviteId: invite.data, request: signed, nowMs: nowMs) }
    lock.withLock { requestHashes[invite] = accepted.requestHash.bytes }
    return TrommiClient.InviteAccepted(reveal: accepted.reveal.bytes, revealSignature: accepted.signature.bytes, numbers: accepted.code.numbers.bytes, newDevice: accepted.newDevice.bytes)
  }

  /// The person confirmed `numbers`. The core computes the code and the Request's hash again and commits the new
  /// device only if both are what this device showed (`code-not-confirmed` otherwise, also when this object accepted
  /// no Request for the invite: accept it again). Returns the Commit's outbox id; `inviteSteps()` says what follows
  /// once the hub took it.
  public func confirmInvite(invite: Bytes, numbers: [UInt8], nowMs: UInt64) throws -> UInt64 {
    guard let hash = lock.withLock({ requestHashes[invite] }) else { throw TrommiError("code-not-confirmed", "this device showed no code for that invite") }
    let confirmed = try core { try device.inviteConfirm(inviteId: invite.data, code: numbers.data, requestHash: hash.data, matches: true, nowMs: nowMs) }
    guard let confirmed else { throw TrommiError("internal", "a confirmed invite made no Commit") }
    lock.withLock { requestHashes[invite] = nil }
    return confirmed.outboxId
  }

  /// "They don't match": the invite is burned, whatever Request it accepted.
  public func burnInvite(invite: Bytes) throws {
    _ = try core { try device.inviteConfirm(inviteId: invite.data, code: Bytes(repeating: 0, count: 6).data, requestHash: ZERO32.data, matches: false, nowMs: nowMs()) }
    lock.withLock { requestHashes[invite] = nil }
  }

  /// What is to do next for every device this one committed by link, until all of it is done.
  public func inviteSteps() throws -> [LiveInviteStep] {
    try core { try device.inviteSteps() }.compactMap { step in
      let invite = step.inviteId.bytes
      switch step.kind {
      case .wait: return .wait(invite: invite)
      case .commit: return .commit(invite: invite)
      case .handover:
        guard let group = step.group, let device = step.device else { return nil }
        return .handover(invite: invite, group: group.bytes, device: device.bytes)
      case .addToSession:
        guard let group = step.group, let device = step.device else { return nil }
        return .addToSession(invite: invite, group: group.bytes, device: device.bytes)
      case .foundSession:
        guard let agent = step.device, let keyPackage = step.keyPackage else { return nil }
        return .foundSession(invite: invite, agent: agent.bytes, keyPackage: keyPackage.bytes)
      case .takeOver:
        guard let group = step.group, let agent = step.device, let keyPackage = step.keyPackage else { return nil }
        let cuts = step.cuts.map { TrommiClient.Cut(device: $0.device.bytes, seq: $0.seq, hash: $0.hash.bytes) }
        return .takeOver(invite: invite, group: group.bytes, cuts: cuts, agent: agent.bytes, keyPackage: keyPackage.bytes)
      }
    }
  }
  /// Sends the key handover a step `.handover` names; the outbox ids of its messages.
  public func inviteHandover(invite: Bytes) throws -> [UInt64] { try core { try device.inviteHandover(inviteId: invite.data) } }
  /// Builds the Commit of a confirmed invite again (a step `.commit`); its outbox id.
  public func inviteRecommit(invite: Bytes, nowMs: UInt64) throws -> UInt64 { try core { try device.inviteRecommit(inviteId: invite.data, nowMs: nowMs) } }
  /// Drops what was left to do for an invite (a takeover without history sends no handover).
  public func inviteForget(invite: Bytes) throws { try core { try device.inviteForget(inviteId: invite.data) } }

  // ---- real: invites by link (12.1), the new device ---------------------------------------------------------

  /// Checks the Offer served for `link` and answers it with a fresh KeyPackage. The core keeps the joining side in
  /// the device's store, so `joiner` is empty; `hub` is the link's, `room` the Offer's.
  public func joinRequest(link: String, offer: Bytes, offerSignature: Bytes, nowMs: UInt64) throws -> TrommiClient.JoinRequest {
    let made = try core { try device.joinRequest(link: link, offer: SignedOffer(offer: offer.data, signature: offerSignature.data), nowMs: nowMs) }
    let hub = try core { try inviteLinkParse(text: link) }.hub
    return TrommiClient.JoinRequest(joiner: [], invite: made.inviteId.bytes, hub: hub, room: made.roomId.bytes,
                                    role: made.role == .human ? ROLE.HUMAN : ROLE.AGENT, inviter: made.inviter.bytes,
                                    request: made.request.bytes, mac: made.mac.bytes, signature: made.signature.bytes)
  }
  /// Checks the Reveal against this device's Request; the six numbers to show.
  public func joinReveal(reveal: Bytes, signature: Bytes) throws -> [UInt8] {
    try core { try device.joinReveal(reveal: SignedReveal(reveal: reveal.data, signature: signature.data)) }.numbers.bytes
  }
  /// An invited agent device starts following the room group from the GroupInfo of the epoch its Offer names.
  public func joinObserve(groupInfo: Bytes) throws { try core { try device.joinObserve(groupInfo: groupInfo.data) } }
  /// An invited human device joins the room group from the Welcome that answers its Request. What the Welcome must
  /// be (the Offer's room, committed by the inviter, for the Request's KeyPackage) is read from the stored invite.
  public func joinInvited(_ welcome: Bytes, nowMs: UInt64) throws -> TrommiClient.Joined {
    let joined = try core { try device.joinInvited(welcome: welcome.data, nowMs: nowMs) }
    return TrommiClient.Joined(group: joined.group.bytes, epoch: joined.epoch, addedBy: joined.addedBy.bytes)
  }

  // ---- real: signing in to the hub (CoreSigner) -----------------------------------------------------------

  public func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) {
    let signed = try core { try device.hubSignIn(hub: hub, challenge: challenge.data) }
    return (signed.auth.bytes, signed.signature.bytes)
  }

  // ---- real, and not in Core.swift yet: the core has them, the client has no call for them ----------------

  /// Whether this device is a human device now.
  public func isHuman() throws -> Bool { try core { try device.isHuman() } }
  /// The leaves of a group that the newest room state does not allow: not empty means the session is stale.
  /// (`groups()` carries the same per group; this asks for one.)
  public func disallowed(group: GroupId) throws -> [DeviceId] { try core { try device.group(group: group.data) }.disallowed.map(\.bytes) }
  /// The room's human devices and enrolled agent devices at its newest epoch; nil before the device follows a room.
  public func roomRoles() throws -> (epoch: UInt64, humans: [DeviceId], agents: [DeviceId])? {
    try core { try device.roomRoles() }.map { ($0.epoch, $0.humans.map(\.bytes), $0.agents.map(\.bytes)) }
  }

  /// The two public keys of the recovery key that the room group names; nil before the device follows a room.
  func recoveryKeys() throws -> (signatureKey: Bytes, hpkeKey: Bytes)? {
    try core { try device.roomRoles() }.map { ($0.recoverySignatureKey.bytes, $0.recoveryHpkeKey.bytes) }
  }

  // =========================================================================================================
  // STUBBED: not in this build of the core binding. Each throws `not-built` and changes nothing.
  // =========================================================================================================

  /// The core hands no content key out: what a key seals is written and opened inside it.
  public func contentKey(group: GroupId, epoch: UInt64) throws -> Bytes { try notBuilt() }

  // recovery (section 8): the call the core cannot serve in this shape (it needs the code in force and the account's
  // new sealed copies). The real ones are `newRecoveryCode(current:)` and `replaceCode(current:account:nowMs:)`.
  public func replaceRecoveryCode(nowMs: UInt64) throws -> Bytes { try notBuilt() }
}

/// What every stubbed call refuses with, in the name of the calling function (`#function`).
func notBuilt<T>(_ call: String = #function) throws -> T { throw TrommiError(LiveCore.notBuiltCode, "\(call): not in this build of the core binding") }

/// One thing to do next for an invite this device confirmed (core `InviteStep`).
public enum LiveInviteStep: Equatable {
  /// Nothing yet: a Commit of this device waits for the hub or the log.
  case wait(invite: Bytes)
  /// The Commit that lets the device in was dropped for another: `inviteRecommit`.
  case commit(invite: Bytes)
  /// `inviteHandover`; or, for a takeover without history, `inviteForget`.
  case handover(invite: Bytes, group: GroupId, device: DeviceId)
  /// Claim one KeyPackage of the human device at the hub and call `addToSession`.
  case addToSession(invite: Bytes, group: GroupId, device: DeviceId)
  /// `foundSession` with this KeyPackage of the agent device and one of every other human device.
  case foundSession(invite: Bytes, agent: DeviceId, keyPackage: Bytes)
  /// `cleanSession` with these cuts and the agent device with this KeyPackage as the replacement.
  case takeOver(invite: Bytes, group: GroupId, cuts: [TrommiClient.Cut], agent: DeviceId, keyPackage: Bytes)
}

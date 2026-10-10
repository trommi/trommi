// LiveDevice.swift: `CoreDevice` (TrommiClient/Core.swift) on the Rust core's device, one call for one call. The list
// of what is bound is in LiveCore.swift.
//
// THREADS. The binding's device is safe to call from any thread: inside the core one caller is in at a time and a
// second waits; a call made from the store's own callback is refused instead of waiting for itself; a panic inside
// the core is caught and closes the device for good (every later call is `internal`, and the stored state is opened
// again). This class keeps one thing of its own: the device id, which never changes.
//
// WHERE Core.swift SAYS LESS THAN THE CORE:
//   - `room`, `cursor`, `isOwner`, `outbox()` cannot throw there and can in the core (a closed or failed device).
//     Here: nil, 0, false, [].
//   - the command gate, an agent's drafts, helper sessions and the work trail's sending are an agent's: not bound.
import Foundation
import TrommiClient
import TrommiCoreRust

public final class LiveDevice: TrommiClient.CoreDevice {
  let device: TrommiCoreRust.CoreDevice
  public let id: DeviceId

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
  public func addToSession(group: GroupId, device added: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.addToSession(group: group.data, device: added.data, keyPackage: keyPackage.data, nowMs: nowMs) }
  }
  public func removeAgents(_ remove: [DeviceId], nowMs: UInt64) throws -> UInt64 {
    try core { try device.removeAgents(remove: remove.map(\.data), nowMs: nowMs) }
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
  private static func cut(_ cut: TrommiCoreRust.Cut) -> TrommiClient.Cut {
    TrommiClient.Cut(device: cut.device.bytes, seq: cut.seq, hash: cut.hash.bytes)
  }

  // ---- real: stored content (section 9) --------------------------------------------------------------------

  /// The recipient is left to the core, which addresses the item as the rules ask.
  public func seal(_ draft: EnvelopeDraft, files: [FileId], nowMs: UInt64) throws -> TrommiClient.Sealed {
    func make(_ kind: DraftKind, session: SessionId? = nil, card: ObjectId? = nil, board: BoardId? = nil, group: GroupId? = nil, name: String? = nil,
              value: Bytes? = nil, object: ObjectId? = nil, request: ObjectId? = nil, choices: [String]? = nil, closes: Bool? = nil, closed: Bool? = nil,
              allow: Bool? = nil, payload: Bytes? = nil) -> Draft {
      Draft(kind: kind, session: session?.data, card: card?.data, board: board?.data, group: group?.data, name: name, value: value?.data,
            objectId: object?.data, requestId: request?.data, choices: choices, closes: closes, closed: closed, allow: allow, urgency: nil, push: nil,
            expiresAt: nil, payload: payload?.data)
    }
    let theirs: Draft
    switch draft {
    case let .sessionChat(session, payload): theirs = make(.sessionChat, session: session, payload: payload)
    case let .cardChat(session, card, payload): theirs = make(.cardChat, session: session, card: card, payload: payload)
    case let .boardItem(board, payload): theirs = make(.boardItem, board: board, payload: payload)
    case let .register(group, name, value): theirs = make(.register, group: group, name: name, value: value)
    case let .noteFirst(payload): theirs = make(.noteFirst, payload: payload)
    case let .noteVersion(object, closed, payload): theirs = make(.noteVersion, object: object, closed: closed, payload: payload)
    case let .answer(session, object, choices, closes, payload): theirs = make(.answer, session: session, object: object, choices: choices, closes: closes, payload: payload)
    case let .takeBack(session, object, payload): theirs = make(.takeBack, session: session, object: object, payload: payload)
    case let .verdict(session, request, allow, payload): theirs = make(.verdict, session: session, request: request, allow: allow, payload: payload)
    }
    let sealed = try core { try device.seal(draft: theirs, recipient: nil, fileIds: files.map(\.data), nowMs: nowMs) }
    return TrommiClient.Sealed(outboxId: sealed.outboxId, hash: sealed.envelopeHash.bytes, seq: sealed.seq, group: sealed.group.bytes, objectId: sealed.objectId?.bytes, time: sealed.time)
  }

  /// `voidCode` is the hub's text; one this core has no code for is `bad-format`. The command gate's flag is an
  /// agent's and is not passed on.
  public func receiveEnvelope(_ bytes: Bytes, change: UInt64, ordered: Bool, voidCode: String?, nowMs: UInt64) throws -> TrommiClient.ReceivedEnvelope {
    let void = try voidCode.map { text -> ErrorCode in
      guard let code = errorCodeFromText(text: text) else { throw TrommiError("bad-format", "a void code this core does not know") }
      return code
    }
    let got = try core { try device.receiveEnvelope(envelope: bytes.data, change: change, ordered: ordered, voidCode: void, nowMs: nowMs) }
    let outcome: TrommiClient.EnvelopeOutcome
    switch got.outcome {
    case .applied: outcome = .applied
    case .chained: outcome = .chained
    case .void: outcome = .void
    case .provisional: outcome = .provisional
    case .refused: outcome = .refused
    }
    func text(_ code: ErrorCode?) -> String? { code.map { errorCodeText(code: $0) } }
    return TrommiClient.ReceivedEnvelope(
      change: got.change, hash: got.envelopeHash.bytes, header: Self.header(got.header), outcome: outcome, code: text(got.code), finding: text(got.finding),
      payload: got.payload?.bytes, bind: got.bind.flatMap(Self.bind), objectAfter: got.objectAfter.map(Self.object),
      register: got.register.map { TrommiClient.RegisterChange(name: $0.name, of: $0.of?.bytes, current: $0.current) },
      confirmed: got.confirmed, dropped: text(got.dropped), replayed: got.replayed)
  }

  private static func type(_ t: TrommiCoreRust.ObjectType) -> TrommiClient.ObjectType {
    switch t { case .card: return .card; case .note: return .note; case .request: return .request; case .artifact: return .artifact }
  }
  private static func state(_ s: TrommiCoreRust.ObjectState) -> TrommiClient.ObjectState {
    switch s { case .open: return .open; case .answered: return .answered; case .closed: return .closed }
  }
  private static func object(_ o: TrommiCoreRust.ObjectView) -> TrommiClient.ObjectView {
    TrommiClient.ObjectView(objectId: o.objectId.bytes, type: type(o.objectType), owner: o.owner.bytes, state: state(o.objectState), current: o.current.bytes, answer: o.answer?.bytes)
  }
  private static func header(_ h: TrommiCoreRust.EnvelopeHeader) -> TrommiClient.EnvelopeHeader {
    let kind: TrommiClient.EnvelopeKind
    switch h.kind {
    case .item: kind = .item
    case .version: kind = .version
    case .answer: kind = .answer
    case .request: kind = .request
    case .verdict: kind = .verdict
    case .register: kind = .register
    case .takeBack: kind = .takeBack
    case .reserved: kind = .reserved(h.reservedKind ?? 255)
    }
    let timeline = h.timeline.map { t -> TrommiClient.TimelineRef in
      switch t.kind { case .sessionChat: return .sessionChat(t.id.bytes); case .cardChat: return .cardChat(t.id.bytes); case .board: return .board(t.id.bytes) }
    }
    let object = h.object.map { o -> TrommiClient.ObjectHeader in
      let urgency: TrommiClient.Urgency
      switch o.urgency { case .low: urgency = .low; case .normal: urgency = .normal; case .high: urgency = .high; case .critical: urgency = .critical }
      return TrommiClient.ObjectHeader(objectId: o.objectId.bytes, type: type(o.objectType), state: state(o.objectState), urgency: urgency, answeredAt: o.answeredAt, objectRef: o.objectRef.bytes)
    }
    return TrommiClient.EnvelopeHeader(group: h.group.bytes, sessionId: h.sessionId?.bytes, epoch: h.epoch, sender: h.sender.bytes, seq: h.seq, prev: h.prev.bytes,
                                       recipient: h.recipient?.bytes, time: h.time, kind: kind, push: h.push, timeline: timeline, registerId: h.registerId?.bytes,
                                       object: object, fileIds: h.fileIds.map(\.bytes))
  }
  /// nil for a bind that lacks a field its kind names (the binding fills them as the kind says).
  private static func bind(_ b: TrommiCoreRust.Bind) -> EnvelopeBind? {
    switch b.kind {
    case .answer:
      guard let object = b.objectId, let version = b.versionHash else { return nil }
      return .answer(objectId: object.bytes, versionHash: version.bytes, choices: b.choices)
    case .request:
      guard let request = b.requestId else { return nil }
      return .request(requestId: request.bytes, expiresAt: b.expiresAt)
    case .verdict:
      guard let request = b.requestId, let hash = b.requestHash else { return nil }
      return .verdict(requestId: request.bytes, requestHash: hash.bytes, expiresAt: b.expiresAt, allow: b.allow)
    case .takeBack:
      guard let object = b.objectId, let previous = b.previousHash, let version = b.versionHash else { return nil }
      return .takeBack(objectId: object.bytes, previousHash: previous.bytes, versionHash: version.bytes)
    }
  }

  public func register(group: GroupId, name: String) throws -> Bytes? { try core { try device.register(group: group.data, name: name) }?.bytes }
  public func cutOf(group: GroupId, device cutDevice: DeviceId) throws -> TrommiClient.Cut {
    Self.cut(try core { try device.cutOf(group: group.data, device: cutDevice.data) })
  }
  public func headsDue(group: GroupId, nowMs: UInt64) throws -> Bytes? { try core { try device.headsDue(group: group.data, nowMs: nowMs) }?.bytes }
  public func compareHeads(group: GroupId, writer: DeviceId) throws -> [(sender: DeviceId, standing: TrommiClient.HeadStanding)] {
    try core { try device.compareHeads(group: group.data, writer: writer.data) }.map { h in
      let standing: TrommiClient.HeadStanding
      switch h.standing { case .held: standing = .held; case .behind: standing = .behind(have: h.have); case .equivocation: standing = .equivocation; case .unknown: standing = .unknown }
      return (h.sender.bytes, standing)
    }
  }
  public func findings() throws -> [ChainFinding] {
    try core { try device.findings() }.map { ChainFinding(group: $0.group.bytes, sender: $0.sender.bytes, code: errorCodeText(code: $0.code)) }
  }
  public func findingsRead() throws { try core { try device.findingsRead() } }
  public func boardLoad(board: BoardId, served: [TrommiClient.WriterHead]) throws -> TrommiClient.BoardLoaded {
    let loaded = try core { try device.boardLoad(board: board.data, served: served.map { ServedItem(sender: $0.writer.data, seq: $0.seq, hash: $0.hash.data) }) }
    return TrommiClient.BoardLoaded(frontier: loaded.frontier.map { TrommiClient.WriterHead(writer: $0.writer.bytes, seq: $0.seq, hash: $0.hash.bytes) },
                                    fresh: loaded.fresh.map(Int.init), covered: loaded.covered.map(Int.init))
  }

  // ---- real: joining and the hub's log --------------------------------------------------------------------

  public func joinWelcome(_ welcome: Bytes, room: RoomId, committer: DeviceId?, nowMs: UInt64) throws -> TrommiClient.Joined {
    let joined = try core { try device.joinWelcome(welcome: welcome.data, room: room.data, committer: committer?.data, nowMs: nowMs) }
    return Self.joined(joined)
  }
  private static func joined(_ j: TrommiCoreRust.Joined) -> TrommiClient.Joined {
    TrommiClient.Joined(group: j.group.bytes, epoch: j.epoch, addedBy: j.addedBy.bytes, offending: j.offending.map(\.bytes))
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
    case .joinSuperseded:
      guard let c = done.commit else { return .skipped }
      return .joinSuperseded(group: c.group.bytes, epoch: c.epoch + 1, superseded: done.superseded)
    case .message: return .message(done.message.map(Self.message) ?? .dropped)
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

  /// What waits to be sent, in order.
  public func outbox() -> [TrommiClient.OutboxEntry] {
    ((try? device.outbox()) ?? []).compactMap { entry in
      TrommiClient.OutboxKind(rawValue: Self.number(entry.kind)).map { TrommiClient.OutboxEntry(id: entry.id, kind: $0, group: entry.group?.bytes, epoch: entry.epoch, parts: entry.parts.map(\.bytes)) }
    }
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

  /// A code that says nothing about the request (`LiveCore.passing`) changes nothing and returns: the entry stays. A
  /// code no hub answers with, or one this core does not know, throws `bad-format` and changes nothing.
  public func outboxRefused(_ id: UInt64, code: String) throws {
    guard let known = errorCodeFromText(text: code) else {
      throw TrommiError("bad-format", "outboxRefused: a code this core does not know is not a refusal for good: send the entry again")
    }
    try core { try device.outboxRefused(id: id, code: known) }
  }
  public func outboxVoided(_ id: UInt64) throws { try core { try device.outboxVoided(id: id) } }
  public func envelopeAbandon(_ id: UInt64) throws { try core { try device.envelopeAbandon(id: id) } }

  public func receiveRelay(group: GroupId, message: Bytes, nowMs: UInt64) throws -> TrommiClient.ReceivedMessage? {
    try core { try device.receiveRelay(group: group.data, message: message.data, nowMs: nowMs) }.map(Self.message)
  }

  // ---- real: invites by link (12.1), the inviting side ----------------------------------------------------

  private static func role(_ r: TrommiCoreRust.InviteRole) -> TrommiClient.InviteRole { r == .human ? .human : .agent }
  private static func code(_ c: TrommiCoreRust.CheckCode) -> TrommiClient.CheckCode { TrommiClient.CheckCode(numbers: c.numbers.bytes, emoji: c.emoji, words: c.words) }

  public func inviteOpen(role: TrommiClient.InviteRole, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> TrommiClient.InviteOpened {
    let opened = try core { try device.inviteOpen(role: role == .human ? .human : .agent, sessionId: session?.data, app: app, hub: hub, nowMs: nowMs) }
    return TrommiClient.InviteOpened(inviteId: opened.inviteId.bytes, link: opened.link, expiresAt: opened.expiresAt,
                                     offer: TrommiClient.SignedOffer(offer: opened.offer.bytes, signature: opened.signature.bytes, mac: opened.mac.bytes))
  }
  public func inviteAccept(invite: Bytes, request: TrommiClient.SignedRequest, nowMs: UInt64) throws -> TrommiClient.InviteAccepted {
    let signed = TrommiCoreRust.SignedRequest(request: request.request.data, mac: request.mac.data, signature: request.signature.data)
    let accepted = try core { try device.inviteAccept(inviteId: invite.data, request: signed, nowMs: nowMs) }
    return TrommiClient.InviteAccepted(newDevice: accepted.newDevice.bytes, code: Self.code(accepted.code),
                                       reveal: TrommiClient.SignedReveal(reveal: accepted.reveal.bytes, signature: accepted.signature.bytes), requestHash: accepted.requestHash.bytes)
  }
  public func inviteConfirm(invite: Bytes, numbers: [UInt8], requestHash: Hash32, matches: Bool, nowMs: UInt64) throws -> TrommiClient.InviteConfirmed? {
    try core { try device.inviteConfirm(inviteId: invite.data, code: numbers.data, requestHash: requestHash.data, matches: matches, nowMs: nowMs) }.map {
      TrommiClient.InviteConfirmed(newDevice: $0.newDevice.bytes, role: Self.role($0.role), sessionId: $0.sessionId?.bytes, outboxId: $0.outboxId)
    }
  }
  /// A step that lacks a field its kind names is left out (the binding fills them as the kind says).
  public func inviteSteps() throws -> [TrommiClient.InviteStep] {
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
        guard let group = step.group, let agent = step.device else { return nil }
        return .takeOver(invite: invite, group: group.bytes, cuts: step.cuts.map(Self.cut), agent: agent.bytes, keyPackage: step.keyPackage?.bytes)
      case .checkHelpers:
        guard let session = step.session else { return nil }
        return .checkHelpers(invite: invite, session: session.bytes)
      }
    }
  }
  public func inviteChecked(invite: Bytes, helpers: [GroupId]) throws { try core { try device.inviteChecked(inviteId: invite.data, helpers: helpers.map(\.data)) } }
  public func inviteHandover(invite: Bytes) throws -> [UInt64] { try core { try device.inviteHandover(inviteId: invite.data) } }
  public func inviteRecommit(invite: Bytes, nowMs: UInt64) throws -> UInt64 { try core { try device.inviteRecommit(inviteId: invite.data, nowMs: nowMs) } }
  public func inviteForget(invite: Bytes) throws { try core { try device.inviteForget(inviteId: invite.data) } }

  // ---- real: invites by link (12.1), the new device ---------------------------------------------------------

  public func joinLink(_ link: String, nowMs: UInt64) throws -> TrommiClient.JoinLink {
    let l = try core { try device.joinLink(link: link, nowMs: nowMs) }
    return TrommiClient.JoinLink(hub: l.hub, room: l.roomId.bytes, invite: l.inviteId.bytes, expiresAt: l.expiresAt)
  }
  public func joinRequest(link: String, offer: TrommiClient.SignedOffer, nowMs: UInt64) throws -> TrommiClient.JoinRequest {
    let made = try core { try device.joinRequest(link: link, offer: TrommiCoreRust.SignedOffer(offer: offer.offer.data, signature: offer.signature.data, mac: offer.mac.data), nowMs: nowMs) }
    return TrommiClient.JoinRequest(inviteId: made.inviteId.bytes, request: TrommiClient.SignedRequest(request: made.request.bytes, mac: made.mac.bytes, signature: made.signature.bytes),
                                    role: Self.role(made.role), inviter: made.inviter.bytes, expiresAt: made.expiresAt, sessionId: made.sessionId?.bytes,
                                    roomId: made.roomId.bytes, roomEpoch: made.roomEpoch, roomState: made.roomState.bytes)
  }
  public func joinReveal(_ reveal: TrommiClient.SignedReveal) throws -> TrommiClient.CheckCode {
    Self.code(try core { try device.joinReveal(reveal: TrommiCoreRust.SignedReveal(reveal: reveal.reveal.data, signature: reveal.signature.data)) })
  }
  public func joinObserve(groupInfo: Bytes) throws { try core { try device.joinObserve(groupInfo: groupInfo.data) } }
  public func joinInvited(_ welcome: Bytes, nowMs: UInt64) throws -> TrommiClient.Joined {
    Self.joined(try core { try device.joinInvited(welcome: welcome.data, nowMs: nowMs) })
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
}

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

  public func contentKey(group: GroupId, epoch: UInt64) throws -> Bytes {
    try core { try device.contentKey(group: group.data, epoch: epoch) }.bytes
  }

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
    try core { try device.addHumanDevice(device: added.data, keyPackage: keyPackage.data, nowMs: nowMs) }
  }
  public func addToSession(group: GroupId, device added: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.addToSession(group: group.data, device: added.data, keyPackage: keyPackage.data, nowMs: nowMs) }
  }
  public func changeAgents(enrol: [DeviceId], remove: [DeviceId], nowMs: UInt64) throws -> UInt64 {
    try core { try device.changeAgents(enrol: enrol.map(\.data), remove: remove.map(\.data), nowMs: nowMs) }
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
    let done = try core { try device.processLogEntry(entry: theirs) }
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
      if done.message?.kind == .recoveryAuthConflict { lock.withLock { conflictFrom = done.message?.from?.bytes } }
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

  /// Only for the hub's last word on those bytes. `LiveCore.isFinalRefusal(_:)` says which codes are; for any other
  /// (the hub could not answer, asks to sign in again, refuses for a reason that passes, or names a code this core
  /// does not know) this throws `bad-format` and changes nothing: the entry stays and is sent again unchanged.
  /// `voided` is not passed on: the binding has no stored content yet, and so no number of an envelope to void.
  public func outboxRefused(_ id: UInt64, code: String, voided: Bool) throws {
    guard let known = errorCodeFromText(text: code) else {
      throw TrommiError("bad-format", "outboxRefused: a code this core does not know is not a refusal for good: send the entry again")
    }
    try core { try device.outboxRefused(id: id, code: known) }
  }

  /// awaited: the binding takes a message only as a log entry.
  public func processRelay(group: GroupId, bytes: Bytes) throws -> TrommiClient.ReceivedMessage { try notBuilt() }

  // ---- real: signing in to the hub (CoreSigner) -----------------------------------------------------------

  public func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) {
    let signed = try core { try device.hubSignIn(room: room.data, hub: hub, challenge: challenge.data) }
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

  // stored content (spec section 9): the binding has `contentKey` and nothing that seals, signs, chains or opens
  public func sendEnvelope(_ draft: EnvelopeDraft, nowMs: UInt64) throws -> SentEnvelope { try notBuilt() }
  public func receiveEnvelope(_ bytes: Bytes, change: UInt64, source: EnvelopeSource, voidCode: String?, nowMs: UInt64) throws -> ReceivedEnvelope { try notBuilt() }
  public func register(group: GroupId, name: String) throws -> Bytes? { try notBuilt() }
  public func cut(group: GroupId, device: DeviceId) throws -> TrommiClient.Cut { try notBuilt() }

  // invites by link (12.1), the inviting side
  public func openInvite(role: Int, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> OpenedInvite { try notBuilt() }
  public func acceptInviteRequest(invite: Bytes, request: Bytes, mac: Bytes, signature: Bytes, nowMs: UInt64) throws -> InviteAccepted { try notBuilt() }
  public func confirmInvite(invite: Bytes, numbers: [UInt8], nowMs: UInt64) throws -> UInt64 { try notBuilt() }
  public func burnInvite(invite: Bytes) throws { try notBuilt() as Void }

  // recovery (section 8): the call the core cannot serve in this shape (it needs the code in force and the account's
  // new sealed copies). The real ones are `newRecoveryCode(current:)` and `replaceCode(current:account:nowMs:)`.
  public func replaceRecoveryCode(nowMs: UInt64) throws -> Bytes { try notBuilt() }
}

/// What every stubbed call refuses with, in the name of the calling function (`#function`).
func notBuilt<T>(_ call: String = #function) throws -> T { throw TrommiError(LiveCore.notBuiltCode, "\(call): not in this build of the core binding") }

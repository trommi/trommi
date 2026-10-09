// LiveCore and LiveDevice on the real Rust library, on Linux. That this file links and runs under `swift test` is the
// proof that the static library of core/swift/build.sh, UniFFI's Swift file and the package's linker settings fit
// together. Recovery (spec/v2.md section 8) runs here without a hub: `PocketHub` below keeps what a hub would.
import Foundation
import XCTest
import TrommiClient
@testable import TrommiCoreLive

/// A folder of its own under the temp directory, removed when the test ends.
func scratchFolder(_ test: XCTestCase) throws -> URL {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("trommi-live-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  test.addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
  return folder
}

/// The repository's root, from where this file lies: Tests/TrommiCoreLiveTests, Tests, TrommiClient, ios, the root.
func repositoryRoot() -> URL {
  var root = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { root.deleteLastPathComponent() }
  return root
}

/// The code a call refused with, or nil when it did not refuse with a `TrommiError`.
func refusedCode(_ call: () throws -> Void) -> String? {
  do { try call(); return nil } catch { return (error as? TrommiError)?.code }
}

/// One invite up to the moment both sides show their code: the inviter opens it, the new device answers the Offer,
/// the inviter accepts the Request, the new device checks the Reveal. (A hub only carries the four parts between
/// them, so none is needed.) The six numbers each side shows; what follows is `confirmInvite` or `burnInvite`.
func exchangeInvite(from inviter: LiveDevice, to newcomer: LiveDevice, role: Int = ROLE.HUMAN, session: SessionId? = nil,
                    tools: LiveCore) throws -> (invite: Bytes, inviterShows: [UInt8], newcomerShows: [UInt8]) {
  let opened = try inviter.openInvite(role: role, session: session, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
  let asked = try tools.inviteRequest(link: opened.link, offer: opened.offer, offerSignature: opened.offerSignature, device: newcomer, nowMs: nowMs())
  let accepted = try inviter.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs())
  let shown = try tools.inviteReveal(device: newcomer, reveal: accepted.reveal, signature: accepted.revealSignature)
  return (opened.invite, accepted.numbers, shown)
}

/// Whether both devices hold the content key of that group and epoch. (The key itself never leaves the core.)
func bothHoldKey(_ a: LiveDevice, _ b: LiveDevice, group: GroupId, epoch: UInt64) throws -> Bool {
  try a.holdsKey(group: group, epoch: epoch) && b.holdsKey(group: group, epoch: epoch)
}

final class LiveCoreTests: XCTestCase {
  let tools = LiveCore()

  // ---- the library itself ---------------------------------------------------------------------------------

  /// The `version` of the package in core/Cargo.toml, read from the checkout this test was built in.
  private func cargoVersion() throws -> String {
    let manifest = try String(contentsOf: repositoryRoot().appendingPathComponent("core/Cargo.toml"), encoding: .utf8)
    for line in manifest.split(separator: "\n") {
      if line.hasPrefix("[") && line != "[package]" { break }
      let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if parts.count == 2, parts[0] == "version" { return parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    }
    throw TrommiError("test", "no version in core/Cargo.toml")
  }

  func testVersionIsTheCoresOwn() throws {
    XCTAssertFalse(tools.version.isEmpty)
    XCTAssertEqual(tools.version, try cargoVersion())
    XCTAssertEqual(tools.buildVersions.openmls, "0.9.1")
    XCTAssertFalse(tools.buildVersions.provider.isEmpty)
    XCTAssertFalse(tools.buildVersions.binding.isEmpty)
  }

  /// The app reaches the core only through `Core.tools`.
  func testInstalledAsTheProcessCore() {
    Core.tools = tools
    XCTAssertTrue(Core.isInstalled)
    XCTAssertEqual(Core.tools.version, tools.version)
  }

  /// Both suites pass every step: the core's own (in memory, inside the library) and the one through the Swift
  /// adapter and a store written in Swift.
  func testSelfTestPassesBothSuites() {
    let steps = tools.selfTest()
    for step in steps { XCTAssertTrue(step.ok, "\(step.suite) / \(step.name): \(step.detail)") }
    XCTAssertEqual(steps.filter { $0.suite == "core" }.count, 12)
    XCTAssertEqual(steps.filter { $0.suite == "swift" }.count, 4)
    XCTAssertEqual(steps.count, 16)
    XCTAssertTrue(steps.allSatisfy { !$0.name.isEmpty })
    XCTAssertTrue(steps.contains { $0.micros > 0 })
  }

  /// What the binding does not have refuses by name, and never pretends. One call of each stubbed block.
  func testAStubSaysItIsAStub() throws {
    XCTAssertThrowsError(try tools.inviteReveal(joiner: [], reveal: [], signature: [])) { error in
      XCTAssertEqual((error as? TrommiError)?.code, LiveCore.notBuiltCode)
      XCTAssertEqual((error as? TrommiError)?.message, "inviteReveal(joiner:reveal:signature:): not in this build of the core binding")
    }
    // The two calls Core.swift guessed for recovery: the core cannot serve them in that shape (LiveRecovery.swift).
    let fresh = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    XCTAssertEqual(refusedCode { _ = try self.tools.joinWithRecoveryCode(device: fresh, code: ZERO32, groupInfos: [], sealedKeys: [], nowMs: nowMs()) }, "not-built")
    let device = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    XCTAssertEqual(refusedCode { _ = try device.sendEnvelope(.boardItem(board: ZERO16, payload: [], files: []), nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try device.receiveEnvelope([], change: 1, source: .live, voidCode: nil, nowMs: nowMs()) }, "not-built")
    // A content key never leaves the core.
    XCTAssertEqual(refusedCode { _ = try device.contentKey(group: ZERO32, epoch: 0) }, "not-built")
    // Gone from the core: a device comes into a room by invite only.
    XCTAssertEqual(refusedCode { _ = try device.addHumanDevice(ZERO32, keyPackage: [], nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try device.changeAgents(enrol: [ZERO32], remove: [], nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try (device as? LiveDevice)?.replaceRecoveryCode(nowMs: nowMs()) }, "not-built")
    // A stubbed call is the device's fault, never the entry's: the caller stops instead of passing an item over.
    XCTAssertEqual(device.logFinding(TrommiError("not-built")), .local)
  }

  // ---- errors ---------------------------------------------------------------------------------------------

  /// A refusal arrives as `TrommiError` with the specification's own spelling of the code.
  func testErrorCodesArriveAsTheSpecsText() throws {
    XCTAssertEqual(refusedCode { _ = try self.tools.normaliseEmail("no address") }, "bad-email")
    XCTAssertEqual(refusedCode { try self.tools.checkPassword("short") }, "weak-password")
    XCTAssertEqual(refusedCode { _ = try self.tools.parseRecoveryCode("not a code") }, "bad-recovery-code")
    XCTAssertEqual(refusedCode { _ = try self.tools.parseKitWords("one two three") }, "bad-recovery-words")
    XCTAssertEqual(refusedCode { _ = try self.tools.passwordKeys(email: "a@example.com", password: "a long password", kdf: #"{"alg":"argon2id","v":1,"m":8,"t":1,"p":1}"#) }, "bad-kdf")
    XCTAssertEqual(refusedCode { _ = try self.tools.openDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32)) }, "storage")
    let device = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    XCTAssertEqual(try (device as? LiveDevice)?.holdsKey(group: ZERO32, epoch: 0), false)
    XCTAssertEqual(refusedCode { _ = try (device as? LiveDevice)?.holdsKey(group: [1, 2, 3], epoch: 0) }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try device.signHubAuth(room: ZERO32, hub: "https://hub.example", challenge: [1]) }, "bad-format")
    // The message names what was refused and does not repeat the code in front of it.
    XCTAssertThrowsError(try device.signHubAuth(room: ZERO32, hub: "https://hub.example", challenge: [1])) { error in
      XCTAssertEqual((error as? TrommiError)?.message, "the challenge is not 32 bytes")
    }
    XCTAssertEqual(device.logFinding(TrommiError("room-behind")), .early)
    XCTAssertEqual(device.logFinding(TrommiError("storage")), .local)
    XCTAssertEqual(device.logFinding(TrommiError("bad-commit")), .badGroup)
  }

  /// Every code of the core's list, as core/swift/src/error.rs spells them.
  private func everyCode() throws -> [String] {
    let source = try String(contentsOf: repositoryRoot().appendingPathComponent("core/swift/src/error.rs"), encoding: .utf8)
    guard let start = source.range(of: "pub enum ErrorCode {"), let end = source.range(of: "\n    }\n", range: start.upperBound..<source.endIndex) else { throw TrommiError("test", "no ErrorCode in error.rs") }
    return source[start.upperBound..<end.lowerBound].split(separator: "\n").compactMap { line -> String? in
      guard let eq = line.range(of: " = \""), line.hasSuffix("\",") else { return nil }
      return String(line[eq.upperBound...].dropLast(2))
    }
  }

  /// `LiveCore.isFinalRefusal` against what the core does with every code of its list, each on a founding that waits
  /// in the outbox: a code that judges the request undoes the founding (the entry and the room are gone), a code
  /// that says nothing about it returns and leaves both, a code no hub answers with is `bad-format` and leaves both.
  func testWhichRefusalsAreFinalIsTheCoresTable() throws {
    let codes = try everyCode()
    XCTAssertGreaterThan(codes.count, 60)
    var passing = [String](), notOfAHub = [String]()
    for code in codes {
      let device = try LiveDevice(store: MemoryStorage(), create: true)
      _ = try device.foundRoom(recoveryCode: ZERO32, nowMs: nowMs())
      let entry = try XCTUnwrap(device.outbox().first)
      let answer = refusedCode { try device.outboxRefused(entry.id, code: code, voided: false) }
      let stays = device.outbox() == [entry] && device.room != nil
      switch answer {
      case nil where stays: passing.append(code)
      case nil: XCTAssertTrue(device.outbox().isEmpty && device.room == nil, code)
      case "bad-format": notOfAHub.append(code); XCTAssertTrue(stays, code)
      default: XCTFail("\(code): \(answer ?? "")")
      }
      XCTAssertEqual(LiveCore.isFinalRefusal(code), answer == nil && !stays, code)
      device.close()
    }
    XCTAssertEqual(Set(passing), LiveCore.passing)
    XCTAssertEqual(Set(notOfAHub), LiveCore.notOfAHub)
    XCTAssertEqual(passing.sorted(), ["bad-challenge", "client-too-old", "internal", "lease-lost", "overloaded", "rate-limited", "unauthorised"])
    for code in ["quota-exceeded", "too-many", "gap", "epoch-taken", "bad-commit"] { XCTAssertTrue(LiveCore.isFinalRefusal(code), code) }
    // A code this core does not know (a newer hub's, or the client's own "http-502") is never a refusal for good.
    let device = try LiveDevice(store: MemoryStorage(), create: true)
    XCTAssertFalse(LiveCore.isFinalRefusal("http-502"))
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "http-502", voided: false) }, "bad-format")
    // An entry that is not there: `not-found`, whatever the code says.
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "internal", voided: false) }, "not-found")
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "bad-commit", voided: false) }, "not-found")
  }

  // ---- the device on the phone's store --------------------------------------------------------------------

  /// A device on the real DeviceStore founds a room the way RoomAccount.swift does today; closed and opened again from
  /// disk it is the same device with the same outbox, byte for byte.
  func testDeviceFoundsARoomAndComesBackFromDisk() throws {
    let folder = try scratchFolder(self)
    let key = systemRandom(32)
    var store = try DeviceStore(directory: folder, key: key)
    var device = try tools.createDevice(store: store)
    XCTAssertEqual(device.id.count, 32)
    XCTAssertNil(device.room)
    XCTAssertTrue(device.isOwner)
    XCTAssertTrue(try device.groups().isEmpty)
    XCTAssertTrue(device.outbox().isEmpty)

    let code = try tools.generateRecoveryCode()
    let room = try device.foundRoom(recoveryCode: code, nowMs: nowMs())
    XCTAssertEqual(room.count, 32)
    XCTAssertEqual(device.room, room)
    // The room names the keys the core derived from the code.
    let roles = try XCTUnwrap(try (device as? LiveDevice)?.roomRoles())
    XCTAssertEqual(roles.humans, [device.id])
    XCTAssertEqual(roles.agents, [])

    let groups = try device.groups()
    XCTAssertEqual(groups, [GroupSummary(group: room, session: nil, epoch: 0, leaves: [device.id], archived: false, pending: false)])
    XCTAssertEqual(try (device as? LiveDevice)?.holdsKey(group: room, epoch: 0), true)
    let outbox = device.outbox()
    XCTAssertEqual(outbox.count, 1)
    XCTAssertEqual(outbox[0].kind, .roomFounding)
    XCTAssertEqual(outbox[0].group, room)
    XCTAssertEqual(outbox[0].epoch, 0)
    XCTAssertEqual(outbox[0].parts.count, 2)                  // GroupInfo of epoch 0, its SealedKey
    XCTAssertTrue(outbox[0].parts.allSatisfy { !$0.isEmpty })
    let signed = try device.signHubAuth(room: room, hub: "https://hub.example", challenge: ZERO32)
    XCTAssertEqual(signed.signature.count, 64)

    // A second owner of the same folder is refused while the first holds it.
    XCTAssertThrowsError(try DeviceStore(directory: folder, key: key)) { XCTAssertEqual($0 as? StoreError, .failed("busy")) }

    (device as? LiveDevice)?.close()
    store.close()
    // A closed device answers no more, and says so without throwing where Core.swift cannot throw.
    XCTAssertNil(device.room)
    XCTAssertFalse(device.isOwner)
    XCTAssertTrue(device.outbox().isEmpty)
    XCTAssertEqual(refusedCode { _ = try device.groups() }, "internal")

    store = try DeviceStore(directory: folder, key: key)
    let before = device.id
    device = try tools.openDevice(store: store)
    XCTAssertEqual(device.id, before)
    XCTAssertEqual(device.room, room)
    XCTAssertEqual(device.outbox(), outbox)
    XCTAssertEqual(try device.groups(), groups)
    // The hub's answer: the entry goes, and that too is on disk.
    try device.outboxAccepted(outbox[0].id, change: nil)
    XCTAssertTrue(device.outbox().isEmpty)
    (device as? LiveDevice)?.close()
    store.close()
    store = try DeviceStore(directory: folder, key: key)
    XCTAssertTrue(try tools.openDevice(store: store).outbox().isEmpty)
    store.close()
  }

  /// A store that fails a write refuses that one call with `storage` and the store's words; the device goes on.
  func testAFailedWriteRefusesOneCall() throws {
    final class Flaky: CoreStorage {
      var entries: [Bytes: Bytes] = [:], revision: UInt64 = 0, failNext: Error?
      func load() throws -> StoreLoaded { StoreLoaded(revision: revision, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) }) }
      func apply(expectedRevision: UInt64, batch: StoreBatch) throws {
        if let error = failNext { failNext = nil; throw error }
        guard expectedRevision == revision else { throw StoreError.conflict }
        for k in batch.delete { entries[k] = nil }
        for e in batch.put { entries[e.key] = e.value }
        revision += 1
      }
    }
    struct Foreign: Error { let secret = "do not print me" }
    let store = Flaky()
    let device = try tools.createDevice(store: store)
    store.failNext = StoreError.failed("the disk is full")
    XCTAssertThrowsError(try device.keyPackage(nowMs: nowMs())) { error in
      XCTAssertEqual((error as? TrommiError)?.code, "storage")
      XCTAssertEqual((error as? TrommiError)?.message.contains("the disk is full"), true)
    }
    XCTAssertTrue(device.isOwner)
    // An error of another type is a failure like any other, and its own words stay behind.
    store.failNext = Foreign()
    XCTAssertThrowsError(try device.keyPackage(nowMs: nowMs())) { error in
      XCTAssertEqual((error as? TrommiError)?.code, "storage")
      XCTAssertEqual((error as? TrommiError)?.message.contains("do not print me"), false)
    }
    XCTAssertTrue(device.isOwner)
    XCTAssertFalse(try device.keyPackage(nowMs: nowMs()).isEmpty)
    // A conflict ends it: another owner wrote.
    store.failNext = StoreError.conflict
    XCTAssertEqual(refusedCode { _ = try device.keyPackage(nowMs: nowMs()) }, "storage")
    XCTAssertFalse(device.isOwner)
    XCTAssertEqual(refusedCode { _ = try device.keyPackage(nowMs: nowMs()) }, "storage")
  }

  // ---- two devices, no hub --------------------------------------------------------------------------------

  /// The first entry of the outbox with that kind, reported to the device as accepted under the next change number.
  private func accept(_ device: CoreDevice, _ kind: OutboxKind, _ change: inout UInt64) throws -> OutboxEntry {
    let entry = try XCTUnwrap(device.outbox().first { $0.kind == kind })
    change += 1
    try device.outboxAccepted(entry.id, change: change)
    return entry
  }

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }

  /// A founds a room and takes B in by invite; B joins by the Welcome; both hold the same key for the room. Then a
  /// later Commit of A reaches B through the log, an agent device is enrolled by invite, and its session is founded.
  func testTwoDevicesShareTheRoomsKey() throws {
    var change: UInt64 = 0
    let a = try newDevice(), b = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)

    // A takes B in. The Commit's parts: Commit, GroupInfo, Welcome, SealedKey.
    let forB = try exchangeInvite(from: a, to: b, tools: tools)
    XCTAssertEqual(forB.inviterShows, forB.newcomerShows)
    let id = try a.confirmInvite(invite: forB.invite, numbers: forB.inviterShows, nowMs: nowMs())
    XCTAssertEqual(try a.groups().first?.pending, true)
    XCTAssertEqual(try a.inviteSteps(), [.wait(invite: forB.invite)])
    let add = try accept(a, .commit, &change)
    XCTAssertEqual(add.id, id)
    XCTAssertEqual(add.group, room)
    XCTAssertEqual(add.epoch, 0)
    XCTAssertEqual(add.parts.count, 4)
    XCTAssertFalse(add.parts[2].isEmpty)

    let joined = try b.joinInvited(add.parts[2], nowMs: nowMs())
    XCTAssertEqual(joined, Joined(group: room, epoch: 1, addedBy: a.id))
    XCTAssertEqual(b.room, room)
    for device in [a, b] {
      let group = try XCTUnwrap(try device.groups().first)
      XCTAssertEqual(group.epoch, 1)
      XCTAssertEqual(Set(group.leaves), Set([a.id, b.id]))
      XCTAssertFalse(group.pending)
    }
    XCTAssertTrue(try bothHoldKey(a, b, group: room, epoch: 1))
    // B was not there at epoch 0 and A has not handed that key over.
    XCTAssertFalse(try b.holdsKey(group: room, epoch: 0))

    // The Commit that added B, as the log brings it: A applied it when the hub accepted it (a duplicate now); for B
    // it lies behind the epoch its Welcome put it in, and is passed over.
    let addEntry = LogEntry(change: change, group: room, kind: .commit(bytes: add.parts[0], recoveryAuth: nil))
    XCTAssertThrowsError(try a.processLogEntry(addEntry)) {
      XCTAssertEqual(($0 as? TrommiError)?.code, "wrong-epoch")
      XCTAssertEqual(a.logFinding($0), .duplicate)
    }
    XCTAssertEqual(try b.processLogEntry(addEntry), .skipped)
    XCTAssertEqual(b.cursor, change)

    // With the Add accepted, A sends B the key that authenticates the room's sealed keys (7.4), unasked: a stored
    // message of the room group, in the epoch the Add led to. B came by Welcome, not with the code, and has none.
    XCTAssertEqual(try b.holdsRecoveryMac(), false)
    let auth = try accept(a, .message, &change)
    XCTAssertEqual(auth.epoch, 1)
    XCTAssertEqual(try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: auth.parts[0]))), .message(.recoveryAuth(from: a.id)))
    XCTAssertEqual(try b.holdsRecoveryMac(), true)

    // What the invite still asks for: the handover of the old key, a stored message of the room group, which B opens.
    XCTAssertEqual(try a.inviteSteps(), [.handover(invite: forB.invite, group: room, device: b.id)])
    XCTAssertFalse(try a.inviteHandover(invite: forB.invite).isEmpty)
    XCTAssertEqual(try a.inviteSteps(), [])
    let handover = try accept(a, .message, &change)
    let taken = try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: handover.parts[0])))
    guard case .message(.keys(let from, let count, _)) = taken else { return XCTFail("\(taken)") }
    XCTAssertEqual(from, a.id)
    XCTAssertGreaterThan(count, 0)
    XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: 0))

    // A's next Commit reaches B through the log: both stand at epoch 2 with one key.
    _ = try XCTUnwrap(try a.update(group: room, forced: true, nowMs: nowMs()))
    let update = try accept(a, .commit, &change)
    XCTAssertEqual(update.epoch, 1)
    let done = try b.processLogEntry(LogEntry(change: change, group: room, kind: .commit(bytes: update.parts[0], recoveryAuth: nil)))
    XCTAssertEqual(done, .commit(group: room, epoch: 2, superseded: nil, removed: false))
    XCTAssertEqual(b.cursor, change)
    XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: 2))

    // A stroke piece is relayed, not stored: the hub passes it on without a change number, and B's cursor stays.
    _ = try a.sendStrokePiece(board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#))
    let piece = try XCTUnwrap(a.outbox().first { $0.kind == .relayMessage })
    try a.outboxAccepted(piece.id, change: nil)
    XCTAssertEqual(try b.processRelay(group: room, bytes: piece.parts[0]), .strokePiece(from: a.id, board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#)))
    XCTAssertEqual(b.cursor, change)
    // A message of a group this device is no leaf of is dropped.
    XCTAssertEqual(try agent.processRelay(group: room, bytes: piece.parts[0]), .dropped)

    // An agent device is enrolled by invite: it follows the room group from the GroupInfo of the epoch its Offer
    // names (the update's), and the Commit that enrols it reaches it and B through the log.
    let forAgent = try exchangeInvite(from: a, to: agent, role: ROLE.AGENT, tools: tools)
    XCTAssertEqual(forAgent.inviterShows, forAgent.newcomerShows)
    try agent.joinObserve(groupInfo: update.parts[1])
    _ = try a.confirmInvite(invite: forAgent.invite, numbers: forAgent.inviterShows, nowMs: nowMs())
    let enrol = try accept(a, .commit, &change)
    let enrolEntry = LogEntry(change: change, group: room, kind: .commit(bytes: enrol.parts[0], recoveryAuth: nil))
    _ = try b.processLogEntry(enrolEntry)
    XCTAssertEqual(try agent.processLogEntry(enrolEntry), .observed)
    XCTAssertEqual(try a.roomRoles()?.agents, [agent.id])
    XCTAssertFalse(try agent.isHuman())

    // The invite asks for the agent's main session, with the KeyPackage of its Request and one of every other human.
    let steps = try a.inviteSteps()
    guard steps.count == 1, case .foundSession(let invite, let enrolled, let keyPackage) = steps[0] else { return XCTFail("\(steps)") }
    XCTAssertEqual(invite, forAgent.invite)
    XCTAssertEqual(enrolled, agent.id)
    let session = try a.foundSession(agent: agent.id, keyPackages: [keyPackage, try b.keyPackage(nowMs: nowMs())], nowMs: nowMs())
    XCTAssertEqual(session.count, 16)
    // The founding's parts: GroupInfo 0, SealedKey 0, the first Commit, its GroupInfo, its Welcome, its SealedKey.
    let founding = try accept(a, .groupFounding, &change)
    XCTAssertEqual(founding.group, room + session)
    XCTAssertEqual(founding.parts.count, 6)
    XCTAssertEqual(try a.inviteSteps(), [])
    _ = try b.joinWelcome(founding.parts[4], room: room, committer: a.id, nowMs: nowMs())
    _ = try agent.joinWelcome(founding.parts[4], room: room, committer: a.id, nowMs: nowMs())
    for device in [a, b, agent] {
      let group = try XCTUnwrap(try device.groups().first { $0.session != nil })
      XCTAssertEqual(group.group, room + session)
      XCTAssertEqual(group.session, SessionInfo(session: session, parent: nil, agents: [agent.id]))
      XCTAssertEqual(Set(group.leaves), Set([a.id, b.id, agent.id]))
      XCTAssertEqual(try device.disallowed(group: group.group), [])
    }
    XCTAssertTrue(try bothHoldKey(a, b, group: room + session, epoch: 1))
    XCTAssertTrue(try bothHoldKey(a, agent, group: room + session, epoch: 1))
    XCTAssertTrue(a.outbox().isEmpty)
  }

  /// The Welcome of an invite is taken only as the invite said: named for another room it is refused, and the
  /// KeyPackage it was for is spent with it, so the same Welcome is refused afterwards and the device asks anew.
  func testAWelcomeForAnotherRoomIsRefusedForGood() throws {
    var change: UInt64 = 0
    let a = try newDevice(), b = try newDevice()
    _ = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)
    let invite = try exchangeInvite(from: a, to: b, tools: tools)
    _ = try a.confirmInvite(invite: invite.invite, numbers: invite.inviterShows, nowMs: nowMs())
    let welcome = try accept(a, .commit, &change).parts[2]
    XCTAssertEqual(refusedCode { _ = try b.joinWelcome(welcome, room: systemRandom(32), committer: a.id, nowMs: nowMs()) }, "wrong-room")
    XCTAssertEqual(refusedCode { _ = try b.joinInvited(welcome, nowMs: nowMs()) }, "not-member")
    XCTAssertNil(b.room)
  }

  // ---- account (8.8) --------------------------------------------------------------------------------------

  func testAccountKeysAndSealedCopies() throws {
    XCTAssertEqual(try tools.normaliseEmail("  Ada@Example.COM "), "ada@example.com")
    XCTAssertNoThrow(try tools.checkPassword("correct horse battery"))
    let room = systemRandom(32)
    let code = try tools.generateRecoveryCode()
    XCTAssertEqual(code.count, 32)

    // The password's keys: the same for one e-mail, password and KDF record; the pinned record is the default.
    let record = #"{"alg":"argon2id","v":1,"m":65536,"t":3,"p":1}"#
    let keys = try tools.passwordKeys(email: "ada@example.com", password: "correct horse battery", kdf: nil)
    XCTAssertEqual(try tools.passwordKeys(email: "Ada@Example.com", password: "correct horse battery", kdf: record), keys)
    XCTAssertEqual(try unb64u(keys.authKey).count, 32)
    XCTAssertEqual(keys.wrapKey.count, 32)
    let other = try tools.passwordKeys(email: "ada@example.com", password: "correct horse battery!", kdf: record)
    XCTAssertNotEqual(other.wrapKey, keys.wrapKey)
    XCTAssertNotEqual(other.authKey, keys.authKey)

    // The copy under the password: opens under its key, room and way, and under nothing else.
    let underPassword = try tools.sealCode(code, email: "ada@example.com", room: room, way: .password(wrapKey: keys.wrapKey))
    XCTAssertEqual(try tools.openCode(underPassword, email: "ada@example.com", room: room, way: .password(wrapKey: keys.wrapKey)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPassword, email: "ada@example.com", room: room, way: .password(wrapKey: other.wrapKey)) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPassword, email: "ada@example.com", room: systemRandom(32), way: .password(wrapKey: keys.wrapKey)) }, "wrong-login")

    // The copy under the Emergency Kit's words.
    let words = try tools.generateKitWords()
    XCTAssertEqual(words.split(separator: " ").count, 12)
    XCTAssertEqual(try tools.parseKitWords("  " + words.uppercased().replacingOccurrences(of: " ", with: "  ")), words)
    XCTAssertEqual(try unb64u(try tools.kitAuthKey(email: "ada@example.com", words: words)).count, 32)
    XCTAssertEqual(try tools.kitAuthKey(email: "ADA@example.com", words: words), try tools.kitAuthKey(email: "ada@example.com", words: words))
    let underKit = try tools.sealCode(code, email: "ada@example.com", room: room, way: .kit(words: words))
    XCTAssertEqual(try tools.openCode(underKit, email: "ada@example.com", room: room, way: .kit(words: words)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, email: "ada@example.com", room: room, way: .kit(words: try self.tools.generateKitWords())) }, "wrong-recovery")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, email: "bob@example.com", room: room, way: .kit(words: words)) }, "wrong-recovery")
    // A copy opens only as the way it was sealed for.
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, email: "ada@example.com", room: room, way: .password(wrapKey: keys.wrapKey)) }, "wrong-login")

    // The copy under a passkey needs no e-mail: a login with a passkey has none (Account.swift).
    let prf = systemRandom(32), credential = systemRandom(20)
    let underPasskey = try tools.sealCode(code, email: "", room: room, way: .passkey(prf: prf, credentialId: credential))
    XCTAssertEqual(try tools.openCode(underPasskey, email: "", room: room, way: .passkey(prf: prf, credentialId: credential)), code)
    XCTAssertEqual(try tools.openCode(underPasskey, email: "this is no address", room: room, way: .passkey(prf: prf, credentialId: credential)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, email: "", room: room, way: .passkey(prf: systemRandom(32), credentialId: credential)) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, email: "", room: room, way: .passkey(prf: prf, credentialId: systemRandom(20))) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, email: "", room: room, way: .passkey(prf: [1, 2, 3], credentialId: credential)) }, "no-prf")

    // The code as a person reads and types it.
    let shown = tools.formatRecoveryCode(code)
    XCTAssertEqual(shown.split(separator: "-").count, 13)
    XCTAssertEqual(shown.filter { $0 != "-" }.count, 52)
    XCTAssertEqual(try tools.parseRecoveryCode(shown), code)
    XCTAssertEqual(try tools.parseRecoveryCode(shown.lowercased().replacingOccurrences(of: "-", with: " ")), code)
    XCTAssertEqual(tools.formatRecoveryCode([1, 2, 3]), "")
  }

  // ---- files (11), push (15.2), the hub's address ---------------------------------------------------------

  func testFilesRoundTripAndAFlippedByteRefuses() throws {
    for size in [0, 1, 65_536, 200_000] {
      let plain = (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }
      let sealed = try tools.encryptFile(plain)
      XCTAssertEqual(sealed.fileId.count, 16)
      XCTAssertEqual(sealed.fileKey.count, 32)
      XCTAssertEqual(sealed.sha256.count, 32)
      XCTAssertGreaterThan(sealed.stored.count, plain.count)
      XCTAssertEqual(try tools.decryptFile(fileId: sealed.fileId, fileKey: sealed.fileKey, sha256: sealed.sha256, stored: sealed.stored), plain)
    }
    let plain = systemRandom(100_000)
    let sealed = try tools.encryptFile(plain)
    // (the first byte is the format's version: changed, it reads as a newer one)
    for at in [0, 30, sealed.stored.count / 2, sealed.stored.count - 1] {
      var changed = sealed.stored
      changed[at] ^= 1
      XCTAssertEqual(refusedCode { _ = try self.tools.decryptFile(fileId: sealed.fileId, fileKey: sealed.fileKey, sha256: sealed.sha256, stored: changed) }, at == 0 ? "newer-version" : "decrypt-failed", "byte \(at)")
    }
    XCTAssertEqual(refusedCode { _ = try self.tools.decryptFile(fileId: sealed.fileId, fileKey: sealed.fileKey, sha256: sealed.sha256, stored: Bytes(sealed.stored.dropLast(1))) }, "decrypt-failed")
    XCTAssertEqual(refusedCode { _ = try self.tools.decryptFile(fileId: sealed.fileId, fileKey: systemRandom(32), sha256: sealed.sha256, stored: sealed.stored) }, "decrypt-failed")

    // The Share link with the file's hash, which Core.swift's call does not carry yet.
    let link = try tools.createShareLink(app: "https://app.trommi.com", fileId: sealed.fileId, fileKey: sealed.fileKey, sha256: sealed.sha256)
    XCTAssertTrue(link.link.hasPrefix("https://app.trommi.com/"))
    XCTAssertEqual(link.shareId.count, 16)
    XCTAssertEqual(link.secretHash.count, 32)
    XCTAssertEqual(refusedCode { _ = try self.tools.createShareLink(app: "app.trommi.com", fileId: sealed.fileId, fileKey: sealed.fileKey, sha256: sealed.sha256) }, "bad-format")
  }

  /// The 64 emoji of the check code and their words are the core's list.
  func testCheckEmoji() {
    let all = tools.checkEmoji(Array(0..<64))
    XCTAssertEqual(all.count, 64)
    XCTAssertEqual(Set(all.map(\.emoji)).count, 64)
    XCTAssertEqual(Set(all.map(\.word)).count, 64)
    XCTAssertTrue(all.allSatisfy { !$0.emoji.isEmpty && !$0.word.isEmpty })
    XCTAssertEqual(tools.checkEmoji([5, 5]).map(\.word), [all[5].word, all[5].word])
    XCTAssertEqual(tools.checkEmoji([64]).map(\.emoji), ["?"])
  }

  /// A link that is none is refused before any hub is asked.
  func testAnInviteLinkIsTheCoresToRead() {
    XCTAssertEqual(refusedCode { _ = try self.tools.parseInviteLink("https://app.trommi.com/#x") }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try self.tools.parseInviteLink("") }, "bad-format")
  }

  func testPushKey() throws {
    let key = try tools.generatePushKey()
    XCTAssertEqual(key.count, 32)
    XCTAssertNotEqual(key, try tools.generatePushKey())
  }

  /// The hub's address is the core's to judge, and is never repaired.
  func testCanonicalHub() throws {
    for good in ["https://hub.example", "https://hub.example:8443", "http://127.0.0.1:8790", "http://localhost:8790"] {
      XCTAssertEqual(try tools.canonicalHub(good), good)
    }
    for bad in ["https://Hub.example", "https://hub.example/", "http://hub.example", "hub.example", "https://hub.example/v2", ""] {
      XCTAssertEqual(refusedCode { _ = try self.tools.canonicalHub(bad) }, "bad-format", bad)
    }
  }
}

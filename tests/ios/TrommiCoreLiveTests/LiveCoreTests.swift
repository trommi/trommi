// LiveCore and LiveDevice on the real Rust library, on Linux. That this file links and runs under `swift test` is the
// proof that the static library of core/swift/build.sh, UniFFI's Swift file and the package's linker settings fit
// together. No hub runs here: where a test needs the hub's one order, `PocketHub` (RecoveryTests.swift) keeps it.
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

/// The repository's root: the first folder above this file that holds the core's manifest.
func repositoryRoot() -> URL {
  var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  while root.path != "/", !FileManager.default.fileExists(atPath: root.appendingPathComponent("core/Cargo.toml").path) { root.deleteLastPathComponent() }
  return root
}

/// The code a call refused with, or nil when it did not refuse with a `TrommiError`.
func refusedCode(_ call: () throws -> Void) -> String? {
  do { try call(); return nil } catch { return (error as? TrommiError)?.code }
}

/// One invite up to the moment both sides show their code: the inviter opens it, the new device answers the Offer,
/// the inviter accepts the Request, the new device checks the Reveal. (A hub only carries the four parts between
/// them, so none is needed.) The six numbers each side shows and the hash of the accepted Request; what follows is
/// `inviteConfirm`, with `matches` as the person said.
func exchangeInvite(from inviter: LiveDevice, to newcomer: LiveDevice, role: InviteRole = .human, session: SessionId? = nil,
                    tools: LiveCore) throws -> (invite: Bytes, inviterShows: [UInt8], newcomerShows: [UInt8], requestHash: Hash32) {
  let opened = try inviter.inviteOpen(role: role, session: session, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
  let asked = try newcomer.joinRequest(link: opened.link, offer: opened.offer, nowMs: nowMs())
  let accepted = try inviter.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs())
  let shown = try newcomer.joinReveal(accepted.reveal)
  return (opened.inviteId, accepted.code.numbers, shown.numbers, accepted.requestHash)
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

  /// Nothing of Core.swift is stubbed against this binding, so no call answers "not in this build". What is left
  /// of that: an error that carries no code of the core (a store's own, a newer hub's) is the device's fault, never
  /// the entry's, so the caller stops instead of passing an item over.
  func testAnErrorWithoutACodeOfTheCoreIsLocal() throws {
    let device = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    XCTAssertEqual(device.logFinding(TrommiError("not-built")), .local)
    XCTAssertEqual(device.logFinding(StoreError.failed("the disk is full")), .local)
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
    XCTAssertEqual(try device.holdsKey(group: ZERO32, epoch: 0), false)
    XCTAssertEqual(refusedCode { _ = try device.holdsKey(group: [1, 2, 3], epoch: 0) }, "bad-format")
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
      let answer = refusedCode { try device.outboxRefused(entry.id, code: code) }
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
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "http-502") }, "bad-format")
    // An entry that is not there: `not-found`, whatever the code says.
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "internal") }, "not-found")
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "bad-commit") }, "not-found")
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
  /// The answer merges nothing: a Commit takes effect when the device processes it from the log (`merge`).
  private func accept(_ device: CoreDevice, _ kind: OutboxKind, _ change: inout UInt64) throws -> OutboxEntry {
    let entry = try XCTUnwrap(device.outbox().first { $0.kind == kind })
    change += 1
    try device.outboxAccepted(entry.id, change: change)
    return entry
  }
  /// An accepted Commit of the device as the hub's log brings it back: the entry, processed as the device's own.
  private func merge(_ device: CoreDevice, _ entry: OutboxEntry, part: Int = 0, _ change: UInt64) throws -> LogEntry {
    let logged = LogEntry(change: change, group: try XCTUnwrap(entry.group), kind: .commit(bytes: entry.parts[part], recoveryAuth: nil))
    XCTAssertEqual(try device.processLogEntry(logged), .ownCommit)
    XCTAssertEqual(device.cursor, change)
    return logged
  }

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }

  /// A founds a room and takes B in by invite; B joins by the Welcome; both hold the same key for the room. Then a
  /// later Commit of A reaches B through the log, a stroke piece is relayed, an agent device is enrolled by invite,
  /// and its session is founded.
  func testTwoDevicesShareTheRoomsKey() throws {
    var change: UInt64 = 0
    let a = try newDevice(), b = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)

    // The invite: opened by A, requested by B, accepted by A, revealed to B. Both show the same six numbers.
    let forB = try exchangeInvite(from: a, to: b, tools: tools)
    XCTAssertEqual(forB.inviterShows.count, 6)
    XCTAssertEqual(forB.inviterShows, forB.newcomerShows)
    XCTAssertEqual(try a.inviteSteps(), [])
    // Confirmed: A commits B. The Commit's parts: Commit, GroupInfo, Welcome, SealedKey.
    let confirmed = try XCTUnwrap(try a.inviteConfirm(invite: forB.invite, numbers: forB.inviterShows, requestHash: forB.requestHash, matches: true, nowMs: nowMs()))
    XCTAssertEqual(confirmed.newDevice, b.id)
    XCTAssertEqual(confirmed.role, .human)
    XCTAssertNil(confirmed.sessionId)
    XCTAssertEqual(try a.groups().first?.pending, true)
    XCTAssertEqual(try a.inviteSteps(), [.wait(invite: forB.invite)])
    let add = try accept(a, .commit, &change)
    XCTAssertEqual(add.id, confirmed.outboxId)
    XCTAssertEqual(add.group, room)
    XCTAssertEqual(add.epoch, 0)
    XCTAssertEqual(add.parts.count, 4)
    XCTAssertFalse(add.parts[2].isEmpty)
    // The hub's answer merged nothing: A stands in its old epoch with the Commit pending, and the invite waits.
    XCTAssertEqual(try a.groups().first?.epoch, 0)
    XCTAssertEqual(try a.groups().first?.pending, true)
    XCTAssertEqual(try a.inviteSteps(), [.wait(invite: forB.invite)])
    // The log brings it back at its place: there it is merged.
    let addEntry = try merge(a, add, change)

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

    // The Commit that added B, handed to B after its Welcome: it lies behind the epoch the Welcome put it in, is
    // passed over, and gives the join its place in the hub's order. For A it is a duplicate now.
    XCTAssertEqual(try b.processLogEntry(addEntry), .skipped)
    XCTAssertEqual(b.cursor, change)
    XCTAssertThrowsError(try a.processLogEntry(addEntry)) { XCTAssertEqual(a.logFinding($0), .duplicate) }

    // With the Add merged, A sends B the key that authenticates the room's sealed keys (7.4), unasked: a stored
    // message of the room group, in the epoch the Add led to. B came by Welcome, not with the code, and has none.
    XCTAssertEqual(try b.holdsRecoveryMac(), false)
    let auth = try accept(a, .message, &change)
    XCTAssertEqual(auth.epoch, 1)
    XCTAssertEqual(try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: auth.parts[0]))), .message(.recoveryAuth(from: a.id)))
    XCTAssertEqual(try b.holdsRecoveryMac(), true)

    // What the invite still asks for: the handover of the old key, a stored message of the room group, which B
    // opens. With that the invite is finished and listed no more.
    XCTAssertEqual(try a.inviteSteps(), [.handover(invite: forB.invite, group: room, device: b.id)])
    XCTAssertFalse(try a.inviteHandover(invite: forB.invite).isEmpty)
    XCTAssertEqual(try a.inviteSteps(), [])
    XCTAssertEqual(refusedCode { _ = try a.inviteHandover(invite: forB.invite) }, "not-found")
    let handover = try accept(a, .message, &change)
    let taken = try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: handover.parts[0])))
    guard case .message(.keys(let from, let count, _)) = taken else { return XCTFail("\(taken)") }
    XCTAssertEqual(from, a.id)
    XCTAssertGreaterThan(count, 0)
    XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: 0))

    // A's next Commit reaches both through the log: both stand at epoch 2 with one key.
    _ = try XCTUnwrap(try a.update(group: room, forced: true, nowMs: nowMs()))
    let update = try accept(a, .commit, &change)
    XCTAssertEqual(update.epoch, 1)
    let updateEntry = try merge(a, update, change)
    XCTAssertEqual(try b.processLogEntry(updateEntry), .commit(group: room, epoch: 2, superseded: nil, removed: false))
    XCTAssertEqual(b.cursor, change)
    XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: 2))

    // A stroke piece is relayed, not stored: the hub passes it on without a change number, and B's cursor stays.
    _ = try a.sendStrokePiece(board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#))
    let piece = try XCTUnwrap(a.outbox().first { $0.kind == .relayMessage })
    try a.outboxAccepted(piece.id, change: nil)
    XCTAssertEqual(try b.receiveRelay(group: room, message: piece.parts[0], nowMs: nowMs()), .strokePiece(from: a.id, board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#)))
    XCTAssertEqual(b.cursor, change)
    // A message of a group this device is no leaf of opens nothing.
    XCTAssertNil(try agent.receiveRelay(group: room, message: piece.parts[0], nowMs: nowMs()))

    // An agent device is enrolled by invite: it follows the room group from the GroupInfo of the epoch its Offer
    // names (the update's), and the Commit that enrols it reaches it and B through the log.
    let forAgent = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    XCTAssertEqual(forAgent.inviterShows, forAgent.newcomerShows)
    try agent.joinObserve(groupInfo: update.parts[1])
    let enrolled = try XCTUnwrap(try a.inviteConfirm(invite: forAgent.invite, numbers: forAgent.inviterShows, requestHash: forAgent.requestHash, matches: true, nowMs: nowMs()))
    XCTAssertEqual(enrolled.role, .agent)
    let enrol = try accept(a, .commit, &change)
    let enrolEntry = try merge(a, enrol, change)
    _ = try b.processLogEntry(enrolEntry)
    XCTAssertEqual(try agent.processLogEntry(enrolEntry), .observed)
    XCTAssertEqual(try a.roomRoles()?.agents, [agent.id])
    XCTAssertFalse(try agent.isHuman())

    // The invite asks for the agent's main session, with the KeyPackage of its Request and one of every other human.
    let steps = try a.inviteSteps()
    guard steps.count == 1, case .foundSession(let invite, let enrolledDevice, let keyPackage) = steps[0] else { return XCTFail("\(steps)") }
    XCTAssertEqual(invite, forAgent.invite)
    XCTAssertEqual(enrolledDevice, agent.id)
    let session = try a.foundSession(agent: agent.id, keyPackages: [keyPackage, try b.keyPackage(nowMs: nowMs())], nowMs: nowMs())
    XCTAssertEqual(session.count, 16)
    // The founding's parts: GroupInfo 0, SealedKey 0, the first Commit, its GroupInfo, its Welcome, its SealedKey.
    let founding = try accept(a, .groupFounding, &change)
    XCTAssertEqual(founding.group, room + session)
    XCTAssertEqual(founding.parts.count, 6)
    // The founding's first Commit is A's own like any other: merged from the log.
    let foundingEntry = try merge(a, founding, part: 2, change)
    XCTAssertEqual(try a.inviteSteps(), [])
    for device in [b, agent] {
      _ = try device.joinWelcome(founding.parts[4], room: room, committer: a.id, nowMs: nowMs())
      XCTAssertEqual(try device.processLogEntry(foundingEntry), .skipped)
    }
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

  /// A and B in one room, B by invite with the handover done, and an agent device with its main session, which all
  /// three are leaves of. `PocketHub` (RecoveryTests.swift) keeps the hub's one order.
  private func roomWithSession(_ hub: PocketHub) throws -> (a: LiveDevice, b: LiveDevice, agent: LiveDevice, room: RoomId, session: SessionId) {
    let a = try newDevice(), b = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let forB = try exchangeInvite(from: a, to: b, tools: tools)
    _ = try a.inviteConfirm(invite: forB.invite, numbers: forB.inviterShows, requestHash: forB.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    _ = try b.joinInvited(try XCTUnwrap(hub.welcomes.last), nowMs: nowMs())
    _ = try a.inviteHandover(invite: forB.invite)
    try hub.post(a)
    try hub.deliver(to: b)

    let forAgent = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[1]))
    _ = try a.inviteConfirm(invite: forAgent.invite, numbers: forAgent.inviterShows, requestHash: forAgent.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let keyPackage)? = try a.inviteSteps().first else { throw TrommiError("test", "the invite asks for no session") }
    let session = try a.foundSession(agent: agent.id, keyPackages: [keyPackage, try b.keyPackage(nowMs: nowMs())], nowMs: nowMs())
    try hub.post(a)
    let welcome = try XCTUnwrap(hub.welcomes.last)
    for device in [b, agent] {
      try hub.deliver(to: device)
      _ = try device.joinWelcome(welcome, room: room, committer: a.id, nowMs: nowMs())
    }
    XCTAssertTrue(a.outbox().isEmpty)
    return (a, b, agent, room, session)
  }

  /// Stored content between two human devices (section 9), each sealed by the one (`seal`) and opened by the other
  /// (`receiveEnvelope`) after the checks of the sender's chain: a Chat message, a register value and a Note. An
  /// envelope handed over twice, or before the one its chain names in front of it, consumes nothing.
  func testStoredContentBetweenTwoDevices() throws {
    let hub = PocketHub()
    let (a, b, agent, room, session) = try roomWithSession(hub)
    let sessionGroup = room + session
    /// Posts what `device` sealed last and returns it with the change number the hub gave it.
    func posted(_ device: LiveDevice) throws -> (change: UInt64, bytes: Bytes) {
      try hub.post(device)
      return try XCTUnwrap(hub.envelopes.last)
    }

    // A Chat message to the session's agent: B, a leaf of the session group, takes it at its place.
    let body = utf8(#"{"schema_version":1,"content_type":"message","text":"hello"}"#)
    let sent = try a.seal(.sessionChat(session: session, payload: body), files: [], nowMs: nowMs())
    XCTAssertEqual(sent.seq, 1)
    XCTAssertEqual(sent.hash.count, 32)
    XCTAssertEqual(sent.group, sessionGroup)
    XCTAssertEqual(a.outbox().map(\.id), [sent.outboxId])
    XCTAssertEqual(a.outbox().first?.kind, .envelope)
    let chat = try posted(a)
    let got = try b.receiveEnvelope(chat.bytes, change: chat.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(got.outcome, .applied)
    XCTAssertNil(got.code)
    XCTAssertEqual(got.change, chat.change)
    XCTAssertEqual(got.hash, sent.hash)
    XCTAssertEqual(got.payload, body)
    XCTAssertNil(got.bind)
    XCTAssertEqual(got.header.kind, .item)
    XCTAssertEqual(got.header.group, sessionGroup)
    XCTAssertEqual(got.header.sessionId, session)
    XCTAssertEqual(got.header.sender, a.id)
    XCTAssertEqual(got.header.seq, 1)
    XCTAssertEqual(got.header.prev, ZERO32)
    XCTAssertEqual(got.header.recipient, agent.id)
    XCTAssertEqual(got.header.timeline, .sessionChat(session))
    XCTAssertEqual(b.cursor, chat.change)
    // The cut of A for B in that group is that envelope now.
    XCTAssertEqual(try b.cutOf(group: sessionGroup, device: a.id), Cut(device: a.id, seq: 1, hash: sent.hash))
    // Handed over again at its place: a replay, which consumes nothing.
    let replayed = try b.receiveEnvelope(chat.bytes, change: chat.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(replayed.outcome, .refused)
    XCTAssertEqual(replayed.code, "replay")
    XCTAssertNil(replayed.payload)
    // Read again out of order (a page of the Chat): the chain holds it, so it is the applied one, with its body.
    let again = try b.receiveEnvelope(chat.bytes, change: chat.change, ordered: false, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(again.outcome, .applied)
    XCTAssertEqual(again.payload, body)
    XCTAssertEqual(try b.cutOf(group: sessionGroup, device: a.id), Cut(device: a.id, seq: 1, hash: sent.hash))

    // Out of order: A's third envelope before its second is a gap in A's chain, and consumes nothing; the second
    // then the third are taken.
    let second = try a.seal(.sessionChat(session: session, payload: utf8(#"{"schema_version":1,"content_type":"message","text":"two"}"#)), files: [], nowMs: nowMs())
    let two = try posted(a)
    let third = try a.seal(.sessionChat(session: session, payload: utf8(#"{"schema_version":1,"content_type":"message","text":"three"}"#)), files: [], nowMs: nowMs())
    let three = try posted(a)
    XCTAssertEqual([second.seq, third.seq], [2, 3])
    let early = try b.receiveEnvelope(three.bytes, change: three.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(early.outcome, .refused)
    XCTAssertEqual(early.code, "gap")
    XCTAssertEqual(try b.cutOf(group: sessionGroup, device: a.id).seq, 1)
    XCTAssertEqual(try b.receiveEnvelope(two.bytes, change: two.change, ordered: true, voidCode: nil, nowMs: nowMs()).outcome, .applied)
    let late = try b.receiveEnvelope(three.bytes, change: three.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(late.outcome, .applied)
    XCTAssertEqual(late.header.prev, second.hash)
    XCTAssertEqual(try b.cutOf(group: sessionGroup, device: a.id), Cut(device: a.id, seq: 3, hash: third.hash))

    // A register value in the room group: B takes it, and reads it back as the current value of that name.
    let value = utf8(#"{"name":"Ops","schema_version":1}"#)    // (the core keeps a value in canonical form: keys in order)
    let name = "desk/\(hex(systemRandom(16)))"
    XCTAssertNil(try b.register(group: room, name: name))
    let set = try a.seal(.register(group: room, name: name, value: value), files: [], nowMs: nowMs())
    XCTAssertEqual(set.group, room)
    XCTAssertEqual(set.seq, 1)                       // a chain per group: A's first in the room group
    let register = try posted(a)
    let read = try b.receiveEnvelope(register.bytes, change: register.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(read.outcome, .applied)
    XCTAssertEqual(read.header.kind, .register)
    XCTAssertNotNil(read.header.registerId)
    XCTAssertEqual(read.register, RegisterChange(name: name, of: nil, current: true))
    XCTAssertEqual(try b.register(group: room, name: name), value)

    // A Note: its first version makes the object. A version's body names the version before it, zeros for the first:
    // without `previous_version_hash` the core refuses the draft, and no number of B's chain is used.
    XCTAssertEqual(refusedCode { _ = try b.seal(.noteFirst(payload: utf8(#"{"schema_version":1,"text":"x"}"#)), files: [], nowMs: nowMs()) }, "bad-format")
    let first = utf8(#"{"schema_version":1,"text":"x","previous_version_hash":"\#(b64u(ZERO32))"}"#)
    let note = try b.seal(.noteFirst(payload: first), files: [], nowMs: nowMs())
    XCTAssertEqual(note.seq, 1)
    XCTAssertEqual(note.objectId?.count, 16)
    let noted = try posted(b)
    let opened = try a.receiveEnvelope(noted.bytes, change: noted.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(opened.outcome, .applied)
    XCTAssertEqual(opened.payload, first)
    XCTAssertEqual(opened.header.kind, .version)
    XCTAssertEqual(opened.header.object?.objectId, note.objectId)
    XCTAssertEqual(opened.header.object?.type, .note)
    XCTAssertEqual(opened.header.object?.state, .open)
    XCTAssertEqual(opened.objectAfter, ObjectView(objectId: try XCTUnwrap(note.objectId), type: .note, owner: b.id, state: .open, current: note.hash))

    // Bytes that are no envelope are refused, and nothing moves.
    let cursor = b.cursor
    XCTAssertEqual(refusedCode { _ = try b.receiveEnvelope([1, 2, 3], change: hub.change + 1, ordered: true, voidCode: nil, nowMs: nowMs()) }, "bad-format")
    XCTAssertEqual(b.cursor, cursor)
    // An answer to a card nobody wrote (`not-found`) and a later version of a Note this device wrote no version of
    // (`forbidden`: only its owner writes one) are refused before anything is signed.
    XCTAssertEqual(refusedCode { _ = try a.seal(.answer(session: session, object: systemRandom(16), choices: ["a"], closes: false, payload: utf8(#"{"answer_action":"answer","choices":["a"],"schema_version":1}"#)), files: [], nowMs: nowMs()) }, "not-found")
    let later = utf8(#"{"schema_version":1,"text":"y","previous_version_hash":"\#(b64u(systemRandom(32)))"}"#)
    XCTAssertEqual(refusedCode { _ = try a.seal(.noteVersion(object: systemRandom(16), closed: false, payload: later), files: [], nowMs: nowMs()) }, "forbidden")
    XCTAssertTrue(a.outbox().isEmpty)
  }

  /// An item written before a device came into its group is `group-behind` for it, also with that epoch's key from
  /// the handover, until it learned the group's past from its public history (`learnHistory`); then the same
  /// envelope is taken, and the sender's chain goes on from its start.
  func testAnItemFromBeforeADeviceCameIsReadOnceThePastIsLearned() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let body = utf8(#"{"schema_version":1,"t":"early"}"#)
    _ = try a.seal(.boardItem(board: ALL_DESKS_BOARD, payload: body), files: [], nowMs: nowMs())
    try hub.post(a)
    let early = try XCTUnwrap(hub.envelopes.last)

    let invite = try exchangeInvite(from: a, to: b, tools: tools)
    _ = try a.inviteConfirm(invite: invite.invite, numbers: invite.inviterShows, requestHash: invite.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    _ = try b.joinInvited(try XCTUnwrap(hub.welcomes.last), nowMs: nowMs())
    _ = try a.inviteHandover(invite: invite.invite)
    try hub.post(a)
    // At its place in the hub's order, above B's cursor: an epoch before B came. Nothing of it is taken, and the
    // cursor moves over it, so the catch-up goes on.
    let atItsPlace = try b.receiveEnvelope(early.bytes, change: early.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(atItsPlace.outcome, .refused)
    XCTAssertEqual(atItsPlace.code, "group-behind")
    XCTAssertEqual(b.cursor, early.change)
    try hub.deliver(to: b)
    XCTAssertTrue(try b.holdsKey(group: room, epoch: 0))

    // Behind B's cursor now, and with that epoch's key from the handover: still nothing of it is taken.
    let before = try b.receiveEnvelope(early.bytes, change: early.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(before.outcome, .refused)
    XCTAssertEqual(before.code, "group-behind")
    XCTAssertNil(before.payload)

    // The room group's public history, as the hub serves it: the founding GroupInfo and every Commit since.
    let served = try hub.served(room)
    XCTAssertEqual(try b.learnHistory(group: room, founding: served.founding, commits: served.commits), 1)
    let after = try b.receiveEnvelope(early.bytes, change: early.change, ordered: true, voidCode: nil, nowMs: nowMs())
    XCTAssertEqual(after.outcome, .applied)
    XCTAssertEqual(after.payload, body)
    XCTAssertEqual(after.header.epoch, 0)
    XCTAssertEqual(after.header.timeline, .board(ALL_DESKS_BOARD))
    XCTAssertEqual(try b.cutOf(group: room, device: a.id).seq, 1)
  }

  /// The Welcome of an invite is taken only as the invite said: named for another room it is refused, and the
  /// KeyPackage it was for is spent with it, so the same Welcome is refused afterwards and the device asks anew.
  func testAWelcomeForAnotherRoomIsRefusedForGood() throws {
    var change: UInt64 = 0
    let a = try newDevice(), b = try newDevice()
    _ = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)
    let invite = try exchangeInvite(from: a, to: b, tools: tools)
    _ = try a.inviteConfirm(invite: invite.invite, numbers: invite.inviterShows, requestHash: invite.requestHash, matches: true, nowMs: nowMs())
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
    let underPassword = try tools.sealCode(code, room: room, way: .password(wrapKey: keys.wrapKey))
    XCTAssertEqual(try tools.openCode(underPassword, room: room, way: .password(wrapKey: keys.wrapKey)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPassword, room: room, way: .password(wrapKey: other.wrapKey)) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPassword, room: systemRandom(32), way: .password(wrapKey: keys.wrapKey)) }, "wrong-login")

    // The copy under the Emergency Kit's words.
    let words = try tools.generateKitWords()
    XCTAssertEqual(words.split(separator: " ").count, 12)
    XCTAssertEqual(try tools.parseKitWords("  " + words.uppercased().replacingOccurrences(of: " ", with: "  ")), words)
    let kit = try tools.kitKeysFor(.email("ada@example.com"), words: words)
    XCTAssertEqual(try unb64u(kit.authKey).count, 32)
    XCTAssertEqual(kit.wrapKey.count, 32)
    XCTAssertEqual(try tools.kitKeysFor(.email("ADA@example.com"), words: words), kit)
    let underKit = try tools.sealCode(code, room: room, way: .kit(wrapKey: kit.wrapKey))
    XCTAssertEqual(try tools.openCode(underKit, room: room, way: .kit(wrapKey: kit.wrapKey)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, room: room, way: .kit(wrapKey: try self.tools.kitKeysFor(.email("ada@example.com"), words: try self.tools.generateKitWords()).wrapKey)) }, "wrong-recovery")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, room: room, way: .kit(wrapKey: try self.tools.kitKeysFor(.email("bob@example.com"), words: words).wrapKey)) }, "wrong-recovery")
    // A copy opens only as the way it was sealed for.
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underKit, room: room, way: .password(wrapKey: keys.wrapKey)) }, "wrong-login")
    // An account without an e-mail: its kit's keys hang on its id, which reads in any case, with or without hyphens.
    let id = try tools.accountIdParse("00000000-0000-4000-8000-0000000000AB")
    XCTAssertEqual(id, try tools.accountIdParse("00000000 0000 4000 8000 0000000000ab"))
    XCTAssertEqual(id, try tools.accountIdParse(id))
    XCTAssertEqual(refusedCode { _ = try self.tools.accountIdParse("not an id") }, "bad-format")
    let byId = try tools.kitKeysFor(.id(id), words: words)
    XCTAssertEqual(byId, try tools.kitKeysFor(.id(id), words: words))
    XCTAssertNotEqual(byId.wrapKey, kit.wrapKey)
    XCTAssertNotEqual(byId.wrapKey, try tools.kitKeysFor(.id(try tools.accountIdParse("00000000-0000-4000-8000-0000000000ac")), words: words).wrapKey)

    // The copy under a passkey needs no e-mail: a login with a passkey has none (Account.swift).
    let prf = systemRandom(32), credential = systemRandom(20)
    let underPasskey = try tools.sealCode(code, room: room, way: .passkey(prf: prf, credentialId: credential))
    XCTAssertEqual(try tools.openCode(underPasskey, room: room, way: .passkey(prf: prf, credentialId: credential)), code)
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, room: room, way: .passkey(prf: systemRandom(32), credentialId: credential)) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, room: room, way: .passkey(prf: prf, credentialId: systemRandom(20))) }, "wrong-login")
    XCTAssertEqual(refusedCode { _ = try self.tools.openCode(underPasskey, room: room, way: .passkey(prf: [1, 2, 3], credentialId: credential)) }, "no-prf")

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
    let all = tools.checkEmoji()
    XCTAssertEqual(all.count, 64)
    XCTAssertEqual(Set(all.map(\.emoji)).count, 64)
    XCTAssertEqual(Set(all.map(\.word)).count, 64)
    XCTAssertTrue(all.allSatisfy { !$0.emoji.isEmpty && !$0.word.isEmpty })
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

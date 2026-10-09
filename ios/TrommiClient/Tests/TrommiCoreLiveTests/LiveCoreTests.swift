// LiveCore and LiveDevice on the real Rust library, on Linux. That this file links and runs under `swift test` is the
// proof that the static library of core/swift/build.sh, UniFFI's Swift file and the package's linker settings fit
// together. Everything here needs a library built with TROMMI_STAND_IN_RECOVERY=1: without it no room is founded.
import Foundation
import XCTest
import TrommiClient
import TrommiCoreLive

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
    XCTAssertTrue(tools.recoveryState.hasPrefix("stand-in"), "these tests need a library built with TROMMI_STAND_IN_RECOVERY=1")
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
    XCTAssertEqual(steps.filter { $0.suite == "core" }.count, 11)
    XCTAssertEqual(steps.filter { $0.suite == "swift" }.count, 4)
    XCTAssertEqual(steps.count, 15)
    XCTAssertTrue(steps.allSatisfy { !$0.name.isEmpty })
    XCTAssertTrue(steps.contains { $0.micros > 0 })
  }

  /// What the binding does not have refuses by name, and never pretends. One call of each stubbed block.
  func testAStubSaysItIsAStub() throws {
    XCTAssertThrowsError(try tools.recoverySigner(code: [])) { error in
      XCTAssertEqual((error as? TrommiError)?.code, LiveCore.notBuiltCode)
      XCTAssertEqual((error as? TrommiError)?.message, "recoverySigner(code:): not in this build of the core binding")
    }
    XCTAssertEqual(refusedCode { _ = try self.tools.parseInviteLink("https://app.trommi.com/#x") }, "not-built")
    XCTAssertEqual(tools.checkEmoji([1, 2]).map(\.word), ["not-built", "not-built"])
    let device = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    XCTAssertEqual(refusedCode { _ = try device.sendEnvelope(.boardItem(board: ZERO16, payload: [], files: []), nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try device.receiveEnvelope([], change: 1, source: .live, voidCode: nil, nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try device.openInvite(role: ROLE.HUMAN, session: nil, app: "", hub: "", nowMs: nowMs()) }, "not-built")
    XCTAssertEqual(refusedCode { _ = try device.replaceRecoveryCode(nowMs: nowMs()) }, "not-built")
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
    XCTAssertEqual(refusedCode { _ = try device.contentKey(group: ZERO32, epoch: 0) }, "no-key")
    XCTAssertEqual(refusedCode { _ = try device.contentKey(group: [1, 2, 3], epoch: 0) }, "bad-format")
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

  /// `LiveCore.isFinalRefusal` against the core's own table. `outboxRefused` for an entry that does not exist answers
  /// `bad-format` before it looks for the entry when the code is not a refusal for good, and `not-found` when it is.
  func testWhichRefusalsAreFinalIsTheCoresTable() throws {
    let device = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: ZERO32))
    let codes = try everyCode()
    XCTAssertGreaterThan(codes.count, 60)
    var sendAgain = [String]()
    for code in codes {
      let answer = refusedCode { try device.outboxRefused(999, code: code, voided: false) }
      XCTAssertTrue(answer == "bad-format" || answer == "not-found", "\(code): \(answer ?? "accepted")")
      XCTAssertEqual(LiveCore.isFinalRefusal(code), answer == "not-found", code)
      if answer == "bad-format" { sendAgain.append(code) }
    }
    XCTAssertEqual(sendAgain.sorted(), ["bad-email", "bad-kdf", "bad-recovery-code", "bad-recovery-words", "busy", "entropy", "internal", "no-prf",
                                        "overloaded", "rate-limited", "storage", "unauthorised", "weak-password"])
    // A code this core does not know (a newer hub's, or the client's own "http-502") is never a refusal for good.
    XCTAssertFalse(LiveCore.isFinalRefusal("http-502"))
    XCTAssertEqual(refusedCode { try device.outboxRefused(999, code: "http-502", voided: false) }, "bad-format")
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
    XCTAssertEqual(try device.contentKey(group: room, epoch: 0).count, 32)
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

  /// A founds a room and adds B with B's KeyPackage; B joins by the Welcome; both hold the same key for the room.
  /// Then a later Commit of A reaches B through the log, an agent device is enrolled, and a session is founded.
  func testTwoDevicesShareTheRoomsKey() throws {
    var change: UInt64 = 0
    let a = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32)))
    let b = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32)))
    let agent = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32)))
    let room = try XCTUnwrap(a as? LiveDevice).foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)

    // A adds B. The Commit's parts: Commit, GroupInfo, Welcome, SealedKey.
    let id = try a.addHumanDevice(b.id, keyPackage: try b.keyPackage(nowMs: nowMs()), nowMs: nowMs())
    XCTAssertEqual(try a.groups().first?.pending, true)
    let add = try accept(a, .commit, &change)
    XCTAssertEqual(add.id, id)
    XCTAssertEqual(add.group, room)
    XCTAssertEqual(add.epoch, 0)
    XCTAssertEqual(add.parts.count, 4)
    XCTAssertFalse(add.parts[2].isEmpty)

    let joined = try b.joinWelcome(add.parts[2], room: room, committer: a.id, nowMs: nowMs())
    XCTAssertEqual(joined, Joined(group: room, epoch: 1, addedBy: a.id))
    XCTAssertEqual(b.room, room)
    for device in [a, b] {
      let group = try XCTUnwrap(try device.groups().first)
      XCTAssertEqual(group.epoch, 1)
      XCTAssertEqual(Set(group.leaves), Set([a.id, b.id]))
      XCTAssertFalse(group.pending)
    }
    let key = try a.contentKey(group: room, epoch: 1)
    XCTAssertEqual(key.count, 32)
    XCTAssertEqual(try b.contentKey(group: room, epoch: 1), key)
    // B was not there at epoch 0 and A has not handed that key over.
    XCTAssertEqual(refusedCode { _ = try b.contentKey(group: room, epoch: 0) }, "no-key")

    // The Commit that added B, as the log brings it: A applied it when the hub accepted it (a duplicate now); for B
    // it lies behind the epoch its Welcome put it in, and is passed over.
    let addEntry = LogEntry(change: change, group: room, kind: .commit(bytes: add.parts[0], recoveryAuth: nil))
    XCTAssertThrowsError(try a.processLogEntry(addEntry)) {
      XCTAssertEqual(($0 as? TrommiError)?.code, "wrong-epoch")
      XCTAssertEqual(a.logFinding($0), .duplicate)
    }
    XCTAssertEqual(try b.processLogEntry(addEntry), .skipped)
    XCTAssertEqual(b.cursor, change)

    // A's next Commit reaches B through the log: both stand at epoch 2 with one key.
    _ = try XCTUnwrap(try a.update(group: room, forced: true, nowMs: nowMs()))
    let update = try accept(a, .commit, &change)
    XCTAssertEqual(update.epoch, 1)
    let done = try b.processLogEntry(LogEntry(change: change, group: room, kind: .commit(bytes: update.parts[0], recoveryAuth: nil)))
    XCTAssertEqual(done, .commit(group: room, epoch: 2, superseded: nil, removed: false))
    XCTAssertEqual(b.cursor, change)
    XCTAssertEqual(try b.contentKey(group: room, epoch: 2), try a.contentKey(group: room, epoch: 2))
    XCTAssertNotEqual(try a.contentKey(group: room, epoch: 2), key)

    // The handover of the old key: a stored message of the room group, which B opens.
    XCTAssertFalse(try a.sendHandover(group: room, recipient: b.id).isEmpty)
    let handover = try accept(a, .message, &change)
    let taken = try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: handover.parts[0])))
    guard case .message(.keys(let from, let count, _)) = taken else { return XCTFail("\(taken)") }
    XCTAssertEqual(from, a.id)
    XCTAssertGreaterThan(count, 0)
    XCTAssertEqual(try b.contentKey(group: room, epoch: 0), try a.contentKey(group: room, epoch: 0))

    // A stroke piece is relayed, not stored.
    _ = try a.sendStrokePiece(board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#))
    // (The real hub gives a relayed message no change number and keeps it out of the log; the core takes a message
    // only as a log entry above its cursor. Until it has a call for a relayed message, this one gets a number.)
    let piece = try accept(a, .relayMessage, &change)
    let drawn = try b.processLogEntry(LogEntry(change: change, group: room, kind: .message(bytes: piece.parts[0])))
    XCTAssertEqual(drawn, .message(.strokePiece(from: a.id, board: ALL_DESKS_BOARD, piece: utf8(#"{"p":[1,2]}"#))))

    // An agent device is enrolled and a session founded: the session's agent is told by the room's roles.
    _ = try a.changeAgents(enrol: [agent.id], remove: [], nowMs: nowMs())
    let enrol = try accept(a, .commit, &change)
    _ = try b.processLogEntry(LogEntry(change: change, group: room, kind: .commit(bytes: enrol.parts[0], recoveryAuth: nil)))
    let session = try a.foundSession(agent: agent.id, keyPackages: [try b.keyPackage(nowMs: nowMs()), try agent.keyPackage(nowMs: nowMs())], nowMs: nowMs())
    XCTAssertEqual(session.count, 16)
    // The founding's parts: GroupInfo 0, SealedKey 0, the first Commit, its GroupInfo, its Welcome, its SealedKey.
    let founding = try accept(a, .groupFounding, &change)
    XCTAssertEqual(founding.group, room + session)
    XCTAssertEqual(founding.parts.count, 6)
    _ = try b.joinWelcome(founding.parts[4], room: room, committer: a.id, nowMs: nowMs())
    for device in [a, b] {
      let group = try XCTUnwrap(try device.groups().first { $0.session != nil })
      XCTAssertEqual(group.group, room + session)
      XCTAssertEqual(group.session, SessionInfo(session: session, parent: nil, agents: [agent.id]))
      XCTAssertEqual(Set(group.leaves), Set([a.id, b.id, agent.id]))
      XCTAssertEqual(try (device as? LiveDevice)?.disallowed(group: group.group), [])
    }
    XCTAssertEqual(try a.contentKey(group: room + session, epoch: 1), try b.contentKey(group: room + session, epoch: 1))
    XCTAssertTrue(a.outbox().isEmpty)
  }

  /// A Welcome that is not from the device the joiner was told (its inviter) is refused, and the KeyPackage it was for
  /// is spent with it: the same Welcome is `not-member` afterwards, and the device asks to be added again.
  func testAWelcomeFromTheWrongCommitterIsRefusedForGood() throws {
    var change: UInt64 = 0
    let a = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32)))
    let b = try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32)))
    let room = try XCTUnwrap(a as? LiveDevice).foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    _ = try accept(a, .roomFounding, &change)
    _ = try a.addHumanDevice(b.id, keyPackage: try b.keyPackage(nowMs: nowMs()), nowMs: nowMs())
    let welcome = try accept(a, .commit, &change).parts[2]
    XCTAssertEqual(refusedCode { _ = try b.joinWelcome(welcome, room: systemRandom(32), committer: a.id, nowMs: nowMs()) }, "wrong-room")
    XCTAssertEqual(refusedCode { _ = try b.joinWelcome(welcome, room: room, committer: a.id, nowMs: nowMs()) }, "not-member")
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

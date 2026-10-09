// Runs tests/bindings/scenario.json through the Swift binding. The steps mean what they mean in
// tests/bindings/scenario.mjs, which runs the same file through the browser binding.
import Foundation
import XCTest
import TrommiCoreRust

/// One step of the scenario, as the JSON spells it.
struct Step: Decodable {
  let `do`: String
  var device: String?
  var by: String?
  var agent: String?
  var humans: [String]?
  var devices: [String]?
  var group: String?
  var name: String?
  var number: UInt32?
  var text: String?
  var message: String?
  var bytes: Int?
  var pieces: Int?
  var count: Int?
  var remember: Bool?
  var same: Bool?
  var removed: Bool?
  var refused: String?
  var epoch_of: String?
  var like: String?
  var epoch: UInt64?
}

struct Scenario: Decodable {
  let steps: [Step]
}

struct Unexpected: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

func check(_ holds: Bool, _ what: String) throws {
  if !holds { throw Unexpected(what) }
}

func now() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

/// The least a hub does: one change counter, the ordered log, the Welcomes, and what it serves a device that
/// comes with the recovery code (every GroupInfo of the room group, every SealedKey, the links).
final class Hub {
  var change: UInt64 = 0
  var log: [LogEntry] = []
  var welcomes: [(change: UInt64, bytes: Data)] = []
  /// The room group's GroupInfo of every epoch, from its founding.
  var roomInfos: [Data] = []
  /// Per session group: its founding GroupInfo and its newest.
  var sessions: [Data: (founding: Data, current: Data)] = [:]
  var rows: [Data] = []
  var links: [Data] = []

  /// Posts everything in the device's outbox and reports each as accepted.
  func post(_ device: CoreDevice) throws {
    for entry in try device.outbox() {
      func part(_ at: Int) -> Data { at < entry.parts.count ? entry.parts[at] : Data() }
      // Where the Commit, its GroupInfo, its Welcome, its SealedKey and its RecoveryAuth stand among the parts.
      var commit: (bytes: Data, groupInfo: Data, welcome: Data, sealedKey: Data, recoveryAuth: Data?)?
      switch entry.kind {
      case .groupFounding:
        rows.append(part(1))
        sessions[entry.group ?? Data()] = (part(0), part(0))
        commit = (part(2), part(3), part(4), part(5), nil)
      case .commit: commit = (part(0), part(1), part(2), part(3), nil)
      case .externalCommit: commit = (part(0), part(1), Data(), part(2), part(3))
      case .recoveryCode:
        commit = (part(0), part(1), Data(), part(2), nil)
        links.append(part(3))
      default: break
      }
      var accepted: UInt64?
      if entry.kind == .roomFounding {
        roomInfos.append(part(0))
        rows.append(part(1))
        change += 1
        accepted = change
      } else if let commit, let group = entry.group {
        change += 1
        accepted = change
        rows.append(commit.sealedKey)
        if group.count == 32 { roomInfos.append(commit.groupInfo) } else { sessions[group]?.current = commit.groupInfo }
        if !commit.welcome.isEmpty { welcomes.append((change, commit.welcome)) }
        log.append(LogEntry(change: change, group: group, kind: .commit, bytes: commit.bytes, recoveryAuth: commit.recoveryAuth))
      } else if entry.kind == .message, let group = entry.group {
        change += 1
        accepted = change
        log.append(LogEntry(change: change, group: group, kind: .message, bytes: part(0), recoveryAuth: nil))
      }
      try device.outboxAccepted(id: entry.id, change: accepted)
    }
  }

  /// A group as the hub serves it to a device that verifies it from its founding.
  func served(_ group: Data, founding: Data, current: Data) -> ServedGroup {
    let commits = log.filter { $0.kind == .commit && $0.group == group }
      .map { ServedCommit(change: $0.change, commit: $0.bytes, recoveryAuth: $0.recoveryAuth) }
    return ServedGroup(founding: founding, commits: commits, current: current)
  }

  /// The room as the hub serves it to a device that comes with the recovery code.
  func servedRoom(_ room: Data, code: Data) throws -> ServedRoom {
    let anchor = try recoveryAnchor(recoveryCode: code, room: room, rows: rows)
    return ServedRoom(
      room: room, group: served(room, founding: roomInfos[0], current: roomInfos[roomInfos.count - 1]),
      anchor: roomInfos[Int(anchor.epoch)], rows: rows, links: links, sessions: [])
  }

  /// Hands the device the log after its cursor, with every Welcome at its place. Returns what the entries did.
  func sync(_ device: CoreDevice, room: Data) throws -> [Processed] {
    var done: [Processed] = []
    let cursor = try device.cursor()
    for entry in log where entry.change > cursor {
      do {
        done.append(try device.processLogEntry(entry: entry))
      } catch let CoreError.Refused(code, _) where logFinding(code: code) == .duplicate {
        // An entry behind what the device holds (its own Commit, a group's Commits before it joined) is passed over.
      }
      for welcome in welcomes where welcome.change == entry.change {
        // A Welcome for another device does not open here: that is no finding.
        _ = try? device.joinWelcome(welcome: welcome.bytes, room: room, committer: nil, nowMs: now())
      }
    }
    return done
  }
}

final class ScenarioTests: XCTestCase {
  let hub = Hub()
  var stores: [String: FileStore] = [:]
  var devices: [String: CoreDevice] = [:]
  var groups: [String: Data] = [:]
  var remembered: [String: [OutboxEntry]] = [:]
  var room = Data()
  /// The recovery code in force.
  var code = Data()
  var folder = URL(fileURLWithPath: NSTemporaryDirectory())

  override func setUpWithError() throws {
    folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("trommi-bindings-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDown() {
    devices.values.forEach { $0.close() }
    try? FileManager.default.removeItem(at: folder)
  }

  func device(_ name: String?) throws -> CoreDevice {
    guard let name, let device = devices[name] else { throw Unexpected("no device \(name ?? "?")") }
    return device
  }

  func group(_ name: String?) throws -> Data {
    guard let name, let group = groups[name] else { throw Unexpected("no group \(name ?? "?")") }
    return group
  }

  /// A device on the stored state `name`, new or as stored.
  func start(_ name: String, create: Bool) throws -> (CoreDevice, FileStore) {
    // A device that closes, or cannot be opened, lets its store go itself: the lock is free again.
    let store = FileStore(directory: folder.appendingPathComponent(name))
    return (create ? try CoreDevice.create(store: store) : try CoreDevice.open(store: store), store)
  }

  func key(_ name: String, _ groupName: String?) throws -> (epoch: UInt64, key: Data) {
    let id = try group(groupName)
    let epoch = try device(name).group(group: id).epoch
    return (epoch, try device(name).contentKey(group: id, epoch: epoch))
  }

  func run(_ step: Step) throws {
    switch step.do {
    case "create":
      let (device, store) = try start(step.device!, create: true)
      devices[step.device!] = device
      stores[step.device!] = store
    case "found_room":
      code = try generateRecoveryCode()
      room = try device(step.device).foundRoom(recoveryCode: code, nowMs: now())
      groups["room"] = try roomGroupId(room: room)
    case "post":
      try hub.post(device(step.device))
    case "add_human":
      let newcomer = try device(step.device)
      let keyPackage = try newcomer.keyPackage(nowMs: now())
      try check(try keyPackageInfo(keyPackage: keyPackage).device == newcomer.id(), "the KeyPackage names another device")
      _ = try device(step.by).addHumanDevice(device: newcomer.id(), keyPackage: keyPackage, nowMs: now())
    case "join":
      guard let welcome = hub.welcomes.last?.bytes else { throw Unexpected("no Welcome") }
      let inviter = try device(step.by).id()
      let joined = try device(step.device).joinWelcome(welcome: welcome, room: room, committer: inviter, nowMs: now())
      try check(joined.offending.isEmpty && joined.addedBy == inviter, "the join is not the expected one")
    case "same_key":
      let keys = try step.devices!.map { try key($0, step.group) }
      try check(keys[0].key.count == 32, "a content key is not 32 bytes")
      try check(keys.allSatisfy { $0.epoch == keys[0].epoch && $0.key == keys[0].key }, "the keys of \(step.group!) differ")
    case "sign_in":
      let signed = try device(step.device).hubSignIn(room: room, hub: "https://hub.example", challenge: Data(repeating: 9, count: 32))
      try check(signed.signature.count == 64 && signed.auth.count > 96, "the sign-in is not a signed HubAuth")
    case "enrol":
      _ = try device(step.by).changeAgents(enrol: [device(step.device).id()], remove: [], nowMs: now())
    case "observe":
      try device(step.device).observeRoom(groupInfo: hub.roomInfos[hub.roomInfos.count - 1], expectedState: nil)
    case "sync":
      let done = try hub.sync(device(step.device), room: room)
      if let expected = step.message {
        let message = done.first { $0.kind == .message }?.message
        try check(message?.kind == .workTrail && message?.payload == Data(expected.utf8), "the message did not arrive as it was sent")
      }
      if step.removed == true { try check(done.contains { $0.removed }, "the device did not learn of its removal") }
    case "found_session":
      let keyPackages = try (step.humans! + [step.agent!]).map { try device($0).keyPackage(nowMs: now()) }
      let session = try device(step.by).foundSession(agent: device(step.agent).id(), keyPackages: keyPackages, nowMs: now())
      groups[step.name!] = try sessionGroupId(room: room, session: session)
    case "work_trail":
      _ = try device(step.device).sendWorkTrail(
        group: group(step.group), turn: Data(repeating: 7, count: 16), number: step.number!, step: Data(step.text!.utf8), nowMs: now())
    case "file":
      try file(bytes: step.bytes!, pieces: step.pieces!)
    case "restart":
      let name = step.device!
      let id = try? device(name).id()
      devices[name]?.close()
      let (again, store) = try start(name, create: false)
      devices[name] = again
      stores[name] = store
      if let id { try check(try again.id() == id, "the device opened from its store is another") }
    case "update":
      _ = try device(step.device).update(group: group(step.group), forced: true, nowMs: now())
    case "outbox":
      let outbox = try device(step.device).outbox()
      try check(outbox.count == step.count!, "the outbox of \(step.device!) holds \(outbox.count), not \(step.count!)")
      if step.remember == true { remembered[step.device!] = outbox }
      if step.same == true { try check(outbox == remembered[step.device!], "the outbox is not the same after the restart") }
    case "fail_next_write":
      stores[step.device!]!.failNextWrite()
    case "second_owner":
      let (second, _) = try start(step.device!, create: false)
      second.close()
    case "remove_human":
      let gone = Cut(device: try device(step.device).id(), seq: 0, hash: Data(count: 32))
      _ = try device(step.by).removeHumanDevices(cuts: [gone], nowMs: now())
    case "clean_session":
      let id = try group(step.group)
      let cuts = try device(step.by).group(group: id).disallowed.map { Cut(device: $0, seq: 0, hash: Data(count: 32)) }
      _ = try device(step.by).cleanSession(group: id, cuts: cuts, replacement: nil, nowMs: now())
    case "join_with_code":
      let joined = try device(step.device).joinRoomWithCode(recoveryCode: code, served: hub.servedRoom(room, code: code), nowMs: now())
      try check(joined.outbox.count == 1 && joined.unverified.isEmpty && joined.missingLink == nil, "the room did not verify whole")
    case "join_session_with_code":
      let id = try group(step.group)
      guard let session = hub.sessions[id] else { throw Unexpected("the hub has no such session") }
      _ = try device(step.device).joinSessionWithCode(
        recoveryCode: code, served: hub.served(id, founding: session.founding, current: session.current), nowMs: now())
    case "earlier_key":
      let id = try group(step.group)
      let mine = try device(step.device).contentKey(group: id, epoch: step.epoch!)
      let theirs = try device(step.like).contentKey(group: id, epoch: step.epoch!)
      try check(mine == theirs && (try device(step.device).keyIsConfirmed(group: id, epoch: step.epoch!)), "the code did not open the earlier key")
    case "replace_code":
      let next = try device(step.device).newRecoveryCode(recoveryCode: code)
      try check(next.count == 32 && next != code, "the new code is not a new code")
      _ = try device(step.device).replaceCode(recoveryCode: code, account: Data("the account's sealed copies".utf8), nowMs: now())
      code = next
    case "holds_recovery_mac":
      try check(try device(step.device).holdsRecoveryMac(), "the device does not hold the key of the code in force")
    case "no_key":
      let epoch = try key(step.epoch_of!, step.group).epoch
      _ = try device(step.device).contentKey(group: group(step.group), epoch: epoch)
    default:
      throw Unexpected("the scenario has a step this test does not know: \(step.do)")
    }
  }

  func file(bytes: Int, pieces: Int) throws {
    let plain = Data((0..<bytes).map { UInt8($0 % 251) })
    let encryptor = try FileEncryptor()
    var stored: [Data] = []
    for start in stride(from: 0, to: plain.count, by: pieces) {
      stored.append(try encryptor.update(plaintext: plain.subdata(in: start..<min(start + pieces, plain.count))))
    }
    let end = try encryptor.finish()
    stored.append(end.stored)
    try check(end.plainLen == UInt64(bytes) && (try fileLayout(storedLen: end.storedLen)).plainLen == UInt64(bytes), "the file has another length")
    let decryptor = try FileDecryptor(file: end.file)
    var opened = Data()
    for piece in stored { opened.append(try decryptor.update(stored: piece)) }
    opened.append(try decryptor.finish())
    try check(opened == plain, "the file came back changed")
    // One changed byte: the file is refused at the latest when it ends.
    stored[0][stored[0].startIndex + 30] ^= 1
    let tampered = try FileDecryptor(file: end.file)
    var refused: ErrorCode?
    do {
      for piece in stored { _ = try tampered.update(stored: piece) }
      _ = try tampered.finish()
    } catch let CoreError.Refused(code, _) {
      refused = code
    }
    try check(refused == .decryptFailed, "a changed file was not refused")
  }

  /// A process that dies runs no orderly close. Here the first device is left as it is, alive and unclosed, and
  /// only the operating system's part is played: its lock goes. The next device finds the request that was
  /// written and not sent, byte for byte; and a store object in use cannot be handed to a second device.
  func testADeviceThatDiedLeavesItsRequestToTheNext() throws {
    let (first, store) = try start("K", create: true)
    _ = try first.foundRoom(recoveryCode: generateRecoveryCode(), nowMs: now())
    let before = try first.outbox()
    XCTAssertEqual(before.count, 1)
    // The store object belongs to the first device: a second open with it fails and leaves the first its lock.
    XCTAssertThrowsError(try CoreDevice.open(store: store))
    XCTAssertThrowsError(try start("K", create: false)) { error in
      guard case let CoreError.Refused(code, _) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(code, .storage)
    }
    store.close()
    let (next, _) = try start("K", create: false)
    XCTAssertEqual(try next.outbox(), before)
    XCTAssertEqual(try next.id(), try first.id())
    // The one that "died" wrote nothing more; if it did, it would find out that it is the owner no longer.
    _ = try next.keyPackage(nowMs: now())
    XCTAssertThrowsError(try first.keyPackage(nowMs: now()))
    next.close()
  }

  func testTheScenario() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scenario.json")
    let scenario = try JSONDecoder().decode(Scenario.self, from: Data(contentsOf: file))
    var ran = 0
    for var step in scenario.steps {
      if step.do == "no_key" { step.refused = "no-key" }
      var refused: String?
      do {
        try run(step)
      } catch let CoreError.Refused(code, message) {
        guard step.refused != nil else { return XCTFail("step \(ran + 1) (\(step.do)): \(message)") }
        refused = errorCodeText(code: code)
      }
      if let expected = step.refused {
        XCTAssertEqual(refused, expected, "step \(ran + 1) (\(step.do))")
        if refused != expected { return }
      }
      ran += 1
    }
    XCTAssertEqual(ran, scenario.steps.count)
    XCTAssertGreaterThan(ran, 70)
  }
}

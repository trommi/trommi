// The client's engine (`Room`, `HubClient`) with the real core against the real hub: the binary of the crate `hub/`
// (branch v2-hub), started here on a port of this machine with a data folder of its own. Runs only when the
// environment names the binary:
//
//   TROMMI_HUB_BIN=<path to trommi-hub> swift test --filter RealHubTests
//
// Without the variable every test here is skipped, so `swift test` passes on a machine without the hub.
// With TROMMI_STRICT_HUB=1 as well, the two tests that stop where the hub and the core part fail there instead.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

/// One hub process for one test.
final class HubProcess {
  let url: String
  private let process = Process()

  /// Starts the hub and waits until it answers. nil: the environment names no binary.
  init?(data: URL) throws {
    guard let binary = ProcessInfo.processInfo.environment["TROMMI_HUB_BIN"], !binary.isEmpty else { return nil }
    let port = Int.random(in: 20_000..<40_000)
    url = "http://127.0.0.1:\(port)"
    process.executableURL = URL(fileURLWithPath: binary)
    // What the hub reads (hub/src/config.rs): where it listens, where it keeps its data, and the address devices sign.
    process.environment = ["HUB_HOST": "127.0.0.1", "HUB_PORT": String(port), "HUB_DATA": data.path, "HUB_URL": url, "HUB_QUIET": "1", "HUB_LOGIN_THROTTLE": "off"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let until = Date().addingTimeInterval(10)
    while Date() < until {
      if process.isRunning, let data = try? Data(contentsOf: URL(string: "\(url)/healthz")!), !data.isEmpty { return }
      Thread.sleep(forTimeInterval: 0.05)
    }
    process.terminate()
    throw TrommiError("test", "the hub did not start")
  }

  func stop() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}

final class RealHubTests: XCTestCase {
  private var hub: HubProcess?
  private var transport: [AnyClass] = []
  private let tools = LiveCore()
  /// TROMMI_STRICT_HUB=1: a point where the hub and the core part, which a test otherwise documents and stops at,
  /// fails that test.
  private let strict = ProcessInfo.processInfo.environment["TROMMI_STRICT_HUB"] == "1"

  override func setUpWithError() throws {
    guard let started = try HubProcess(data: try scratchFolder(self).appendingPathComponent("hub")) else {
      throw XCTSkip("TROMMI_HUB_BIN names no hub binary")
    }
    hub = started
    Core.tools = tools
    // Other tests of this run answer the hub's routes in the process; these go to the real one.
    transport = HubClient.transportForTests
    HubClient.transportForTests = []
  }

  override func tearDown() {
    hub?.stop()
    HubClient.transportForTests = transport
  }

  /// SIGNING IN ON A NEW DEVICE WITH THE CODE (8.4), as RoomAccount.joinWithRecoveryCode is to do it: a new device in
  /// a new folder, the hub client signed in as the recovery key, the whole join by `LiveCore.joinWithRecoveryCode`,
  /// then the room record and the `Room`. (RoomAccount.swift still calls the shape Core.swift guessed, which the core
  /// cannot serve; this is the body it gets.)
  private func signIn(code: Bytes, room: RoomId, hubURL: String, challenge: Bytes? = nil) async throws -> (room: Room, notJoined: [(group: GroupId, code: String)]) {
    let store = try Store.new(base: try scratchFolder(self))
    let state = try store.openState(create: true)
    do {
      let device = try tools.createDevice(store: state)
      let hub = try HubClient(hubURL: hubURL, room: room, signer: try tools.recoverySigner(code: code))
      let role = try await hub.signIn(challenge: challenge)
      XCTAssertEqual(role, "recovery")
      let outcome = try await tools.joinWithRecoveryCode(device: device, code: code, hub: hub, nowMs: nowMs())
      XCTAssertNil(outcome.missingLink)
      let record = RoomRecord(hubURL: hubURL, roomId: hex(room), myDeviceId: hex(device.id), role: "human", deviceRegisterSent: false)
      try store.save(record)
      return (try Room(store: store, record: record, deviceStore: state, device: device), outcome.notJoined)
    } catch { state.close(); store.wipe(); throw error }
  }

  /// What the hub answers a login with: the room and the code, opened from the copy sealed under the password.
  private func login(hubURL: String, email: String, password: String) async throws -> (room: RoomId, code: Bytes, challenge: Bytes?) {
    let keys = try tools.passwordKeys(email: email, password: password, kdf: nil)
    let answer = try await HubClient(hubURL: hubURL).request("POST", "/account/login", body: ["account": email, "auth_key": keys.authKey], auth: false)
    let first = try XCTUnwrap((answer["rooms"] as? [JSON])?.first)
    let room = try unb64u(try XCTUnwrap(first["room_id"] as? String))
    let sealed = try unb64u(try XCTUnwrap(first["sealed_copy"] as? String))
    return (room, try tools.openCode(sealed, room: room, way: .password(wrapKey: keys.wrapKey)), (first["challenge"] as? String).flatMap { try? unb64u($0) })
  }

  private func leaves(_ room: Room, of group: GroupId) async throws -> Set<Bytes> {
    let listed = try await room.hub.groups().first { ($0["group_id"] as? String).flatMap { try? unb64u($0) } == group }
    return Set((listed?["leaves"] as? [String] ?? []).compactMap { try? unb64u($0) })
  }

  /// The founding as the app does it: the hub takes the SealedKey the core made, and the device signs in.
  func testFoundingAsTheAppDoesIt() async throws {
    let hubURL = try XCTUnwrap(hub).url
    let founded = try await Room.foundRoom(hubURL: hubURL, base: try scratchFolder(self))
    defer { founded.room.close() }
    XCTAssertEqual(founded.recoveryCode.count, 32)
    let role = try await founded.room.hub.signIn()
    XCTAssertEqual(role, "human")
    let device = try XCTUnwrap(founded.room.device as? LiveDevice)
    XCTAssertTrue(device.outbox().isEmpty)
    XCTAssertTrue(try device.holdsRecoveryMac())
    // The hub lists the founding's SealedKey, and the code finds its anchor in it.
    let sealed = try await ServedByHub(hub: founded.room.hub).sealedKeys()
    XCTAssertEqual(sealed.sealedKeys.count, 1)
    XCTAssertTrue(sealed.links.isEmpty)
    XCTAssertEqual(try tools.recoveryAnchor(code: founded.recoveryCode, room: founded.room.roomId, sealedKeys: sealed.sealedKeys).epoch, 0)
  }

  /// Everything behind the founding that one human device can do with what the binding has, against the real hub:
  /// an account made with the founding, the signed challenge, catching up, the account's routes, KeyPackages, a
  /// Commit, a relayed message, a file, the stream.
  func testOneDeviceAgainstTheHub() async throws {
    let hubURL = try XCTUnwrap(hub).url
    let made = try await Room.createAccount(hubURL: hubURL, email: "Ada@Example.com", password: "correct horse battery", base: try scratchFolder(self))
    let room = made.room
    defer { room.close() }
    let device = try XCTUnwrap(room.device as? LiveDevice)
    XCTAssertEqual(made.kit.email, "ada@example.com")
    XCTAssertEqual(made.kit.words.split(separator: " ").count, 12)
    XCTAssertTrue(device.outbox().isEmpty)

    // POST /v2/rooms/{room}/tokens with the signed challenge: a token, and the hub's word for this device.
    let role = try await room.hub.signIn()
    XCTAssertEqual(role, "human")
    let report = try await room.sync()
    XCTAssertEqual(report.refused, 0)
    let groups = try await room.hub.groups()
    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual((groups[0]["group_id"] as? String).flatMap { try? unb64u($0) }, room.roomId)
    XCTAssertEqual((groups[0]["leaves"] as? [String])?.compactMap { try? unb64u($0) }, [device.id])

    // The account the founding made: the hub hands back the KDF record and the copy under the password, and the
    // core derives and opens with them (a change of password proves both).
    let account = try await room.accountStatus()
    XCTAssertEqual(account?.email, "ada@example.com")
    XCTAssertEqual(account?.hasPassword, true)
    XCTAssertEqual(account?.hasRecovery, true)
    try await room.changePassword(current: "correct horse battery", next: "another long password")
    do { try await room.changePassword(current: "correct horse battery", next: "a third long password"); XCTFail("the old password still opens the code") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-login") }
    let kit = try await room.makeEmergencyKit(password: "another long password")
    XCTAssertEqual(kit.words.split(separator: " ").count, 12)
    let revision = try await room.accountStatus()?.revision
    XCTAssertEqual(revision, 3)
    // The words of the first kit open nothing any more: one error for that and for an unknown e-mail.
    do { _ = try await Room.resetPassword(hubURL: hubURL, account: "ada@example.com", words: made.kit.words, newPassword: "a fourth long password", base: try scratchFolder(self)); XCTFail("an old kit reset the password") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-recovery") }
    do { _ = try await Room.signInWithPassword(hubURL: hubURL, account: "ada@example.com", password: "a wrong long password", base: try scratchFolder(self)); XCTFail("a wrong password signed in") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-login") }
    // The right password gets the sealed code from the hub, and RoomAccount.joinWithRecoveryCode joins with it
    // (LiveCore.joinWithRecoveryCode); testASecondDeviceSignsInWithThePassword looks at that join closely.
    let outcome = try await Room.signInWithPassword(hubURL: hubURL, account: "ada@example.com", password: "another long password", base: try scratchFolder(self))
    if case .joined(let second) = outcome { XCTAssertEqual(second.roomId, room.roomId); second.close() }
    _ = try await room.sync()
    let base = try device.groups().first?.epoch ?? 0

    // KeyPackages: the room published what the core made when it caught up (PUT /v2/key-packages); an empty PUT
    // answers with how many the hub still holds, with that count nothing more is due, and a claim hands one out.
    // (Asked with a count of 0 the core would make a second full set, which the hub refuses with `too-many`: no
    // refusal for good by the core's table, so that entry would wait in front of everything else.)
    try await room.flush(timeoutMs: 5_000)
    let held = try await room.hub.request("PUT", "/key-packages", body: ["single_use": [String]()])
    let unused = try XCTUnwrap(Wire.int(held["unused"]))
    XCTAssertGreaterThan(unused, 0)
    XCTAssertNil(try device.keyPackagesToUpload(unusedAtHub: unused, nowMs: nowMs()))
    XCTAssertTrue(device.outbox().isEmpty)
    let claimed = try await room.hub.claimKeyPackages([device.id])
    XCTAssertEqual(claimed.map(\.device), [device.id])
    XCTAssertFalse(claimed[0].keyPackage.isEmpty)

    // A Commit: POST /v2/groups/{group}/commits. The hub's answer merges nothing; the outbox reads the changes
    // after it, where the Commit comes back and is merged (`flush` waits for that): the device's group then
    // stands where the hub's does.
    XCTAssertNotNil(try device.update(group: room.roomId, forced: true, nowMs: nowMs()))
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    XCTAssertEqual(try device.groups().first?.epoch, base + 1)
    XCTAssertEqual(try device.groups().first?.pending, false)
    let epoch = try await room.hub.groups().first?["epoch"] as? NSNumber
    XCTAssertEqual(epoch?.uint64Value, base + 1)
    // The log gives the Commit back as the client reads it: kind, group_id, bytes, change.
    let log = try await room.hub.changes(after: 0)
    let commits = (log["items"] as? [JSON] ?? []).compactMap(Room.Item.init)
    XCTAssertEqual(commits.count, Int(base) + 1)
    _ = try await room.sync()

    // A relayed message and a file.
    _ = try device.sendStrokePiece(board: ALL_DESKS_BOARD, piece: utf8("{}"))
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    let plain = systemRandom(70_000)
    let reference = try await room.uploadAttachment(plain, fileName: "a.bin", mediaType: "application/octet-stream")
    let fetched = try await room.fetchAttachment(reference)
    XCTAssertEqual(fetched, plain)

    // The stream opens with this device's token.
    let live = Task { await room.runLive() }
    for _ in 0..<100 where !room.live { try await Task.sleep(nanoseconds: 50_000_000) }
    XCTAssertTrue(room.live)
    live.cancel()
  }

  // (A device joining by invite against the real hub: to be written on the binding's invite calls through Room.)


  /// Two devices of one account. The first founds the room with its account and moves the room group on; the second
  /// logs in with the password, opens the code, signs in to the hub as the recovery key and joins from outside. Both
  /// then stand in one epoch with one key, and the second holds the keys of the epochs before it came. Then the
  /// first replaces the code (8.6), and a third device comes in with the password again.
  func testASecondDeviceSignsInWithThePassword() async throws {
    let hubURL = try XCTUnwrap(hub).url
    let email = "ada@example.com", password = "correct horse battery"
    let made = try await Room.createAccount(hubURL: hubURL, email: email, password: password, base: try scratchFolder(self))
    let first = made.room
    defer { first.close() }
    let a = try XCTUnwrap(first.device as? LiveDevice)
    let roomId = first.roomId
    XCTAssertNotNil(try a.update(group: roomId, forced: true, nowMs: nowMs()))
    first.pumpOutbox()
    try await first.flush(timeoutMs: 5_000)
    XCTAssertEqual(try a.groups().first?.epoch, 1)

    // The second device: the hub's login answer, the code, the join.
    let opened = try await login(hubURL: hubURL, email: email, password: password)
    XCTAssertEqual(opened.room, roomId)
    let signedIn = try await signIn(code: opened.code, room: roomId, hubURL: hubURL, challenge: opened.challenge)
    let second = signedIn.room
    defer { second.close() }
    XCTAssertTrue(signedIn.notJoined.isEmpty)
    let b = try XCTUnwrap(second.device as? LiveDevice)
    XCTAssertEqual(b.room, roomId)
    XCTAssertTrue(try b.isHuman())
    XCTAssertTrue(try b.holdsRecoveryMac())
    XCTAssertTrue(b.outbox().isEmpty)
    XCTAssertEqual(try b.groups().first?.epoch, 2)
    // The hub knows the new leaf, and the device signs in as itself now.
    let role = try await second.hub.signIn()
    XCTAssertEqual(role, "human")
    let listed = try await leaves(second, of: roomId)
    XCTAssertEqual(listed, Set([a.id, b.id]))
    // The log brings the first device the join with its RecoveryAuth, as the client reads it.
    let seen = try await first.sync()
    XCTAssertEqual(seen.refused, 0)
    XCTAssertEqual(try a.groups().first?.epoch, 2)
    XCTAssertEqual(Set(try a.groups().first?.leaves ?? []), Set([a.id, b.id]))
    for epoch in UInt64(0)...2 { XCTAssertTrue(try bothHoldKey(b, a, group: roomId, epoch: epoch), "epoch \(epoch)") }
    // The second device catches up from the start of the log and passes over what lies behind its join.
    let caught = try await second.sync()
    XCTAssertEqual(caught.refused, 0)
    XCTAssertEqual(try b.groups().first?.epoch, 2)

    // The code is replaced by the first device: the Commit, the link and the account's new copies in one request.
    let next = try a.newRecoveryCode(current: opened.code)
    let keys = try tools.passwordKeys(email: email, password: password, kdf: nil)
    let kit = try tools.kitKeysFor(.email(email), words: try tools.generateKitWords())
    let account: JSON = [
      "kit": ["auth_key": kit.authKey, "sealed_copy": b64u(try tools.sealCode(next, room: roomId, way: .kit(wrapKey: kit.wrapKey)))] as JSON,
      "password": ["sealed_copy": b64u(try tools.sealCode(next, room: roomId, way: .password(wrapKey: keys.wrapKey)))] as JSON,
    ]
    let id = try a.replaceCode(current: opened.code, account: Bytes(try JSONSerialization.data(withJSONObject: account)), nowMs: nowMs())
    let entry = try XCTUnwrap(a.outbox().first { $0.id == id })
    XCTAssertEqual(entry.kind, .recoveryCode)
    // Posted here as spec/hub-api.md says: the Commit's fields under `commit`, beside `recovery_link` and `account`
    // (the account from the entry's fifth part). The hub also takes the Commit's fields beside the other members.
    let body: JSON = ["commit": ["epoch": entry.epoch, "commit": b64u(entry.parts[0]), "group_info": b64u(entry.parts[1]), "sealed_key": b64u(entry.parts[2])] as JSON,
                      "recovery_link": b64u(entry.parts[3]), "account": try XCTUnwrap(JSONSerialization.jsonObject(with: Data(entry.parts[4])) as? JSON)]
    let answer: JSON
    do { answer = try await first.hub.request("POST", "/rooms/\(b64u(roomId))/recovery-code", body: body) }
    catch let refused as HubError where refused.code == "incomplete" && refused.message.contains("another room epoch") {
      // WHERE THE HUB AND THE CORE PART (not the client): the SealedKey of a room Commit that replaces the recovery
      // keys names the new room epoch (spec/v2.md 8.2, core/src); the hub of branch v2-hub wants the room epoch of
      // the Commit's note for every Commit (hub/src/delivery.rs, the call of `check_sealed_key` in `commit_in`). The
      // refusal is the hub's last word: the device takes its Commit back and keeps the code in force. The rest of
      // this test runs once the hub follows 8.2.
      XCTAssertEqual(refused.status, 400)
      if strict { XCTFail("the hub refuses the SealedKey of a Commit that replaces the recovery keys: \(refused)") }
      try a.outboxRefused(id, code: refused.code)
      XCTAssertTrue(a.outbox().isEmpty)
      XCTAssertEqual(try a.groups().first?.epoch, 2)
      XCTAssertEqual(try a.groups().first?.pending, false)
      XCTAssertEqual(try a.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: opened.code).id)
      return
    }
    try a.outboxAccepted(id, change: try XCTUnwrap(Room.accepted(.recoveryCode, answer) ?? nil))
    // The answer merged nothing: the Commit takes effect when the changes bring it back. With it merged, the new
    // key for the sealed keys goes to the other human device by itself (a stored message, posted by the outbox).
    XCTAssertEqual(try a.groups().first?.epoch, 2)
    _ = try await first.sync()
    XCTAssertEqual(try a.groups().first?.epoch, 3)
    try await first.flush(timeoutMs: 5_000)
    _ = try await second.sync()
    XCTAssertEqual(try b.groups().first?.epoch, 3)
    XCTAssertTrue(try b.holdsRecoveryMac())

    // The old code signs in no more; the password now opens the new one, and a third device joins with it.
    do { _ = try await signIn(code: opened.code, room: roomId, hubURL: hubURL); XCTFail("the replaced code signed in") }
    catch let refused as HubError { XCTAssertEqual(refused.code, "not-member") }
    let again = try await login(hubURL: hubURL, email: email, password: password)
    XCTAssertEqual(again.code, next)
    let third = try await signIn(code: again.code, room: roomId, hubURL: hubURL, challenge: again.challenge).room
    defer { third.close() }
    let c = try XCTUnwrap(third.device as? LiveDevice)
    XCTAssertEqual(try c.groups().first?.epoch, 4)
    _ = try await first.sync()
    for epoch in UInt64(0)...4 { XCTAssertTrue(try bothHoldKey(c, a, group: roomId, epoch: epoch), "epoch \(epoch)") }
    let all = try await leaves(first, of: roomId)
    XCTAssertEqual(all, Set([a.id, b.id, c.id]))
  }

  /// Every device is lost (8.7), against the hub's recovery routes: a room without an account, whose only device is
  /// given up. A new device signs in as the recovery key, opens a recovery, reads the room, builds the whole
  /// recovery, posts its parts and the finish. Afterwards it is the room's one human device, under a new code.
  func testAWholeRecoveryAgainstTheHub() async throws {
    let hubURL = try XCTUnwrap(hub).url
    let founded = try await Room.foundRoom(hubURL: hubURL, base: try scratchFolder(self))
    let roomId = founded.room.roomId, code = founded.recoveryCode
    let lost = try XCTUnwrap(founded.room.device as? LiveDevice).id
    founded.room.close()

    let store = try Store.new(base: try scratchFolder(self))
    let state = try store.openState(create: true)
    let device = try XCTUnwrap(try tools.createDevice(store: state) as? LiveDevice)
    let hub = try HubClient(hubURL: hubURL, room: roomId, signer: try tools.recoverySigner(code: code))
    try await hub.signIn()
    let room = b64u(roomId)
    // POST /v2/rooms/{room}/recovery: from here on the room takes nothing else for ten minutes.
    let opened = try await hub.request("POST", "/rooms/\(room)/recovery")
    let recovery = try XCTUnwrap(opened["recovery_id"] as? String)
    let served = try await ServedByHub(hub: hub).room { try self.tools.recoveryAnchor(code: code, room: roomId, sealedKeys: $0).epoch }.served
    let plan = try device.prepareRecovery(code, served: served)
    XCTAssertEqual(plan.removals.map(\.group), [roomId])
    XCTAssertEqual(plan.removals.first?.devices, [lost])
    // (the lost device stored nothing: GET /v2/groups/{group}/chains/{sender} is empty, its Cut is 0 and zeros)
    let chain = try await hub.chain(group: roomId, sender: lost, after: 0)
    XCTAssertEqual((chain["items"] as? [Any])?.count ?? 0, 0)
    let built = try device.recover(code, served: served, chains: [], account: [], nowMs: nowMs())
    XCTAssertEqual(PocketHub.waiting(device).map(\.kind), [11, 11, 12])
    for (index, entry) in PocketHub.waiting(device).enumerated() {
      XCTAssertTrue(built.outbox.contains(entry.id))
      func part(_ at: Int) -> Any { at < entry.parts.count && !entry.parts[at].isEmpty ? b64u(entry.parts[at]) as Any : NSNull() }
      if entry.kind == 11 {
        // One Commit of the recovery: Commit, GroupInfo, Welcome, SealedKey, RecoveryAuth. The hub keeps it apart.
        let answer: JSON
        do {
          answer = try await hub.request("POST", "/rooms/\(room)/recovery/\(recovery)/commits", body: [
            "group_id": b64u(entry.group ?? []), "epoch": entry.epoch, "commit": part(0), "group_info": part(1), "welcome": part(2), "sealed_key": part(3), "recovery_auth": part(4),
          ])
        } catch let refused as HubError where index == 1 && refused.code == "incomplete" && refused.message.contains("another room epoch") {
          // WHERE THE HUB AND THE CORE PART (not the client), as in testASecondDeviceSignsInWithThePassword: the hub
          // took the join (the first part) and refuses the Commit that removes the lost device and brings the new
          // code, for the room epoch its SealedKey names (spec/v2.md 8.2). The recovery is given up at the hub and
          // on the device, which is in no room, as before. The rest of this test runs once the hub follows 8.2.
          XCTAssertEqual(refused.status, 400)
          if strict { XCTFail("the hub refuses the SealedKey of a Commit that replaces the recovery keys: \(refused)") }
          let dropped = try await hub.request("DELETE", "/rooms/\(room)/recovery/\(recovery)")
          XCTAssertEqual(dropped["dropped"] as? Bool, true)
          while let waiting = PocketHub.waiting(device).first { try device.outboxRefused(waiting.id, code: refused.code) }
          XCTAssertTrue(PocketHub.waiting(device).isEmpty)
          XCTAssertNil(device.room)
          device.close()
          state.close()
          return
        }
        XCTAssertEqual(answer["kept"] as? Bool, true)
        try device.outboxAccepted(entry.id, change: nil)
      } else {
        // The finish: RecoveryLink and the account's copies (none: the room has no account). All or nothing.
        let answer = try await hub.request("POST", "/rooms/\(room)/recovery/\(recovery)/finish", body: ["recovery_link": part(0), "account": NSNull()])
        XCTAssertEqual(answer["published"] as? Bool, true)
        XCTAssertEqual((answer["device"] as? String).flatMap { try? unb64u($0) }, device.id)
        try device.outboxAccepted(entry.id, change: try XCTUnwrap(Wire.uint(answer["change"])))
      }
    }
    XCTAssertEqual(device.room, roomId)
    XCTAssertTrue(try device.isHuman())
    XCTAssertEqual(try device.roomRoles()?.humans, [device.id])
    XCTAssertEqual(try device.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: plan.newCode).id)

    // As a room of the app: the device signs in as itself, and the hub lists it as the one leaf.
    let record = RoomRecord(hubURL: hubURL, roomId: hex(roomId), myDeviceId: hex(device.id), role: "human", deviceRegisterSent: false)
    try store.save(record)
    let recovered = try Room(store: store, record: record, deviceStore: state, device: device)
    defer { recovered.close() }
    let role = try await recovered.hub.signIn()
    XCTAssertEqual(role, "human")
    let listed = try await leaves(recovered, of: roomId)
    XCTAssertEqual(listed, Set([device.id]))
    let report = try await recovered.sync()
    XCTAssertEqual(report.refused, 0)
    // The old code is no key of the room any more.
    do { try await HubClient(hubURL: hubURL, room: roomId, signer: try tools.recoverySigner(code: code)).signIn(); XCTFail("the replaced code signed in") }
    catch let refused as HubError { XCTAssertEqual(refused.code, "not-member") }
  }
}

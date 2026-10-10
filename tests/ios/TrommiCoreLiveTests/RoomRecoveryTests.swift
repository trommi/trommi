// Replacing the recovery code (spec/v1.md 8.6) and the recovery when every device is lost (8.7) through the engine
// (`Room`, Account.swift, RoomAccount.swift), with the real core and `PocketHub` behind the hub's routes
// (PocketRoutes.swift). The account is the one a test fills in: its sealed copies are the real core's.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class RoomRecoveryTests: XCTestCase {
  let tools = LiveCore()
  var hub = PocketHub()
  private var transport: [AnyClass] = []
  let email = "ada@example.org", password = "correct horse battery", accountId = "0f8fad5b-d9cb-469f-a165-70867728950e"

  override func setUp() async throws {
    Core.tools = tools
    transport = HubClient.transportForTests
    hub = PocketHub()
    PocketRoutes.install(hub)
  }
  override func tearDown() async throws { HubClient.transportForTests = transport }

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }
  private func code(of error: Error?) -> String { (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? "" }
  private func failure(_ op: () async throws -> Void) async -> Error? { do { try await op(); return nil } catch { return error } }

  /// The account of `room` as GET /v1/account gives it, with the code sealed under the password and under a kit;
  /// the kit's words. The kit also answers POST /v1/account/recover.
  @discardableResult private func account(room: RoomId, code: Bytes) throws -> String {
    let keys = try tools.passwordKeys(email: email, password: password, kdf: nil)
    let words = try tools.generateKitWords()
    let kit = try tools.kitKeysFor(.email(email), words: words)
    let kitCopy = b64u(try tools.sealCode(code, room: room, way: .kit(wrapKey: kit.wrapKey)))
    PocketRoutes.account = ["email": email, "account": accountId, "kit_form": "email", "revision": 3, "has_password": true,
                            "kdf": ["alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1] as JSON,
                            "password_copy": b64u(try tools.sealCode(code, room: room, way: .password(wrapKey: keys.wrapKey))), "kit_copy": kitCopy,
                            "user_handle": b64u(Bytes(repeating: 4, count: 16)), "passkeys": [JSON]()]
    PocketRoutes.logins[kit.authKey] = ["rooms": [["room_id": b64u(room), "sealed_copy": kitCopy] as JSON], "account": accountId, "email": email]
    return words
  }

  /// The code is replaced from Settings (8.6): one request with the room Commit, the link from the old code and the
  /// account's new copies (a new kit, and the password that was just used); the other device gets the new key for
  /// the sealed keys; a device comes in with the new code, and the old code opens the room no more.
  func testTheCodeIsReplacedWithThePasswordAndANewKit() async throws {
    let old = try tools.generateRecoveryCode()
    let founder = try newDevice()
    let room = try founder.foundRoom(recoveryCode: old, nowMs: nowMs())
    try hub.post(founder)
    try account(room: room, code: old)
    // The device of the person who replaces the code is a `Room`; it came in with the code, as a sign-in does.
    let me = try pocketRoom(self, room: room, tools: tools) { device in
      _ = try device.joinRoomWithCode(old, served: try self.hub.served(room: room, code: old, tools: self.tools), nowMs: nowMs())
      try self.hub.post(device)
    }
    addTeardownBlock { await me.shutdown() }
    try hub.deliver(to: founder)
    _ = try await me.sync()

    let wrong = await failure { _ = try await me.replaceRecoveryCode(way: .password("not the password!")) }
    XCTAssertEqual(code(of: wrong), "wrong-login")
    XCTAssertFalse(hub.kinds.contains(10), "nothing is sent for a wrong password")

    let kit = try await me.replaceRecoveryCode(way: .password(password))
    XCTAssertEqual(kit.email, email)
    XCTAssertEqual(kit.accountId, accountId)
    XCTAssertEqual(kit.words.split(separator: " ").count, 12)
    XCTAssertTrue(PocketRoutes.asked.contains("POST /rooms/\(b64u(room))/recovery-code"))
    XCTAssertEqual(hub.kinds.filter { $0 == 10 }.count, 1)
    XCTAssertEqual(hub.links.count, 1)

    // The account's new copies: a kit and the password's copy, nothing else. Both open to the one new code, whose
    // keys the room names now.
    let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(hub.account))) as? JSON)
    XCTAssertEqual(Set(sent.keys), ["kit", "password"])
    let sentKit = try XCTUnwrap(sent["kit"] as? JSON), sentPassword = try XCTUnwrap(sent["password"] as? JSON)
    XCTAssertEqual(Set(sentKit.keys), ["auth_key", "sealed_copy"])
    XCTAssertEqual(Set(sentPassword.keys), ["sealed_copy"], "the login hash stays: only the copy is new")
    let kitKeys = try tools.kitKeysFor(.email(email), words: kit.words)
    XCTAssertEqual(sentKit["auth_key"] as? String, kitKeys.authKey)
    let next = try tools.openCode(try unb64u(try XCTUnwrap(sentKit["sealed_copy"] as? String)), room: room, way: .kit(wrapKey: kitKeys.wrapKey))
    let passwordKeys = try tools.passwordKeys(email: email, password: password, kdf: nil)
    XCTAssertEqual(try tools.openCode(try unb64u(try XCTUnwrap(sentPassword["sealed_copy"] as? String)), room: room, way: .password(wrapKey: passwordKeys.wrapKey)), next)
    XCTAssertNotEqual(next, old)
    let mine = try XCTUnwrap(me.device as? LiveDevice)
    XCTAssertEqual(try mine.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: next).id)
    // Neither the password, the words nor a code went out in the clear.
    let said = String(decoding: Data(try XCTUnwrap(hub.account)), as: UTF8.self)
    for secret in [password, kit.words, b64u(next), hex(next), b64u(old)] { XCTAssertFalse(said.contains(secret)) }

    // The other device takes the Commit and the new key for the sealed keys, which this one sent by itself.
    try await me.flush()
    let got = try hub.deliver(to: founder)
    XCTAssertTrue(got.contains(.message(.recoveryAuth(from: mine.id))))
    XCTAssertTrue(try founder.holdsRecoveryMac())

    // A new device comes in with the new code; the old one opens the room no more.
    let third = try newDevice()
    _ = try third.joinRoomWithCode(next, served: try hub.served(room: room, code: next, tools: tools), nowMs: nowMs())
    try hub.post(third)
    XCTAssertEqual(third.room, room)
    let fourth = try newDevice()
    XCTAssertEqual(refusedCode { _ = try fourth.joinRoomWithCode(old, served: try self.hub.served(room: room, code: old, tools: self.tools), nowMs: nowMs()) }, "wrong-recovery")
  }

  /// A room whose two human devices are lost, each with Notes that interleave in the hub's order, and its account.
  private func lostRoom() throws -> (first: LiveDevice, second: LiveDevice, room: RoomId, code: Bytes, words: String) {
    let code = try tools.generateRecoveryCode()
    let first = try newDevice(), second = try newDevice()
    let room = try first.foundRoom(recoveryCode: code, nowMs: nowMs())
    try hub.post(first)
    _ = try second.joinRoomWithCode(code, served: try hub.served(room: room, code: code, tools: tools), nowMs: nowMs())
    try hub.post(second)
    try hub.deliver(to: first)
    for round in 0..<2 {
      for device in [first, second] {
        _ = try device.seal(.noteFirst(payload: utf8(#"{"schema_version":1,"text":"note \#(round)","previous_version_hash":"\#(b64u(ZERO32))"}"#)), files: [], nowMs: nowMs())
        try hub.post(device)
      }
    }
    return (first, second, room, code, try account(room: room, code: code))
  }

  /// Every device is lost (8.7), from the reset path: the kit's words open the code, and the new device removes the
  /// two lost ones, replaces the code and gets a new kit, all through the recovery's routes.
  func testAWholeRecoveryFromTheEmergencyKit() async throws {
    let (first, second, room, code, words) = try lostRoom()
    let base = try scratchFolder(self)
    var asked: Int?
    let done = try await Room.recoverAccount(hubURL: PocketRoutes.url, account: email, words: words, newPassword: "a brand new password", base: base) { asked = $0; return true }
    addTeardownBlock { await done.room.shutdown() }
    XCTAssertEqual(asked, 2, "the person is told how many devices go before anything is posted")
    XCTAssertEqual(done.removed, 2)
    XCTAssertEqual(Store.rooms(base: base), [hex(room)])

    // What went to the hub, in order: the recovery is opened, the chains of both lost devices are read, the parts
    // are posted into the recovery, and the finish comes last.
    let recovery = "/rooms/\(b64u(room))/recovery"
    let posts = PocketRoutes.asked.filter { $0.hasPrefix("POST \(recovery)") }
    XCTAssertEqual(posts.first, "POST \(recovery)")
    XCTAssertTrue(posts.last?.hasSuffix("/finish") == true)
    XCTAssertEqual(posts.filter { $0.hasSuffix("/commits") }.count, posts.count - 2)
    for lost in [first, second] { XCTAssertTrue(PocketRoutes.asked.contains("GET /groups/\(b64u(room))/chains/\(b64u(lost.id))")) }
    XCTAssertFalse(PocketRoutes.asked.contains { $0.hasPrefix("DELETE \(recovery)") })
    XCTAssertEqual(Array(hub.kinds.suffix(3)), [11, 11, 12])

    // The new device is the room's one human device, under a new code.
    let mine = try XCTUnwrap(done.room.device as? LiveDevice)
    XCTAssertEqual(mine.room, room)
    XCTAssertEqual(try mine.roomRoles()?.humans, [mine.id])
    XCTAssertTrue(try mine.holdsRecoveryMac())
    XCTAssertTrue(mine.outbox().isEmpty)
    XCTAssertNotEqual(try mine.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: code).id)
    // The account's new copies: a new kit and the password set anew, both holding the new code.
    let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(hub.account))) as? JSON)
    XCTAssertEqual(Set(sent.keys), ["kit", "password"])
    let sentKit = try XCTUnwrap(sent["kit"] as? JSON), sentPassword = try XCTUnwrap(sent["password"] as? JSON)
    XCTAssertEqual(Set(sentPassword.keys), ["auth_key", "sealed_copy", "kdf"])
    XCTAssertNotEqual(done.kit.words, words)
    let kitKeys = try tools.kitKeysFor(.email(email), words: done.kit.words)
    XCTAssertEqual(sentKit["auth_key"] as? String, kitKeys.authKey)
    let next = try tools.openCode(try unb64u(try XCTUnwrap(sentKit["sealed_copy"] as? String)), room: room, way: .kit(wrapKey: kitKeys.wrapKey))
    XCTAssertEqual(try mine.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: next).id)
    // A lost device, should it turn up, learns that it is out; and the new one reads on.
    XCTAssertTrue(try hub.deliver(to: first).contains { if case .commit(_, _, _, true) = $0 { return true } else { return false } })
    _ = try await done.room.sync()
    XCTAssertEqual(done.room.state.humans, 1)
  }

  /// THE ORDER OF THE CHAINS. The core reads the removed devices' envelopes in the order handed in and does not sort
  /// them: they go in as one list rising by change number across devices, never chain after chain. This holds down
  /// what the client hands in. (With both devices' envelopes in one epoch, as here, the core takes either order;
  /// the order decides once Commits lie between them.)
  func testTheRemovedDevicesChainsAreHandedInInTheHubsOrder() async throws {
    let (first, second, room, code, _) = try lostRoom()
    let client = try HubClient(hubURL: PocketRoutes.url, room: room, signer: try tools.recoverySigner(code: code))
    let chains = try await ServedByHub(hub: client).chains([(room, [first.id, second.id])])
    XCTAssertEqual(chains.count, 4)
    XCTAssertEqual(chains.map(\.change), chains.map(\.change).sorted(), "one list, rising by change number")
    // The two devices' envelopes interleave in it, as they did at the hub.
    let senders = chains.map { e in hub.chains.first { $0.change == e.change }?.sender }
    XCTAssertEqual(senders, [first.id, second.id, first.id, second.id])

    // In that order the recovery builds: the join, the removal of both with the new code, the finish.
    let served = try hub.served(room: room, code: code, tools: tools)
    let device = try newDevice()
    _ = try device.prepareRecovery(code, served: served)
    XCTAssertEqual(try device.recover(code, served: served, chains: chains, account: utf8("{}"), nowMs: nowMs()).outbox.count, 3)
  }

  /// A recovery the person does not confirm is dropped at the hub, and nothing of the device is left.
  func testARecoveryThatIsNotConfirmedIsDropped() async throws {
    let (first, _, room, _, words) = try lostRoom()
    let base = try scratchFolder(self)
    let kinds = hub.kinds
    let no = await failure { _ = try await Room.recoverAccount(hubURL: PocketRoutes.url, account: self.email, words: words, newPassword: "a brand new password", base: base) { _ in false } }
    XCTAssertEqual(code(of: no), "cancelled")
    XCTAssertTrue(PocketRoutes.asked.contains { $0.hasPrefix("DELETE /rooms/\(b64u(room))/recovery/") })
    XCTAssertEqual(hub.kinds, kinds, "nothing was posted")
    XCTAssertEqual(Store.rooms(base: base), [])
    XCTAssertEqual(try first.roomRoles()?.humans.count, 2)
  }

  /// SIGNING IN WITH THE CODE, INTERRUPTED (8.4). Before the hub accepted the join of the room group a failure
  /// leaves nothing. Once it did, the device is kept: a session join the hub did not answer is finished by the
  /// next sync, also after the app was ended in between, and only then is the code forgotten.
  func testAnInterruptedSignInKeepsTheDeviceOnceItIsInTheRoom() async throws {
    let secret = try tools.generateRecoveryCode()
    let a = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: secret, nowMs: nowMs())
    try hub.post(a)
    let invite = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[0]))
    _ = try a.inviteConfirm(invite: invite.invite, numbers: invite.inviterShows, requestHash: invite.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let keyPackage)? = try a.inviteSteps().first else { return XCTFail("the invite asks for no session") }
    let session = room + (try a.foundSession(agent: agent.id, keyPackages: [keyPackage], nowMs: nowMs()))
    try hub.post(a)
    let base = try scratchFolder(self)

    // The hub refuses the join of the room group: nothing is left.
    PocketRoutes.refuseOnce["POST /groups/\(b64u(room))/commits"] = "bad-commit"
    let refused = await failure { _ = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base) }
    XCTAssertEqual(code(of: refused), "bad-commit")
    XCTAssertEqual(Store.rooms(base: base), [])

    // The hub takes the join of the room group and fails on the session's: the device is in, and kept.
    PocketRoutes.refuseOnce["POST /groups/\(b64u(session))/commits"] = "internal"
    let joined = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base)
    XCTAssertEqual(Store.rooms(base: base), [hex(room)])
    XCTAssertEqual(try joined.store.load().codeJoin, true)
    let item = Room.joinCodeItem(joined.store.dir), folder = joined.store.dir
    XCTAssertEqual(try LocalKey.read(item, dir: folder), secret)
    XCTAssertEqual(try (joined.device as? LiveDevice)?.groups().map(\.group), [room])
    let id = joined.deviceIdHex
    // The app is ended, and opened again: the same device goes on.
    await joined.shutdown()
    let again = try Room.open(base: base, roomId: hex(room))
    addTeardownBlock { await again.shutdown() }
    XCTAssertEqual(again.deviceIdHex, id)
    _ = try await again.sync()
    try await again.flush()
    _ = try await again.sync()
    let device = try XCTUnwrap(again.device as? LiveDevice)
    XCTAssertEqual(Set(try device.groups().map(\.group)), [room, session])
    XCTAssertNil(again.record.codeJoin)
    XCTAssertNil(try again.store.load().codeJoin)
    XCTAssertNil(try LocalKey.read(item, dir: folder), "the code is forgotten once the join has finished")
  }
  /// SIGNING IN WITH THE CODE TO A ROOM WITH A LONG HISTORY (8.4, 8.5). The room group and a session group hold
  /// more Commits together than one slice (256) and than one page of a log: the logs are read page by page, handed
  /// to the core in slices in the hub's order across the two groups, and the device joins both.
  func testASignInWalksAHistoryLongerThanOneSlice() async throws {
    let secret = try tools.generateRecoveryCode()
    let a = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: secret, nowMs: nowMs())
    try hub.post(a)
    let invite = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[0]))
    _ = try a.inviteConfirm(invite: invite.invite, numbers: invite.inviterShows, requestHash: invite.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let keyPackage)? = try a.inviteSteps().first else { return XCTFail("the invite asks for no session") }
    let session = room + (try a.foundSession(agent: agent.id, keyPackages: [keyPackage], nowMs: nowMs()))
    try hub.post(a)
    // (the two groups' Commits interleave in the hub's order)
    for at in 0..<400 {
      _ = try a.update(group: at % 5 == 0 ? session : room, forced: true, nowMs: nowMs())
      try hub.post(a)
    }
    func commits(_ group: GroupId) -> Int { hub.log.filter { $0.group == group }.count }
    XCTAssertGreaterThan(commits(room), Slices.maxCommits)
    XCTAssertGreaterThan(commits(session), 64)

    let base = try scratchFolder(self)
    let joined = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base)
    addTeardownBlock { await joined.shutdown() }
    _ = try await joined.sync()
    try await joined.flush()
    _ = try await joined.sync()
    let device = try XCTUnwrap(joined.device as? LiveDevice)
    XCTAssertEqual(Set(try device.groups().map(\.group)), [room, session])
    XCTAssertGreaterThan(PocketRoutes.asked.filter { $0.hasSuffix("/groups/\(b64u(room))/log") }.count, 2, "the log is read in pages")
  }

  /// The join of the room group is taken and its answer is lost: the room group's log, handed to the core, holds
  /// the device's own join, so the sign-in goes on with this device; nothing is posted twice.
  func testALostAnswerToATakenJoinIsSettledByTheLog() async throws {
    let secret = try tools.generateRecoveryCode()
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: secret, nowMs: nowMs())
    try hub.post(a)
    let base = try scratchFolder(self)
    func commits() -> Int { hub.log.filter { if case .commit = $0.kind { return $0.group == room } else { return false } }.count }
    let before = commits()
    PocketRoutes.loseAnswers["POST /groups/\(b64u(room))/commits"] = 2
    let joined = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base)
    XCTAssertEqual(Store.folders(base).count, 1)
    XCTAssertEqual(Store.rooms(base: base), [hex(room)])
    XCTAssertEqual(commits(), before + 1, "one join")
    XCTAssertEqual(try (joined.device as? LiveDevice)?.room, room)
    XCTAssertNil(joined.store.unsureJoin)
    await joined.shutdown()
  }

  /// The join's answer is lost and the hub never took it: the next sign-in sends the same join once more and goes
  /// on with the same device.
  func testALostJoinTheHubNeverTookIsSentAgainByTheNextSignIn() async throws {
    let secret = try tools.generateRecoveryCode()
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: secret, nowMs: nowMs())
    try hub.post(a)
    let base = try scratchFolder(self)
    PocketRoutes.takeLost = false
    PocketRoutes.loseAnswers["POST /groups/\(b64u(room))/commits"] = 2
    let lost = await failure { _ = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base) }
    XCTAssertEqual(code(of: lost), "pending")
    let left = Store.folders(base)
    XCTAssertEqual(left.count, 1)

    let joined = try await Room.joinWithRecoveryCode(hubURL: PocketRoutes.url, roomId: hex(room), code: secret, base: base)
    XCTAssertEqual(joined.store.dir.standardizedFileURL, left[0].standardizedFileURL, "the same device")
    XCTAssertEqual(try (joined.device as? LiveDevice)?.room, room)
    await joined.shutdown()
  }
}

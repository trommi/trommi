// Replacing the recovery code (spec/v2.md 8.6) and the recovery when every device is lost (8.7) through the engine
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

  /// The account of `room` as GET /v2/account gives it, with the code sealed under the password and under a kit;
  /// the kit's words. The kit also answers POST /v2/account/recover.
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
}

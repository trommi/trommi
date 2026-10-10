// The account (Account.swift) against a core that seals nothing and a hub in the process: creating an account with
// the founding, signing in with password, Emergency Kit words and passkey, a new password, a new kit, and that no
// error says a secret.
//
// `AccountTools` is a test double, not cryptography: its "sealed copy" is the code in the clear behind a tag that
// names the way in, its "keys" are a fold of their inputs. It keeps what Account.swift relies on: a copy opens only
// under the way and the secret it was sealed with, and says `wrong-login` or `wrong-recovery` otherwise. Devices and
// everything else are FakeCore.swift's. `AccountHub` answers the account routes as hub/src/accounts.rs does.
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient

/** Not a hash: enough to tell two inputs apart in a test. */
private func fold(_ parts: [Bytes], _ n: Int) -> Bytes {
  var h = Bytes(repeating: 0x5a, count: n)
  var i = 0
  for p in parts { for x in p + [0xff] { h[i % n] = h[i % n] &* 31 &+ x &+ UInt8(truncatingIfNeeded: i); i += 1 } }
  return h
}

final class AccountSigner: CoreSigner {
  let id: DeviceId
  init(id: DeviceId) { self.id = id }
  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) { (challenge, [1]) }
}

final class AccountTools: CoreTools {
  let base = FakeTools()
  static let list = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "islet", "jolly", "kayak", "lemon", "maple", "north", "ocean"]
  private var made = 0
  /** The codes made, and the code the last join with a recovery code was given. */
  var codes = [Bytes]()
  var joinedWith: Bytes?
  /** How often the slow step ran. */
  var derivations = 0

  // ---- the account, as a double --------------------------------------------------------------------------------
  func normaliseEmail(_ email: String) throws -> String {
    let e = email.trimmingCharacters(in: .whitespaces).lowercased()
    guard e.split(separator: "@").count == 2 else { throw TrommiError("bad-email") }
    return e
  }
  func checkPassword(_ password: String) throws { if password.unicodeScalars.count < 12 { throw TrommiError("weak-password") } }
  func passwordKeys(email: String, password: String, kdf: String?) throws -> PasswordKeys {
    if let k = kdf, !k.contains("argon2id") { throw TrommiError("bad-kdf") }
    derivations += 1
    return PasswordKeys(authKey: b64u(fold([utf8("auth"), utf8(email), utf8(password)], 32)), wrapKey: fold([utf8("wrap"), utf8(email), utf8(password)], 32))
  }
  func kitAuthKey(email: String, words: String) throws -> String { b64u(fold([utf8("kit"), utf8(email), utf8(try parseKitWords(words))], 32)) }
  func generateKitWords() throws -> String {
    made += 1
    return (0..<12).map { Self.list[($0 * made + made) % Self.list.count] }.joined(separator: " ")
  }
  func parseKitWords(_ text: String) throws -> String {
    let words = text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
    guard words.count == 12, words.allSatisfy(Self.list.contains) else { throw TrommiError("bad-recovery-words") }
    return words.joined(separator: " ")
  }
  func generateRecoveryCode() throws -> Bytes { let c = systemRandom(32); codes.append(c); return c }
  func formatRecoveryCode(_ code: Bytes) -> String { hex(code) }
  func parseRecoveryCode(_ text: String) throws -> Bytes { try unhex(text) }
  private func tag(_ way: AccountWay, email: String, room: RoomId) -> Bytes {
    switch way {
    case .password(let key): return fold([utf8("password"), room, key], 28)
    case .kit(let words): return fold([utf8("recovery"), room, utf8(email), utf8(words)], 28)
    case .passkey(let prf, let id): return fold([utf8("passkey"), room, prf, id], 28)
    }
  }
  /** 61 bytes that begin with 0x02, as the hub asks of a sealed copy. */
  func sealCode(_ code: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes { [2] + tag(way, email: email, room: room) + code }
  func openCode(_ sealed: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes {
    guard sealed.count == 61, sealed[0] == 2 else { throw TrommiError("bad-format") }
    guard Bytes(sealed[1..<29]) == tag(way, email: email, room: room) else {
      if case .kit = way { throw TrommiError("wrong-recovery") }
      throw TrommiError("wrong-login")
    }
    return Bytes(sealed[29...])
  }
  func isFinalRefusal(_ code: String) -> Bool { base.isFinalRefusal(code) }
  func recoverySigner(code: Bytes) throws -> CoreSigner { AccountSigner(id: fold([code], 32)) }
  func joinWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> (missingLink: Bytes?, notJoined: [(group: GroupId, code: String)]) { joinedWith = code; return (nil, []) }

  // ---- everything else: FakeCore.swift -------------------------------------------------------------------------
  var version: String { base.version }
  func selfTest() -> [SelfTestStep] { base.selfTest() }
  func createDevice(store: CoreStorage) throws -> CoreDevice { try base.createDevice(store: store) }
  func openDevice(store: CoreStorage) throws -> CoreDevice { try base.openDevice(store: store) }
  func canonicalHub(_ text: String) throws -> String { try base.canonicalHub(text) }
  func parseInviteLink(_ text: String) throws -> InviteLinkParts { try base.parseInviteLink(text) }
  func inviteRequest(link: String, offer: Bytes, offerSignature: Bytes, device: CoreDevice, nowMs: UInt64) throws -> JoinRequest { try base.inviteRequest(link: link, offer: offer, offerSignature: offerSignature, device: device, nowMs: nowMs) }
  func inviteReveal(joiner: Bytes, reveal: Bytes, signature: Bytes) throws -> [UInt8] { try base.inviteReveal(joiner: joiner, reveal: reveal, signature: signature) }
  func checkEmoji(_ numbers: [UInt8]) -> [(emoji: String, word: String)] { base.checkEmoji(numbers) }
  func encryptFile(_ plain: Bytes) throws -> SealedFile { try base.encryptFile(plain) }
  func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes { try base.decryptFile(fileId: fileId, fileKey: fileKey, sha256: sha256, stored: stored) }
  func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts { try base.createShareLink(app: app, fileId: fileId, fileKey: fileKey, sha256: sha256) }
  func generatePushKey() throws -> Bytes { try base.generatePushKey() }
}

/** The hub's account routes, answered in the process for one room and its account. */
final class AccountHub: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var shared = Hub()
  final class Hub: @unchecked Sendable {
    let lock = NSLock()
    var room = ""                                    // base64url
    var account: [String: Any]?                      // as posted with the founding, plus what changed since
    var revision = 0
    var passkeys: [String: String] = [:]             // credential id -> sealed copy (base64url)
    var posted: [(method: String, path: String, body: [String: Any])] = []
    func paths(_ method: String) -> [String] { lock.withLock { posted.filter { $0.method == method }.map { $0.path } } }
    func body(_ method: String, _ path: String) -> [String: Any]? { lock.withLock { posted.last { $0.method == method && $0.path == path }?.body } }

    private func refuse(_ status: Int, _ code: String) -> (Int, Any) { (status, ["error": code, "message": "refused"]) }
    private func login(_ copy: Any?) -> (Int, Any) {
      (200, ["rooms": [["room_id": room, "sealed_copy": copy ?? "", "challenge": b64u(Bytes(repeating: 9, count: 32))]], "kdf": (account?["password"] as? [String: Any])?["kdf"] ?? NSNull()])
    }
    func answer(_ method: String, _ path: String, _ body: [String: Any]) -> (Int, Any) {
      lock.lock(); defer { lock.unlock() }
      posted.append((method, path, body))
      let password = account?["password"] as? [String: Any], kit = account?["kit"] as? [String: Any]
      let known = body["email"] as? String == account?["email"] as? String
      switch (method, path) {
      case ("POST", "/v2/rooms"):
        room = b64u(try! unhex(parse(try! unb64u(body["group_info"] as! String))["room"] as! String))
        account = body["account"] as? [String: Any]
        return (200, ["room_id": room])
      case ("GET", "/v2/account"):
        guard let a = account else { return refuse(404, "not-found") }
        return (200, ["email": a["email"]!, "revision": revision, "has_password": password != nil, "kdf": password?["kdf"] ?? NSNull(), "password_copy": password?["sealed_copy"] ?? NSNull(),
                      "kit_copy": kit?["sealed_copy"] ?? NSNull(), "user_handle": b64u(Bytes(repeating: 4, count: 32)), "passkeys": passkeys.keys.sorted().map { ["credential_id": $0] }, "rooms": [room]])
      case ("POST", "/v2/account/login"):
        return known && body["auth_key"] as? String == password?["auth_key"] as? String ? login(password?["sealed_copy"]) : refuse(401, "wrong-login")
      case ("POST", "/v2/account/recover"):
        return known && body["auth_key"] as? String == kit?["auth_key"] as? String ? login(kit?["sealed_copy"]) : refuse(401, "wrong-recovery")
      case ("PUT", "/v2/account/password"), ("PUT", "/v2/account/kit"):
        guard (body["revision"] as? NSNumber)?.intValue == revision else { return refuse(409, "account-changed") }
        var part = body; part["revision"] = nil
        account?[path.hasSuffix("kit") ? "kit" : "password"] = part
        revision += 1
        return (200, ["revision": revision])
      case ("POST", "/v2/account/passkeys/challenge"), ("POST", "/v2/account/passkey/challenge"): return (200, ["challenge": b64u(Bytes(repeating: 8, count: 32))])
      case ("POST", "/v2/account/passkeys"):
        // (the double of the system's step puts the credential id into the "attestation")
        passkeys[body["attestation_object"] as! String] = body["sealed_copy"] as? String
        revision += 1
        return (200, ["credential_id": body["attestation_object"]!, "created_at": 1])
      case ("POST", "/v2/account/passkey/login"):
        guard let copy = passkeys[body["credential_id"] as? String ?? ""] else { return refuse(401, "wrong-login") }
        return login(copy)
      case ("GET", _) where path.hasSuffix("/challenge"): return (200, ["challenge": b64u(Bytes(repeating: 9, count: 32))])
      case ("POST", _) where path.hasSuffix("/tokens"): return (200, ["token": "t", "expires_at": nowMs() + 600_000, "role": "human"])
      case ("POST", _) where path.hasSuffix("/recovery"): return (200, ["recovery_id": "r1"])
      case ("GET", _) where path.hasSuffix("/groups"): return (200, [Any]())
      case ("GET", "/v2/sealed-keys"): return (200, ["rows": [String](), "more": false])
      default: return (200, [String: Any]())   // (the rest of a join: taken)
      }
    }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    guard let url = request.url else { return }
    var data = request.httpBody ?? Data()
    if data.isEmpty, let s = request.httpBodyStream { s.open(); var buf = [UInt8](repeating: 0, count: 65536); while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }; s.close() }
    let (status, answer) = AccountHub.shared.answer(request.httpMethod ?? "GET", url.path, parse(Bytes(data)))
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: answer))
    client?.urlProtocolDidFinishLoading(self)
  }
}

@MainActor
final class AccountTests: XCTestCase {
  var root: URL!
  var tools: AccountTools!
  var hub: AccountHub.Hub { AccountHub.shared }
  let hubURL = "http://127.0.0.1:9"
  let email = "Ada@Example.org", password = "correct horse battery", other = "another long password"

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("trommi-account-\(UUID().uuidString)")
    tools = AccountTools()
    Core.tools = tools
    HubClient.transportForTests = [AccountHub.self]
    AccountHub.shared = AccountHub.Hub()
  }
  override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }

  /** A device's own folder: every sign-in of these tests is "another device". */
  func device(_ name: String) -> URL { root.appendingPathComponent(name) }
  func created() async throws -> (room: Room, words: String) {
    let made = try await Room.createAccount(hubURL: hubURL, email: email, password: password, base: device("first"))
    return (made.room, made.kit.words)
  }
  func code(of error: Error) -> String { (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? "" }
  func failure(_ op: () async throws -> Void) async -> Error? { do { try await op(); return nil } catch { return error } }

  func testCreatingAnAccountPostsTheFoundingWithTheAccount() async throws {
    let (room, words) = try await created()
    XCTAssertEqual(hub.paths("POST"), ["/v2/rooms"], "one request founds the room and makes the account")
    let account = try XCTUnwrap(hub.body("POST", "/v2/rooms")?["account"] as? [String: Any])
    XCTAssertEqual(account["email"] as? String, "ada@example.org")
    let pw = try XCTUnwrap(account["password"] as? [String: Any]), kit = try XCTUnwrap(account["kit"] as? [String: Any])
    XCTAssertEqual(pw["kdf"] as? NSDictionary, ["alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1])
    // both copies hold the code the founding made, each under its own way in
    let code = try XCTUnwrap(tools.codes.last)
    let keys = try tools.passwordKeys(email: "ada@example.org", password: password, kdf: nil)
    XCTAssertEqual(pw["auth_key"] as? String, keys.authKey)
    let pwCopy = try unb64u(pw["sealed_copy"] as! String), kitCopy = try unb64u(kit["sealed_copy"] as! String)
    XCTAssertEqual([pwCopy.count, kitCopy.count], [61, 61])
    XCTAssertEqual(try tools.openCode(pwCopy, email: "ada@example.org", room: room.roomId, way: .password(wrapKey: keys.wrapKey)), code)
    XCTAssertEqual(try tools.openCode(kitCopy, email: "ada@example.org", room: room.roomId, way: .kit(words: words)), code)
    XCTAssertEqual(kit["auth_key"] as? String, try tools.kitAuthKey(email: "ada@example.org", words: words))
    XCTAssertEqual(words.split(separator: " ").count, 12)
    // neither the password nor the words went to the hub
    let sent = String(decoding: try JSONSerialization.data(withJSONObject: account), as: UTF8.self)
    XCTAssertFalse(sent.contains(password)); XCTAssertFalse(sent.contains(words))
    let st = try await room.accountStatus()
    XCTAssertEqual(st?.email, "ada@example.org")
    XCTAssertEqual(st?.hasRecovery, true)
    XCTAssertEqual(st?.confirmsEmail, false)
    room.close()
  }

  func testARefusedAccountLeavesNothingOnTheDevice() async throws {
    let weak = await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: self.email, password: "short", base: self.device("first")) }
    XCTAssertEqual(code(of: try XCTUnwrap(weak)), "weak-password")
    let bad = await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: "nobody", password: self.password, base: self.device("first")) }
    XCTAssertEqual(code(of: try XCTUnwrap(bad)), "bad-email")
    XCTAssertEqual(hub.paths("POST"), [])
    XCTAssertEqual(Store.rooms(base: device("first")), [])
  }

  func testSigningInOpensTheSealedCopyAndJoinsWithTheCode() async throws {
    let (room, _) = try await created()
    guard case .joined(let second) = try await Room.signInWithPassword(hubURL: hubURL, email: " ada@example.org ", password: password, base: device("second")) else { return XCTFail() }
    XCTAssertEqual(hub.body("POST", "/v2/account/login")?["email"] as? String, "ada@example.org")
    XCTAssertEqual(tools.joinedWith, tools.codes.last, "the join got the code the founding made")
    XCTAssertEqual(second.roomIdHex, room.roomIdHex)
    XCTAssertNotEqual(second.deviceIdHex, room.deviceIdHex)
    XCTAssertEqual(Store.rooms(base: device("second")), [room.roomIdHex])
    room.close(); second.close()
  }

  func testAWrongPasswordAndAnUnknownEmailAreTheOneError() async throws {
    let (room, _) = try await created()
    for (e, p) in [(email, other), ("eve@example.org", password)] {
      let error = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, email: e, password: p, base: self.device("second")) }
      XCTAssertEqual(try XCTUnwrap(error) as? TrommiError, TrommiError("wrong-login", "email or password is wrong"))
    }
    XCTAssertNil(tools.joinedWith)
    XCTAssertEqual(Store.rooms(base: device("second")), [])
    room.close()
  }

  func testANewPasswordSealsTheCodeAgain() async throws {
    let (room, _) = try await created()
    let wrong = await failure { try await room.changePassword(current: self.other, next: "a brand new password") }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-login")
    let weak = await failure { try await room.changePassword(current: self.password, next: "short") }
    XCTAssertEqual(code(of: try XCTUnwrap(weak)), "weak-password")
    XCTAssertEqual(hub.paths("PUT"), [], "nothing was sent for a wrong or a weak password")

    try await room.changePassword(current: password, next: other)
    let body = try XCTUnwrap(hub.body("PUT", "/v2/account/password"))
    XCTAssertEqual((body["revision"] as? NSNumber)?.intValue, 0)
    let keys = try tools.passwordKeys(email: "ada@example.org", password: other, kdf: nil)
    XCTAssertEqual(body["auth_key"] as? String, keys.authKey)
    XCTAssertEqual(try tools.openCode(try unb64u(body["sealed_copy"] as! String), email: "ada@example.org", room: room.roomId, way: .password(wrapKey: keys.wrapKey)), tools.codes.last)
    XCTAssertNotNil(body["kdf"])

    // the old password is out, the new one is in
    let old = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, email: self.email, password: self.password, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(old)), "wrong-login")
    let second = try await Room.loginWithPassword(hubURL: hubURL, email: email, password: other, base: device("second"))
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    room.close(); second.close()
  }

  func testTheEmergencyKit() async throws {
    let (room, first) = try await created()
    let wrong = await failure { _ = try await room.makeEmergencyKit(password: self.other) }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-login")

    // a new kit replaces the one before
    let kit = try await room.makeEmergencyKit(password: password)
    XCTAssertEqual(kit.email, "ada@example.org")
    XCTAssertNotEqual(kit.words, first)
    let put = try XCTUnwrap(hub.body("PUT", "/v2/account/kit"))
    XCTAssertEqual(try tools.openCode(try unb64u(put["sealed_copy"] as! String), email: "ada@example.org", room: room.roomId, way: .kit(words: kit.words)), tools.codes.last)
    let old = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, email: self.email, words: first, newPassword: self.other, base: self.device("second")) }
    XCTAssertEqual(try XCTUnwrap(old) as? TrommiError, TrommiError("wrong-recovery", "email or recovery words are wrong"))
    let none = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, email: self.email, words: "eleven words only", newPassword: self.other, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(none)), "bad-recovery-words")
    XCTAssertNil(tools.joinedWith)

    // forgot password: the words, typed loosely, open the account; the new password then logs in
    let second = try await Room.resetPassword(hubURL: hubURL, email: email, words: kit.words.uppercased().replacingOccurrences(of: " ", with: ",  "), newPassword: other, base: device("second"))
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    XCTAssertEqual((hub.body("PUT", "/v2/account/password")?["revision"] as? NSNumber)?.intValue, 1)
    tools.joinedWith = nil
    let third = try await Room.loginWithPassword(hubURL: hubURL, email: email, password: other, base: device("third"))
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    room.close(); second.close(); third.close()
  }

  func testAPasskeyIsAnotherWayIn() async throws {
    let (room, _) = try await created()
    let credential: Bytes = [1, 2, 3], prf = Bytes(repeating: 6, count: 32)
    var asked: PasskeyRequest?
    // a wrong password ends before the system is asked
    let wrong = await failure { try await room.addPasskey(password: self.other) { asked = $0; throw TrommiError("never") } }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-login")
    XCTAssertNil(asked)
    // a passkey without a prf output is not registered
    let noPrf = await failure { try await room.addPasskey(password: self.password) { _ in PasskeyMade(credentialId: credential, attestationObject: credential, clientDataJSON: [5], prf: []) } }
    XCTAssertEqual(code(of: try XCTUnwrap(noPrf)), "no-prf")
    XCTAssertFalse(hub.paths("POST").contains("/v2/account/passkeys"))

    try await room.addPasskey(password: password) { asked = $0; return PasskeyMade(credentialId: credential, attestationObject: credential, clientDataJSON: [5], prf: prf) }
    XCTAssertEqual(asked?.challenge, Bytes(repeating: 8, count: 32))
    XCTAssertEqual(asked?.userHandle, Bytes(repeating: 4, count: 32))
    XCTAssertEqual(asked?.email, "ada@example.org")
    let st = try await room.accountStatus()
    XCTAssertEqual(st?.passkeys, [credential])

    func assertion(_ prf: Bytes) -> PasskeyAssertion { PasskeyAssertion(credentialId: credential, authenticatorData: [1], clientDataJSON: [2], signature: [3], userHandle: nil, prf: prf) }
    let other = await failure { _ = try await Room.signInWithPasskey(hubURL: self.hubURL, base: self.device("second")) { _ in assertion(Bytes(repeating: 7, count: 32)) } }
    XCTAssertEqual(code(of: try XCTUnwrap(other)), "wrong-login", "another passkey's output does not open the copy")
    XCTAssertNil(tools.joinedWith)
    guard case .joined(let second) = try await Room.signInWithPasskey(hubURL: hubURL, base: device("second"), assert: { _ in assertion(prf) }) else { return XCTFail() }
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    room.close(); second.close()
  }

  func testNoErrorSaysASecret() async throws {
    let (room, words) = try await created()
    let code = try XCTUnwrap(tools.codes.last)
    let keys = try tools.passwordKeys(email: "ada@example.org", password: password, kdf: nil)
    let wrongWords = try tools.generateKitWords()   // twelve words of the list, not this account's
    XCTAssertNotEqual(wrongWords, words)
    var errors = [Error?]()
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, email: self.email, password: self.other, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, email: self.email, words: wrongWords, newPassword: self.other, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, email: self.email, words: "not the words", newPassword: self.other, base: self.device("second")) })
    errors.append(await failure { try await room.changePassword(current: self.other, next: self.password) })
    errors.append(await failure { _ = try await room.makeEmergencyKit(password: self.other) })
    errors.append(await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: self.email, password: "short", base: self.device("third")) })
    errors.append(await failure { try await room.verifyEmail(code: "123456") })
    // a hub that answers a login with something else
    hub.lock.withLock { hub.room = "not a room id" }
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, email: self.email, password: self.password, base: self.device("second")) })
    XCTAssertEqual(errors.compactMap { $0 }.count, 8)
    let secrets = [password, other, words, "ada@example.org", email, hex(code), b64u(code), keys.authKey, hex(keys.wrapKey), b64u(keys.wrapKey), "123456"]
    for e in errors.compactMap({ $0 }) {
      let said = "\(e) \(String(describing: e)) \(e.localizedDescription)"
      for s in secrets { XCTAssertFalse(said.contains(s), "an error names a secret: \(self.code(of: e))") }
      for w in words.split(separator: " ") { XCTAssertFalse(said.contains(String(w)), "an error names a word of the kit: \(self.code(of: e))") }
    }
    room.close()
  }

  func testThePasswordRuleAndTheGeneratedPasswordAreTheCores() {
    XCTAssertNil(passwordProblem("twelve chars"))
    XCTAssertEqual(passwordProblem("eleven char"), "at least 12 characters")
    let p = generatePassword().split(separator: "-").map(String.init)
    XCTAssertEqual(p.count, 5)
    XCTAssertTrue(p.allSatisfy(AccountTools.list.contains))
    XCTAssertEqual(try normaliseEmail(" Ada@Example.org "), "ada@example.org")
    XCTAssertThrowsError(try parseRecoveryWords("amber birch"))
    XCTAssertTrue(emergencyKitText(email: "a@b.cd", words: "w", made: Date(timeIntervalSince1970: 0)).contains("Made 1970-01-01"))
  }
}

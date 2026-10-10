// The account (Account.swift) against a core that seals nothing and a hub in the process: creating an account with
// the founding (with a password, or with a passkey and no e-mail), signing in with password, Emergency Kit words and
// passkey, the one field that names an account (an e-mail or the account id), a new password, a new kit, an e-mail
// for an account without one, the wait a refusal names, logging out, the kit's QR text, and that no error says a
// secret.
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
  /** As the core: an e-mail and an id give unrelated keys, and an id is taken in its one text form only. */
  func kitKeysFor(_ name: AccountName, words: String) throws -> PasswordKeys {
    let salt: Bytes
    switch name {
    case .email(let email): salt = utf8("email:" + (try normaliseEmail(email)))
    case .id(let id):
      guard try accountIdParse(id) == id else { throw TrommiError("bad-format") }
      salt = utf8("id:" + id)
    }
    let kit = utf8(try parseKitWords(words))
    return PasswordKeys(authKey: b64u(fold([utf8("kit"), salt, kit], 32)), wrapKey: fold([utf8("kit-wrap"), salt, kit], 32))
  }
  func accountIdParse(_ text: String) throws -> String {
    let d = Array(text.lowercased().filter { $0 != " " && $0 != "-" })
    guard d.count == 32, d.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { throw TrommiError("bad-format") }
    return [d[0..<8], d[8..<12], d[12..<16], d[16..<20], d[20..<32]].map { String($0) }.joined(separator: "-")
  }
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
  private func tag(_ way: AccountWay, room: RoomId) -> Bytes {
    switch way {
    case .password(let key): return fold([utf8("password"), room, key], 28)
    case .kit(let key): return fold([utf8("recovery"), room, key], 28)
    case .passkey(let prf, let id): return fold([utf8("passkey"), room, prf, id], 28)
    }
  }
  /** 61 bytes that begin with 0x02, as the hub asks of a sealed copy. */
  func sealCode(_ code: Bytes, room: RoomId, way: AccountWay) throws -> Bytes { [2] + tag(way, room: room) + code }
  func openCode(_ sealed: Bytes, room: RoomId, way: AccountWay) throws -> Bytes {
    guard sealed.count == 61, sealed[0] == 2 else { throw TrommiError("bad-format") }
    guard Bytes(sealed[1..<29]) == tag(way, room: room) else {
      if case .kit = way { throw TrommiError("wrong-recovery") }
      throw TrommiError("wrong-login")
    }
    return Bytes(sealed[29...])
  }
  func isFinalRefusal(_ code: String) -> Bool { base.isFinalRefusal(code) }
  func recoverySigner(code: Bytes) throws -> CoreSigner { AccountSigner(id: fold([code], 32)) }
  func joinRoomWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> Bytes? { joinedWith = code; return nil }
  /** What the second step of a join answers, and how often it was asked. */
  var sessionsLeft: (notJoined: [(group: GroupId, code: String)], again: Bool) = ([], false)
  var sessionJoins = 0
  func joinSessionsWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> (notJoined: [(group: GroupId, code: String)], again: Bool) {
    sessionJoins += 1
    guard code == joinedWith else { throw TrommiError("wrong-recovery") }
    return sessionsLeft
  }
  /** The recovery of a double: it removes two devices, makes a new code and keeps the account's copies it was given. */
  var recoveredWith: Bytes?
  var recoveryCopies: [String: Any]?
  func recoverWithCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64, confirm: @escaping ([DeviceId]) async -> Bool,
                       account: @escaping (Bytes) async throws -> Bytes) async throws -> (removed: [DeviceId], missingLink: Bytes?) {
    let removed: [DeviceId] = [Bytes(repeating: 1, count: 32), Bytes(repeating: 2, count: 32)]
    guard await confirm(removed) else { throw TrommiError("cancelled") }
    recoveryCopies = parse(try await account(try generateRecoveryCode()))
    recoveredWith = code
    return (removed, nil)
  }

  // ---- everything else: FakeCore.swift -------------------------------------------------------------------------
  var version: String { base.version }
  func selfTest() -> [SelfTestStep] { base.selfTest() }
  func createDevice(store: CoreStorage) throws -> CoreDevice { try base.createDevice(store: store) }
  func openDevice(store: CoreStorage) throws -> CoreDevice { try base.openDevice(store: store) }
  func canonicalHub(_ text: String) throws -> String { try base.canonicalHub(text) }
  func parseInviteLink(_ text: String) throws -> InviteLinkParts { try base.parseInviteLink(text) }
  func checkEmoji() -> [(emoji: String, word: String)] { base.checkEmoji() }
  func boardReduce(snapshot: Bytes?, snapshotFrontier: [WriterHead], items: [BoardItemBody], frontier: [WriterHead]) throws -> Bytes { try base.boardReduce(snapshot: snapshot, snapshotFrontier: snapshotFrontier, items: items, frontier: frontier) }
  func encryptFile(_ plain: Bytes) throws -> SealedFile { try base.encryptFile(plain) }
  func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes { try base.decryptFile(fileId: fileId, fileKey: fileKey, sha256: sha256, stored: stored) }
  func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts { try base.createShareLink(app: app, fileId: fileId, fileKey: fileKey, sha256: sha256) }
  func generatePushKey() throws -> Bytes { try base.generatePushKey() }
}

/** The hub's account routes, answered in the process for one room and its account, as hub/src/accounts.rs does. */
final class AccountHub: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var shared = Hub()
  final class Hub: @unchecked Sendable {
    let lock = NSLock()
    var room = ""                                    // base64url
    var account: [String: Any]?                      // as posted with the founding, plus what changed since
    var revision = 0
    var passkeys: [String: String] = [:]             // credential id -> sealed copy (base64url)
    /** The account id this hub mints, and its 16 bytes: the user handle of the account's passkeys. */
    let id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    var handle: Bytes { try! unhex(id.filter { $0 != "-" }) }
    var posted: [(method: String, path: String, body: [String: Any], token: String?)] = []
    /** The next request to this path is refused with this status, body and headers (a throttled login). */
    var refusal: (path: String, status: Int, body: [String: Any], headers: [String: String])?
    func paths(_ method: String) -> [String] { lock.withLock { posted.filter { $0.method == method }.map { $0.path } } }
    func body(_ method: String, _ path: String) -> [String: Any]? { lock.withLock { posted.last { $0.method == method && $0.path == path }?.body } }

    private func refuse(_ status: Int, _ code: String) -> (Int, Any) { (status, ["error": code, "message": "refused"]) }
    private var email: Any { account?["email"] ?? NSNull() }
    private func login(_ copy: Any?) -> (Int, Any) {
      (200, ["rooms": [["room_id": room, "sealed_copy": copy ?? "", "challenge": b64u(Bytes(repeating: 9, count: 32))]], "kdf": (account?["password"] as? [String: Any])?["kdf"] ?? NSNull(),
             "account": id, "email": email])
    }
    /** The one field `account` (read as `email` too): the account's e-mail, or its id typed in any case, with or without dashes and spaces. */
    private func names(_ body: [String: Any]) -> Bool {
      let text = body["account"] as? String ?? body["email"] as? String ?? ""
      if text.contains("@") { return text == account?["email"] as? String }
      return text.lowercased().filter { $0 != " " && $0 != "-" } == id.filter { $0 != "-" } && account != nil
    }
    func answer(_ method: String, _ path: String, _ body: [String: Any], token: String?) -> (Int, Any, [String: String]) {
      lock.lock(); defer { lock.unlock() }
      posted.append((method, path, body, token))
      if let r = refusal, r.path == path { refusal = nil; return (r.status, r.body, r.headers) }
      let (status, answer) = route(method, path, body)
      return (status, answer, [:])
    }
    private func route(_ method: String, _ path: String, _ body: [String: Any]) -> (Int, Any) {
      let password = account?["password"] as? [String: Any], kit = account?["kit"] as? [String: Any]
      switch (method, path) {
      case ("POST", "/v2/rooms"):
        room = b64u(try! unhex(parse(try! unb64u(body["group_info"] as! String))["room"] as! String))
        account = body["account"] as? [String: Any]
        if let p = account?["passkey"] as? [String: Any] { passkeys[p["attestation_object"] as! String] = p["sealed_copy"] as? String; account?["passkey"] = nil }
        return (200, ["room_id": room])
      case ("GET", "/v2/account"):
        guard account != nil else { return refuse(404, "not-found") }
        return (200, ["email": email, "account": id, "kit_form": email is String ? "email" : "id", "revision": revision, "has_password": password != nil, "kdf": password?["kdf"] ?? NSNull(),
                      "password_copy": password?["sealed_copy"] ?? NSNull(), "kit_copy": kit?["sealed_copy"] ?? NSNull(), "user_handle": b64u(handle),
                      "passkeys": passkeys.keys.sorted().map { ["credential_id": $0, "sealed_copy": passkeys[$0] ?? ""] }, "rooms": [room]])
      case ("POST", "/v2/account/login"):
        return names(body) && body["auth_key"] as? String == password?["auth_key"] as? String ? login(password?["sealed_copy"]) : refuse(401, "wrong-login")
      case ("POST", "/v2/account/recover"):
        return names(body) && body["auth_key"] as? String == kit?["auth_key"] as? String ? login(kit?["sealed_copy"]) : refuse(401, "wrong-recovery")
      case ("PUT", "/v2/account/password"), ("PUT", "/v2/account/kit"):
        guard (body["revision"] as? NSNumber)?.intValue == revision else { return refuse(409, "account-changed") }
        if path.hasSuffix("password") && !(email is String) { return refuse(400, "bad-email") }
        var part = body; part["revision"] = nil
        account?[path.hasSuffix("kit") ? "kit" : "password"] = part
        revision += 1
        return (200, ["revision": revision])
      case ("PUT", "/v2/account/email"):
        guard (body["revision"] as? NSNumber)?.intValue == revision else { return refuse(409, "account-changed") }
        if email is String { return refuse(403, "forbidden") }
        guard let new = body["kit"] as? [String: Any], new["auth_key"] is String, new["sealed_copy"] is String else { return refuse(400, "incomplete") }
        account?["email"] = body["email"]; account?["kit"] = new
        revision += 1
        return (200, ["revision": revision])
      // (without a token: the challenge comes with the id the account will have)
      case ("POST", "/v2/account/passkey/challenge"): return (200, ["challenge": b64u(Bytes(repeating: 8, count: 32)), "account": id, "user_handle": b64u(handle)])
      case ("POST", "/v2/account/passkeys/challenge"):
        return (200, ["challenge": b64u(Bytes(repeating: 8, count: 32)), "account": id, "user_handle": b64u(handle), "email": email, "kit_form": email is String ? "email" : "id"])
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
      default: return (200, [String: Any]())   // (the rest of a join, and DELETE /v2/push and /v2/token: taken)
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
    let (status, answer, headers) = AccountHub.shared.answer(request.httpMethod ?? "GET", url.path, parse(Bytes(data)), token: request.value(forHTTPHeaderField: "authorization"))
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers.merging(["content-type": "application/json"]) { a, _ in a })!, cacheStoragePolicy: .notAllowed)
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
  let credential: Bytes = [1, 2, 3], prf = Bytes(repeating: 6, count: 32)

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
  /** An account made with a passkey; `asked`: what the system's step was handed. */
  func createdWithPasskey(email: String? = nil, asked: ((PasskeyRequest) -> Void)? = nil) async throws -> (room: Room, kit: EmergencyKit) {
    try await Room.createAccountWithPasskey(hubURL: hubURL, email: email, base: device("first")) { r in
      asked?(r)
      return PasskeyMade(credentialId: self.credential, attestationObject: self.credential, clientDataJSON: [5], prf: self.prf)
    }
  }
  func code(of error: Error) -> String { (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? "" }
  func failure(_ op: () async throws -> Void) async -> Error? { do { try await op(); return nil } catch { return error } }

  func testCreatingAnAccountPostsTheFoundingWithTheAccount() async throws {
    let made = try await Room.createAccount(hubURL: hubURL, email: email, password: password, base: device("first"))
    let (room, words) = (made.room, made.kit.words)
    XCTAssertEqual(hub.paths("POST").first, "/v2/rooms", "one request founds the room and makes the account")
    XCTAssertFalse(hub.paths("POST").contains("/v2/account"))
    let account = try XCTUnwrap(hub.body("POST", "/v2/rooms")?["account"] as? [String: Any])
    XCTAssertEqual(Set(account.keys), ["email", "password", "kit"])
    XCTAssertEqual(account["email"] as? String, "ada@example.org")
    let pw = try XCTUnwrap(account["password"] as? [String: Any]), kit = try XCTUnwrap(account["kit"] as? [String: Any])
    XCTAssertEqual(Set(pw.keys), ["auth_key", "sealed_copy", "kdf"])
    XCTAssertEqual(Set(kit.keys), ["auth_key", "sealed_copy"], "the kit's form is not sent: the hub knows it from the account")
    XCTAssertEqual(pw["kdf"] as? NSDictionary, ["alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1])
    // both copies hold the code the founding made, each under its own way in
    let code = try XCTUnwrap(tools.codes.last)
    let keys = try tools.passwordKeys(email: "ada@example.org", password: password, kdf: nil)
    let kitKeys = try tools.kitKeysFor(.email("ada@example.org"), words: words)
    XCTAssertEqual(pw["auth_key"] as? String, keys.authKey)
    let pwCopy = try unb64u(pw["sealed_copy"] as! String), kitCopy = try unb64u(kit["sealed_copy"] as! String)
    XCTAssertEqual([pwCopy.count, kitCopy.count], [61, 61])
    XCTAssertEqual(try tools.openCode(pwCopy, room: room.roomId, way: .password(wrapKey: keys.wrapKey)), code)
    XCTAssertEqual(try tools.openCode(kitCopy, room: room.roomId, way: .kit(wrapKey: kitKeys.wrapKey)), code)
    XCTAssertEqual(kit["auth_key"] as? String, kitKeys.authKey)
    XCTAssertEqual(words.split(separator: " ").count, 12)
    // neither the password nor the words went to the hub
    let sent = String(decoding: try JSONSerialization.data(withJSONObject: account), as: UTF8.self)
    XCTAssertFalse(sent.contains(password)); XCTAssertFalse(sent.contains(words))
    // the id the hub minted is kept for the kit's sheet, and the account says it
    XCTAssertEqual(made.kit, EmergencyKit(words: words, email: "ada@example.org", accountId: hub.id))
    let st = try await room.accountStatus()
    XCTAssertEqual(st?.email, "ada@example.org")
    XCTAssertEqual(st?.accountId, hub.id)
    XCTAssertEqual(st?.kitForm, .email)
    XCTAssertEqual(st?.userHandle, hub.handle)
    XCTAssertEqual(st?.hasRecovery, true)
    XCTAssertEqual(st?.confirmsEmail, false)
    room.close()
  }

  func testARefusedAccountLeavesNothingOnTheDevice() async throws {
    let weak = await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: self.email, password: "short", base: self.device("first")) }
    XCTAssertEqual(code(of: try XCTUnwrap(weak)), "weak-password")
    // a password needs an e-mail
    for none in ["nobody", "", hub.id] {
      let bad = await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: none, password: self.password, base: self.device("first")) }
      XCTAssertEqual(code(of: try XCTUnwrap(bad)), "bad-email")
    }
    XCTAssertEqual(hub.paths("POST"), [])
    XCTAssertEqual(Store.rooms(base: device("first")), [])
  }

  func testAnAccountWithAPasskeyNeedsNoEmail() async throws {
    var asked: PasskeyRequest?
    let made = try await createdWithPasskey { asked = $0 }
    // the challenge without a token comes first: it names the id the account will have
    XCTAssertEqual(Array(hub.paths("POST").prefix(2)), ["/v2/account/passkey/challenge", "/v2/rooms"])
    XCTAssertEqual(hub.posted.first?.body.isEmpty, true)
    XCTAssertNil(hub.posted.first?.token)
    XCTAssertEqual(asked?.challenge, Bytes(repeating: 8, count: 32))
    XCTAssertEqual(asked?.userHandle, hub.handle, "the passkey carries the account id's 16 bytes")
    XCTAssertEqual(asked?.accountId, hub.id)
    XCTAssertEqual(asked?.email, "")
    XCTAssertEqual(asked?.name, hub.id)
    let account = try XCTUnwrap(hub.body("POST", "/v2/rooms")?["account"] as? [String: Any])
    XCTAssertEqual(Set(account.keys), ["kit", "passkey"], "no e-mail, no password")
    let kit = try XCTUnwrap(account["kit"] as? [String: Any]), passkey = try XCTUnwrap(account["passkey"] as? [String: Any])
    XCTAssertEqual(Set(kit.keys), ["auth_key", "sealed_copy"])
    XCTAssertEqual(Set(passkey.keys), ["attestation_object", "client_data_json", "sealed_copy", "transports"])
    // the kit's keys are derived from the id, and are not those of any e-mail
    let byId = try tools.kitKeysFor(.id(hub.id), words: made.kit.words)
    XCTAssertEqual(kit["auth_key"] as? String, byId.authKey)
    let code = try XCTUnwrap(tools.codes.last)
    XCTAssertEqual(try tools.openCode(try unb64u(kit["sealed_copy"] as! String), room: made.room.roomId, way: .kit(wrapKey: byId.wrapKey)), code)
    XCTAssertEqual(try tools.openCode(try unb64u(passkey["sealed_copy"] as! String), room: made.room.roomId, way: .passkey(prf: prf, credentialId: credential)), code)
    XCTAssertEqual(made.kit, EmergencyKit(words: made.kit.words, email: "", accountId: hub.id))
    let st = try await made.room.accountStatus()
    XCTAssertEqual(st?.email, "")
    XCTAssertEqual(st?.accountId, hub.id)
    XCTAssertEqual(st?.kitForm, .id)
    XCTAssertEqual(st?.hasPassword, false)
    XCTAssertEqual(st?.passkeys, [credential])
    made.room.close()
  }

  func testAnEmailBesideAPasskeyIsSentAndSaltsTheKit() async throws {
    var asked: PasskeyRequest?
    let made = try await createdWithPasskey(email: " Ada@Example.org ") { asked = $0 }
    XCTAssertEqual(asked?.name, "ada@example.org")
    let account = try XCTUnwrap(hub.body("POST", "/v2/rooms")?["account"] as? [String: Any])
    XCTAssertEqual(Set(account.keys), ["email", "kit", "passkey"])
    XCTAssertEqual(account["email"] as? String, "ada@example.org")
    XCTAssertEqual((account["kit"] as? [String: Any])?["auth_key"] as? String, try tools.kitKeysFor(.email("ada@example.org"), words: made.kit.words).authKey)
    XCTAssertEqual(made.kit.email, "ada@example.org")
    XCTAssertEqual(made.kit.accountId, hub.id)
    made.room.close()
  }

  func testAPasskeyWithoutAKeyOrABadEmailFoundsNothing() async throws {
    let noPrf = await failure { _ = try await Room.createAccountWithPasskey(hubURL: self.hubURL, base: self.device("first")) { _ in PasskeyMade(credentialId: [1], attestationObject: [1], clientDataJSON: [5], prf: []) } }
    XCTAssertEqual(code(of: try XCTUnwrap(noPrf)), "no-prf")
    var asked = false
    let bad = await failure { _ = try await Room.createAccountWithPasskey(hubURL: self.hubURL, email: "nobody", base: self.device("first")) { _ in asked = true; throw TrommiError("never") } }
    XCTAssertEqual(code(of: try XCTUnwrap(bad)), "bad-email")
    XCTAssertFalse(asked)
    XCTAssertFalse(hub.paths("POST").contains("/v2/rooms"))
    XCTAssertEqual(Store.rooms(base: device("first")), [])
  }

  func testSigningInSendsTheOneFieldAndJoinsWithTheCode() async throws {
    let (room, _) = try await created()
    guard case .joined(let second) = try await Room.signInWithPassword(hubURL: hubURL, account: " ada@example.org ", password: password, base: device("second")) else { return XCTFail() }
    let body = try XCTUnwrap(hub.body("POST", "/v2/account/login"))
    XCTAssertEqual(Set(body.keys), ["account", "auth_key"])
    XCTAssertEqual(body["account"] as? String, "ada@example.org")
    XCTAssertEqual(tools.joinedWith, tools.codes.last, "the join got the code the founding made")
    XCTAssertEqual(second.roomIdHex, room.roomIdHex)
    XCTAssertNotEqual(second.deviceIdHex, room.deviceIdHex)
    XCTAssertEqual(Store.rooms(base: device("second")), [room.roomIdHex])
    room.close(); second.close()
  }

  /** A sign-in whose session joins did not all go through keeps the device and the code, and the next try finishes it. */
  func testAnUnfinishedCodeJoinKeepsTheDeviceAndGoesOn() async throws {
    let (room, _) = try await created()
    tools.sessionsLeft = ([], true)
    let second = try await Room.loginWithPassword(hubURL: hubURL, account: email, password: password, base: device("second"))
    let item = Room.joinCodeItem(second.store.dir)
    XCTAssertEqual(Store.rooms(base: device("second")), [room.roomIdHex], "the device is kept")
    XCTAssertEqual(try second.store.load().codeJoin, true)
    XCTAssertEqual(try LocalKey.read(item, dir: second.store.dir), tools.codes.last, "the code is kept until the join has finished")
    await second.finishCodeJoin()
    XCTAssertEqual(second.record.codeJoin, true, "still not finished: nothing is forgotten")
    // after a restart it goes on from what room.json and the Keychain hold
    await second.shutdown()
    let again = try Room.open(base: device("second"), roomId: room.roomIdHex)
    tools.sessionsLeft = ([], false)
    await again.finishCodeJoin()
    XCTAssertEqual(tools.sessionJoins, 3)
    XCTAssertNil(again.record.codeJoin)
    XCTAssertNil(try again.store.load().codeJoin)
    XCTAssertNil(try LocalKey.read(item, dir: again.store.dir), "the code is forgotten once the join has finished")
    room.close(); again.close()
  }

  /** A finished sign-in keeps no code. */
  func testAFinishedCodeJoinKeepsNoCode() async throws {
    let (room, _) = try await created()
    let second = try await Room.loginWithPassword(hubURL: hubURL, account: email, password: password, base: device("second"))
    XCTAssertNil(second.record.codeJoin)
    XCTAssertNil(try LocalKey.read(Room.joinCodeItem(second.store.dir), dir: second.store.dir))
    room.close(); second.close()
  }

  /** When every device is lost: the kit's words open the account, and the request carries a new kit and a password set anew. */
  func testARecoveryCarriesANewKitAndAPasswordSetAnew() async throws {
    let (room, words) = try await created()
    let founding = try XCTUnwrap(tools.codes.last)
    var asked: Int?
    let done = try await Room.recoverAccount(hubURL: hubURL, account: email, words: words, newPassword: other, base: device("second")) { asked = $0; return true }
    XCTAssertEqual(asked, 2)
    XCTAssertEqual(done.removed, 2)
    XCTAssertEqual(tools.recoveredWith, founding, "the recovery got the code the kit's words opened")
    XCTAssertNil(tools.joinedWith, "no ordinary join beside it")
    XCTAssertEqual(Store.rooms(base: device("second")), [room.roomIdHex])
    // a new kit, and one way in set anew: the password with its login key and derivation record
    let copies = try XCTUnwrap(tools.recoveryCopies)
    XCTAssertEqual(Set(copies.keys), ["kit", "password"])
    let kit = try XCTUnwrap(copies["kit"] as? [String: Any]), pw = try XCTUnwrap(copies["password"] as? [String: Any])
    XCTAssertEqual(Set(kit.keys), ["auth_key", "sealed_copy"])
    XCTAssertEqual(Set(pw.keys), ["auth_key", "sealed_copy", "kdf"])
    let next = try XCTUnwrap(tools.codes.last)
    XCTAssertNotEqual(next, founding)
    XCTAssertNotEqual(done.kit.words, words)
    XCTAssertEqual(done.kit.email, "ada@example.org")
    XCTAssertEqual(done.kit.accountId, hub.id)
    let kitKeys = try tools.kitKeysFor(.email("ada@example.org"), words: done.kit.words), keys = try tools.passwordKeys(email: "ada@example.org", password: other, kdf: nil)
    XCTAssertEqual(kit["auth_key"] as? String, kitKeys.authKey)
    XCTAssertEqual(pw["auth_key"] as? String, keys.authKey)
    XCTAssertEqual(try tools.openCode(try unb64u(kit["sealed_copy"] as! String), room: room.roomId, way: .kit(wrapKey: kitKeys.wrapKey)), next)
    XCTAssertEqual(try tools.openCode(try unb64u(pw["sealed_copy"] as! String), room: room.roomId, way: .password(wrapKey: keys.wrapKey)), next)
    room.close(); done.room.close()
  }

  /** A recovery the person does not confirm, or that cannot set a way in, leaves nothing on the device. */
  func testARecoveryThatIsNotConfirmedLeavesNothing() async throws {
    let (room, words) = try await created()
    let no = await failure { _ = try await Room.recoverAccount(hubURL: self.hubURL, account: self.email, words: words, newPassword: self.other, base: self.device("second")) { _ in false } }
    XCTAssertEqual(code(of: try XCTUnwrap(no)), "cancelled")
    let weak = await failure { _ = try await Room.recoverAccount(hubURL: self.hubURL, account: self.email, words: words, newPassword: "short", base: self.device("second")) { _ in true } }
    XCTAssertEqual(code(of: try XCTUnwrap(weak)), "weak-password")
    // an account named by its id has no password to set: without the system's passkey step nothing is asked
    let before = hub.paths("POST").count
    let byId = await failure { _ = try await Room.recoverAccount(hubURL: self.hubURL, account: self.hub.id, words: words, newPassword: nil, base: self.device("second")) { _ in true } }
    XCTAssertEqual(code(of: try XCTUnwrap(byId)), "not-built")
    XCTAssertEqual(hub.paths("POST").count, before)
    XCTAssertNil(tools.recoveredWith)
    XCTAssertEqual(Store.rooms(base: device("second")), [])
    room.close()
  }

  func testAPasswordWithAnAccountIdSendsNothing() async throws {
    let (room, _) = try await created()
    let before = hub.paths("POST").count, derived = tools.derivations
    // a password's keys are derived from the e-mail: the id alone cannot make them
    let byId = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.hub.id.uppercased(), password: self.password, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(byId)), "needs-email")
    let neither = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: "ada", password: self.password, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(neither)), "bad-account")
    XCTAssertEqual(hub.paths("POST").count, before)
    XCTAssertEqual(tools.derivations, derived)
    room.close()
  }

  func testAWrongPasswordAndAnUnknownEmailAreTheOneError() async throws {
    let (room, _) = try await created()
    for (e, p) in [(email, other), ("eve@example.org", password)] {
      let error = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: e, password: p, base: self.device("second")) }
      XCTAssertEqual(try XCTUnwrap(error) as? TrommiError, TrommiError("wrong-login", "the account's name or the password is wrong"))
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
    XCTAssertEqual(try tools.openCode(try unb64u(body["sealed_copy"] as! String), room: room.roomId, way: .password(wrapKey: keys.wrapKey)), tools.codes.last)
    XCTAssertNotNil(body["kdf"])

    // the old password is out, the new one is in
    let old = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.password, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(old)), "wrong-login")
    let second = try await Room.loginWithPassword(hubURL: hubURL, account: email, password: other, base: device("second"))
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
    XCTAssertEqual(kit.accountId, hub.id)
    XCTAssertNotEqual(kit.words, first)
    let put = try XCTUnwrap(hub.body("PUT", "/v2/account/kit"))
    XCTAssertEqual(Set(put.keys), ["auth_key", "sealed_copy", "revision"])
    XCTAssertEqual(try tools.openCode(try unb64u(put["sealed_copy"] as! String), room: room.roomId, way: .kit(wrapKey: try tools.kitKeysFor(.email("ada@example.org"), words: kit.words).wrapKey)), tools.codes.last)
    let old = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: first, newPassword: self.other, base: self.device("second")) }
    XCTAssertEqual(try XCTUnwrap(old) as? TrommiError, TrommiError("wrong-recovery", "the account's name or the recovery words are wrong"))
    let none = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: "eleven words only", newPassword: self.other, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(none)), "bad-recovery-words")
    // the kit of an account with an e-mail opens with the e-mail only: under the id the words give other keys
    let byId = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.hub.id, words: kit.words, newPassword: nil, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(byId)), "wrong-recovery")
    XCTAssertEqual(hub.body("POST", "/v2/account/recover")?["account"] as? String, hub.id)
    XCTAssertNil(tools.joinedWith)

    // forgot password: the words, typed loosely, open the account; the new password then logs in
    let second = try await Room.resetPassword(hubURL: hubURL, account: email, words: kit.words.uppercased().replacingOccurrences(of: " ", with: ",  "), newPassword: other, base: device("second"))
    let recover = try XCTUnwrap(hub.body("POST", "/v2/account/recover"))
    XCTAssertEqual(Set(recover.keys), ["account", "auth_key"])
    XCTAssertEqual(recover["account"] as? String, "ada@example.org")
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    XCTAssertEqual((hub.body("PUT", "/v2/account/password")?["revision"] as? NSNumber)?.intValue, 1)
    tools.joinedWith = nil
    let third = try await Room.loginWithPassword(hubURL: hubURL, account: email, password: other, base: device("third"))
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    room.close(); second.close(); third.close()
  }

  func testTheKitOfAnAccountWithoutEmailOpensWithTheId() async throws {
    let made = try await createdWithPasskey()
    // the id as a person types it from the sheet: upper case, spaces for dashes
    let typed = hub.id.uppercased().replacingOccurrences(of: "-", with: " ")
    let wrong = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: typed, words: try self.tools.generateKitWords(), newPassword: nil, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-recovery")
    // (a password given by mistake is not set: an account without an e-mail has none)
    let second = try await Room.resetPassword(hubURL: hubURL, account: typed, words: made.kit.words, newPassword: other, base: device("second"))
    let recover = try XCTUnwrap(hub.body("POST", "/v2/account/recover"))
    XCTAssertEqual(Set(recover.keys), ["account", "auth_key"])
    XCTAssertEqual(recover["account"] as? String, hub.id, "the id goes out in its canonical text")
    XCTAssertEqual(recover["auth_key"] as? String, try tools.kitKeysFor(.id(hub.id), words: made.kit.words).authKey)
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    XCTAssertEqual(hub.paths("PUT"), [])
    let neither = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: "0f8fad5b", words: made.kit.words, newPassword: nil, base: self.device("third")) }
    XCTAssertEqual(code(of: try XCTUnwrap(neither)), "bad-account")
    made.room.close(); second.close()
  }

  func testAnEmailForAnAccountWithoutOneCarriesTheKitMadeAnew() async throws {
    let made = try await createdWithPasskey()
    let room = made.room
    let wrong = await failure { _ = try await room.setEmail(self.email, words: try self.tools.generateKitWords()) }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-recovery")
    let bad = await failure { _ = try await room.setEmail("nobody", words: made.kit.words) }
    XCTAssertEqual(code(of: try XCTUnwrap(bad)), "bad-email")
    XCTAssertEqual(hub.paths("PUT"), [], "nothing was sent for wrong words or a bad address")

    let kit = try await room.setEmail(email, words: made.kit.words)
    XCTAssertEqual(kit, EmergencyKit(words: made.kit.words, email: "ada@example.org", accountId: hub.id))
    let put = try XCTUnwrap(hub.body("PUT", "/v2/account/email"))
    XCTAssertEqual(Set(put.keys), ["email", "kit", "revision"])
    XCTAssertEqual(put["email"] as? String, "ada@example.org")
    XCTAssertEqual((put["revision"] as? NSNumber)?.intValue, 0)
    let new = try XCTUnwrap(put["kit"] as? [String: Any])
    XCTAssertEqual(Set(new.keys), ["auth_key", "sealed_copy"])
    let byEmail = try tools.kitKeysFor(.email("ada@example.org"), words: made.kit.words)
    XCTAssertEqual(new["auth_key"] as? String, byEmail.authKey)
    XCTAssertNotEqual(new["auth_key"] as? String, try tools.kitKeysFor(.id(hub.id), words: made.kit.words).authKey)
    XCTAssertEqual(try tools.openCode(try unb64u(new["sealed_copy"] as! String), room: room.roomId, way: .kit(wrapKey: byEmail.wrapKey)), tools.codes.last)
    let st = try await room.accountStatus()
    XCTAssertEqual(st?.email, "ada@example.org")
    XCTAssertEqual(st?.kitForm, .email)
    // set once
    let again = await failure { _ = try await room.setEmail("eve@example.org", words: made.kit.words) }
    XCTAssertEqual(code(of: try XCTUnwrap(again)), "forbidden")
    // the same words now open the account with the e-mail, and a password can be set
    let second = try await Room.resetPassword(hubURL: hubURL, account: email, words: made.kit.words, newPassword: other, base: device("second"))
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    XCTAssertEqual(hub.paths("PUT").last, "/v2/account/password")
    room.close(); second.close()
  }

  func testAPasskeyIsAnotherWayIn() async throws {
    let (room, _) = try await created()
    var asked: PasskeyRequest?
    // a wrong password ends before the system is asked
    let wrong = await failure { try await room.addPasskey(password: self.other) { asked = $0; throw TrommiError("never") } }
    XCTAssertEqual(code(of: try XCTUnwrap(wrong)), "wrong-login")
    XCTAssertNil(asked)
    // a passkey without a prf output is not registered
    let noPrf = await failure { try await room.addPasskey(password: self.password) { _ in PasskeyMade(credentialId: self.credential, attestationObject: self.credential, clientDataJSON: [5], prf: []) } }
    XCTAssertEqual(code(of: try XCTUnwrap(noPrf)), "no-prf")
    XCTAssertFalse(hub.paths("POST").contains("/v2/account/passkeys"))

    try await room.addPasskey(password: password) { asked = $0; return PasskeyMade(credentialId: self.credential, attestationObject: self.credential, clientDataJSON: [5], prf: self.prf) }
    XCTAssertEqual(asked?.challenge, Bytes(repeating: 8, count: 32))
    XCTAssertEqual(asked?.userHandle, hub.handle)
    XCTAssertEqual(asked?.email, "ada@example.org")
    XCTAssertEqual(asked?.name, "ada@example.org")
    let st = try await room.accountStatus()
    XCTAssertEqual(st?.passkeys, [credential])

    func assertion(_ prf: Bytes) -> PasskeyAssertion { PasskeyAssertion(credentialId: credential, authenticatorData: [1], clientDataJSON: [2], signature: [3], userHandle: nil, prf: prf) }
    let other = await failure { _ = try await Room.signInWithPasskey(hubURL: self.hubURL, base: self.device("second")) { _ in assertion(Bytes(repeating: 7, count: 32)) } }
    XCTAssertEqual(code(of: try XCTUnwrap(other)), "wrong-login", "another passkey's output does not open the copy")
    XCTAssertNil(tools.joinedWith)
    guard case .joined(let second) = try await Room.signInWithPasskey(hubURL: hubURL, base: device("second"), assert: { _ in assertion(self.prf) }) else { return XCTFail() }
    XCTAssertEqual(tools.joinedWith, tools.codes.last)
    // a log-in with a passkey names no account: the hub finds it by the credential
    XCTAssertEqual(Set(try XCTUnwrap(hub.body("POST", "/v2/account/passkey/login")).keys), ["credential_id", "authenticator_data", "client_data_json", "signature"])
    room.close(); second.close()
  }

  func testAWaitTheHubNamesIsKept() async throws {
    let (room, _) = try await created()
    let refused: [String: Any] = ["error": "rate-limited", "message": "refused"]
    // in the body
    hub.lock.withLock { hub.refusal = ("/v2/account/login", 429, refused.merging(["retry_after": 7]) { a, _ in a }, [:]) }
    let inBody = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.password, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(inBody)), "rate-limited")
    XCTAssertEqual(retryWait(of: try XCTUnwrap(inBody)), 7)
    // in the header alone
    hub.lock.withLock { hub.refusal = ("/v2/account/recover", 503, ["error": "overloaded", "message": "refused"], ["retry-after": "90"]) }
    let inHeader = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: try self.tools.generateKitWords(), newPassword: nil, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(inHeader)), "overloaded")
    XCTAssertEqual(retryWait(of: try XCTUnwrap(inHeader)), 90)
    // a refusal that names none
    let none = await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.other, base: self.device("second")) }
    XCTAssertNil(retryWait(of: try XCTUnwrap(none)))
    XCTAssertNil(tools.joinedWith)
    XCTAssertEqual([1, 7, 59, 60, 61, 900].map { waitText(seconds: $0) }, ["1 second", "7 seconds", "59 seconds", "1 minute", "2 minutes", "15 minutes"])
    room.close()
  }

  func testLoggingOutEndsTheTokenBeforeTheDeviceForgets() async throws {
    let (room, _) = try await created()
    _ = try await room.accountStatus()   // (signed in: the device holds a token)
    XCTAssertEqual(Store.rooms(base: device("first")), [room.roomIdHex])
    try await room.leaveRoom()
    XCTAssertEqual(hub.paths("DELETE"), ["/v2/push", "/v2/token"])
    XCTAssertEqual(hub.posted.last { $0.path == "/v2/token" }?.token, "Bearer t", "the token that is ended is the one it is sent with")
    XCTAssertEqual(Store.rooms(base: device("first")), [], "nothing of the room is left on the device")
    // a client that holds no token asks for none to end it
    let before = hub.posted.count
    await (try HubClient(hubURL: hubURL)).signOut()
    XCTAssertEqual(hub.posted.count, before)
  }

  func testTheKitsQRTextAndFile() throws {
    // https://<app>/#k1.<hub address, base64url of its UTF-8>.<account id, 32 hex digits>
    XCTAssertEqual(kitQRText(hubURL: "https://hub.trommi.com", accountId: hub.id), "https://app.trommi.com/#k1.aHR0cHM6Ly9odWIudHJvbW1pLmNvbQ.0f8fad5bd9cb469fa16570867728950e")
    XCTAssertEqual(kitQRText(hubURL: "http://127.0.0.1:9", accountId: hub.id.uppercased(), app: "https://app.example"), "https://app.example/#k1.\(b64u(utf8("http://127.0.0.1:9"))).0f8fad5bd9cb469fa16570867728950e")
    XCTAssertNil(kitQRText(hubURL: "https://hub.trommi.com", accountId: ""))
    XCTAssertNil(kitQRText(hubURL: "https://hub.trommi.com", accountId: "ada@example.org"))
    XCTAssertTrue(looksLikeAccountId(hub.id)); XCTAssertTrue(looksLikeAccountId(" 0F8FAD5B D9CB 469F A165 70867728950E "))
    XCTAssertFalse(looksLikeAccountId("0f8fad5b-d9cb-469f-a165-70867728950")); XCTAssertFalse(looksLikeAccountId("zf8fad5b-d9cb-469f-a165-70867728950e"))
    XCTAssertEqual(try accountName(" Ada@Example.org "), .email("ada@example.org"))
    XCTAssertEqual(try accountName(hub.id.uppercased()), .id(hub.id))

    let day = Date(timeIntervalSince1970: 0)
    let withEmail = emergencyKitText(EmergencyKit(words: "w1 w2", email: "a@b.cd", accountId: hub.id), made: day)
    XCTAssertTrue(withEmail.hasPrefix("Trommi Emergency Kit\n\nAccount ID: \(hub.id)\nEmail: a@b.cd\nRecovery words: w1 w2\n\n"))
    XCTAssertTrue(withEmail.contains("Enter your email and these 12 words, then choose a new password."))
    XCTAssertTrue(withEmail.hasSuffix("Made 1970-01-01\n"))
    let withoutEmail = emergencyKitText(EmergencyKit(words: "w1 w2", email: "", accountId: hub.id), made: day)
    XCTAssertTrue(withoutEmail.hasPrefix("Trommi Emergency Kit\n\nAccount ID: \(hub.id)\nRecovery words: w1 w2\n\n"))
    XCTAssertTrue(withoutEmail.contains("Enter your account ID and these 12 words."))
    XCTAssertFalse(withoutEmail.contains("Email"))
  }

  func testNoErrorSaysASecret() async throws {
    let (room, words) = try await created()
    let code = try XCTUnwrap(tools.codes.last)
    let keys = try tools.passwordKeys(email: "ada@example.org", password: password, kdf: nil)
    let kitKeys = try tools.kitKeysFor(.email("ada@example.org"), words: words)
    let wrongWords = try tools.generateKitWords()   // twelve words of the list, not this account's
    XCTAssertNotEqual(wrongWords, words)
    var errors = [Error?]()
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.other, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.hub.id, password: self.password, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: "ada", password: self.password, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: wrongWords, newPassword: self.other, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.hub.id, words: words, newPassword: nil, base: self.device("second")) })
    errors.append(await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: "not the words", newPassword: self.other, base: self.device("second")) })
    errors.append(await failure { try await room.changePassword(current: self.other, next: self.password) })
    errors.append(await failure { _ = try await room.makeEmergencyKit(password: self.other) })
    errors.append(await failure { _ = try await room.setEmail("eve@example.org", words: words) })
    errors.append(await failure { _ = try await Room.createAccount(hubURL: self.hubURL, email: self.email, password: "short", base: self.device("third")) })
    errors.append(await failure { try await room.verifyEmail(code: "123456") })
    hub.lock.withLock { hub.refusal = ("/v2/account/login", 429, ["error": "rate-limited", "message": "refused", "retry_after": 3], [:]) }
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.password, base: self.device("second")) })
    // a hub that answers a login with something else
    hub.lock.withLock { hub.room = "not a room id" }
    errors.append(await failure { _ = try await Room.signInWithPassword(hubURL: self.hubURL, account: self.email, password: self.password, base: self.device("second")) })
    XCTAssertEqual(errors.compactMap { $0 }.count, 13)
    let secrets = [password, other, words, "ada@example.org", email, "eve@example.org", hub.id, hub.id.filter { $0 != "-" }, hex(code), b64u(code), keys.authKey, hex(keys.wrapKey), b64u(keys.wrapKey),
                   kitKeys.authKey, hex(kitKeys.wrapKey), b64u(kitKeys.wrapKey), "123456"]
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
  }
  /// Passkeys switch on by themselves once the web app's association file names this app under `webcredentials`.
  func testPasskeysAreOnWhenTheDomainNamesTheApp() {
    let bundle = "com.trommi.app"
    let named = utf8(#"{"applinks":{"details":[]},"webcredentials":{"apps":["ABCDE12345.com.trommi.app"]}}"#)
    XCTAssertTrue(associationAllowsPasskeys(named, bundleId: bundle))
    XCTAssertFalse(associationAllowsPasskeys(utf8(#"{"applinks":{"details":[]}}"#), bundleId: bundle), "today's file: links only")
    XCTAssertFalse(associationAllowsPasskeys(utf8(#"{"webcredentials":{"apps":["ABCDE12345.com.trommi.app.share"]}}"#), bundleId: bundle))
    XCTAssertFalse(associationAllowsPasskeys(utf8(#"{"webcredentials":{"apps":[".com.trommi.app"]}}"#), bundleId: bundle), "no team id")
    XCTAssertFalse(associationAllowsPasskeys(utf8("<html>"), bundleId: bundle))
    XCTAssertFalse(associationAllowsPasskeys(named, bundleId: ""))
  }
  /// An account with a passkey and no password: its passkey opens the code here for a new kit and for one more
  /// passkey; another passkey's output opens nothing and nothing is sent.
  func testAnAccountWithoutAPasswordUsesItsPasskeyForTheKitAndAnotherPasskey() async throws {
    let made = try await createdWithPasskey()
    let room = made.room
    let wrong = await failure { _ = try await room.makeEmergencyKit(way: .passkey(credentialId: self.credential, prf: Bytes(repeating: 7, count: 32))) }
    XCTAssertNotNil(wrong)
    XCTAssertFalse(hub.paths("PUT").contains("/v2/account/kit"))
    let unknown = await failure { _ = try await room.makeEmergencyKit(way: .passkey(credentialId: [9, 9], prf: self.prf)) }
    XCTAssertEqual(code(of: try XCTUnwrap(unknown)), "wrong-login")

    let kit = try await room.makeEmergencyKit(way: .passkey(credentialId: credential, prf: prf))
    XCTAssertEqual(kit.email, "")
    XCTAssertNotEqual(kit.words, made.kit.words)
    let put = try XCTUnwrap(hub.body("PUT", "/v2/account/kit"))
    XCTAssertEqual(try tools.openCode(try unb64u(put["sealed_copy"] as! String), room: room.roomId, way: .kit(wrapKey: try tools.kitKeysFor(.id(hub.id), words: kit.words).wrapKey)), tools.codes.last)

    let second: Bytes = [4, 4, 4, 4]
    try await room.addPasskey(way: .passkey(credentialId: credential, prf: prf)) { _ in PasskeyMade(credentialId: second, attestationObject: second, clientDataJSON: [5], prf: Bytes(repeating: 6, count: 32)) }
    let added = try XCTUnwrap(hub.body("POST", "/v2/account/passkeys"))
    XCTAssertEqual(try tools.openCode(try unb64u(added["sealed_copy"] as! String), room: room.roomId, way: .passkey(prf: Bytes(repeating: 6, count: 32), credentialId: second)), tools.codes.last)
    room.close()
  }
  /// "New password" came into the room and the hub did not take the password: the same words again set it on the
  /// device that is in, instead of failing with `room-exists`.
  func testANewPasswordThatFailedIsSetByTheNextTry() async throws {
    let (room, words) = try await created()
    hub.refusal = ("/v2/account/password", 500, ["error": "internal", "message": "x"], [:])
    let failed = await failure { _ = try await Room.resetPassword(hubURL: self.hubURL, account: self.email, words: words, newPassword: self.other, base: self.device("second")) }
    XCTAssertEqual(code(of: try XCTUnwrap(failed)), "internal")
    XCTAssertEqual(Store.rooms(base: device("second")).count, 1, "the device is in")
    let again = try await Room.resetPassword(hubURL: hubURL, account: email, words: words, newPassword: other, base: device("second"))
    XCTAssertEqual(Store.folders(device("second")).count, 1, "no second device")
    let third = try await Room.loginWithPassword(hubURL: hubURL, account: email, password: other, base: device("third"))
    room.close(); again.close(); third.close()
  }
}

// Account.swift: the account of a room (spec/v2.md 8.8, which is spec/v1.md section 16): an e-mail with a password,
// passkeys or both, and an Emergency Kit of twelve words. An account is a way to the room's recovery code: the hub
// keeps one sealed copy of the code per way in and hands it out to who proves that way; the device opens the copy and
// joins the room with the code (RoomAccount.swift). The hub never sees the password, the words, a passkey's output or
// the code.
//
// Nothing here computes a key or seals anything: every derivation, the word list and the sealed copies are the core's
// (`Core.tools`). This file names the hub's routes (hub/src/accounts.rs) and moves the bytes between the two. The
// recovery code is 32 bytes that live in a local variable for the length of one call: it is not stored, logged or
// put into an error.
import Foundation

public let PASSWORD_MIN = 12

/** nil if the password may be set, else why not. The rule is the core's (at least 12 code points in NFC). */
public func passwordProblem(_ p: String) -> String? { (try? Core.tools.checkPassword(p)) != nil ? nil : "at least \(PASSWORD_MIN) characters" }

/** An e-mail address as the account keeps it, or `bad-email`. */
public func normaliseEmail(_ email: String) throws -> String { try Core.tools.normaliseEmail(email) }

/** A strong password to offer: five words of the core's list joined by "-" (about 64 bits). Empty if the core has no randomness. */
public func generatePassword() -> String {
  ((try? Core.tools.generateKitWords()) ?? "").split(separator: " ").prefix(5).joined(separator: "-")
}

/** The Emergency Kit's words as typed, in their one form (lower case, single spaces), or `bad-recovery-words`. */
public func parseRecoveryWords(_ text: String) throws -> String { try Core.tools.parseKitWords(text) }

/** The fixed input every passkey of an account evaluates its prf over (spec/v1.md 16.7): a constant, not a secret. */
public let PASSKEY_PRF_INPUT: Bytes = utf8("trommi/v1/passkey-prf")

/** The Emergency Kit as a text file, the web's download word for word; `made` is shown as a UTC day. */
public let KIT_FILE_NAME = "Trommi-Emergency-Kit.txt"
public func emergencyKitText(email: String, words: String, made: Date = Date()) -> String {
  let day = DateFormatter()
  day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = TimeZone(identifier: "UTC"); day.dateFormat = "yyyy-MM-dd"
  return """
  Trommi Emergency Kit

  Email: \(email)
  Recovery words: \(words)

  Forgot your password? Open https://app.trommi.com, choose "Log in", then "Forgot password?".
  Enter your email and these 12 words, then choose a new password.

  Keep this kit private and offline: with these words and your email, anyone can get into your account.
  If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.

  Made \(day.string(from: made))

  """
}

/** The account as a human device of its room sees it (GET /v2/account). */
public struct AccountStatus {
  public var email: String
  /** Whether this hub confirms e-mail addresses at all. A v2 hub does not yet: then there is nothing to confirm. */
  public var confirmsEmail: Bool
  public var emailVerifiedAt: UInt64?
  /** An account is made with its Emergency Kit and never without one (16.8). */
  public var hasRecovery: Bool
  public var hasPassword: Bool
  /** Sent back with every change, so that two devices do not overwrite each other (`account-changed`). */
  public var revision: Int
  /** The hub's key derivation record as JSON text (nil: none). The core judges it before it derives anything. */
  public var kdfRecord: String?
  /** The code sealed under the password; nil for an account that has only passkeys. */
  var passwordCopy: Bytes?
  /** What every passkey of the account is made with, so that the system keeps them as one account. */
  public var userHandle: Bytes
  /** The credential ids of the account's passkeys. */
  public var passkeys: [Bytes]

  init?(_ j: JSON) {
    guard let e = j["email"] as? String else { return nil }
    email = e
    confirmsEmail = j["email_verified_at"] != nil
    emailVerifiedAt = (j["email_verified_at"] as? NSNumber)?.uint64Value
    hasRecovery = j["kit_copy"] is String
    hasPassword = j["has_password"] as? Bool ?? false
    revision = (j["revision"] as? NSNumber)?.intValue ?? 0
    kdfRecord = (j["kdf"] as? JSON).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) }
    passwordCopy = (j["password_copy"] as? String).flatMap { try? unb64u($0) }
    userHandle = (j["user_handle"] as? String).flatMap { try? unb64u($0) } ?? []
    passkeys = (j["passkeys"] as? [JSON] ?? []).compactMap { ($0["credential_id"] as? String).flatMap { try? unb64u($0) } }
  }
}

/** What the system needs to make a passkey for the account. */
public struct PasskeyRequest {
  public let challenge: Bytes
  public let userHandle: Bytes
  public let email: String
  /** The account's passkeys so far: the system does not make a second one beside them. */
  public let existing: [Bytes]
}
/** A passkey the system made, with its prf output over `PASSKEY_PRF_INPUT`. */
public struct PasskeyMade {
  public let credentialId: Bytes
  public let attestationObject: Bytes
  public let clientDataJSON: Bytes
  public let prf: Bytes
  public init(credentialId: Bytes, attestationObject: Bytes, clientDataJSON: Bytes, prf: Bytes) {
    self.credentialId = credentialId; self.attestationObject = attestationObject; self.clientDataJSON = clientDataJSON; self.prf = prf
  }
}
/** A passkey's answer to a sign-in challenge, with its prf output over `PASSKEY_PRF_INPUT`. */
public struct PasskeyAssertion {
  public let credentialId: Bytes
  public let authenticatorData: Bytes
  public let clientDataJSON: Bytes
  public let signature: Bytes
  public let userHandle: Bytes?
  public let prf: Bytes
  public init(credentialId: Bytes, authenticatorData: Bytes, clientDataJSON: Bytes, signature: Bytes, userHandle: Bytes?, prf: Bytes) {
    self.credentialId = credentialId; self.authenticatorData = authenticatorData; self.clientDataJSON = clientDataJSON
    self.signature = signature; self.userHandle = userHandle; self.prf = prf
  }
}

/** The pinned key derivation record (16.6): the only one a hub stores and the only one the core derives with. */
private let KDF_RECORD: JSON = ["alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1]

/** The password's part of an account: what the hub checks a login with, and the code sealed under the password. */
private func passwordPart(_ keys: PasswordKeys, email: String, room: RoomId, code: Bytes) throws -> JSON {
  ["auth_key": keys.authKey, "sealed_copy": b64u(try Core.tools.sealCode(code, email: email, room: room, way: .password(wrapKey: keys.wrapKey))), "kdf": KDF_RECORD]
}
/** The Emergency Kit's part: what the hub checks before it hands out the kit's copy, and the code sealed under the words. */
private func kitPart(words: String, email: String, room: RoomId, code: Bytes) throws -> JSON {
  ["auth_key": try Core.tools.kitAuthKey(email: email, words: words), "sealed_copy": b64u(try Core.tools.sealCode(code, email: email, room: room, way: .kit(words: words)))]
}

extension Room {
  // ---- on a signed-in device ---------------------------------------------------------------------------------

  /** The room's account as this device sees it, or nil (a room without one). */
  public func accountStatus() async throws -> AccountStatus? {
    do { return AccountStatus(try await hub.request("GET", "/account")) }
    catch let e as HubError where e.code == "not-found" { return nil }
  }
  private func status() async throws -> AccountStatus {
    guard let st = try await accountStatus() else { throw TrommiError("no-account", "this room has no account") }
    return st
  }
  /** The room's recovery code, opened with the account's password. `wrong-login` when it does not open. */
  private func codeFromPassword(_ password: String, _ st: AccountStatus) throws -> Bytes {
    guard let copy = st.passwordCopy else { throw TrommiError("wrong-login", "this account has no password") }
    let keys = try Core.tools.passwordKeys(email: st.email, password: password, kdf: st.kdfRecord)
    return try Core.tools.openCode(copy, email: st.email, room: roomId, way: .password(wrapKey: keys.wrapKey))
  }

  /** A new password: the code is sealed again under it and the hub swaps what it checks a login with; nothing else changes. */
  public func changePassword(current: String, next: String) async throws {
    try Core.tools.checkPassword(next)
    let st = try await status()
    let code = try codeFromPassword(current, st)
    var body = try passwordPart(try Core.tools.passwordKeys(email: st.email, password: next, kdf: nil), email: st.email, room: roomId, code: code)
    body["revision"] = st.revision
    try await hub.request("PUT", "/account/password", body: body)
  }

  /** A new Emergency Kit, which replaces the one before: its twelve words, to be shown once and kept nowhere. */
  public func makeEmergencyKit(password: String) async throws -> (words: String, email: String) {
    let st = try await status()
    let code = try codeFromPassword(password, st)
    let words = try Core.tools.generateKitWords()
    var body = try kitPart(words: words, email: st.email, room: roomId, code: code)
    body["revision"] = st.revision
    try await hub.request("PUT", "/account/kit", body: body)
    return (words, st.email)
  }

  /**
   * A passkey as one more way into the account. The password opens the code first, so a wrong one ends here before
   * the system asks for anything; `make` is the system's step (the app: Passkeys.swift). The code is sealed under the
   * passkey's prf output and posted together with what the system made.
   */
  public func addPasskey(password: String, make: (PasskeyRequest) async throws -> PasskeyMade) async throws {
    let st = try await status()
    let code = try codeFromPassword(password, st)
    let r = try await hub.request("POST", "/account/passkeys/challenge", body: [:])
    guard let challenge = (r["challenge"] as? String).flatMap({ try? unb64u($0) }), challenge.count == 32 else { throw TrommiError("bad-format", "the hub's passkey challenge") }
    let made = try await make(PasskeyRequest(challenge: challenge, userHandle: st.userHandle, email: st.email, existing: st.passkeys))
    guard made.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    let copy = try Core.tools.sealCode(code, email: st.email, room: roomId, way: .passkey(prf: made.prf, credentialId: made.credentialId))
    try await hub.request("POST", "/account/passkeys", body: [
      "attestation_object": b64u(made.attestationObject), "client_data_json": b64u(made.clientDataJSON), "sealed_copy": b64u(copy),
      // (a passkey of the platform: on this device, or on another one by its QR code)
      "transports": ["internal", "hybrid"],
    ])
  }

  /** A v2 hub does not confirm e-mail addresses (spec/hub-api.md has no route for it): said as one error, nothing is sent. */
  public func verifyEmail(code: String) async throws { throw TrommiError("not-supported", "this hub does not confirm e-mail addresses") }
  public func resendEmailCode() async throws { throw TrommiError("not-supported", "this hub does not confirm e-mail addresses") }

  // ---- before the room: creating an account, signing in ------------------------------------------------------

  /**
   * Create an account: this device founds the room and the hub makes the account in the same request (the founding
   * carries the account: e-mail, the password's part and the Emergency Kit's part), so there is no room without its
   * account and no account without its kit. The kit's words are returned to be shown once; the code does not leave
   * this function.
   */
  public static func createAccount(hubURL: String, email: String, password: String, base: URL = Store.defaultBase(), foundToken: String? = nil) async throws -> (room: Room, kit: (words: String, email: String)) {
    let tools = Core.tools
    let e = try tools.normaliseEmail(email)
    try tools.checkPassword(password)
    // (the slow step, about a second, before anything is founded)
    let keys = try tools.passwordKeys(email: e, password: password, kdf: nil)
    let words = try tools.generateKitWords()
    let made = try await foundRoom(hubURL: hubURL, base: base, foundToken: foundToken) { room, code in
      ["email": e, "password": try passwordPart(keys, email: e, room: room, code: code), "kit": try kitPart(words: words, email: e, room: room, code: code)]
    }
    return (made.room, (words, e))
  }

  /**
   * What a sign-in led to. Today the hub always answers with the sealed code, so the device is in. A later step of
   * the hub (a link mailed per new device, a one-time code) becomes a case here, handled in `loginAnswer` alone.
   */
  public enum LoginOutcome { case joined(Room) }

  /** Log in with the account's e-mail and password and return the room. */
  public static func loginWithPassword(hubURL: String, email: String, password: String, base: URL = Store.defaultBase()) async throws -> Room {
    switch try await signInWithPassword(hubURL: hubURL, email: email, password: password, base: base) {
    case .joined(let room): return room
    }
  }

  /**
   * Sign in on this device with e-mail and password: the hub checks the login key and hands back the code sealed
   * under the password, the device opens it and joins the room with it. One error for an unknown e-mail and a wrong
   * password: `wrong-login`.
   */
  public static func signInWithPassword(hubURL: String, email: String, password: String, base: URL = Store.defaultBase()) async throws -> LoginOutcome {
    let tools = Core.tools
    let e = try tools.normaliseEmail(email)
    let keys = try tools.passwordKeys(email: e, password: password, kdf: nil)
    let r: JSON
    do { r = try await HubClient(hubURL: try tools.canonicalHub(hubURL)).request("POST", "/account/login", body: ["email": e, "auth_key": keys.authKey], auth: false) }
    catch let h as HubError where h.code == "wrong-login" { throw TrommiError("wrong-login", "email or password is wrong") }
    return try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
      try tools.openCode(sealed, email: e, room: room, way: .password(wrapKey: keys.wrapKey))
    }.outcome
  }

  /**
   * Sign in with a passkey: the hub hands out a challenge, `assert` is the system's step (the app: Passkeys.swift),
   * the hub checks the signature and hands back the code sealed under that passkey, which its prf output opens.
   */
  public static func signInWithPasskey(hubURL: String, base: URL = Store.defaultBase(), assert: (Bytes) async throws -> PasskeyAssertion) async throws -> LoginOutcome {
    let tools = Core.tools
    let hub = try HubClient(hubURL: try tools.canonicalHub(hubURL))
    let c = try await hub.request("POST", "/account/passkey/challenge", body: [:], auth: false)
    guard let challenge = (c["challenge"] as? String).flatMap({ try? unb64u($0) }), challenge.count == 32 else { throw TrommiError("bad-format", "the hub's passkey challenge") }
    let a = try await assert(challenge)
    // (without the prf output nothing could be opened: nothing is sent)
    guard a.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    var body: JSON = ["credential_id": b64u(a.credentialId), "authenticator_data": b64u(a.authenticatorData), "client_data_json": b64u(a.clientDataJSON), "signature": b64u(a.signature)]
    if let handle = a.userHandle, !handle.isEmpty { body["user_handle"] = b64u(handle) }
    let r: JSON
    do { r = try await hub.request("POST", "/account/passkey/login", body: body, auth: false) }
    catch let h as HubError where h.code == "wrong-login" { throw TrommiError("wrong-login", "this passkey does not open an account") }
    return try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
      // (a passkey's wrap key is made from the room id, not the e-mail, which is not known here)
      try tools.openCode(sealed, email: "", room: room, way: .passkey(prf: a.prf, credentialId: a.credentialId))
    }.outcome
  }

  /**
   * The hub's answer to a login, the one place it is read: { rooms: [{ room_id, sealed_copy, challenge }], kdf }. An
   * account has a list of rooms, one for now: the first is joined. `open` turns the sealed copy into the code.
   */
  private static func loginAnswer(_ r: JSON, hubURL: String, base: URL, open: (RoomId, Bytes) throws -> Bytes) async throws -> (outcome: LoginOutcome, room: Room) {
    guard let first = (r["rooms"] as? [JSON])?.first,
          let room = (first["room_id"] as? String).flatMap({ try? unb64u($0) }), room.count == 32,
          let sealed = (first["sealed_copy"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-format", "the login answer") }
    let code = try open(room, sealed)
    let challenge = (first["challenge"] as? String).flatMap { try? unb64u($0) }
    let joined = try await joinWithRecoveryCode(hubURL: hubURL, roomId: hex(room), code: code, base: base, challenge: challenge)
    return (.joined(joined), joined)
  }

  /**
   * Forgot password: e-mail, the Emergency Kit's words and a new password. The words open the kit's copy of the code,
   * the device joins the room with it and then sets the new password (the old one stops working). One error for an
   * unknown e-mail and wrong words: `wrong-recovery`.
   */
  public static func resetPassword(hubURL: String, email: String, words: String, newPassword: String, base: URL = Store.defaultBase()) async throws -> Room {
    let tools = Core.tools
    let e = try tools.normaliseEmail(email)
    try tools.checkPassword(newPassword)
    let kit = try tools.parseKitWords(words)
    let r: JSON
    do { r = try await HubClient(hubURL: try tools.canonicalHub(hubURL)).request("POST", "/account/recover", body: ["email": e, "auth_key": try tools.kitAuthKey(email: e, words: kit)], auth: false) }
    catch let h as HubError where h.code == "wrong-recovery" { throw TrommiError("wrong-recovery", "email or recovery words are wrong") }
    // The code is needed once more after the join, to seal it under the new password: it is kept for this call only.
    var code = Bytes()
    let room = try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
      code = try tools.openCode(sealed, email: e, room: room, way: .kit(words: kit))
      return code
    }.room
    let st = try await room.status()
    var body = try passwordPart(try tools.passwordKeys(email: e, password: newPassword, kdf: nil), email: e, room: room.roomId, code: code)
    body["revision"] = st.revision
    try await room.hub.request("PUT", "/account/password", body: body)
    return room
  }
}

// Account.swift: the account of a room (spec/v2.md 8.8, which is spec/v1.md section 16; the routes: spec/hub-api.md
// "The account"): a password, passkeys or both, and an Emergency Kit of twelve words. An account is a way to the
// room's recovery code: the hub keeps one sealed copy of the code per way in and hands it out to who proves that
// way; the device opens the copy and joins the room with the code (RoomAccount.swift). The hub never sees the
// password, the words, a passkey's output or the code.
//
// How an account is named. Every account has an account id, a UUID the hub mints (a public value, printed on the
// kit). It may have an e-mail: a password needs one (its keys are derived from it), a passkey does not. At log-in
// and recovery ONE field names the account, `account`: an e-mail address if it contains "@", else the id. The kit's
// keys are derived from the e-mail if the account has one, else from the id (`kit_form`: "email" or "id").
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

/**
 * Whether a text has the form of an account id as a person may type it: 32 hex digits, without regard to case,
 * spaces and dashes (spec/hub-api.md). A check of a field's form only: the id is read by the core
 * (`accountIdParse`) and by the hub.
 */
public func looksLikeAccountId(_ text: String) -> Bool {
  let digits = text.filter { $0 != " " && $0 != "-" }
  return digits.count == 32 && digits.allSatisfy { $0.isASCII && $0.isHexDigit }
}

/**
 * The one field that names an account at log-in and recovery: an e-mail address if it contains "@", else the account
 * id. `bad-email` for an address that is none, `bad-account` for a text that is neither.
 */
public func accountName(_ field: String) throws -> AccountName {
  let text = field.trimmingCharacters(in: .whitespacesAndNewlines)
  if text.contains("@") { return .email(try Core.tools.normaliseEmail(text)) }
  guard looksLikeAccountId(text) else { throw TrommiError("bad-account", "neither an e-mail address nor an account id") }
  return .id(try Core.tools.accountIdParse(text))
}
extension AccountName {
  /** What goes into the hub's field `account`. */
  var wire: String { switch self { case .email(let email): return email; case .id(let id): return id } }
}

/** An Emergency Kit as it is shown once: its words, and what the sheet prints beside them. */
public struct EmergencyKit: Equatable {
  /** The twelve words. They are kept nowhere. */
  public var words: String
  /** The account's e-mail; empty for an account without one. */
  public var email: String
  /** The account id in its canonical text; empty if the hub did not say it. */
  public var accountId: String
  public init(words: String, email: String, accountId: String) { self.words = words; self.email = email; self.accountId = accountId }
}

/** The web app's address: where the Emergency Kit sends a person, and the origin of the kit's QR code. */
public let APP_ORIGIN = "https://app.trommi.com"

/**
 * The text of the Emergency Kit's QR code (spec/hub-api.md "The kit sheet"): an address of the app that opens the
 * recovery screen with hub and account id filled in, `https://<app>/#k1.<hub, base64url>.<id, 32 hex digits>`. It is
 * in the fragment, so it reaches no server, and it never holds the words. nil without an account id.
 */
public func kitQRText(hubURL: String, accountId: String, app: String = APP_ORIGIN) -> String? {
  guard looksLikeAccountId(accountId), !hubURL.isEmpty else { return nil }
  return "\(app)/#k1.\(b64u(utf8(hubURL))).\(accountId.filter { $0 != " " && $0 != "-" }.lowercased())"
}

/**
 * The Emergency Kit as a text file; `made` is shown as a UTC day. The account id is printed always; the words open
 * the account together with the e-mail if it has one, else together with the id.
 */
public let KIT_FILE_NAME = "Trommi-Emergency-Kit.txt"
public func emergencyKitText(_ kit: EmergencyKit, made: Date = Date()) -> String {
  let day = DateFormatter()
  day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = TimeZone(identifier: "UTC"); day.dateFormat = "yyyy-MM-dd"
  let name = kit.email.isEmpty ? "account ID" : "email"
  var lines = ["Trommi Emergency Kit", ""]
  if !kit.accountId.isEmpty { lines.append("Account ID: \(kit.accountId)") }
  if !kit.email.isEmpty { lines.append("Email: \(kit.email)") }
  lines += [
    "Recovery words: \(kit.words)",
    "",
    "Forgot your password? Open \(APP_ORIGIN), choose \"Log in\", then \"Forgot password?\".",
    kit.email.isEmpty ? "Enter your account ID and these 12 words." : "Enter your email and these 12 words, then choose a new password.",
    "",
    "Keep this kit private and offline: with these words and your \(name), anyone can get into your account.",
    "If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.",
    "",
    "Made \(day.string(from: made))",
    "",
  ]
  return lines.joined(separator: "\n")
}

/** The account as a human device of its room sees it (GET /v2/account). */
public struct AccountStatus {
  /** The account's e-mail; empty for an account without one (it then has no password). */
  public var email: String
  /** The account id in its canonical text (lower case, with dashes); empty if the hub said none. */
  public var accountId: String
  /** What the Emergency Kit's keys are derived from, as the hub says it (`kit_form`): the e-mail, or the id. */
  public enum KitForm: String { case email, id }
  public var kitForm: KitForm
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
  /** The code sealed under the Emergency Kit's words. */
  var kitCopy: Bytes?
  /** What every passkey of the account is made with, so that the system keeps them as one account. */
  public var userHandle: Bytes
  /** The credential ids of the account's passkeys. */
  public var passkeys: [Bytes]
  /** The code sealed under each passkey, by credential id. */
  var passkeyCopies: [Bytes: Bytes]

  init?(_ j: JSON) {
    // (an account without an e-mail says `email: null`; what every account has is its id)
    guard j["email"] is String || j["account"] is String else { return nil }
    email = j["email"] as? String ?? ""
    accountId = j["account"] as? String ?? ""
    kitForm = (j["kit_form"] as? String).flatMap(KitForm.init) ?? (email.isEmpty ? .id : .email)
    confirmsEmail = j["email_verified_at"] != nil
    emailVerifiedAt = (j["email_verified_at"] as? NSNumber)?.uint64Value
    hasRecovery = j["kit_copy"] is String
    hasPassword = j["has_password"] as? Bool ?? false
    revision = (j["revision"] as? NSNumber)?.intValue ?? 0
    kdfRecord = (j["kdf"] as? JSON).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) }
    passwordCopy = (j["password_copy"] as? String).flatMap { try? unb64u($0) }
    kitCopy = (j["kit_copy"] as? String).flatMap { try? unb64u($0) }
    userHandle = (j["user_handle"] as? String).flatMap { try? unb64u($0) } ?? []
    passkeys = (j["passkeys"] as? [JSON] ?? []).compactMap { ($0["credential_id"] as? String).flatMap { try? unb64u($0) } }
    passkeyCopies = [:]
    for p in j["passkeys"] as? [JSON] ?? [] {
      if let id = (p["credential_id"] as? String).flatMap({ try? unb64u($0) }), let copy = (p["sealed_copy"] as? String).flatMap({ try? unb64u($0) }) { passkeyCopies[id] = copy }
    }
  }
  /** What the kit's keys of this account are derived from. */
  var kitName: AccountName { kitForm == .email ? .email(email) : .id(accountId) }
}

/** What the system needs to make a passkey for the account. */
public struct PasskeyRequest {
  public let challenge: Bytes
  /** The 16 bytes of the account id: the system keeps every passkey made with them as one account. */
  public let userHandle: Bytes
  /** The account's e-mail; empty for an account without one. */
  public let email: String
  public let accountId: String
  /** What the system shows as the passkey's name: the e-mail, or the account id where there is none. */
  public var name: String { email.isEmpty ? accountId : email }
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
private func passwordPart(_ keys: PasswordKeys, room: RoomId, code: Bytes) throws -> JSON {
  ["auth_key": keys.authKey, "sealed_copy": b64u(try Core.tools.sealCode(code, room: room, way: .password(wrapKey: keys.wrapKey))), "kdf": KDF_RECORD]
}
/**
 * The Emergency Kit's part: what the hub checks before it hands out the kit's copy, and the code sealed under the
 * words. `keys`: the words' keys for this account (`kitKeysFor`). The hub is not told which form they have: it
 * knows it from the account (with an e-mail "email", else "id").
 */
private func kitPart(_ keys: PasswordKeys, room: RoomId, code: Bytes) throws -> JSON {
  ["auth_key": keys.authKey, "sealed_copy": b64u(try Core.tools.sealCode(code, room: room, way: .kit(wrapKey: keys.wrapKey)))]
}
/** A new passkey's part: what the system made, and the code sealed under the passkey's prf output. */
private func passkeyPart(_ made: PasskeyMade, room: RoomId, code: Bytes) throws -> JSON {
  ["attestation_object": b64u(made.attestationObject), "client_data_json": b64u(made.clientDataJSON),
   "sealed_copy": b64u(try Core.tools.sealCode(code, room: room, way: .passkey(prf: made.prf, credentialId: made.credentialId))),
   // (a passkey of the platform: on this device, or on another one by its QR code)
   "transports": ["internal", "hybrid"]]
}
/**
 * The way into the account that a person just used on this device: it opens the recovery code in force, and it is
 * the one way in that keeps working when the code is replaced (spec/v2.md 8.6). Both hold a secret.
 */
public enum WayIn {
  case password(String)
  /** A passkey of the account with its prf output over `PASSKEY_PRF_INPUT`. */
  case passkey(credentialId: Bytes, prf: Bytes)
}

/**
 * The account's new sealed copies of a new recovery code, as the hub takes them with new recovery keys (spec/hub-api.md
 * "The account": a new kit and one way in; every other way in is removed in the same request). The JSON of `account`.
 */
private func newCopies(kit: PasswordKeys, way: JSON, room: RoomId, code: Bytes) throws -> Bytes {
  var account = way
  account["kit"] = try kitPart(kit, room: room, code: code)
  return Bytes(try JSONSerialization.data(withJSONObject: account, options: [.sortedKeys]))
}

/** A passkey challenge of the hub: 32 bytes. */
private func passkeyChallenge(_ answer: JSON) throws -> Bytes {
  guard let challenge = (answer["challenge"] as? String).flatMap({ try? unb64u($0) }), challenge.count == 32 else { throw TrommiError("bad-format", "the hub's passkey challenge") }
  return challenge
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
    return try Core.tools.openCode(copy, room: roomId, way: .password(wrapKey: keys.wrapKey))
  }

  /** The room's recovery code, opened with a way in the person just used here. `wrong-login` when it does not open. */
  private func codeFrom(_ way: WayIn, _ st: AccountStatus) throws -> Bytes {
    switch way {
    case .password(let password): return try codeFromPassword(password, st)
    case .passkey(let credentialId, let prf):
      guard prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
      guard let copy = st.passkeyCopies[credentialId] else { throw TrommiError("wrong-login", "this passkey does not open the account") }
      return try Core.tools.openCode(copy, room: roomId, way: .passkey(prf: prf, credentialId: credentialId))
    }
  }

  /** A new password: the code is sealed again under it and the hub swaps what it checks a login with; nothing else changes. */
  public func changePassword(current: String, next: String) async throws {
    try Core.tools.checkPassword(next)
    let st = try await status()
    let code = try codeFromPassword(current, st)
    var body = try passwordPart(try Core.tools.passwordKeys(email: st.email, password: next, kdf: nil), room: roomId, code: code)
    body["revision"] = st.revision
    try await hub.request("PUT", "/account/password", body: body)
  }

  /** A new Emergency Kit, which replaces the one before: its twelve words, to be shown once and kept nowhere. */
  public func makeEmergencyKit(password: String) async throws -> EmergencyKit { try await makeEmergencyKit(way: .password(password)) }
  /** The same with the way in just used here: the password, or a passkey of the account (an account without a password). */
  public func makeEmergencyKit(way: WayIn) async throws -> EmergencyKit {
    let st = try await status()
    let code = try codeFrom(way, st)
    let words = try Core.tools.generateKitWords()
    var body = try kitPart(try Core.tools.kitKeysFor(st.kitName, words: words), room: roomId, code: code)
    body["revision"] = st.revision
    try await hub.request("PUT", "/account/kit", body: body)
    return EmergencyKit(words: words, email: st.email, accountId: st.accountId)
  }

  /**
   * Gives an account without an e-mail one, once (PUT /v2/account/email). The kit's keys are derived from the
   * e-mail from then on, so the same request carries the kit made anew: the person types the kit's words once more,
   * they open the code under the account id and seal it again under the e-mail. The words stay the same; the sheet
   * is to be printed again, since the account is opened with the e-mail from now on. `forbidden` for an account
   * that has an e-mail, `wrong-recovery` for words that are not the kit's, `account-exists` for an address taken.
   */
  public func setEmail(_ email: String, words: String) async throws -> EmergencyKit {
    let tools = Core.tools
    let e = try tools.normaliseEmail(email)
    let kit = try tools.parseKitWords(words)
    let st = try await status()
    guard st.email.isEmpty else { throw TrommiError("forbidden", "the e-mail of an account is set once") }
    guard let copy = st.kitCopy else { throw TrommiError("wrong-recovery", "this account has no Emergency Kit") }
    let code = try tools.openCode(copy, room: roomId, way: .kit(wrapKey: try tools.kitKeysFor(st.kitName, words: kit).wrapKey))
    try await hub.request("PUT", "/account/email", body: ["email": e, "kit": try kitPart(try tools.kitKeysFor(.email(e), words: kit), room: roomId, code: code), "revision": st.revision])
    return EmergencyKit(words: kit, email: e, accountId: st.accountId)
  }

  /**
   * A passkey as one more way into the account. The password opens the code first, so a wrong one ends here before
   * the system asks for anything; `make` is the system's step (the app: Passkeys.swift). The code is sealed under the
   * passkey's prf output and posted together with what the system made.
   */
  public func addPasskey(password: String, make: (PasskeyRequest) async throws -> PasskeyMade) async throws { try await addPasskey(way: .password(password), make: make) }
  /** The same with the way in just used here: the password, or another passkey of the account. */
  public func addPasskey(way: WayIn, make: (PasskeyRequest) async throws -> PasskeyMade) async throws {
    let st = try await status()
    let code = try codeFrom(way, st)
    let challenge = try passkeyChallenge(try await hub.request("POST", "/account/passkeys/challenge", body: [:]))
    let made = try await make(PasskeyRequest(challenge: challenge, userHandle: st.userHandle, email: st.email, accountId: st.accountId, existing: st.passkeys))
    guard made.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    try await hub.request("POST", "/account/passkeys", body: try passkeyPart(made, room: roomId, code: code))
  }

  /**
   * Replaces the room's recovery code (spec/v2.md 8.6): for after a device was removed that is not in the person's
   * hands, since whoever holds it may have learned the code. `way` is the way in the person just proved here: it
   * opens the code in force. The core makes the new code and the room Commit that puts its keys in force; the same
   * request carries the account's new copies: one under a new Emergency Kit, one under `way`. The hub applies all of
   * it or nothing, and removes every other way in (a password beside the passkey used, the other passkeys): the
   * person sets those up again. This device then hands the other human devices the new key for the sealed keys by
   * itself. Returns the new kit, to be shown once: the old kit opens nothing any more.
   *
   * `wrong-login` for a way that does not open the code (nothing is sent). `pending` when the hub has not answered
   * in time: the request waits in the outbox and is sent again, and the kit returned is not shown, so the person
   * then makes a new Emergency Kit with the way in they used. A refusal of the hub is thrown and changes nothing.
   */
  public func replaceRecoveryCode(way: WayIn) async throws -> EmergencyKit {
    let tools = Core.tools, room = roomId
    let st = try await status()
    // The code in force, and how the new one is sealed under the same way.
    let current: Bytes
    let sealWay: (Bytes) throws -> JSON
    switch way {
    case .password(let password):
      guard let copy = st.passwordCopy else { throw TrommiError("wrong-login", "this account has no password") }
      let keys = try tools.passwordKeys(email: st.email, password: password, kdf: st.kdfRecord)
      current = try tools.openCode(copy, room: room, way: .password(wrapKey: keys.wrapKey))
      sealWay = { ["password": ["sealed_copy": b64u(try tools.sealCode($0, room: room, way: .password(wrapKey: keys.wrapKey)))]] }
    case .passkey(let credentialId, let prf):
      guard let copy = st.passkeyCopies[credentialId] else { throw TrommiError("wrong-login", "this passkey does not open the account") }
      current = try tools.openCode(copy, room: room, way: .passkey(prf: prf, credentialId: credentialId))
      sealWay = { ["passkey": ["credential_id": b64u(credentialId), "sealed_copy": b64u(try tools.sealCode($0, room: room, way: .passkey(prf: prf, credentialId: credentialId)))]] }
    }
    let words = try tools.generateKitWords()
    let kitKeys = try tools.kitKeysFor(st.kitName, words: words)
    let id: UInt64 = try await serial { [self] in
      if !self.synced { _ = try await self.catchUp() }
      let id = try await self.onCore { device in
        let next = try device.newRecoveryCode(current: current)
        return try device.replaceCode(current: current, account: try newCopies(kit: kitKeys, way: try sealWay(next), room: room, code: next), nowMs: nowMs())
      }
      self.pumpOutbox()
      return id
    }
    try await awaitOutcome(id, ms: 20_000, orThrow: true)
    return EmergencyKit(words: words, email: st.email, accountId: st.accountId)
  }

  /** A v2 hub does not confirm e-mail addresses (spec/hub-api.md has no route for it): said as one error, nothing is sent. */
  public func verifyEmail(code: String) async throws { throw TrommiError("not-supported", "this hub does not confirm e-mail addresses") }
  public func resendEmailCode() async throws { throw TrommiError("not-supported", "this hub does not confirm e-mail addresses") }

  // ---- before the room: creating an account, signing in ------------------------------------------------------

  /**
   * Create an account with e-mail and password: this device founds the room and the hub makes the account in the same
   * request (the founding carries the account: e-mail, the password's part and the Emergency Kit's part), so there
   * is no room without its account and no account without its kit. A password needs an e-mail: its keys are derived
   * from it. The hub mints the account id; it is read back for the kit's sheet. The kit is returned to be shown
   * once; the code does not leave this function.
   */
  public static func createAccount(hubURL: String, email: String, password: String, base: URL = Store.defaultBase(), foundToken: String? = nil) async throws -> (room: Room, kit: EmergencyKit) {
    let tools = Core.tools
    let e = try tools.normaliseEmail(email)
    try tools.checkPassword(password)
    // (the slow step, about a second, before anything is founded)
    let keys = try tools.passwordKeys(email: e, password: password, kdf: nil)
    let words = try tools.generateKitWords()
    let kitKeys = try tools.kitKeysFor(.email(e), words: words)
    let made = try await foundRoom(hubURL: hubURL, base: base, foundToken: foundToken) { room, code in
      ["email": e, "password": try passwordPart(keys, room: room, code: code), "kit": try kitPart(kitKeys, room: room, code: code)]
    }
    // (the founding's answer names the room only: the id comes from the account. Without it the sheet shows none.)
    let id = (try? await made.room.accountStatus())?.accountId ?? ""
    return (made.room, EmergencyKit(words: words, email: e, accountId: id))
  }

  /**
   * Create an account with a passkey; an e-mail is optional beside it (nil or empty: none). The hub's challenge
   * (no token, no name) comes with the id the account will have: the passkey carries its 16 bytes as its user
   * handle, and without an e-mail the kit's keys are derived from it, so both are known before the account exists.
   * `make` is the system's step (the app: Passkeys.swift); then the founding carries the account: the kit's part,
   * the passkey's part and, if given, the e-mail. Nothing is founded unless the passkey gives a key (`no-prf`).
   */
  public static func createAccountWithPasskey(hubURL: String, email: String? = nil, base: URL = Store.defaultBase(), foundToken: String? = nil,
                                              make: (PasskeyRequest) async throws -> PasskeyMade) async throws -> (room: Room, kit: EmergencyKit) {
    let tools = Core.tools
    let typed = (email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let e = typed.isEmpty ? nil : try tools.normaliseEmail(typed)
    let c = try await HubClient(hubURL: try tools.canonicalHub(hubURL)).request("POST", "/account/passkey/challenge", body: [:], auth: false)
    let challenge = try passkeyChallenge(c)
    guard let id = c["account"] as? String, let handle = (c["user_handle"] as? String).flatMap({ try? unb64u($0) }), handle.count == 16 else { throw TrommiError("bad-format", "the hub's passkey challenge names no account id") }
    let words = try tools.generateKitWords()
    // (before the system is asked: a core that cannot make this kit ends here, with no passkey made for nothing)
    let kitKeys = try tools.kitKeysFor(e.map { .email($0) } ?? .id(id), words: words)
    let passkey = try await make(PasskeyRequest(challenge: challenge, userHandle: handle, email: e ?? "", accountId: id, existing: []))
    guard passkey.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    let made = try await foundRoom(hubURL: hubURL, base: base, foundToken: foundToken) { room, code in
      var account: JSON = ["kit": try kitPart(kitKeys, room: room, code: code), "passkey": try passkeyPart(passkey, room: room, code: code)]
      if let e = e { account["email"] = e }
      return account
    }
    return (made.room, EmergencyKit(words: words, email: e ?? "", accountId: id))
  }

  /**
   * What a sign-in led to. Today the hub always answers with the sealed code, so the device is in. A later step of
   * the hub (a link mailed per new device, a one-time code) becomes a case here, handled in `loginAnswer` alone.
   */
  public enum LoginOutcome { case joined(Room) }

  /** Log in with the account's e-mail and password and return the room. */
  public static func loginWithPassword(hubURL: String, account: String, password: String, base: URL = Store.defaultBase()) async throws -> Room {
    switch try await signInWithPassword(hubURL: hubURL, account: account, password: password, base: base) {
    case .joined(let room): return room
    }
  }

  /**
   * Sign in on this device with a password: the hub checks the login key and hands back the code sealed under the
   * password, the device opens it and joins the room with it. `account` is the one field that names the account.
   * A password's keys are derived from the e-mail, so with a password the field must hold the e-mail: an account id
   * is `needs-email`, and nothing is sent. One error for an unknown e-mail and a wrong password: `wrong-login`.
   */
  public static func signInWithPassword(hubURL: String, account: String, password: String, base: URL = Store.defaultBase()) async throws -> LoginOutcome {
    let tools = Core.tools
    if !account.contains("@") && looksLikeAccountId(account.trimmingCharacters(in: .whitespacesAndNewlines)) { throw TrommiError("needs-email", "a password opens the account together with its e-mail") }
    guard case .email(let e) = try accountName(account) else { throw TrommiError("bad-account", "neither an e-mail address nor an account id") }
    let keys = try tools.passwordKeys(email: e, password: password, kdf: nil)
    let r: JSON
    do { r = try await HubClient(hubURL: try tools.canonicalHub(hubURL)).request("POST", "/account/login", body: ["account": e, "auth_key": keys.authKey], auth: false) }
    catch let h as HubError where h.code == "wrong-login" { throw TrommiError("wrong-login", "the account's name or the password is wrong") }
    return try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
      try tools.openCode(sealed, room: room, way: .password(wrapKey: keys.wrapKey))
    }.outcome
  }

  /**
   * Sign in with a passkey, without a name: the hub hands out a challenge, `assert` is the system's step (the app:
   * Passkeys.swift), the hub finds the account by the credential, checks the signature and hands back the code
   * sealed under that passkey, which its prf output opens.
   */
  public static func signInWithPasskey(hubURL: String, base: URL = Store.defaultBase(), assert: (Bytes) async throws -> PasskeyAssertion) async throws -> LoginOutcome {
    let tools = Core.tools
    let hub = try HubClient(hubURL: try tools.canonicalHub(hubURL))
    let challenge = try passkeyChallenge(try await hub.request("POST", "/account/passkey/challenge", body: [:], auth: false))
    let a = try await assert(challenge)
    // (without the prf output nothing could be opened: nothing is sent)
    guard a.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    var body: JSON = ["credential_id": b64u(a.credentialId), "authenticator_data": b64u(a.authenticatorData), "client_data_json": b64u(a.clientDataJSON), "signature": b64u(a.signature)]
    if let handle = a.userHandle, !handle.isEmpty { body["user_handle"] = b64u(handle) }
    let r: JSON
    do { r = try await hub.request("POST", "/account/passkey/login", body: body, auth: false) }
    catch let h as HubError where h.code == "wrong-login" { throw TrommiError("wrong-login", "this passkey does not open an account") }
    return try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
      // (a passkey's wrap key is made from the room id and the credential: no e-mail and no account id is in it)
      try tools.openCode(sealed, room: room, way: .passkey(prf: a.prf, credentialId: a.credentialId))
    }.outcome
  }

  /**
   * The hub's answer to a login, the one place it is read: { rooms: [{ room_id, sealed_copy, challenge }], kdf,
   * account, email }. An account has a list of rooms, one for now: the first is joined. `open` turns the sealed copy
   * into the code. The account's id and e-mail are not taken from here: the joined device asks for them
   * (`accountStatus`).
   */
  private static func loginAnswer(_ r: JSON, hubURL: String, base: URL, open: (RoomId, Bytes) throws -> Bytes) async throws -> (outcome: LoginOutcome, room: Room) {
    let first = try loginRoom(r)
    let code = try open(first.room, first.sealed)
    let joined = try await joinWithRecoveryCode(hubURL: hubURL, roomId: hex(first.room), code: code, base: base, challenge: first.challenge)
    return (.joined(joined), joined)
  }
  /** The first room of a login answer: its id, the sealed copy of its code, and a sign-in challenge if one came. */
  private static func loginRoom(_ r: JSON) throws -> (room: RoomId, sealed: Bytes, challenge: Bytes?) {
    guard let first = (r["rooms"] as? [JSON])?.first,
          let room = (first["room_id"] as? String).flatMap({ try? unb64u($0) }), room.count == 32,
          let sealed = (first["sealed_copy"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-format", "the login answer") }
    return (room, sealed, (first["challenge"] as? String).flatMap { try? unb64u($0) })
  }
  /** Asks the hub for the kit's copy of the code (POST /v2/account/recover). One error for an unknown name and wrong words. */
  private static func kitLogin(hubURL: String, name: AccountName, keys: PasswordKeys) async throws -> JSON {
    do { return try await HubClient(hubURL: try Core.tools.canonicalHub(hubURL)).request("POST", "/account/recover", body: ["account": name.wire, "auth_key": keys.authKey], auth: false) }
    catch let h as HubError where h.code == "wrong-recovery" { throw TrommiError("wrong-recovery", "the account's name or the recovery words are wrong") }
  }

  /**
   * The way back with the Emergency Kit ("Forgot password"): `account` is the one field that names the account, and
   * the kit's words open the kit's copy of the code; the device joins the room with it. Named by e-mail, the words'
   * keys are derived from the e-mail, and `newPassword`, if given, is then set (the old one stops working). Named by
   * account id, the keys are derived from the id: that opens the kit of an account without an e-mail, which has no
   * password, so none is set. (The kit of an account with an e-mail opens with the e-mail only.) One error for an
   * unknown name and wrong words: `wrong-recovery`.
   */
  public static func resetPassword(hubURL: String, account: String, words: String, newPassword: String?, base: URL = Store.defaultBase()) async throws -> Room {
    let tools = Core.tools
    let name = try accountName(account)
    var next: (email: String, password: String)?
    if case .email(let e) = name, let p = newPassword { try tools.checkPassword(p); next = (e, p) }
    let kit = try tools.parseKitWords(words)
    let keys = try tools.kitKeysFor(name, words: kit)
    let r = try await kitLogin(hubURL: hubURL, name: name, keys: keys)
    // The code is needed once more after the join, to seal it under the new password: it is kept for this call only.
    var code = Bytes()
    let room: Room
    do {
      room = try await loginAnswer(r, hubURL: hubURL, base: base) { room, sealed in
        code = try tools.openCode(sealed, room: room, way: .kit(wrapKey: keys.wrapKey))
        return code
      }.room
    } catch let e as TrommiError where e.code == "room-exists" && next != nil {
      // An earlier try came into the room and then could not set the password: it is set now, on that device.
      let first = try loginRoom(r)
      code = try tools.openCode(first.sealed, room: first.room, way: .kit(wrapKey: keys.wrapKey))
      room = try Room.open(base: base, roomId: hex(first.room))
    }
    guard let next = next else { return room }
    do {
      let st = try await room.status()
      var body = try passwordPart(try tools.passwordKeys(email: next.email, password: next.password, kdf: nil), room: room.roomId, code: code)
      body["revision"] = st.revision
      try await room.hub.request("PUT", "/account/password", body: body)
    } catch {
      // (the device stays in the room; the same words again set the password on it: see above)
      room.close()
      throw error
    }
    return room
  }

  /**
   * When every device is lost (spec/v2.md 8.7): the Emergency Kit's words open the account as in `resetPassword`,
   * but this device does not come in beside the others: it removes every other device of the person from the room
   * and every session, and replaces the recovery code, so that a lost device and the old kit open nothing new. The
   * hub applies all of it at once or nothing. The request carries the account's new copies of the new code: one
   * under a new Emergency Kit, and one under a way in set anew, since none was used just now: `newPassword` for an
   * account with an e-mail, a passkey (`makePasskey`: the system's step) for an account without one. Every other
   * way in is removed and set up again by the person.
   *
   * `confirm` is asked with how many devices will be removed, after the room was checked and before anything is
   * posted that changes it; false ends it with `cancelled`. Returns the room, the new kit (to be shown once: the
   * old one opens nothing any more) and how many devices were removed. Any failure leaves nothing on this device
   * and the room as it was. `not-built` for an account without an e-mail when no `makePasskey` is given.
   */
  public static func recoverAccount(hubURL: String, account: String, words: String, newPassword: String?, base: URL = Store.defaultBase(),
                                    makePasskey: ((PasskeyRequest) async throws -> PasskeyMade)? = nil,
                                    confirm: @escaping (Int) async -> Bool) async throws -> (room: Room, kit: EmergencyKit, removed: Int) {
    let tools = Core.tools
    let name = try accountName(account)
    var password: PasswordKeys?
    switch name {
    case .email(let e):
      guard let p = newPassword else { throw TrommiError("weak-password", "a recovery sets a new password") }
      try tools.checkPassword(p)
      password = try tools.passwordKeys(email: e, password: p, kdf: nil)
    case .id:
      guard makePasskey != nil else { throw TrommiError("not-built", "the recovery of an account without an e-mail sets a new passkey") }
    }
    let keys = try tools.kitKeysFor(name, words: try tools.parseKitWords(words))
    let first = try loginRoom(try await kitLogin(hubURL: hubURL, name: name, keys: keys))
    let room = first.room
    let code = try tools.openCode(first.sealed, room: room, way: .kit(wrapKey: keys.wrapKey))
    // (the new kit is salted as the one that just opened: with the e-mail, or with the account id)
    let newWords = try tools.generateKitWords()
    let newKit = try tools.kitKeysFor(name, words: newWords)
    let done = try await recoverWithCode(hubURL: hubURL, roomId: hex(room), code: code, base: base, challenge: first.challenge, confirm: { await confirm($0.count) }) { hub, next in
      if let password = password { return try newCopies(kit: newKit, way: ["password": try passwordPart(password, room: room, code: next)], room: room, code: next) }
      // A passkey made anew, on the account's challenge, which the recovery key may ask for before the end.
      let c = try await hub.request("POST", "/account/passkeys/challenge", body: [:])
      guard let make = makePasskey, let handle = (c["user_handle"] as? String).flatMap({ try? unb64u($0) }), handle.count == 16 else { throw TrommiError("bad-format", "the hub's passkey challenge names no account") }
      let made = try await make(PasskeyRequest(challenge: try passkeyChallenge(c), userHandle: handle, email: "", accountId: c["account"] as? String ?? "", existing: []))
      guard made.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
      return try newCopies(kit: newKit, way: ["passkey": try passkeyPart(made, room: room, code: next)], room: room, code: next)
    }
    // (the account's id and e-mail for the kit's sheet: the device that is in now asks for them)
    let st = try? await done.room.accountStatus()
    var email = st?.email ?? ""
    if email.isEmpty, case .email(let e) = name { email = e }
    return (done.room, EmergencyKit(words: newWords, email: email, accountId: st?.accountId ?? ""), done.removed.count)
  }
}

/** The seconds a refusal of the hub asks to wait (`rate-limited`, `overloaded`), or nil. For a form's one line. */
public func retryWait(of error: Error) -> Int? { (error as? HubError)?.retryAfter }

/** A wait in a person's words: "1 second", "40 seconds", "1 minute", "12 minutes" (rounded up to whole minutes). */
public func waitText(seconds: Int) -> String {
  if seconds < 60 { return seconds == 1 ? "1 second" : "\(max(1, seconds)) seconds" }
  let minutes = (seconds + 59) / 60
  return minutes == 1 ? "1 minute" : "\(minutes) minutes"
}

/**
 * Whether a domain's apple-app-site-association file lets this app use the domain's passkeys: its `webcredentials`
 * names the app as "<team id>.<bundle id>". The app's passkeys are switched on by this (Passkeys.swift): the system
 * hands out a domain's passkeys only to an app the domain names this way.
 */
public func associationAllowsPasskeys(_ file: Bytes, bundleId: String) -> Bool {
  guard !bundleId.isEmpty, let j = (try? JSONSerialization.jsonObject(with: Data(file))) as? JSON,
        let apps = (j["webcredentials"] as? JSON)?["apps"] as? [String] else { return false }
  return apps.contains { app in
    guard let dot = app.firstIndex(of: ".") else { return false }
    return app[app.index(after: dot)...] == bundleId && dot > app.startIndex
  }
}

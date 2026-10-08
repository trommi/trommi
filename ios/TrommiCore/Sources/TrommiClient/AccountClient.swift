// AccountClient.swift: the account of a room as a signed-in device and the sign-in screens use it (shared/account.mjs):
// its status, a login added to an older room, a new password, the Emergency Kit (twelve words), the email code; on a
// new device "Forgot password" with the kit's words. One password: the auth key for the hub and the wrap key for the
// room's recovery code both come from it (Argon2id); the hub sees neither the password nor the words nor the code.
import Foundation
import TrommiCore

public let PASSWORD_MIN = 12

/** nil if the password may be used, else why not (the only rule: at least 12 characters). */
public func passwordProblem(_ p: String) -> String? { p.precomposedStringWithCanonicalMapping.count >= PASSWORD_MIN ? nil : "at least \(PASSWORD_MIN) characters" }

/** n uniformly random words of the list (rejection sampling, no modulo bias). */
func randomWords(_ n: Int) -> [String] {
  var out = [String]()
  let limit = (65536 / WORDS.count) * WORDS.count
  while out.count < n {
    let r = systemRandom(64)
    for b in stride(from: 0, to: 64, by: 2) {
      let v = Int(r[b]) << 8 | Int(r[b + 1])
      if v < limit && out.count < n { out.append(WORDS[v % WORDS.count]) }
    }
  }
  return out
}
/** A strong password to offer: five words joined by "-" (about 64 bits). */
public func generatePassword() -> String { randomWords(5).joined(separator: "-") }
/** The Emergency Kit's recovery words: twelve words (about 155 bits), one space between. */
public func generateRecoveryWords() -> String { randomWords(12).joined(separator: " ") }
private let WORD_SET = Set(WORDS)
/** Normalised recovery words (lowercase, single spaces), or ZError bad-recovery-words. */
public func parseRecoveryWords(_ text: String) throws -> String {
  let words = text.lowercased().split(whereSeparator: { !("a"..."z").contains($0) }).map(String.init)
  if words.count != 12 { throw ZError("bad-recovery-words", "the Emergency Kit has 12 words") }
  let unknown = words.filter { !WORD_SET.contains($0) }
  if !unknown.isEmpty { throw ZError("bad-recovery-words", "not a word of the kit: \(unknown.joined(separator: ", "))") }
  return words.joined(separator: " ")
}

private func accountHkdf(_ ikm: Bytes, _ salt: Bytes, _ label: String) -> Bytes { hkdfPlainInfo(ikm, salt: salt, info: utf8(label), length: 32) }
/** recovery_auth (b64u, for the hub) and the recovery wrap key, from email and the twelve words (no slow KDF: 155 random bits). */
public func accountRecoveryKeys(email: String, words: String) throws -> (recoveryAuth: String, wrapKey: Bytes) {
  let e = try normaliseEmail(email)
  let salt = accountSalt(e)
  let r = utf8(try parseRecoveryWords(words))
  return (b64u(accountHkdf(r, salt, "trommi/v1/recovery-auth")), accountHkdf(r, salt, "trommi/v1/recovery-wrap"))
}
/** Seal the room's recovery code under a wrap key ("password" or "recovery"): 0x01 ‖ nonce ‖ AES-GCM. */
public func accountWrapCode(wrapKey: Bytes, roomId: String, code: String, what: String = "password") throws -> String {
  let nonce = systemRandom(12)
  let aad = utf8("trommi/v1/account-wrap") + [0] + (try unhex(roomId)) + utf8(what)
  return b64u([1] + nonce + (try gcmSeal(key: wrapKey, nonce: nonce, aad: aad, try parseRecoveryCode(code))))
}

public struct AccountStatus {
  public var email: String
  public var emailVerifiedAt: UInt64?
  public var hasRecovery: Bool
  public var revision: Int
  public var keyWrapped: String
  public var kdf: AccountKDF
  init?(_ j: JSON) {
    guard let e = j["email"] as? String else { return nil }
    email = e
    emailVerifiedAt = (j["email_verified_at"] as? NSNumber)?.uint64Value
    hasRecovery = j["has_recovery"] as? Bool ?? false
    revision = (j["revision"] as? NSNumber)?.intValue ?? 0
    keyWrapped = j["key_wrapped"] as? String ?? ""
    let k = j["kdf"] as? JSON ?? [:]
    kdf = AccountKDF(alg: k["alg"] as? String ?? "argon2id", v: (k["v"] as? NSNumber)?.intValue ?? 1, m: (k["m"] as? NSNumber)?.intValue ?? 65536,
                     t: (k["t"] as? NSNumber)?.intValue ?? 3, p: (k["p"] as? NSNumber)?.intValue ?? 1)
  }
}

extension Room {
  private func accountPath(_ p: String = "") -> String { "/rooms/\(record.roomId)/account\(p)" }
  /** The room's account as this device sees it, or nil (a room from before accounts). */
  public func accountStatus() async throws -> AccountStatus? {
    do { return AccountStatus(try await hub.request("GET", accountPath())) }
    catch let e as HubError where e.status == 404 { return nil }
  }
  private func passwordPart(email: String, password: String, code: String) throws -> JSON {
    if let why = passwordProblem(password) { throw ZError("weak-password", why) }
    let k = try accountPasswordKeys(email: email, password: password)
    return ["auth_key": k.authKey, "key_wrapped": try accountWrapCode(wrapKey: k.wrapKey, roomId: record.roomId, code: code), "kdf": ["alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1]]
  }
  /** The room's recovery code from the account password. */
  private func codeFromPassword(_ password: String, _ st: AccountStatus) throws -> String {
    let k = try accountPasswordKeys(email: st.email, password: password, kdf: st.kdf)
    return try accountUnwrapCode(wrapKey: k.wrapKey, roomId: record.roomId, blob: st.keyWrapped)
  }
  /** Add a login to a room that has none yet: needs the room's recovery code (shown once at founding). */
  public func addAccount(email: String, password: String, recoveryCode: String) async throws {
    let e = try normaliseEmail(email)
    _ = try parseRecoveryCode(recoveryCode)
    var body = try passwordPart(email: e, password: password, code: recoveryCode)
    body["email"] = e
    _ = try await hub.request("POST", accountPath(), body: body)
  }
  /** A new password: the code is re-wrapped, the hub swaps the auth hash; nothing else changes. */
  public func changePassword(current: String, next: String) async throws {
    if let why = passwordProblem(next) { throw ZError("weak-password", why) }
    guard let st = try await accountStatus() else { throw ZError("no-account", "this room has no account yet") }
    let code: String
    do { code = try codeFromPassword(current, st) } catch { throw ZError("wrong-login", "the current password is not right") }
    var body = try passwordPart(email: st.email, password: next, code: code)
    body["revision"] = st.revision
    _ = try await hub.request("PUT", accountPath("/password"), body: body)
  }
  /** A new Emergency Kit (it replaces an older one): the twelve words, shown once. */
  public func makeEmergencyKit(password: String) async throws -> (words: String, email: String) {
    guard let st = try await accountStatus() else { throw ZError("no-account", "this room has no account yet") }
    let code: String
    do { code = try codeFromPassword(password, st) } catch { throw ZError("wrong-login", "this password does not open the account") }
    let words = generateRecoveryWords()
    let k = try accountRecoveryKeys(email: st.email, words: words)
    _ = try await hub.request("PUT", accountPath("/recovery"), body: ["recovery_auth": k.recoveryAuth, "recovery_wrapped": try accountWrapCode(wrapKey: k.wrapKey, roomId: record.roomId, code: code, what: "recovery"), "revision": st.revision])
    return (words, st.email)
  }
  public func verifyEmail(code: String) async throws { _ = try await hub.request("POST", accountPath("/verify"), body: ["code": code.filter { $0.isNumber }]) }
  public func resendEmailCode() async throws { _ = try await hub.request("POST", accountPath("/code"), body: [:]) }

  /**
   * Forgot password: email + the Emergency Kit's words + a new password. The device adds itself, then sets the new
   * password (the old one stops working). One error for every miss: wrong-recovery.
   */
  public static func resetPassword(hubURL: String, email: String, words: String, newPassword: String, base: URL = Store.defaultBase()) async throws -> Room {
    let e = try normaliseEmail(email)
    if let why = passwordProblem(newPassword) { throw ZError("weak-password", why) }
    let k = try accountRecoveryKeys(email: e, words: words)
    let r: JSON
    do { r = try await HubClient(hubURL: hubURL).request("POST", "/accounts/recover", body: ["email": e, "recovery_auth": k.recoveryAuth], auth: false) }
    catch let h as HubError where h.code == "wrong-recovery" { throw ZError("wrong-recovery", "email or recovery words are wrong") }
    guard let roomId = r["room_id"] as? String, let wrapped = r["recovery_wrapped"] as? String else { throw ZError("bad-format", "the recover answer") }
    let code: String
    do { code = try accountUnwrapCode(wrapKey: k.wrapKey, roomId: roomId, blob: wrapped, what: "recovery") } catch { throw ZError("wrong-recovery", "these words do not open the account") }
    let room = try await joinWithRecoveryCode(hubURL: hubURL, roomId: roomId, code: code, base: base, challenge: r["challenge"] as? String)
    guard let st = try await room.accountStatus() else { return room }
    var body = try room.passwordPart(email: e, password: newPassword, code: code)
    body["revision"] = st.revision
    _ = try await room.hub.request("PUT", room.accountPath("/password"), body: body)
    return room
  }
}

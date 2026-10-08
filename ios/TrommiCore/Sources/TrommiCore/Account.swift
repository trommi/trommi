// Account.swift: the Trommi account (shared/account.mjs, README "Accounts"): email + password open the room's recovery
// code, from which a new device adds itself (joinWithRecoveryCode). Argon2id from the vendored reference implementation.
import CArgon2
import Foundation

public struct AccountKDF: Codable, Equatable {
  public let alg: String, v: Int, m: Int, t: Int, p: Int
  public static let v1 = AccountKDF(alg: "argon2id", v: 1, m: 65536, t: 3, p: 1)
}

/** Argon2id (RFC 9106, version 0x13). `memoryKiB` like hash-wasm's memorySize. */
public func argon2id(password: Bytes, salt: Bytes, iterations: Int, memoryKiB: Int, parallelism: Int, length: Int, secret: Bytes = [], ad: Bytes = []) throws -> Bytes {
  var out = Bytes(repeating: 0, count: length)
  var pwd = password, slt = salt, sec = secret, adv = ad
  let rc: Int32 = out.withUnsafeMutableBufferPointer { o in
    pwd.withUnsafeMutableBufferPointer { p in
      slt.withUnsafeMutableBufferPointer { s in
        sec.withUnsafeMutableBufferPointer { k in
          adv.withUnsafeMutableBufferPointer { a in
            var ctx = argon2_context()
            ctx.out = o.baseAddress; ctx.outlen = UInt32(length)
            ctx.pwd = p.baseAddress; ctx.pwdlen = UInt32(p.count)
            ctx.salt = s.baseAddress; ctx.saltlen = UInt32(s.count)
            ctx.secret = k.count > 0 ? k.baseAddress : nil; ctx.secretlen = UInt32(k.count)
            ctx.ad = a.count > 0 ? a.baseAddress : nil; ctx.adlen = UInt32(a.count)
            ctx.t_cost = UInt32(iterations); ctx.m_cost = UInt32(memoryKiB)
            ctx.lanes = UInt32(parallelism); ctx.threads = UInt32(parallelism)
            ctx.version = UInt32(ARGON2_VERSION_13.rawValue)
            ctx.allocate_cbk = nil; ctx.free_cbk = nil
            ctx.flags = 0   // ARGON2_DEFAULT_FLAGS
            return argon2_ctx(&ctx, Argon2_id)
          }
        }
      }
    }
  }
  if rc != ARGON2_OK.rawValue { throw fail("argon2", String(cString: argon2_error_message(rc))) }
  return out
}

public func normaliseEmail(_ email: String) throws -> String {
  let e = email.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let parts = e.split(separator: "@", omittingEmptySubsequences: false)
  let ok = e.utf16.count <= 254 && parts.count == 2 && !parts[0].isEmpty && parts[0].count <= 64 && !e.contains(where: { $0.isWhitespace })
    && parts[1].split(separator: ".", omittingEmptySubsequences: false).count >= 2 && !parts[1].hasPrefix(".") && !(parts[1].split(separator: ".").last.map { $0.count < 2 } ?? true)
  if !ok { throw fail("bad-email", "not an email address") }
  return e
}
public func accountSalt(_ email: String) -> Bytes { sha256(utf8("trommi/v1/account-salt") + [0] + utf8(email)) }
/** HKDF-SHA-256 with info = the label (no 0x00: account.mjs's own convention). */
private func accountHkdf(_ ikm: Bytes, _ salt: Bytes, _ label: String) -> Bytes { hkdfPlainInfo(ikm, salt: salt, info: utf8(label), length: 32) }

public func accountMasterKey(email: String, password: String, kdf: AccountKDF = .v1) throws -> Bytes {
  if kdf.alg != "argon2id" || kdf.v != 1 { throw fail("bad-kdf", "unknown account kdf") }
  return try argon2id(password: utf8(password.precomposedStringWithCanonicalMapping), salt: accountSalt(email), iterations: kdf.t, memoryKiB: kdf.m, parallelism: kdf.p, length: 32)
}
/** auth_key (sent to the hub at login, b64u) and wrap_key (never leaves the device). */
public func accountPasswordKeys(email: String, password: String, kdf: AccountKDF = .v1) throws -> (authKey: String, wrapKey: Bytes) {
  let e = try normaliseEmail(email)
  let salt = accountSalt(e)
  let master = try accountMasterKey(email: e, password: password, kdf: kdf)
  return (b64u(accountHkdf(master, salt, "trommi/v1/account-auth")), accountHkdf(master, salt, "trommi/v1/account-wrap"))
}
/** Open key_wrapped (0x01 ‖ nonce ‖ AES-GCM(code)) into the room's recovery code. */
public func accountUnwrapCode(wrapKey: Bytes, roomId: String, blob: String, what: String = "password") throws -> String {
  let b = try unb64u(blob)
  if b.count != 1 + 12 + 32 + 16 || b[0] != 1 { throw fail("bad-format", "account key blob") }
  let aad = utf8("trommi/v1/account-wrap") + [0] + (try unhex(roomId)) + utf8(what)
  do { return try formatRecoveryCode(try gcmOpen(key: wrapKey, nonce: Array(b[1..<13]), aad: aad, Array(b[13...]))) }
  catch { throw fail("wrong-login", "this password does not open the account") }
}

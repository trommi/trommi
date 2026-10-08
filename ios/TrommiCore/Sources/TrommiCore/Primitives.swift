// Primitives.swift: the six primitives of FORMAT.md section 1, through swift-crypto (CryptoKit's API; on Apple
// platforms it is CryptoKit itself). Domain separation (section 3): label ‖ 0x00 in front of hashed, signed and
// derived data. Nothing here implements a primitive.
import Crypto
import Foundation

public enum LABEL {
  public static let deviceId = "trommi/v1/device-id"
  public static let logEntry = "trommi/v1/log-entry"
  public static let logSig = "trommi/v1/log-sig"
  public static let sealedBox = "trommi/v1/sealed-box"
  public static let epochWrap = "trommi/v1/epoch-wrap"
  public static let keyCommit = "trommi/v1/epoch-commit/key"
  public static let histCommit = "trommi/v1/epoch-commit/hist"
  public static let backLink = "trommi/v1/back-link"
  public static let senderKey = "trommi/v1/sender-key"
  public static let envelope = "trommi/v1/envelope"
  public static let envelopeSig = "trommi/v1/envelope-sig"
  public static let inviteId = "trommi/v1/invite-id"
  public static let inviteMac = "trommi/v1/invite-mac"
  public static let inviteCommit = "trommi/v1/invite-commit"
  public static let inviteOffer = "trommi/v1/invite-offer"
  public static let inviteOfferSig = "trommi/v1/invite-offer-sig"
  public static let inviteRequest = "trommi/v1/invite-request"
  public static let inviteRequestSig = "trommi/v1/invite-request-sig"
  public static let inviteRevealSig = "trommi/v1/invite-reveal-sig"
  public static let inviteCode = "trommi/v1/invite-code"
  public static let recoverySign = "trommi/v1/recovery/sign"
  public static let recoveryKex = "trommi/v1/recovery/kex"
  public static let hubAuth = "trommi/v1/hub-auth"
  public static let objectId = "trommi/v1/object-id"
  // session-grants.mjs
  public static let sessionCommitKey = "trommi/v1/session-commit/key"
  public static let sessionCommitHist = "trommi/v1/session-commit/hist"
  public static let sessionGrantSig = "trommi/v1/session-grant-sig"
  public static let sessionGrant = "trommi/v1/session-grant"
  public static let sessionWrap = "trommi/v1/session-wrap"
  public static let sessionManifest = "trommi/v1/session-manifest"
  public static let sessionBackLink = "trommi/v1/session-back-link"
}
public func labelBytes(_ label: String) -> Bytes { Array(label.utf8) + [0] }

public func sha256(_ parts: Bytes...) -> Bytes {
  var h = SHA256()
  for p in parts { h.update(data: p) }
  return Array(h.finalize())
}
public func sha256(_ parts: [Bytes]) -> Bytes {
  var h = SHA256()
  for p in parts { h.update(data: p) }
  return Array(h.finalize())
}
/** H(label, data…) = SHA-256(label ‖ 0x00 ‖ data…) */
public func hash(_ label: String, _ parts: Bytes...) -> Bytes { sha256([labelBytes(label)] + parts) }
public func hash(_ label: String, parts: [Bytes]) -> Bytes { sha256([labelBytes(label)] + parts) }

/** HKDF-SHA-256 with info = label ‖ 0x00 ‖ context, extract and expand. */
public func hkdf(_ ikm: Bytes, salt: Bytes, label: String, context: Bytes = [], length: Int) -> Bytes {
  let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: labelBytes(label) + context, outputByteCount: length)
  return key.withUnsafeBytes { Array($0) }
}

/** HKDF-SHA-256 with a raw info (account.mjs uses the label without the 0x00). */
public func hkdfPlainInfo(_ ikm: Bytes, salt: Bytes, info: Bytes, length: Int) -> Bytes {
  HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length).withUnsafeBytes { Array($0) }
}

public func hmacSHA256(key: Bytes, _ data: Bytes) -> Bytes {
  Array(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
}
public func hmacVerify(key: Bytes, mac: Bytes, _ data: Bytes) -> Bool {
  HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: data, using: SymmetricKey(data: key))
}

/** AES-256-GCM, 96-bit nonce, the 128-bit tag appended to the ciphertext (WebCrypto's layout). */
public func gcmSeal(key: Bytes, nonce: Bytes, aad: Bytes, _ plaintext: Bytes) throws -> Bytes {
  _ = try need(key, 32, "AES key")
  let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: try need(nonce, 12, "nonce")), authenticating: aad)
  return Array(box.ciphertext) + Array(box.tag)
}
public func gcmOpen(key: Bytes, nonce: Bytes, aad: Bytes, _ ciphertext: Bytes) throws -> Bytes {
  _ = try need(key, 32, "AES key")
  guard ciphertext.count >= 16, nonce.count == 12 else { throw fail("decrypt-failed", "authentication tag does not match") }
  do {
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext[..<(ciphertext.count - 16)], tag: ciphertext[(ciphertext.count - 16)...])
    return Array(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad))
  } catch {
    throw fail("decrypt-failed", "authentication tag does not match")
  }
}

// ---- Ed25519 and X25519 -------------------------------------------------------------

/** Ed25519 public key of an RFC 8032 seed. */
public func ed25519Public(seed: Bytes) throws -> Bytes {
  Array(try Curve25519.Signing.PrivateKey(rawRepresentation: try need(seed, 32, "signing seed")).publicKey.rawRepresentation)
}
/** X25519 public key of a 32-byte private scalar (before clamping, RFC 7748). */
public func x25519Public(priv: Bytes) throws -> Bytes {
  Array(try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try need(priv, 32, "exchange key")).publicKey.rawRepresentation)
}
/** Ed25519 over label ‖ 0x00 ‖ message. CryptoKit's signatures are randomized on Apple platforms: compare by verifying. */
public func signRaw(seed: Bytes, _ message: Bytes) throws -> Bytes {
  Array(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).signature(for: message))
}
public func verify(_ signPub: Bytes, _ label: String, _ message: Bytes, _ signature: Bytes) -> Bool {
  guard signature.count == 64, signPub.count == 32, let key = try? Curve25519.Signing.PublicKey(rawRepresentation: signPub) else { return false }
  return key.isValidSignature(signature, for: labelBytes(label) + message)
}
/** X25519; an invalid or small-order key and the all-zero secret are refused (bad-key). */
public func x25519(priv: Bytes, pub: Bytes) throws -> Bytes {
  _ = try need(pub, 32, "X25519 public key")
  let shared: Bytes
  do {
    let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
    let s = try k.sharedSecretFromKeyAgreement(with: try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub))
    shared = s.withUnsafeBytes { Array($0) }
  } catch {
    throw fail("bad-key", "X25519 failed (invalid or small-order public key)")
  }
  if isZero(shared) { throw fail("bad-key", "X25519 gave the all-zero secret") }
  return shared
}

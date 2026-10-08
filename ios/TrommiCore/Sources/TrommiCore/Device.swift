// Device.swift: device identity (FORMAT.md section 4) and the sealed box ZSEAL1 (section 5).
import Foundation

public enum ROLE { public static let HUMAN = 1, AGENT = 2 }

public func deviceId(_ signPub: Bytes, _ kexPub: Bytes) throws -> Bytes {
  hash(LABEL.deviceId, try need(signPub, 32, "signPub"), try need(kexPub, 32, "kexPub"))
}

/** The public half of a device or of the recovery key. */
public struct PublicDevice: Equatable {
  public let id: Bytes, signPub: Bytes, kexPub: Bytes
  public init(signPub: Bytes, kexPub: Bytes) throws { self.signPub = signPub; self.kexPub = kexPub; id = try deviceId(signPub, kexPub) }
}

/**
 * A device: Ed25519 seed and X25519 private key as bytes. The app keeps them in the Keychain; the command-line client
 * in its key file (0x01 0x0c ‖ signSeed ‖ kexPrivate, mode 0600). Never printed.
 */
public struct Device {
  public let signSeed: Bytes
  public let kexPriv: Bytes
  public let signPub: Bytes
  public let kexPub: Bytes
  public let id: Bytes
  public init(signSeed: Bytes, kexPriv: Bytes) throws {
    self.signSeed = try need(signSeed, 32, "signing seed")
    self.kexPriv = try need(kexPriv, 32, "exchange key")
    signPub = try ed25519Public(seed: signSeed)
    kexPub = try x25519Public(priv: kexPriv)
    id = try deviceId(signPub, kexPub)
  }
  public static func generate(rng: RNG = systemRandom) throws -> Device { try Device(signSeed: rng(32), kexPriv: rng(32)) }
  public var publicDevice: PublicDevice { try! PublicDevice(signPub: signPub, kexPub: kexPub) }

  /** Ed25519 over label ‖ 0x00 ‖ message. */
  public func sign(_ label: String, _ message: Bytes) throws -> Bytes { try signRaw(seed: signSeed, labelBytes(label) + message) }

  /** 0x01 0x0b signPub kexPub */
  public func encodePublic() -> Bytes { [VERSION, OBJ.DEVICE_PUBLIC] + signPub + kexPub }
  /** 0x01 0x0c signSeed kexPrivate: the key file. */
  public func exportSecret() -> Bytes { [VERSION, OBJ.DEVICE_SECRET] + signSeed + kexPriv }
  public static func importSecret(_ bytes: Bytes) throws -> Device {
    var r = R(bytes)
    try header(&r, OBJ.DEVICE_SECRET)
    let s = try r.take(32), k = try r.take(32)
    try r.end()
    return try Device(signSeed: s, kexPriv: k)
  }
}

public func decodeDevicePublic(_ bytes: Bytes) throws -> PublicDevice {
  var r = R(bytes)
  try header(&r, OBJ.DEVICE_PUBLIC)
  let s = try r.take(32), k = try r.take(32)
  try r.end()
  return try PublicDevice(signPub: s, kexPub: k)
}

// ---- sealed box: X25519 + HKDF-SHA-256 + AES-256-GCM (HPKE pattern, not RFC 9180 wire format) ----

private func sealKeys(_ shared: Bytes, _ ephPub: Bytes, _ recipientPub: Bytes) -> (key: Bytes, nonce: Bytes) {
  let okm = hkdf(shared, salt: ephPub + recipientPub, label: LABEL.sealedBox, length: 44)
  return (Array(okm[0..<32]), Array(okm[32..<44]))
}

/** 0x01 0x04 ‖ ephemeralPub(32) ‖ ciphertext+tag. `aad` is bound but not transmitted. */
public func seal(_ recipientKexPub: Bytes, _ plaintext: Bytes, aad: Bytes = [], rng: RNG = systemRandom) throws -> Bytes {
  let ephPriv = rng(32)
  let ephPub = try x25519Public(priv: ephPriv)
  let shared = try x25519(priv: ephPriv, pub: recipientKexPub)
  let k = sealKeys(shared, ephPub, recipientKexPub)
  return [VERSION, OBJ.SEALED] + ephPub + (try gcmSeal(key: k.key, nonce: k.nonce, aad: aad, plaintext))
}

public func openSealed(_ device: Device, _ sealed: Bytes, aad: Bytes = []) throws -> Bytes {
  var r = R(sealed)
  try header(&r, OBJ.SEALED)
  let ephPub = try r.take(32)
  let ct = try r.take(r.left)
  if ct.count < 16 { throw fail("bad-format", "sealed box too short") }
  let shared = try x25519(priv: device.kexPriv, pub: ephPub)
  let k = sealKeys(shared, ephPub, device.kexPub)
  return try gcmOpen(key: k.key, nonce: k.nonce, aad: aad, ct)
}

// LocalSeal.swift: sealing what this device keeps on its own disk (the record cache, the list of share links) under a
// key from the Keychain. Local storage only, with Apple's CryptoKit (swift-crypto elsewhere): nothing here is the
// protocol, nothing sealed here leaves the device.
import Foundation
import Crypto

/** AES-256-GCM: ciphertext ‖ tag. */
func gcmSeal(key: Bytes, nonce: Bytes, aad: Bytes, _ plain: Bytes) throws -> Bytes {
  let box = try AES.GCM.seal(Data(plain), using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: Data(nonce)), authenticating: Data(aad))
  return Bytes(box.ciphertext) + Bytes(box.tag)
}
func gcmOpen(key: Bytes, nonce: Bytes, aad: Bytes, _ sealed: Bytes) throws -> Bytes {
  guard sealed.count >= 16 else { throw TrommiError("decrypt-failed") }
  let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: Data(nonce)), ciphertext: Data(sealed.dropLast(16)), tag: Data(sealed.suffix(16)))
  do { return Bytes(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(aad))) } catch { throw TrommiError("decrypt-failed") }
}

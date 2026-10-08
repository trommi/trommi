// Assets.swift: attachments (FORMAT.md section 11): 64 KiB STREAM chunks, the asset key under the room key, the link.
import Foundation

public let ASSET_CHUNK = 65536
private let ASSET_HEAD = 22
private func assetNonce(_ index: Int, _ last: Bool) -> Bytes { [0, 0, 0] + be64(UInt64(index)) + [last ? 1 : 0] }
private func assetHeader(_ blobId: Bytes) throws -> Bytes { let w = W(); try w.u8(Int(VERSION)).u8(Int(OBJ.ASSET)).raw(blobId, 16, "blob id").u32(ASSET_CHUNK); return w.out }

public func encryptAsset(_ data: Bytes, rng: RNG = systemRandom) throws -> (blob: Bytes, key: Bytes, blobId: Bytes, sha256: Bytes, size: Int) {
  let key = rng(32), blobId = rng(16)
  let head = try assetHeader(blobId)
  var blob = head
  let chunks = max(1, (data.count + ASSET_CHUNK - 1) / ASSET_CHUNK)
  for i in 0..<chunks {
    let part = Array(data[min(i * ASSET_CHUNK, data.count)..<min((i + 1) * ASSET_CHUNK, data.count)])
    blob += try gcmSeal(key: key, nonce: assetNonce(i, i == chunks - 1), aad: head, part)
  }
  return (blob, key, blobId, sha256(blob), data.count)
}
private func assetLayout(_ blob: Bytes) throws -> (blobId: Bytes, chunks: Int, head: Bytes, full: Int) {
  var r = R(blob)
  try header(&r, OBJ.ASSET)
  let blobId = try r.take(16)
  if try r.u32() != ASSET_CHUNK { throw fail("bad-format", "unsupported chunk size") }
  let body = blob.count - ASSET_HEAD, full = ASSET_CHUNK + 16
  let chunks = (body + full - 1) / full
  if chunks < 1 || body - (chunks - 1) * full < 16 { throw fail("bad-format", "asset is cut off") }
  return (blobId, chunks, Array(blob[0..<ASSET_HEAD]), full)
}
public func decryptAssetChunk(_ blob: Bytes, key: Bytes, index: Int) throws -> Bytes {
  let l = try assetLayout(blob)
  if index < 0 || index >= l.chunks { throw fail("bad-argument", "no such chunk") }
  let from = ASSET_HEAD + index * l.full
  return try gcmOpen(key: key, nonce: assetNonce(index, index == l.chunks - 1), aad: l.head, Array(blob[from..<min(from + l.full, blob.count)]))
}
public func decryptAsset(_ blob: Bytes, key: Bytes, expectedSha256: Bytes? = nil) throws -> Bytes {
  if let e = expectedSha256, !bytesEqual(sha256(blob), e) { throw fail("decrypt-failed", "this is not the blob the message names") }
  let l = try assetLayout(blob)
  return try (0..<l.chunks).flatMap { try decryptAssetChunk(blob, key: key, index: $0) }
}
private func assetWrapKey(_ roomId: Bytes, _ s: EpochSecret, _ blobId: Bytes) throws -> Bytes {
  hkdf(s.key, salt: roomId, label: LABEL.assetWrap, context: epochCtx(s.epoch) + (try need(blobId, 16, "blob id")), length: 32)
}
private func assetWrapAad(_ roomId: Bytes, _ epoch: Int, _ blobId: Bytes) -> Bytes { [VERSION, OBJ.ASSET_WRAP] + roomId + epochCtx(epoch) + blobId }
/** 0x01 0x0a epoch blobId nonce(12, random: never derived) ciphertext(48). */
public func wrapAssetKey(roomId: Bytes, secret: EpochSecret, blobId: Bytes, assetKey: Bytes, rng: RNG = systemRandom) throws -> Bytes {
  let nonce = rng(12)
  return [VERSION, OBJ.ASSET_WRAP] + epochCtx(secret.epoch) + blobId + nonce + (try gcmSeal(key: try assetWrapKey(roomId, secret, blobId), nonce: nonce, aad: assetWrapAad(roomId, secret.epoch, blobId), try need(assetKey, 32, "asset key")))
}
public func unwrapAssetKey(roomId: Bytes, secrets: (Int) -> EpochSecret?, _ wrapped: Bytes) throws -> (blobId: Bytes, epoch: Int, key: Bytes) {
  var r = R(wrapped)
  try header(&r, OBJ.ASSET_WRAP)
  let epoch = try r.u32(), blobId = try r.take(16), nonce = try r.take(12), ct = try r.take(r.left)
  guard let s = secrets(epoch) else { throw fail("no-key", "no key for epoch \(epoch)") }
  return (blobId, epoch, try gcmOpen(key: try assetWrapKey(roomId, s, blobId), nonce: nonce, aad: assetWrapAad(roomId, epoch, blobId), ct))
}
public func assetLink(url: String, blobId: Bytes, key: Bytes) -> String { "\(url)#a\(VERSION).\(b64u(blobId)).\(b64u(key))" }
public func parseAssetLink(_ link: String) throws -> (url: String, blobId: Bytes, key: Bytes) {
  guard let at = link.firstIndex(of: "#") else { throw fail("bad-version", "asset link version") }
  let parts = link[link.index(after: at)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
  if parts[0] != "a\(VERSION)" { throw fail("bad-version", "asset link version") }
  if parts.count != 3 { throw fail("bad-format", "asset link") }
  let blobId = try unb64u(parts[1]), key = try unb64u(parts[2])
  if blobId.count != 16 || key.count != 32 { throw fail("bad-format", "asset link") }
  return (String(link[..<at]), blobId, key)
}

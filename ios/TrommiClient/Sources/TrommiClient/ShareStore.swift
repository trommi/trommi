// ShareStore.swift: the links for people outside the room this device made ("Copy link" on an artifact), kept so the
// same link is copied again while it holds and can be stopped (the web keeps them in its storage: client.myShares).
// A link carries the share's secret and the file's key after its #, so the file is sealed like the cache: AES-256-GCM
// under the room's cache key (the Keychain on the phone), written with the phone's file protection.
import Foundation

/** One link this device made: `<app>/artifact/<share_id>#<secret>.<file_key>.<sha256>` and until when the hub answers it. */
public struct SharedLink: Codable, Equatable, Sendable {
  public let shareId: String
  public let attachmentId: String
  public let link: String
  public let expiresAt: UInt64
  public init(shareId: String, attachmentId: String, link: String, expiresAt: UInt64) {
    self.shareId = shareId; self.attachmentId = attachmentId; self.link = link; self.expiresAt = expiresAt
  }
  /** Whole days it still holds, at least 1 while it does ("Shared · 30 days"). */
  public func daysLeft(now: UInt64 = nowMs()) -> Int { expiresAt > now ? max(1, Int((Double(expiresAt - now) / 86_400_000).rounded(.up))) : 0 }
}

public final class ShareStore {
  /** A link holds 30 days; it is not renewed (a new one is made only after it ran out or was stopped). */
  public static let days = 30
  private let url: URL
  private let key: Bytes
  private var list: [SharedLink]
  private static let aad = utf8("trommi ios shares")

  public init(dir: URL, key: Bytes) {
    url = dir.appendingPathComponent("shares.bin")
    self.key = key
    list = []
    if let d = try? Data(contentsOf: url), d.count > 12 + 16,
       let plain = try? gcmOpen(key: key, nonce: Array(d[0..<12]), aad: ShareStore.aad, Array(d[12...])),
       let l = try? JSONDecoder().decode([SharedLink].self, from: Data(plain)) { list = l }
  }
  /** The link of that file that still holds, if this device made one. */
  public func live(_ attachmentId: String, now: UInt64 = nowMs()) -> SharedLink? {
    list.first { $0.attachmentId == attachmentId && $0.expiresAt > now }
  }
  /** Every link of that file still kept (to stop them). */
  public func all(_ attachmentId: String) -> [SharedLink] { list.filter { $0.attachmentId == attachmentId } }
  public func put(_ s: SharedLink, now: UInt64 = nowMs()) throws {
    list = [s] + list.filter { $0.shareId != s.shareId && $0.expiresAt > now }
    try save()
  }
  public func remove(shareId: String) throws {
    list.removeAll { $0.shareId == shareId }
    try save()
  }
  private func save() throws {
    let nonce = systemRandom(12)
    let sealed = nonce + (try gcmSeal(key: key, nonce: nonce, aad: ShareStore.aad, Array(try JSONEncoder().encode(list))))
    var o: Data.WritingOptions = [.atomic]
    #if os(iOS)
    o.insert(.completeFileProtectionUntilFirstUserAuthentication)
    #endif
    try Data(sealed).write(to: url, options: o)
  }
}

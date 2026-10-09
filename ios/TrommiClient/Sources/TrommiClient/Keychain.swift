// Keychain.swift: the two secrets of the app that are not in the device's state, one item per room each:
//   state-<room>   the key that seals the device's state (DeviceStore.swift)
//   cache-<room>   the key that seals what this device already opened, kept for a quick start (RecordStore.swift)
// Both are kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly (a push wakes the app while the phone is locked; never in
// a backup, never on another device) and are items of the APP: no access group is named, so they land in the app's
// own group (<team>.<bundle id>), which no extension is in. The one item the notification extension may read is
// PushNotify's, which names the App Group as its access group (NotifyGroup.swift).
// Elsewhere (Linux: tests) the key is a 0600 file beside the state.
import Foundation
#if os(iOS)
import Security
#endif

enum LocalKey {
  /** The 32-byte key `name` of the room in `dir`, made on first use. */
  static func get(_ name: String, dir: URL) throws -> Bytes {
    #if os(iOS)
    let account = "\(name)-\(dir.lastPathComponent)"
    if let k = read(account), k.count == 32 { return Bytes(k) }
    var k = Bytes(repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, 32, &k) == errSecSuccess else { throw TrommiError("keychain", "no random bytes") }
    try put(account, Data(k))
    guard read(account) == Data(k) else { throw TrommiError("keychain", "the key is not kept") }
    return k
    #else
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = dir.appendingPathComponent("\(name).key")
    if let k = try? Data(contentsOf: url), k.count == 32 { return Bytes(k) }
    var g = SystemRandomNumberGenerator()
    let k = (0..<32).map { _ in UInt8.random(in: 0...255, using: &g) }
    guard FileManager.default.createFile(atPath: url.path, contents: Data(k), attributes: [.posixPermissions: 0o600]) else { throw TrommiError("keychain", "the key file could not be written") }
    return k
    #endif
  }
  /** The keys of a room whose folder was renamed (a founding gets its room id from the hub's answer). */
  static func move(from: URL, to: URL) throws {
    #if os(iOS)
    for name in ["state", "cache"] {
      guard let k = read("\(name)-\(from.lastPathComponent)") else { continue }
      try put("\(name)-\(to.lastPathComponent)", k)
      SecItemDelete(query("\(name)-\(from.lastPathComponent)") as CFDictionary)
    }
    #endif
    // (elsewhere the key files moved with the folder)
  }
  /** Forgets every key of that room (signing out). */
  static func wipe(dir: URL) {
    #if os(iOS)
    for name in ["state", "cache"] { SecItemDelete(query("\(name)-\(dir.lastPathComponent)") as CFDictionary) }
    #endif
  }

  #if os(iOS)
  private static let service = "com.trommi.local-key"
  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }
  private static func put(_ account: String, _ data: Data) throws {
    SecItemDelete(query(account) as CFDictionary)
    var add = query(account)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let rc = SecItemAdd(add as CFDictionary, nil)
    if rc != errSecSuccess { throw TrommiError("keychain", "a key could not be kept in the Keychain (\(rc))") }
  }
  private static func read(_ account: String) -> Data? {
    var q = query(account)
    q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }
  #endif
}

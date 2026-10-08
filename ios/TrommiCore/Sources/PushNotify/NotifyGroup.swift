// NotifyGroup: where the context lives on the phone. The App Group container (group.com.trommi.ios; xtool signed in with
// an Apple ID registers group.XTL-<team>.com.trommi.ios, so both are tried, as ShareGroup does), two sealed files:
//   notify/context.sealed   NotifyContext, AES-256-GCM under the context key (the Notification Service Extension)
//   notify/live.sealed      LiveLook, under the live key (the Live Activity's widget: the crowned session's drawing)
// Each key is 32 random bytes in the Keychain with the App Group as access group, kSecAttrAccessibleAfterFirstUnlock-
// ThisDeviceOnly: never in a backup, never on another device. The app makes them; the extensions only read. The device
// keys and the record store's key stay in the app's own Keychain group.
import Foundation
import TrommiCore
#if canImport(Security)
import Security
#endif

public enum NotifyGroup {
  public static let base = "com.trommi.ios"
  /** The App Group ids to try: an Info.plist override (TrommiAppGroup), the one of this bundle id, the plain one. */
  public static func candidates(bundleID: String?, infoGroup: String?) -> [String] {
    var out = [String]()
    if let g = infoGroup, !g.isEmpty { out.append(g) }
    if var b = bundleID {
      for suffix in [".notify", ".live", ".share"] where b.hasSuffix(suffix) { b = String(b.dropLast(suffix.count)) }
      out.append("group.\(b)")
    }
    out.append("group.\(base)")
    var seen = Set<String>()
    return out.filter { seen.insert($0).inserted }
  }

  #if os(iOS)
  public static func resolve(bundle: Bundle = .main) -> (id: String, url: URL)? {
    for g in candidates(bundleID: bundle.bundleIdentifier, infoGroup: bundle.object(forInfoDictionaryKey: "TrommiAppGroup") as? String) {
      if let u = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) { return (g, u) }
    }
    return nil
  }

  enum Item: String { case context = "context-key", live = "live-key" }
  static let service = "com.trommi.notify"

  static func key(_ item: Item, group: String, create: Bool) -> Bytes? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: item.rawValue, kSecAttrAccessGroup as String: group]
    var get = q
    get[kSecReturnData as String] = true
    get[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    if SecItemCopyMatching(get as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 { return Array(d) }
    guard create else { return nil }
    let k = systemRandom(32)
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = Data(k)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
    return k
  }

  static func file(_ name: String, in container: URL) -> URL {
    container.appendingPathComponent("notify", isDirectory: true).appendingPathComponent(name)
  }
  static func write(_ bytes: Bytes, _ name: String, in container: URL) throws {
    let url = file(name, in: container)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(bytes).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  // ---- the app writes ----
  public static func writeContext(_ c: NotifyContext) throws {
    guard let g = resolve(), let k = key(.context, group: g.id, create: true) else { throw ZError("no-app-group", "no App Group or no Keychain item") }
    try write(try NotifySeal.seal(c, key: k), "context.sealed", in: g.url)
  }
  public static func writeLive(_ l: LiveLook) throws {
    guard let g = resolve(), let k = key(.live, group: g.id, create: true) else { throw ZError("no-app-group", "no App Group or no Keychain item") }
    try write(try l.seal(key: k), "live.sealed", in: g.url)
  }
  /** Signed out: nothing of the room stays for the extensions. */
  public static func clear() {
    guard let g = resolve() else { return }
    try? FileManager.default.removeItem(at: g.url.appendingPathComponent("notify", isDirectory: true))
  }

  // ---- the extensions read ----
  public static func readContext() -> NotifyContext? {
    guard let g = resolve(), let k = key(.context, group: g.id, create: false), let d = try? Data(contentsOf: file("context.sealed", in: g.url)) else { return nil }
    return NotifySeal.open(Array(d), key: k)
  }
  public static func readLive() -> LiveLook? {
    guard let g = resolve(), let k = key(.live, group: g.id, create: false), let d = try? Data(contentsOf: file("live.sealed", in: g.url)) else { return nil }
    return LiveLook.open(Array(d), key: k)
  }
  #endif
}

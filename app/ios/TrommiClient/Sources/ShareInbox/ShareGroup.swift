// ShareGroup: where the inbox lives on the phone and the key that seals it. The App Group's id differs by build:
// `group.com.trommi.ios` in the entitlements; xtool, signed in with an Apple ID, registers it as
// `group.XTL-<team>.com.trommi.ios` and rewrites the entitlement (with the API key it keeps it as written). Both are
// tried; the one iOS gives a container for is the one this build is entitled to. The inbox key lives in the Keychain
// with that same App Group as its access group (an App Group is a valid keychain access group, no
// keychain-access-groups entitlement needed): the app and its extension share this one item, and nothing else of the
// app's Keychain (the device keys stay the app's own).
import Foundation
import Crypto
#if canImport(Security)
import Security
#endif

public enum ShareGroup {
  public static let base = "com.trommi.ios"
  /** The App Group ids to try, in order: an Info.plist override, the one xtool derives from this bundle id, the plain one. */
  public static func candidates(bundleID: String?, infoGroup: String?) -> [String] {
    var out = [String]()
    if let g = infoGroup, !g.isEmpty { out.append(g) }
    if var b = bundleID {
      if b.hasSuffix(".share") { b = String(b.dropLast(".share".count)) }
      out.append("group.\(b)")
    }
    out.append("group.\(base)")
    var seen = Set<String>()
    return out.filter { seen.insert($0).inserted }
  }

  #if os(iOS)
  /** This build's App Group and its container, or nil when the build has none (then there is no share inbox). */
  public static func resolve(bundle: Bundle = .main) -> (id: String, url: URL)? {
    for g in candidates(bundleID: bundle.bundleIdentifier, infoGroup: bundle.object(forInfoDictionaryKey: "TrommiAppGroup") as? String) {
      if let u = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) { return (g, u) }
    }
    return nil
  }

  /** The inbox of this build: its App Group, its key (made by the app when missing; the extension only reads). */
  public static func inbox(create: Bool, bundle: Bundle = .main) -> ShareInbox? {
    guard let g = resolve(bundle: bundle), let k = ShareKeychain.key(group: g.id, create: create) else { return nil }
    return ShareInbox(container: g.url, key: k)
  }
  #endif
}

#if os(iOS)
/** The inbox key in the Keychain: after the first unlock, this device only, under the App Group's access group. */
public enum ShareKeychain {
  static let service = "com.trommi.share-inbox"
  static let account = "inbox-key"
  public static func key(group: String, create: Bool) -> SymmetricKey? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
    var get = q
    get[kSecReturnData as String] = true
    get[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    if SecItemCopyMatching(get as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 { return SymmetricKey(data: d) }
    guard create else { return nil }
    let k = SymmetricKey(size: .bits256)
    let bytes = k.withUnsafeBytes { Data($0) }
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
    return k
  }
  /** The key goes with the inbox it opened (ShareInbox.wipe): a new room gets a new one. */
  public static func remove(group: String) {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                   kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group] as CFDictionary)
  }
}
#endif

#if canImport(Darwin)
/** "Something was shared": the extension posts, the running app hears it (no payload: a Darwin notification carries none). */
public enum ShareSignal {
  public static func post() {
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(ShareInbox.darwinName as CFString), nil, nil, true)
  }
  private static var handler: (() -> Void)?
  /** Call `on` on the main queue on every share while this process runs (one observer per process). */
  public static func observe(_ on: @escaping () -> Void) {
    let first = handler == nil
    handler = on
    guard first else { return }
    CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
      DispatchQueue.main.async { ShareSignal.handler?() }
    }, ShareInbox.darwinName as CFString, nil, .deliverImmediately)
  }
}
#endif

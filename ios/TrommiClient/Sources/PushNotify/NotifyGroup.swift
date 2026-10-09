// NotifyGroup: where the context lives on the phone. It holds keys, so it is not a file: it is ONE Keychain item (a
// generic password) that the app writes and the Notification Service Extension reads. The item is
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable after the first unlock since the phone started (a push
// arrives while the phone is locked), never on another device. The system keeps it encrypted;
// nothing is sealed in Swift here.
//
// The item's access group is the App Group that the app and the extension share (on iOS an App Group is also a
// Keychain access group; `accessGroup` below is the one place that names it). The App Group's file container is not
// used. Everything else of the app (the device's store, its device key, the push key's own copy) stays in the app's
// private container and its private Keychain group, which no extension can open.
import Foundation
#if canImport(Security)
import Security
#endif

/** A refusal of this module; the text names no key and no content. */
public struct NotifyError: Error, Equatable, CustomStringConvertible {
  public let code: String
  public init(_ code: String) { self.code = code }
  public var description: String { code }
}

/** Where the context's bytes are kept: the Keychain on the phone, a fake in the tests. */
public protocol NotifyStorage {
  /** The stored bytes, nil when there are none or they cannot be read. */
  func read() -> [UInt8]?
  /** Replaces what is stored. */
  func write(_ bytes: [UInt8]) throws
  /** Removes what is stored. */
  func clear()
}

/** The context over a storage: the app writes, the extension reads. */
public struct NotifyStore {
  let storage: NotifyStorage
  public init(storage: NotifyStorage) { self.storage = storage }

  public func write(_ c: NotifyContext) throws { try storage.write(Array(try JSONEncoder().encode(c))) }
  /** nil when nothing is stored, or it is not a context of this version. */
  public func read() -> NotifyContext? {
    guard let b = storage.read(), let c = try? JSONDecoder().decode(NotifyContext.self, from: Data(b)), c.version == 2 else { return nil }
    return c
  }
  /** Signed out: nothing of the room stays for the extension. */
  public func clear() { storage.clear() }
}

public enum NotifyGroup {
  public static let base = "com.trommi.ios"

  /**
   * The App Group ids to try: an Info.plist override (TrommiAppGroup), the one of this bundle id, the plain one.
   * A development build signed by xtool gets its bundle ids and its App Group prefixed (group.XTL-<team>.com.trommi.ios),
   * so the name is not fixed at build time.
   */
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
  /**
   * The Keychain access group of the context: the first candidate App Group this process is entitled to. The one
   * place that names the access group, for the app and the extension alike.
   */
  public static func accessGroup(bundle: Bundle = .main) -> String? {
    candidates(bundleID: bundle.bundleIdentifier, infoGroup: bundle.object(forInfoDictionaryKey: "TrommiAppGroup") as? String)
      .first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
  }

  /** The context on this phone; nil when the process has no App Group. */
  public static func store() -> NotifyStore? { accessGroup().map { NotifyStore(storage: NotifyKeychain(accessGroup: $0)) } }

  // ---- the app writes ----
  public static func writeContext(_ c: NotifyContext) throws {
    guard let s = store() else { throw NotifyError("no-app-group") }
    try s.write(c)
  }
  /** Signed out: nothing of the room stays for the extension. */
  public static func clear() { store()?.clear() }

  // ---- the extension reads ----
  public static func readContext() -> NotifyContext? { store()?.read() }
  #endif
}

#if os(iOS)
/** The context's one Keychain item. */
public struct NotifyKeychain: NotifyStorage {
  static let service = "com.trommi.notify"
  static let account = "context"
  let accessGroup: String
  public init(accessGroup: String) { self.accessGroup = accessGroup }

  private var item: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
     kSecAttrAccount as String: Self.account, kSecAttrAccessGroup as String: accessGroup]
  }

  public func read() -> [UInt8]? {
    var q = item
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return Array(d)
  }

  public func write(_ bytes: [UInt8]) throws {
    // Updated in place when it exists, so the extension never finds it missing between two writes.
    let fresh: [String: Any] = [kSecValueData as String: Data(bytes), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var rc = SecItemUpdate(item as CFDictionary, fresh as CFDictionary)
    if rc == errSecItemNotFound { rc = SecItemAdd(item.merging(fresh) { $1 } as CFDictionary, nil) }
    if rc != errSecSuccess { throw NotifyError("keychain-\(rc)") }
  }

  /** Every item of this service in the group: the context, and what an older build kept there. */
  public func clear() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                   kSecAttrAccessGroup as String: accessGroup] as CFDictionary)
  }
}
#endif

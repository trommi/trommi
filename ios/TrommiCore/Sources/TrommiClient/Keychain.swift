// Keychain.swift: the device key on the phone (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: never in a backup,
// never on another device), one item per room.
import Foundation
#if os(iOS)
import Security

enum Keychain {
  static let service = "com.trommi.device-key"
  static func put(account: String, _ data: Data) throws {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let rc = SecItemAdd(add as CFDictionary, nil)
    if rc != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(rc), userInfo: [NSLocalizedDescriptionKey: "the device key could not be kept in the Keychain (\(rc))"]) }
  }
  static func get(account: String) -> Data? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: AnyObject?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }
  static func delete(account: String) {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
  }
}
#endif

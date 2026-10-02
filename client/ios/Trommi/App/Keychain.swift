// Address, token and cookie name of the server, kept in the Keychain so the
// token never lands in a backup of the preferences.
import Foundation
import Security

enum Keychain {
    private static let service = "com.trommi.app.login"
    private static let account = "server"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func load() -> StoredLogin? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(StoredLogin.self, from: data)
    }

    @discardableResult
    static func save(_ login: StoredLogin) -> Bool {
        guard let data = try? JSONEncoder().encode(login) else { return false }
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

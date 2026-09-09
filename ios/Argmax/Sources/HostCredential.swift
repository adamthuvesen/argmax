import Foundation
import Security

/// The paired host, kept in the keychain.
///
/// The pairing link carries the bridge's bearer token in its fragment, so the
/// whole URL is a credential: `UserDefaults` would put it in an unencrypted
/// backup. `AfterFirstUnlock` rather than `WhenUnlocked` so a relaunch from a
/// notification tap can read it before the phone has been opened.
enum HostCredential {
    private static let service = "com.argmax.remote"
    private static let account = "pairing-url"

    static func load() -> URL? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return URL(string: text)
    }

    static func save(_ url: URL) {
        let data = Data(url.absoluteString.utf8)
        // Delete first: SecItemUpdate on a missing item fails, and re-pairing
        // to a different host is the common case.
        clear()
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecValueData as String: data
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

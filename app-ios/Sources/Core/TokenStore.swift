import Foundation
import Security

/// The bearer token, kept in the iOS Keychain. OAuth is only the front door that
/// hands us this token; every API call thereafter is `Authorization: Bearer <token>`
/// — no cookies, which is exactly what sidesteps the cookie-jar split that broke the
/// old WKWebView wrapper (PLAN_NATIVE_AUTH.md).
enum TokenStore {
    private static let service = "com.viberate.app"
    private static let account = "bearer-token"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func save(_ token: String) {
        SecItemDelete(baseQuery as CFDictionary)
        var add = baseQuery
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else { return nil }
        return token
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

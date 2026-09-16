import Foundation
import Security

/**
 * The bearer session never crosses the Expo bridge. Keychain access is bound
 * to this installation and invalidated when the enrolled biometric set changes.
 */
enum SecureNativeSessionStore {
  private static let service = "online.alarabiya.superapp.secure-transport"
  private static let account = "app_session_id.v1"

  static func hasSession() -> Bool {
    var query = baseQuery
    query[kSecReturnAttributes as String] = true
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  static func loadCookie() throws -> String? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecUseOperationPrompt as String] = "تأكيد هويتك لفتح جلسة العمل"
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, let cookie = String(data: data, encoding: .utf8), isSessionCookie(cookie) else {
      if status == errSecAuthFailed || status == errSecUserCanceled || status == errSecInteractionNotAllowed {
        throw SecureTransportException(
          code: "E_SECURE_TRANSPORT_SESSION_LOCKED",
          reason: "The protected work session was not unlocked."
        )
      }
      clear()
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SESSION_INVALID",
        reason: "The protected work session could not be read."
      )
    }
    return cookie
  }

  static func saveCookie(_ cookie: String) throws {
    guard isSessionCookie(cookie) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SESSION_INVALID",
        reason: "The protected session cookie is invalid."
      )
    }
    clear()
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.biometryCurrentSet],
      &accessError
    ) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SESSION_UNAVAILABLE",
        reason: "The protected session storage could not be configured."
      )
    }
    var query = baseQuery
    query[kSecValueData as String] = Data(cookie.utf8)
    query[kSecAttrAccessControl as String] = access
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SESSION_UNAVAILABLE",
        reason: "The protected session could not be saved."
      )
    }
  }

  static func clear() {
    SecItemDelete(baseQuery as CFDictionary)
  }

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
  }

  private static func isSessionCookie(_ value: String) -> Bool {
    value.hasPrefix("app_session_id=") && value.count >= 18 && value.count <= 8192 && !value.contains(";") && !value.contains("\n") && !value.contains("\r")
  }
}

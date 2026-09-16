import ExpoModulesCore

final class SecureTransportException: Exception {
  private let transportCode: String
  private let transportReason: String

  init(code: String, reason: String) {
    transportCode = code
    transportReason = reason
    super.init()
  }

  override var code: String {
    transportCode
  }

  override var reason: String {
    transportReason
  }
}

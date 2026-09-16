import CryptoKit
import Foundation
import Security

enum DeviceProofEncoding {
  static let clientId = "superapp-expo"
  static let clientVersion = "1"
  static let proofVersion = "1"
  static let registrationPrefix = "ALRUEYA-NATIVE-REGISTER"
  static let requestPrefix = "ALRUEYA-NATIVE-REQUEST"

  static func registrationMessage(ticket: String, keyThumbprint: String) -> Data {
    let message = [
      registrationPrefix,
      proofVersion,
      sha256Base64Url(Data(ticket.utf8)),
      keyThumbprint
    ].joined(separator: "\n")
    return Data(message.utf8)
  }

  static func sha256Base64Url(_ value: Data) -> String {
    base64Url(Data(SHA256.hash(data: value)))
  }

  static func requestMessage(
    timestamp: Int64,
    counter: Int64,
    nonce: String,
    sessionToken: String,
    method: String,
    target: String,
    body: String
  ) -> Data {
    let message = [
      requestPrefix,
      proofVersion,
      String(timestamp),
      String(counter),
      nonce,
      sha256Base64Url(Data(sessionToken.utf8)),
      method.uppercased(),
      target,
      sha256Base64Url(Data(body.utf8))
    ].joined(separator: "\n")
    return Data(message.utf8)
  }

  static func nonce() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_NONCE_UNAVAILABLE",
        reason: "The device could not create a request nonce."
      )
    }
    return base64Url(Data(bytes))
  }

  static func base64Url(_ value: Data) -> String {
    value.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func validateRegistrationTicket(_ ticket: String) throws {
    guard !ticket.isEmpty,
          ticket.utf8.count <= 4096,
          !ticket.contains("\r"),
          !ticket.contains("\n") else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_INVALID_TICKET",
        reason: "The device registration ticket is invalid."
      )
    }
  }

  static func p256Spki(publicKeyX963: Data) throws -> Data {
    // SubjectPublicKeyInfo DER prefix for id-ecPublicKey / prime256v1. SecKey
    // yields ANSI X9.63 (0x04 + X + Y), while the server accepts only SPKI DER.
    let prefix = Data([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE,
      0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D,
      0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ])
    guard publicKeyX963.count == 65, publicKeyX963.first == 0x04 else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key did not expose a P-256 public key."
      )
    }
    var spki = prefix
    spki.append(publicKeyX963)
    return spki
  }
}

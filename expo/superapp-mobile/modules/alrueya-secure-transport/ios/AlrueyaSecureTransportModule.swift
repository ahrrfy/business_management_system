import CryptoKit
import ExpoModulesCore
import Foundation
import Security

public final class AlrueyaSecureTransportModule: Module {
  private lazy var transport = NativeTrpcTransport()

  public func definition() -> ModuleDefinition {
    Name("AlrueyaSecureTransport")

    AsyncFunction("getOrCreateDeviceKey") {
      try self.descriptor(for: DeviceProofKeyStore.getOrCreate())
    }

    AsyncFunction("getDeviceKeyStatus") {
      [
        "keyExists": DeviceProofKeyStore.exists(),
        "keyAliasVersion": "device-proof-v1",
        "algorithm": "ES256",
        "storage": DeviceProofKeyStore.storageName
      ]
    }

    AsyncFunction("createRegistrationProof") { (ticket: String) in
      try DeviceProofEncoding.validateRegistrationTicket(ticket)
      let privateKey = try DeviceProofKeyStore.getOrCreate()
      let descriptor = try self.descriptor(for: privateKey)
      let message = DeviceProofEncoding.registrationMessage(
        ticket: ticket,
        keyThumbprint: descriptor["keyThumbprint"] as? String ?? ""
      )
      let signature = try DeviceProofKeyStore.sign(privateKey: privateKey, message: message)
      return descriptor.merging([
        "signatureDerBase64Url": DeviceProofEncoding.base64Url(signature)
      ]) { _, replacement in replacement }
    }

    AsyncFunction("deleteDeviceKey") {
      [
        "deleted": DeviceProofKeyStore.delete(),
        "keyAliasVersion": "device-proof-v1"
      ]
    }

    AsyncFunction("getSecureTransportStatus") {
      self.transport.status()
    }

    /** A native UUID is used only for idempotency of closed mobile commands. */
    AsyncFunction("createMobileRequestId") {
      UUID().uuidString.lowercased()
    }

    AsyncFunction("login") { (identifier: String, password: String, remember: Bool, companyCode: String?) in
      try self.transport.login(
        identifier: identifier,
        password: password,
        remember: remember,
        companyCode: companyCode
      )
    }

    AsyncFunction("verifyTwoFactor") { (ticket: String, code: String?, recoveryCode: String?) in
      try self.transport.verifyTwoFactor(ticket: ticket, code: code, recoveryCode: recoveryCode)
    }

    AsyncFunction("getMobileToday") {
      try self.transport.mobileToday()
    }

    AsyncFunction("getMobileAttendanceHistory") {
      try self.transport.mobileAttendanceHistory()
    }

    AsyncFunction("revealMobilePayslip") { (code: String?, recoveryCode: String?) in
      try self.transport.mobilePayslipReveal(code: code, recoveryCode: recoveryCode)
    }

    AsyncFunction("requestMobileLeave") { (leaveType: String, fromDate: String, toDate: String, reason: String?, clientRequestId: String) in
      try self.transport.mobileRequestLeave(
        leaveType: leaveType,
        fromDate: fromDate,
        toDate: toDate,
        reason: reason,
        clientRequestId: clientRequestId
      )
    }

    AsyncFunction("withdrawLatestMobileLeave") { (clientRequestId: String) in
      try self.transport.mobileWithdrawLatestLeave(clientRequestId: clientRequestId)
    }

    AsyncFunction("startFocusedMobileTask") { (clientRequestId: String) in
      try self.transport.mobileStartFocusedTask(clientRequestId: clientRequestId)
    }

    AsyncFunction("resolveFocusedMobileTask") { (resolutionNote: String?, clientRequestId: String) in
      try self.transport.mobileResolveFocusedTask(
        resolutionNote: resolutionNote,
        clientRequestId: clientRequestId
      )
    }

    AsyncFunction("getMobileCommandCenter") {
      try self.transport.mobileCommandCenter()
    }

    AsyncFunction("getMobileExpoPushStatus") {
      try self.transport.mobileExpoPushStatus()
    }

    AsyncFunction("registerMobileExpoPush") { (expoPushToken: String, platform: String, environment: String, appVersion: String) in
      try self.transport.mobileRegisterExpoPush(
        expoPushToken: expoPushToken,
        platform: platform,
        environment: environment,
        appVersion: appVersion
      )
    }

    AsyncFunction("revokeMobileExpoPush") {
      try self.transport.mobileRevokeExpoPush()
    }

    AsyncFunction("logout") {
      self.transport.logout()
      return ["cleared": true]
    }
  }

  private func descriptor(for privateKey: SecKey) throws -> [String: String] {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key did not expose a public key."
      )
    }
    var error: Unmanaged<CFError>?
    guard let externalPublicKey = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key could not be encoded."
      )
    }
    let spki = try DeviceProofEncoding.p256Spki(publicKeyX963: externalPublicKey)
    let thumbprint = DeviceProofEncoding.sha256Base64Url(spki)
    return [
      "keyId": thumbprint,
      "keyThumbprint": thumbprint,
      "publicKeySpkiBase64Url": DeviceProofEncoding.base64Url(spki),
      "algorithm": "ES256",
      "clientId": DeviceProofEncoding.clientId,
      "clientVersion": DeviceProofEncoding.clientVersion,
      "proofVersion": DeviceProofEncoding.proofVersion
    ]
  }
}

enum DeviceProofKeyStore {
  private static let applicationTag = Data("online.alarabiya.superapp.device-proof.v1".utf8)
  private static let keySize = 256
  private static let counterLock = NSLock()
  private static var requestCounter = Int64(Date().timeIntervalSince1970 * 1000)

  static var storageName: String {
    #if targetEnvironment(simulator)
    return "ios-keychain-simulator"
    #else
    return "ios-secure-enclave"
    #endif
  }

  static func exists() -> Bool {
    (try? loadExisting()) != nil
  }

  static func getOrCreate() throws -> SecKey {
    if let key = try loadExisting() {
      return key
    }
    return try create()
  }

  static func delete() -> Bool {
    let status = SecItemDelete(privateKeyQuery(returnReference: false) as CFDictionary)
    return status == errSecSuccess
  }

  static func sign(privateKey: SecKey, message: Data) throws -> Data {
    let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(privateKey, .sign, algorithm) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SIGNING_UNAVAILABLE",
        reason: "The device proof key cannot sign this registration proof."
      )
    }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(privateKey, algorithm, message as CFData, &error) as Data? else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_SIGNING_UNAVAILABLE",
        reason: "The device proof key could not sign the registration proof."
      )
    }
    return signature
  }

  static func baseHeaders(publicKeySpki: Data? = nil) -> [String: String] {
    var headers = [
      "X-Alrueya-Client": DeviceProofEncoding.clientId,
      "X-Alrueya-Client-Version": DeviceProofEncoding.clientVersion,
      "X-Alrueya-Device-Proof-Version": DeviceProofEncoding.proofVersion
    ]
    if let publicKeySpki {
      headers["X-Alrueya-Device-Key"] = DeviceProofEncoding.base64Url(publicKeySpki)
    }
    return headers
  }

  static func registrationHeaders(ticket: String) throws -> [String: String] {
    try DeviceProofEncoding.validateRegistrationTicket(ticket)
    let (privateKey, publicKeySpki) = try keyAndSpki()
    let thumbprint = DeviceProofEncoding.sha256Base64Url(publicKeySpki)
    let signature = try sign(
      privateKey: privateKey,
      message: DeviceProofEncoding.registrationMessage(ticket: ticket, keyThumbprint: thumbprint)
    )
    return baseHeaders(publicKeySpki: publicKeySpki).merging([
      "X-Alrueya-Device-Challenge": ticket,
      "X-Alrueya-Device-Signature": DeviceProofEncoding.base64Url(signature)
    ]) { _, replacement in replacement }
  }

  static func signedRequestHeaders(
    method: String,
    target: String,
    body: String,
    sessionToken: String
  ) throws -> [String: String] {
    let (privateKey, publicKeySpki) = try keyAndSpki()
    let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    let counter = nextCounter(timestamp)
    let nonce = try DeviceProofEncoding.nonce()
    let signature = try sign(
      privateKey: privateKey,
      message: DeviceProofEncoding.requestMessage(
        timestamp: timestamp,
        counter: counter,
        nonce: nonce,
        sessionToken: sessionToken,
        method: method,
        target: target,
        body: body
      )
    )
    return baseHeaders(publicKeySpki: publicKeySpki).merging([
      "X-Alrueya-Device-Timestamp": String(timestamp),
      "X-Alrueya-Device-Counter": String(counter),
      "X-Alrueya-Device-Nonce": nonce,
      "X-Alrueya-Device-Signature": DeviceProofEncoding.base64Url(signature)
    ]) { _, replacement in replacement }
  }

  private static func keyAndSpki() throws -> (SecKey, Data) {
    let privateKey = try getOrCreate()
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key did not expose a public key."
      )
    }
    var error: Unmanaged<CFError>?
    guard let x963 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key could not be encoded."
      )
    }
    return (privateKey, try DeviceProofEncoding.p256Spki(publicKeyX963: x963))
  }

  private static func nextCounter(_ now: Int64) -> Int64 {
    counterLock.lock()
    defer { counterLock.unlock() }
    requestCounter = max(now, requestCounter + 1)
    return requestCounter
  }

  private static func loadExisting() throws -> SecKey? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(privateKeyQuery(returnReference: true) as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let key = result as? SecKey else {
        throw SecureTransportException(
          code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
          reason: "The stored device proof key is invalid."
        )
      }
      return key
    case errSecItemNotFound:
      return nil
    default:
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key could not be accessed."
      )
    }
  }

  private static func create() throws -> SecKey {
    var accessControlError: Unmanaged<CFError>?
    guard let accessControl = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .privateKeyUsage,
      &accessControlError
    ) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "The device proof key protection could not be configured."
      )
    }

    var parameters: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: keySize,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: applicationTag,
        kSecAttrAccessControl as String: accessControl
      ]
    ]

    #if !targetEnvironment(simulator)
    parameters[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif

    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(parameters as CFDictionary, &error) else {
      throw SecureTransportException(
        code: "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
        reason: "A protected device proof key could not be created."
      )
    }
    return privateKey
  }

  private static func privateKeyQuery(returnReference: Bool) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: applicationTag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    if returnReference {
      query[kSecReturnRef as String] = true
    }
    return query
  }
}

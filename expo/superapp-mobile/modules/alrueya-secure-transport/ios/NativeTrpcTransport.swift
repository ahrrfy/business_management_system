import CryptoKit
import Foundation
import Security

/**
 * A closed iOS transport. The Expo bridge can request only named procedures;
 * it never receives a cookie, certificate pin, signature, counter, or nonce.
 */
final class NativeTrpcTransport {
  private let configuration = SecureTransportConfiguration()
  private let lock = NSLock()
  private lazy var session: URLSession = {
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    // Cookies are managed solely by SecureNativeSessionStore; URLSession must
    // not retain a second implicit in-memory cookie jar.
    sessionConfiguration.httpCookieStorage = nil
    sessionConfiguration.httpShouldSetCookies = false
    return URLSession(
      configuration: sessionConfiguration,
      delegate: PinnedURLSessionDelegate(pins: configuration.spkiPins),
      delegateQueue: nil
    )
  }()

  func status() -> [String: Any] {
    [
      "configured": configuration.isConfigured,
      "environment": configuration.environment,
      "pinning": configuration.isProduction
        ? (configuration.spkiPins.isEmpty ? "required" : "configured")
        : (configuration.spkiPins.isEmpty ? "development-unpinned" : "configured"),
      "session": SecureNativeSessionStore.hasSession() ? "present" : "none",
      "reason": configuration.statusReason ?? NSNull()
    ]
  }

  func login(identifier: String, password: String, remember: Bool, companyCode: String?) throws -> String {
    guard !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, identifier.count <= 320 else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid login identifier.")
    }
    guard !password.isEmpty, password.count <= 128 else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid login password.")
    }
    var input: [String: Any] = [
      "identifier": identifier.trimmingCharacters(in: .whitespacesAndNewlines),
      "password": password,
      "remember": remember
    ]
    if let companyCode = companyCode?.trimmingCharacters(in: .whitespacesAndNewlines), !companyCode.isEmpty {
      input["companyCode"] = companyCode
    }
    return try serialMutation {
      try mutation(procedure: "auth.login", input: input, registration: true)
    }
  }

  func verifyTwoFactor(ticket: String, code: String?, recoveryCode: String?) throws -> String {
    guard !ticket.isEmpty, ticket.count <= 4096 else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid two-factor ticket.")
    }
    let cleanCode = code?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanRecovery = recoveryCode?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (cleanCode?.isEmpty == false) != (cleanRecovery?.isEmpty == false) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Exactly one two-factor value is required.")
    }
    var input: [String: Any] = ["ticket": ticket]
    if let cleanCode, !cleanCode.isEmpty { input["code"] = cleanCode }
    if let cleanRecovery, !cleanRecovery.isEmpty { input["recoveryCode"] = cleanRecovery }
    return try serialMutation {
      try mutation(procedure: "auth.twoFactorVerify", input: input, registration: true)
    }
  }

  func mobileToday() throws -> String {
    try query(procedure: "superApp.mobileToday", input: nil, requiresSession: true)
  }

  func mobileAttendanceHistory() throws -> String {
    try query(procedure: "superApp.mobileAttendanceHistory", input: nil, requiresSession: true)
  }

  func mobilePayslipReveal(code: String?, recoveryCode: String?) throws -> String {
    let cleanCode = code?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanRecovery = recoveryCode?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (cleanCode?.isEmpty == false) != (cleanRecovery?.isEmpty == false) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Exactly one two-factor value is required.")
    }
    if let cleanCode {
      guard cleanCode.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else {
        throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid two-factor code.")
      }
    }
    if let cleanRecovery {
      guard (5 ... 64).contains(cleanRecovery.count) else {
        throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid recovery code.")
      }
    }
    var input: [String: Any] = [:]
    if let cleanCode, !cleanCode.isEmpty { input["code"] = cleanCode }
    if let cleanRecovery, !cleanRecovery.isEmpty { input["recoveryCode"] = cleanRecovery }
    return try serialMutation {
      try mutation(procedure: "superApp.mobilePayslipReveal", input: input, registration: false, requiresSession: true)
    }
  }

  func mobileRequestLeave(
    leaveType: String,
    fromDate: String,
    toDate: String,
    reason: String?,
    clientRequestId: String
  ) throws -> String {
    guard ["سنوية", "مرضية", "أمومة", "بدون راتب"].contains(leaveType) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid leave type.")
    }
    guard isDay(fromDate), isDay(toDate), toDate >= fromDate else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid leave dates.")
    }
    if let reason {
      guard reason.count <= 1_000, !reason.contains("\n"), !reason.contains("\r") else {
        throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid leave reason.")
      }
    }
    guard validRequestId(clientRequestId) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid client request id.")
    }
    var input: [String: Any] = [
      "leaveType": leaveType,
      "fromDate": fromDate,
      "toDate": toDate,
      "clientRequestId": clientRequestId
    ]
    if let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
      input["reason"] = reason
    }
    return try serialMutation {
      try mutation(procedure: "superApp.mobileRequestLeave", input: input, registration: false, requiresSession: true)
    }
  }

  func mobileWithdrawLatestLeave(clientRequestId: String) throws -> String {
    guard validRequestId(clientRequestId) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid client request id.")
    }
    return try serialMutation {
      try mutation(
        procedure: "superApp.mobileWithdrawLatestLeave",
        input: ["clientRequestId": clientRequestId],
        registration: false,
        requiresSession: true
      )
    }
  }

  func mobileStartFocusedTask(clientRequestId: String) throws -> String {
    guard validRequestId(clientRequestId) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid client request id.")
    }
    return try serialMutation {
      try mutation(
        procedure: "superApp.mobileStartFocusedTask",
        input: ["clientRequestId": clientRequestId],
        registration: false,
        requiresSession: true
      )
    }
  }

  func mobileResolveFocusedTask(resolutionNote: String?, clientRequestId: String) throws -> String {
    guard validRequestId(clientRequestId) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid client request id.")
    }
    if let resolutionNote {
      guard resolutionNote.count <= 4_000, !resolutionNote.contains("\n"), !resolutionNote.contains("\r") else {
        throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid resolution note.")
      }
    }
    var input: [String: Any] = ["clientRequestId": clientRequestId]
    if let resolutionNote = resolutionNote?.trimmingCharacters(in: .whitespacesAndNewlines), !resolutionNote.isEmpty {
      input["resolutionNote"] = resolutionNote
    }
    return try serialMutation {
      try mutation(procedure: "superApp.mobileResolveFocusedTask", input: input, registration: false, requiresSession: true)
    }
  }

  func mobileCommandCenter() throws -> String {
    try query(procedure: "superApp.mobileCommandCenter", input: nil, requiresSession: true)
  }

  func mobileExpoPushStatus() throws -> String {
    try query(procedure: "superApp.mobileExpoPushStatus", input: nil, requiresSession: true)
  }

  func mobileRegisterExpoPush(
    expoPushToken: String,
    platform: String,
    environment: String,
    appVersion: String
  ) throws -> String {
    guard expoPushToken.range(of: "^(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]{8,200}\\]$", options: .regularExpression) != nil else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid Expo push token.")
    }
    guard platform == "IOS", ["dev", "staging", "prod"].contains(environment), !appVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, appVersion.count <= 64 else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_INPUT", reason: "Invalid Expo push registration.")
    }
    return try serialMutation {
      try mutation(
        procedure: "superApp.mobileRegisterExpoPush",
        input: [
          "expoPushToken": expoPushToken,
          "platform": platform,
          "environment": environment,
          "appVersion": appVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        ],
        registration: false,
        requiresSession: true
      )
    }
  }

  func mobileRevokeExpoPush() throws -> String {
    try serialMutation {
      try mutation(procedure: "superApp.mobileRevokeExpoPush", input: [:], registration: false, requiresSession: true)
    }
  }

  func logout() {
    serial {
      defer { SecureNativeSessionStore.clear() }
      guard SecureNativeSessionStore.hasSession() else { return }
      _ = try? mutation(procedure: "auth.logout", input: nil, registration: false)
    }
  }

  private func serial<T>(_ block: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return block()
  }

  private func serialMutation<T>(_ block: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    return try block()
  }

  private func query(procedure: String, input: [String: Any]?, requiresSession: Bool) throws -> String {
    let envelope = try inputEnvelope(input)
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    guard let encoded = envelope.addingPercentEncoding(withAllowedCharacters: allowed) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_REQUEST", reason: "The request could not be encoded.")
    }
    return try execute(
      method: "GET",
      path: "/api/trpc/\(procedure)?batch=1&input=\(encoded)",
      body: nil,
      requiresSession: requiresSession,
      registration: false
    )
  }

  private func mutation(
    procedure: String,
    input: [String: Any]?,
    registration: Bool,
    requiresSession: Bool = false
  ) throws -> String {
    try execute(
      method: "POST",
      path: "/api/trpc/\(procedure)?batch=1",
      body: try inputEnvelope(input),
      requiresSession: requiresSession,
      registration: registration
    )
  }

  private func challenge() throws -> String {
    let data = try query(procedure: "auth.nativeDeviceChallenge", input: nil, requiresSession: false)
    guard
      let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)),
      let object = json as? [String: Any],
      let ticket = object["ticket"] as? String
    else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_CHALLENGE_INVALID", reason: "The native device challenge response was invalid.")
    }
    try DeviceProofEncoding.validateRegistrationTicket(ticket)
    return ticket
  }

  private func execute(
    method: String,
    path: String,
    body: String?,
    requiresSession: Bool,
    registration: Bool
  ) throws -> String {
    guard configuration.isConfigured, let baseURL = configuration.baseURL else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_CONFIGURATION", reason: "Secure transport is unavailable until this build has a valid endpoint and required pins.")
    }
    let cookie = try SecureNativeSessionStore.loadCookie()
    if requiresSession && cookie == nil {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_SESSION_REQUIRED", reason: "A protected Super Arabia session is required.")
    }
    let headers: [String: String]
    if registration {
      headers = try DeviceProofKeyStore.registrationHeaders(ticket: try challenge())
    } else if let cookie {
      headers = try DeviceProofKeyStore.signedRequestHeaders(
        method: method,
        target: path,
        body: body ?? "",
        sessionToken: try sessionToken(cookie)
      )
    } else {
      headers = DeviceProofKeyStore.baseHeaders()
    }
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_ENDPOINT", reason: "The configured endpoint is not HTTP.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 25
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("ar-IQ,ar;q=0.9", forHTTPHeaderField: "Accept-Language")
    request.setValue("AlrueyaSuperAppExpo/1", forHTTPHeaderField: "User-Agent")
    headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    if let body {
      request.httpBody = Data(body.utf8)
      request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try send(request)
    guard (200 ... 299).contains(response.statusCode) else {
      throw remoteError(status: response.statusCode)
    }
    try saveSessionCookie(response)
    return try trpcData(data)
  }

  private func send(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
    let semaphore = DispatchSemaphore(value: 0)
    var output: Result<(Data, HTTPURLResponse), Error>?
    let task = session.dataTask(with: request) { data, response, error in
      defer { semaphore.signal() }
      if let error { output = .failure(error); return }
      guard let data, let response = response as? HTTPURLResponse else {
        output = .failure(SecureTransportException(code: "E_SECURE_TRANSPORT_NETWORK", reason: "The protected connection could not be completed."))
        return
      }
      output = .success((data, response))
    }
    task.resume()
    guard semaphore.wait(timeout: .now() + 30) == .success else {
      task.cancel()
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_NETWORK", reason: "The protected connection timed out.")
    }
    guard let output else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_NETWORK", reason: "The protected connection could not be completed.")
    }
    do {
      return try output.get()
    } catch let error as SecureTransportException {
      throw error
    } catch {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_NETWORK", reason: "The protected connection could not be completed.")
    }
  }

  private func saveSessionCookie(_ response: HTTPURLResponse) throws {
    for (name, value) in response.allHeaderFields where String(describing: name).caseInsensitiveCompare("Set-Cookie") == .orderedSame {
      let values = value as? [String] ?? [String(describing: value)]
      if let cookie = values.map({ $0.split(separator: ";", maxSplits: 1).first.map(String.init) ?? "" }).first(where: { $0.hasPrefix("app_session_id=") }) {
        try SecureNativeSessionStore.saveCookie(cookie)
        return
      }
    }
  }

  private func trpcData(_ data: Data) throws -> String {
    let item = try trpcItem(data)
    if item["error"] != nil { throw remoteError(status: 200) }
    guard
      let result = item["result"] as? [String: Any],
      let resultData = result["data"] as? [String: Any],
      let value = resultData["json"],
      JSONSerialization.isValidJSONObject(value),
      let encoded = try? JSONSerialization.data(withJSONObject: value),
      let string = String(data: encoded, encoding: .utf8)
    else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_RESPONSE", reason: "The server response was incomplete.")
    }
    return string
  }

  private func trpcItem(_ data: Data) throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: data)
    if let item = object as? [String: Any] { return item }
    if let list = object as? [[String: Any]], let item = list.first { return item }
    throw SecureTransportException(code: "E_SECURE_TRANSPORT_RESPONSE", reason: "The server response was not valid JSON.")
  }

  private func remoteError(status: Int) -> SecureTransportException {
    SecureTransportException(code: "E_SECURE_TRANSPORT_REMOTE", reason: "The server rejected the protected request (HTTP \(status)).")
  }

  private func inputEnvelope(_ input: [String: Any]?) throws -> String {
    let value: [String: Any]
    if let input {
      value = ["0": ["json": input]]
    } else {
      value = ["0": ["json": NSNull(), "meta": ["values": ["undefined"]]]]
    }
    let data = try JSONSerialization.data(withJSONObject: value)
    guard let output = String(data: data, encoding: .utf8) else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_REQUEST", reason: "The request could not be encoded.")
    }
    return output
  }

  private func sessionToken(_ cookie: String) throws -> String {
    let token = String(cookie.dropFirst("app_session_id=".count))
    guard !token.isEmpty else {
      throw SecureTransportException(code: "E_SECURE_TRANSPORT_SESSION_INVALID", reason: "The protected session cookie is invalid.")
    }
    return token
  }

  private func isDay(_ value: String) -> Bool {
    value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil
  }

  private func validRequestId(_ value: String) -> Bool {
    guard UUID(uuidString: value) != nil else { return false }
    return value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
  }
}

private final class PinnedURLSessionDelegate: NSObject, URLSessionDelegate {
  private let pins: Set<String>

  init(pins: Set<String>) {
    self.pins = pins
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    var error: CFError?
    guard SecTrustEvaluateWithError(trust, &error) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    guard pins.isEmpty || matchesPinnedSpki(trust) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  private func matchesPinnedSpki(_ trust: SecTrust) -> Bool {
    for index in 0 ..< SecTrustGetCertificateCount(trust) {
      guard let certificate = SecTrustGetCertificateAtIndex(trust, index), let spki = SubjectPublicKeyInfo.from(certificate) else { continue }
      if pins.contains(DeviceProofEncoding.base64Url(Data(SHA256.hash(data: spki)))) { return true }
    }
    return false
  }
}

/** Extract the complete DER SubjectPublicKeyInfo from an X.509 certificate. */
private enum SubjectPublicKeyInfo {
  static func from(_ certificate: SecCertificate) -> Data? {
    let der = SecCertificateCopyData(certificate) as Data
    guard let certificateSequence = element(in: der, at: 0), certificateSequence.tag == 0x30,
          let tbs = element(in: der, at: certificateSequence.contentStart), tbs.tag == 0x30 else { return nil }
    var children: [DerElement] = []
    var cursor = tbs.contentStart
    while cursor < tbs.end, let child = element(in: der, at: cursor) {
      children.append(child)
      cursor = child.end
    }
    let index = children.first?.tag == 0xA0 ? 6 : 5
    guard children.indices.contains(index), children[index].tag == 0x30 else { return nil }
    return der.subdata(in: children[index].start ..< children[index].end)
  }

  private static func element(in data: Data, at start: Int) -> DerElement? {
    guard start + 2 <= data.count else { return nil }
    let bytes = [UInt8](data)
    let tag = bytes[start]
    let firstLength = Int(bytes[start + 1])
    var contentStart = start + 2
    let length: Int
    if firstLength & 0x80 == 0 {
      length = firstLength
    } else {
      let count = firstLength & 0x7F
      guard count > 0, count <= 4, contentStart + count <= bytes.count else { return nil }
      var value = 0
      for offset in 0 ..< count { value = (value << 8) | Int(bytes[contentStart + offset]) }
      length = value
      contentStart += count
    }
    let end = contentStart + length
    guard end <= bytes.count else { return nil }
    return DerElement(tag: tag, start: start, contentStart: contentStart, end: end)
  }

  private struct DerElement {
    let tag: UInt8
    let start: Int
    let contentStart: Int
    let end: Int
  }
}

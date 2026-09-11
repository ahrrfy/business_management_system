import Foundation

struct SecureTransportConfiguration {
  let baseURL: URL?
  let environment: String
  let spkiPins: Set<String>

  var isProduction: Bool { environment == "production" }
  var isConfigured: Bool { isAllowedEndpoint && (!isProduction || !spkiPins.isEmpty) }
  var statusReason: String? {
    if !isAllowedEndpoint { return "endpoint_invalid" }
    if isProduction && spkiPins.isEmpty { return "production_pin_missing" }
    return nil
  }

  init(bundle: Bundle = .main) {
    guard
      let raw = bundle.object(forInfoDictionaryKey: "AlrueyaSecureTransportConfiguration") as? String,
      let data = raw.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data),
      let object = json as? [String: Any],
      let urlString = object["baseUrl"] as? String,
      let parsedURL = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines))
    else {
      baseURL = nil
      environment = "development"
      spkiPins = []
      return
    }
    baseURL = parsedURL
    environment = object["environment"] as? String == "production" ? "production" : "development"
    let pins = (object["spkiPins"] as? [Any] ?? []).compactMap { $0 as? String }
    spkiPins = Set(pins.filter { $0.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil })
  }

  private var isAllowedEndpoint: Bool {
    guard let baseURL, let scheme = baseURL.scheme?.lowercased(), let host = baseURL.host?.lowercased(), !host.isEmpty else {
      return false
    }
    guard baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil else { return false }
    guard baseURL.path.isEmpty || baseURL.path == "/" else { return false }
    if scheme == "https" { return true }
    return environment == "development" && scheme == "http" && ["10.0.2.2", "127.0.0.1", "localhost"].contains(host)
  }
}

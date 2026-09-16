package online.alarabiya.securetransport

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection

/**
 * A closed native BFF transport. It exposes only named Super Arabia procedures
 * and owns the session cookie, request counter, nonce, and P-256 signature.
 * There is intentionally no `fetch(url)` bridge for JavaScript to misuse.
 */
internal class NativeTrpcTransport(context: Context) {
  private val configuration = SecureTransportConfiguration.from(context)
  private val deviceProof = AndroidDeviceProofKeyStore(context)
  private val sessions = SecureNativeSessionStore(context)

  fun status(): Map<String, Any?> = mapOf(
    "configured" to configuration.isConfigured,
    "environment" to configuration.environment,
    "pinning" to when {
      configuration.isProduction && configuration.spkiPins.isNotEmpty() -> "configured"
      configuration.isProduction -> "required"
      configuration.spkiPins.isNotEmpty() -> "configured"
      else -> "development-unpinned"
    },
    "session" to if (sessions.hasSession()) "present" else "none",
    "reason" to configuration.statusReason,
  )

  @Synchronized
  fun login(
    identifier: String,
    password: String,
    remember: Boolean,
    companyCode: String?,
  ): String {
    require(identifier.isNotBlank() && identifier.length <= 320) { "Invalid login identifier" }
    require(password.isNotEmpty() && password.length <= 128) { "Invalid login password" }
    val input = JSONObject()
      .put("identifier", identifier.trim())
      .put("password", password)
      .put("remember", remember)
    companyCode?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("companyCode", it) }
    return mutation("auth.login", input, registration = true)
  }

  @Synchronized
  fun verifyTwoFactor(ticket: String, code: String?, recoveryCode: String?): String {
    require(ticket.isNotBlank() && ticket.length <= 4096) { "Invalid two-factor ticket" }
    require((code.isNullOrBlank()) != (recoveryCode.isNullOrBlank())) { "Exactly one two-factor value is required" }
    val input = JSONObject().put("ticket", ticket)
    code?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("code", it) }
    recoveryCode?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("recoveryCode", it) }
    return mutation("auth.twoFactorVerify", input, registration = true)
  }

  fun mobileToday(): String = query("superApp.mobileToday", null, requiresSession = true)

  fun mobileAttendanceHistory(): String = query("superApp.mobileAttendanceHistory", null, requiresSession = true)

  @Synchronized
  fun mobilePayslipReveal(code: String?, recoveryCode: String?): String {
    val cleanCode = code?.trim()?.takeIf { it.isNotEmpty() }
    val cleanRecovery = recoveryCode?.trim()?.takeIf { it.isNotEmpty() }
    require((cleanCode != null) != (cleanRecovery != null)) { "Exactly one two-factor value is required" }
    require(cleanCode == null || cleanCode.matches(Regex("^\\d{6}$"))) { "Invalid two-factor code" }
    require(cleanRecovery == null || cleanRecovery.length in 5..64) { "Invalid recovery code" }
    val input = JSONObject()
    cleanCode?.let { input.put("code", it) }
    cleanRecovery?.let { input.put("recoveryCode", it) }
    return mutation("superApp.mobilePayslipReveal", input, registration = false, requiresSession = true)
  }

  @Synchronized
  fun mobileRequestLeave(
    leaveType: String,
    fromDate: String,
    toDate: String,
    reason: String?,
    clientRequestId: String,
  ): String {
    require(leaveType in setOf("سنوية", "مرضية", "أمومة", "بدون راتب")) { "Invalid leave type" }
    require(DATE.matches(fromDate) && DATE.matches(toDate) && toDate >= fromDate) { "Invalid leave dates" }
    require(reason == null || (reason.length <= 1_000 && reason.none { it == '\n' || it == '\r' })) { "Invalid leave reason" }
    require(UUID.matches(clientRequestId)) { "Invalid client request id" }
    val input = JSONObject()
      .put("leaveType", leaveType)
      .put("fromDate", fromDate)
      .put("toDate", toDate)
      .put("clientRequestId", clientRequestId)
    reason?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("reason", it) }
    return mutation("superApp.mobileRequestLeave", input, registration = false, requiresSession = true)
  }

  @Synchronized
  fun mobileWithdrawLatestLeave(clientRequestId: String): String {
    require(UUID.matches(clientRequestId)) { "Invalid client request id" }
    return mutation(
      "superApp.mobileWithdrawLatestLeave",
      JSONObject().put("clientRequestId", clientRequestId),
      registration = false,
      requiresSession = true,
    )
  }

  @Synchronized
  fun mobileStartFocusedTask(clientRequestId: String): String {
    require(UUID.matches(clientRequestId)) { "Invalid client request id" }
    return mutation(
      "superApp.mobileStartFocusedTask",
      JSONObject().put("clientRequestId", clientRequestId),
      registration = false,
      requiresSession = true,
    )
  }

  @Synchronized
  fun mobileResolveFocusedTask(resolutionNote: String?, clientRequestId: String): String {
    require(UUID.matches(clientRequestId)) { "Invalid client request id" }
    require(resolutionNote == null || (resolutionNote.length <= 4_000 && resolutionNote.none { it == '\n' || it == '\r' })) { "Invalid resolution note" }
    val input = JSONObject().put("clientRequestId", clientRequestId)
    resolutionNote?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("resolutionNote", it) }
    return mutation("superApp.mobileResolveFocusedTask", input, registration = false, requiresSession = true)
  }

  fun mobileCommandCenter(): String = query("superApp.mobileCommandCenter", null, requiresSession = true)

  fun mobileExpoPushStatus(): String = query("superApp.mobileExpoPushStatus", null, requiresSession = true)

  @Synchronized
  fun mobileRegisterExpoPush(
    expoPushToken: String,
    platform: String,
    environment: String,
    appVersion: String,
  ): String {
    require(expoPushToken.matches(Regex("^(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]{8,200}\\]$"))) { "Invalid Expo push token" }
    require(platform == "ANDROID") { "Invalid Expo platform" }
    require(environment == "dev" || environment == "staging" || environment == "prod") { "Invalid Expo environment" }
    require(appVersion.trim().isNotEmpty() && appVersion.length <= 64) { "Invalid app version" }
    return mutation(
      "superApp.mobileRegisterExpoPush",
      JSONObject()
        .put("expoPushToken", expoPushToken)
        .put("platform", platform)
        .put("environment", environment)
        .put("appVersion", appVersion.trim()),
      registration = false,
      requiresSession = true,
    )
  }

  @Synchronized
  fun mobileRevokeExpoPush(): String = mutation(
    "superApp.mobileRevokeExpoPush",
    JSONObject(),
    registration = false,
    requiresSession = true,
  )

  @Synchronized
  fun logout() {
    if (sessions.loadCookie() == null) {
      sessions.clear()
      return
    }
    try {
      mutation("auth.logout", null, registration = false)
    } finally {
      // Logout is local revocation as well: a network error must never leave a
      // bearer cookie available for an accidental later retry.
      sessions.clear()
    }
  }

  private fun query(procedure: String, input: JSONObject?, requiresSession: Boolean): String {
    val envelope = inputEnvelope(input)
    val path = "/api/trpc/$procedure?batch=1&input=${Uri.encode(envelope.toString())}"
    return execute("GET", path, null, requiresSession = requiresSession, registration = false)
  }

  private fun mutation(
    procedure: String,
    input: JSONObject?,
    registration: Boolean,
    requiresSession: Boolean = false,
  ): String =
    execute(
      method = "POST",
      path = "/api/trpc/$procedure?batch=1",
      body = inputEnvelope(input).toString(),
      requiresSession = requiresSession,
      registration = registration,
    )

  private fun challenge(): String {
    val payload = query("auth.nativeDeviceChallenge", null, requiresSession = false)
    return try {
      JSONObject(payload).getString("ticket").also { Base64Url.validateRegistrationTicket(it) }
    } catch (error: Exception) {
      throw SecureTransportException(
        "E_SECURE_TRANSPORT_CHALLENGE_INVALID",
        "The native device challenge response was invalid.",
        error,
      )
    }
  }

  private fun execute(
    method: String,
    path: String,
    body: String?,
    requiresSession: Boolean,
    registration: Boolean,
  ): String {
    require(configuration.isConfigured) {
      "Secure transport is unavailable until this build has a valid endpoint and required pins."
    }
    val cookie = sessions.loadCookie()
    if (requiresSession && cookie == null) {
      throw SecureTransportException(
        "E_SECURE_TRANSPORT_SESSION_REQUIRED",
        "A protected Super Arabia session is required.",
      )
    }
    val headers = when {
      registration -> deviceProof.registrationHeaders(challenge())
      cookie != null -> deviceProof.signedRequestHeaders(
        method = method,
        target = path,
        body = body.orEmpty(),
        sessionToken = sessionToken(cookie),
      )
      else -> deviceProof.baseHeaders()
    }
    val connection = openConnection(path, method, body != null)
    try {
      headers.forEach(connection::setRequestProperty)
      cookie?.let { connection.setRequestProperty("Cookie", it) }
      if (connection is HttpsURLConnection) {
        // Handshake plus regular CA/hostname validation happens before writing
        // any POST bytes. Pin mismatch therefore fails without sending a
        // password or a protected mutation to the peer.
        connection.connect()
        verifyPins(connection)
      }
      if (body != null) connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val status = connection.responseCode
      val payload = (if (status in 200..299) connection.inputStream else connection.errorStream)
        ?.bufferedReader(Charsets.UTF_8)
        ?.use { it.readText() }
        .orEmpty()
      if (status !in 200..299) throw trpcError(payload, status)
      saveSessionCookie(connection)
      return trpcData(payload, status)
    } catch (error: SecureTransportException) {
      throw error
    } catch (error: Exception) {
      throw SecureTransportException(
        "E_SECURE_TRANSPORT_NETWORK",
        "The protected connection could not be completed.",
        error,
      )
    } finally {
      connection.disconnect()
    }
  }

  private fun openConnection(path: String, method: String, hasBody: Boolean): HttpURLConnection {
    val connection = URL(configuration.baseUrl.trimEnd('/') + path).openConnection() as? HttpURLConnection
      ?: throw SecureTransportException("E_SECURE_TRANSPORT_ENDPOINT", "The configured endpoint is not HTTP.")
    return connection.apply {
      requestMethod = method
      connectTimeout = 15_000
      readTimeout = 25_000
      instanceFollowRedirects = false
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Accept-Language", "ar-IQ,ar;q=0.9")
      setRequestProperty("User-Agent", "AlrueyaSuperAppExpo/1")
      if (hasBody) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json; charset=utf-8")
      }
    }
  }

  private fun verifyPins(connection: HttpsURLConnection) {
    if (configuration.spkiPins.isEmpty()) {
      if (configuration.isProduction) {
        throw SecureTransportException("E_SECURE_TRANSPORT_PIN_REQUIRED", "Production certificate pinning is not configured.")
      }
      return
    }
    val observed = connection.serverCertificates
      .filterIsInstance<X509Certificate>()
      .map { certificate ->
        Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded))
      }
      .toSet()
    if (observed.none(configuration.spkiPins::contains)) {
      throw SecureTransportException(
        "E_SECURE_TRANSPORT_PIN_MISMATCH",
        "The server certificate does not match this app build.",
      )
    }
  }

  private fun saveSessionCookie(connection: HttpURLConnection) {
    connection.headerFields.entries
      .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
      .flatMap { it.value.orEmpty() }
      .asSequence()
      .map { it.substringBefore(';').trim() }
      .firstOrNull { it.startsWith("app_session_id=") }
      ?.let(sessions::saveCookie)
  }

  private fun trpcData(payload: String, status: Int): String {
    val item = trpcItem(payload, status)
    item.optJSONObject("error")?.let { throw trpcError(payload, status) }
    val value = item.optJSONObject("result")
      ?.optJSONObject("data")
      ?.opt("json")
      ?: throw SecureTransportException("E_SECURE_TRANSPORT_RESPONSE", "The server response was incomplete.")
    return value.toString()
  }

  private fun trpcError(payload: String, status: Int): SecureTransportException {
    val item = runCatching { trpcItem(payload, status) }.getOrNull()
    val error = item?.optJSONObject("error")
    val detail = error?.optJSONObject("json") ?: error
    val message = detail?.optString("message")?.takeIf { it.isNotBlank() }
      ?: error?.optString("message")?.takeIf { it.isNotBlank() }
      ?: "The server rejected the protected request."
    return SecureTransportException("E_SECURE_TRANSPORT_REMOTE", message)
  }

  private fun trpcItem(payload: String, status: Int): JSONObject {
    if (payload.isBlank()) throw SecureTransportException("E_SECURE_TRANSPORT_RESPONSE", "The server response was empty (HTTP $status).")
    return when (payload.trim().firstOrNull()) {
      '[' -> JSONArray(payload).optJSONObject(0)
      '{' -> JSONObject(payload)
      else -> null
    } ?: throw SecureTransportException("E_SECURE_TRANSPORT_RESPONSE", "The server response was not valid JSON.")
  }

  private fun inputEnvelope(input: JSONObject?): JSONObject {
    val serialized = input ?: JSONObject()
      .put("json", JSONObject.NULL)
      .put("meta", JSONObject().put("values", JSONArray().put("undefined")))
    return if (input == null) JSONObject().put("0", serialized) else JSONObject().put("0", JSONObject().put("json", input))
  }

  private fun sessionToken(cookie: String): String = cookie.substringAfter('=', "").takeIf { it.isNotBlank() }
    ?: throw SecureTransportException("E_SECURE_TRANSPORT_SESSION_INVALID", "The protected session cookie is invalid.")

  private companion object {
    val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
  }
}

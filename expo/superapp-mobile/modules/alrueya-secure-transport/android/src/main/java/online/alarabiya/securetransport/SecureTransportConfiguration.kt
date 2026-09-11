package online.alarabiya.securetransport

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/**
 * Build-time configuration injected by the Expo config plugin. It is not a
 * credential: the endpoint and public SPKI hashes are safe to compile into an
 * app. The important invariant is that JavaScript cannot replace either one at
 * runtime, which would otherwise defeat certificate pinning.
 */
internal data class SecureTransportConfiguration(
  val baseUrl: String,
  val environment: String,
  val spkiPins: Set<String>,
) {
  val isProduction: Boolean get() = environment == "production"
  val isConfigured: Boolean
    get() = isAllowedEndpoint(baseUrl, environment) && (!isProduction || spkiPins.isNotEmpty())

  val statusReason: String?
    get() = when {
      !isAllowedEndpoint(baseUrl, environment) -> "endpoint_invalid"
      isProduction && spkiPins.isEmpty() -> "production_pin_missing"
      else -> null
    }

  companion object {
    private const val RESOURCE_NAME = "alrueya_secure_transport_configuration"
    private val loopbackHosts = setOf("10.0.2.2", "127.0.0.1", "localhost")
    private val pinPattern = Regex("^[A-Za-z0-9_-]{43}$")

    fun from(context: Context): SecureTransportConfiguration {
      val id = context.resources.getIdentifier(RESOURCE_NAME, "string", context.packageName)
      val raw = if (id == 0) null else context.getString(id)
      return parse(raw)
    }

    fun parse(raw: String?): SecureTransportConfiguration {
      if (raw.isNullOrBlank()) return SecureTransportConfiguration("", "development", emptySet())
      return try {
        val source = JSONObject(raw)
        val environment = if (source.optString("environment") == "production") "production" else "development"
        val baseUrl = source.optString("baseUrl").trim()
        val pins = source.optJSONArray("spkiPins")
          ?.strings()
          ?.filter(pinPattern::matches)
          ?.toSet()
          ?: emptySet()
        SecureTransportConfiguration(baseUrl, environment, pins)
      } catch (_: Exception) {
        SecureTransportConfiguration("", "development", emptySet())
      }
    }

    fun isAllowedEndpoint(baseUrl: String, environment: String): Boolean {
      val uri = runCatching { URI(baseUrl) }.getOrNull() ?: return false
      val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return false
      if (uri.userInfo != null || uri.query != null || uri.fragment != null) return false
      if (uri.path != null && uri.path !in setOf("", "/")) return false
      return when (uri.scheme?.lowercase()) {
        "https" -> true
        "http" -> environment == "development" && host in loopbackHosts
        else -> false
      }
    }

    private fun JSONArray.strings(): List<String> = buildList {
      for (index in 0 until length()) optString(index).takeIf { it.isNotBlank() }?.let(::add)
    }
  }
}

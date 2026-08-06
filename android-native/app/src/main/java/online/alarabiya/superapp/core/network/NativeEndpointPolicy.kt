package online.alarabiya.superapp.core.network

import java.net.URI

/** Keeps non-TLS traffic impossible outside an explicit emulator/local development endpoint. */
object NativeEndpointPolicy {
    private val developmentLoopbacks = setOf("10.0.2.2", "127.0.0.1", "localhost")

    fun isAllowed(baseUrl: String, environment: String): Boolean {
        val uri = runCatching { URI(baseUrl) }.getOrNull() ?: return false
        val host = uri.host?.lowercase()?.takeIf(String::isNotBlank) ?: return false
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) return false
        if (uri.path != null && uri.path !in setOf("", "/")) return false
        return when (uri.scheme?.lowercase()) {
            "https" -> true
            "http" -> environment == "dev" && host in developmentLoopbacks
            else -> false
        }
    }
}

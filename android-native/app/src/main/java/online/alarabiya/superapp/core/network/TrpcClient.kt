package online.alarabiya.superapp.core.network

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.security.DeviceProofKey
import online.alarabiya.superapp.core.security.NativeDeviceChallenge
import online.alarabiya.superapp.core.security.SecureSessionStore
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class ApiException(
    message: String,
    val status: Int? = null,
    val code: String? = null,
    val appCode: String? = null,
    val correlationId: String? = null,
    val dbCode: String? = null,
    val retryableTransportFailure: Boolean = false,
    /**
     * Delay the server hinted before retrying (parsed from RFC 7231 Retry-After: seconds form).
     * Present only when the server sent the header — honored by [IdempotentRequestRetryPolicy]
     * so the client does not stampede at Retry-After boundaries during peak load (H4).
     */
    val retryAfterMillis: Long? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class TrpcClient(private val sessionStore: SecureSessionStore) {
    private val deviceProofKey = DeviceProofKey()
    private val _usingCachedRead = MutableStateFlow(false)
    val usingCachedRead: StateFlow<Boolean> = _usingCachedRead.asStateFlow()

    init {
        require(NativeEndpointPolicy.isAllowed(BuildConfig.ERP_BASE_URL, BuildConfig.ENVIRONMENT)) {
            "Native API endpoint violates the environment transport policy"
        }
    }

    suspend fun query(procedure: String, input: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val envelope = inputEnvelope(input)
        val encoded = Uri.encode(envelope.toString())
        readThroughCache(procedure, envelope, "object") {
            requireObject(execute("GET", "/api/trpc/$procedure?batch=1&input=$encoded", null))
        } as JSONObject
    }

    /**
     * Executes an object query whose server contract explicitly permits a JSON `null` result.
     *
     * Callers must opt into this surface instead of interpreting an [ApiException] message from
     * [query]. Non-object, non-null results remain contract violations and still fail closed.
     */
    suspend fun queryNullableObject(
        procedure: String,
        input: JSONObject? = null,
    ): JSONObject? = withContext(Dispatchers.IO) {
        val envelope = inputEnvelope(input)
        val encoded = Uri.encode(envelope.toString())
        val result = execute(
            method = "GET",
            path = "/api/trpc/$procedure?batch=1&input=$encoded",
            body = null,
            allowNullResult = true,
        )
        _usingCachedRead.value = false
        TrpcResultType.objectOrNull(result)
    }

    suspend fun mutate(procedure: String, input: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        requireObject(execute("POST", "/api/trpc/$procedure?batch=1", inputEnvelope(input).toString()))
    }

    suspend fun queryArray(procedure: String, input: JSONObject? = null): JSONArray = withContext(Dispatchers.IO) {
        val envelope = inputEnvelope(input)
        val encoded = Uri.encode(envelope.toString())
        readThroughCache(procedure, envelope, "array") {
            requireArray(execute("GET", "/api/trpc/$procedure?batch=1&input=$encoded", null))
        } as JSONArray
    }

    suspend fun mutateArray(procedure: String, input: JSONObject? = null): JSONArray = withContext(Dispatchers.IO) {
        requireArray(execute("POST", "/api/trpc/$procedure?batch=1", inputEnvelope(input).toString()))
    }

    fun clearSession() {
        sessionStore.clear()
        deviceProofKey.clear()
    }

    private fun inputEnvelope(input: JSONObject?): JSONObject = TrpcInputSerializer.envelope(input)

    private suspend fun readThroughCache(
        procedure: String,
        envelope: JSONObject,
        kind: String,
        remote: suspend () -> Any,
    ): Any {
        val cacheKey = OfflineReadCachePolicy.cacheKey(procedure, envelope.toString())
        return try {
            remote().also { result ->
                _usingCachedRead.value = false
                if (cacheKey != null) saveCachedRead(cacheKey, kind, result)
            }
        } catch (error: ApiException) {
            val cached = if (error.retryableTransportFailure && cacheKey != null) {
                loadCachedRead(cacheKey, kind)
            } else {
                null
            }
            if (cached == null) throw error
            _usingCachedRead.value = true
            cached
        }
    }

    private fun saveCachedRead(cacheKey: String, kind: String, result: Any) {
        val userId = cachedUserId() ?: return
        val snapshot = JSONObject()
            .put("savedAt", System.currentTimeMillis())
            .put("userId", userId)
            .put("kind", kind)
            .put("payload", result)
        sessionStore.saveQuerySnapshot(cacheKey, snapshot.toString())
    }

    private fun loadCachedRead(cacheKey: String, kind: String): Any? {
        val userId = cachedUserId() ?: return null
        val snapshot = sessionStore.loadQuerySnapshot(cacheKey)?.let { raw ->
            runCatching { JSONObject(raw) }.getOrNull()
        } ?: return null
        if (!OfflineReadCachePolicy.accepts(snapshot, kind, userId, System.currentTimeMillis())) return null
        return when (kind) {
            "object" -> snapshot.optJSONObject("payload")
            "array" -> snapshot.optJSONArray("payload")
            else -> null
        }
    }

    private fun cachedUserId(): Long? = sessionStore.loadUserSnapshot()?.let { raw ->
        runCatching { JSONObject(raw).optLong("id", -1L) }.getOrNull()
    }?.takeIf { it > 0L }

    private suspend fun execute(
        method: String,
        path: String,
        body: String?,
        allowNullResult: Boolean = false,
    ): Any? {
        val request = {
            IdempotentRequestRetryPolicy.execute(method) {
                executeAttempt(method, path, body, allowNullResult)
            }
        }
        return if (NativeRequestSerializationPolicy.requiresSerialization(method)) {
            mutationMutex.withLock { request() }
        } else {
            request()
        }
    }

    private fun executeAttempt(
        method: String,
        path: String,
        body: String?,
        allowNullResult: Boolean,
    ): Any? {
        val sessionCookie = sessionStore.loadCookie()
        val proofHeaders = when {
            procedureName(path) in AUTH_COMPLETION_PROCEDURES ->
                deviceProofKey.registrationHeaders(fetchNativeDeviceChallenge())

            sessionCookie != null && !sessionCookie.startsWith(LOCKED_COOKIE_PREFIX) ->
                deviceProofKey.sessionHeaders(
                    method = method,
                    target = path,
                    body = body.orEmpty(),
                    sessionToken = sessionToken(sessionCookie),
                )

            else -> BASE_NATIVE_HEADERS
        }
        val connection = (URL(BuildConfig.ERP_BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 25_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Language", "ar-IQ,ar;q=0.9")
            setRequestProperty("User-Agent", "AlrueyaNative/1.0 Android")
            proofHeaders.forEach(::setRequestProperty)
            sessionCookie?.let { setRequestProperty("Cookie", it) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }

        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            // Retry-After only applies to non-2xx (particularly 429/503). Captured here so the
            // retry policy honors the server's stampede hint at peak load (H4).
            val retryAfterMillis = if (status in 200..299) null else parseRetryAfterMillis(connection)
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val payload = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()

            if (status in 200..299) {
                // Only persist Set-Cookie from a real success — a 4xx/5xx that carries Set-Cookie
                // used to overwrite the live cookie (M2). Also swallow biometric-lock exceptions
                // from Keystore so a locked device does not turn a good response into a false
                // transport failure that the caller then retries with the same cookie.
                runCatching { persistSessionCookie(connection) }
                if (payload.isBlank()) throw ApiException("لم يصل رد صالح من الخادم", status)
                return if (allowNullResult) {
                    TrpcEnvelopeParser.parseNullable(payload, status)
                } else {
                    TrpcEnvelopeParser.parse(payload, status)
                }
            }

            if (payload.isBlank()) {
                throw ApiException("لم يصل رد صالح من الخادم", status, retryAfterMillis = retryAfterMillis)
            }
            try {
                return if (allowNullResult) {
                    TrpcEnvelopeParser.parseNullable(payload, status)
                } else {
                    TrpcEnvelopeParser.parse(payload, status)
                }
            } catch (parsed: ApiException) {
                throw withRetryAfter(parsed, retryAfterMillis)
            }
        } catch (error: ApiException) {
            throw error
        } catch (error: Exception) {
            val message = if (method.equals("GET", ignoreCase = true)) {
                "تعذر الوصول إلى خادم الشركة حالياً. تحقق من اتصال الإنترنت ثم أعد المحاولة."
            } else {
                "تعذر تأكيد استجابة الخادم للعملية. تحقق من حالتها قبل إعادة الإرسال."
            }
            throw ApiException(message, retryableTransportFailure = true, cause = error)
        } finally {
            connection.disconnect()
        }
    }

    /** Fetches a credential-free, short-lived registration ticket without recursing through execute(). */
    private fun fetchNativeDeviceChallenge(): NativeDeviceChallenge {
        return IdempotentRequestRetryPolicy.execute("GET") {
            fetchNativeDeviceChallengeAttempt()
        }
    }

    private fun fetchNativeDeviceChallengeAttempt(): NativeDeviceChallenge {
        val input = Uri.encode(inputEnvelope(null).toString())
        val path = "/api/trpc/auth.nativeDeviceChallenge?batch=1&input=$input"
        val connection = (URL(BuildConfig.ERP_BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Language", "ar-IQ,ar;q=0.9")
            setRequestProperty("User-Agent", "AlrueyaNative/1.0 Android")
            BASE_NATIVE_HEADERS.forEach(::setRequestProperty)
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val payload = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (payload.isBlank()) throw ApiException("لم يصل تحدي إثبات الجهاز من الخادم", status)
            val result = TrpcEnvelopeParser.parse(payload, status) as? JSONObject
                ?: throw ApiException("استجابة تحدي إثبات الجهاز غير صالحة", status)
            val ticket = result.optString("ticket").takeIf { it.isNotBlank() }
                ?: throw ApiException("تذكرة إثبات الجهاز مفقودة", status)
            val expiresAt = result.optLong("expiresAt", 0L)
            if (expiresAt <= 0L) throw ApiException("صلاحية تذكرة إثبات الجهاز مفقودة", status)
            return NativeDeviceChallenge(ticket = ticket, expiresAt = expiresAt)
        } catch (error: ApiException) {
            throw error
        } catch (error: Exception) {
            throw nativeChallengeTransportError(error)
        } finally {
            connection.disconnect()
        }
    }

    private fun procedureName(path: String): String =
        path.substringAfter("/api/trpc/", "").substringBefore('?')

    private fun sessionToken(cookie: String): String = cookie.substringAfter('=', "")
        .takeIf { it.isNotBlank() }
        ?: throw ApiException("جلسة التطبيق المحلية غير صالحة")

    private fun persistSessionCookie(connection: HttpURLConnection) {
        val pair = SessionCookieParser.findSessionCookie(
            connection.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value.orEmpty() },
        ) ?: return
        sessionStore.saveCookie(pair)
    }

    /**
     * Reads RFC 7231 Retry-After. Only the delta-seconds form is honored — the HTTP-date form
     * requires wall clock and is discarded to keep the retry policy device-time-independent.
     * Values outside [0, 30 s] are clamped to keep the client responsive at peak.
     */
    private fun parseRetryAfterMillis(connection: HttpURLConnection): Long? {
        val header = connection.getHeaderField("Retry-After")?.trim().orEmpty()
        if (header.isEmpty()) return null
        val seconds = header.toLongOrNull() ?: return null
        return seconds.coerceIn(0L, MAX_RETRY_AFTER_SECONDS) * 1_000L
    }

    private fun withRetryAfter(base: ApiException, retryAfterMillis: Long?): ApiException {
        if (retryAfterMillis == null || base.retryAfterMillis != null) return base
        return ApiException(
            message = base.message ?: "",
            status = base.status,
            code = base.code,
            appCode = base.appCode,
            correlationId = base.correlationId,
            dbCode = base.dbCode,
            retryableTransportFailure = base.retryableTransportFailure,
            retryAfterMillis = retryAfterMillis,
            cause = base.cause,
        )
    }

    private fun requireObject(value: Any?): JSONObject = value as? JSONObject
        ?: throw ApiException("استجابة الخادم ليست كائناً كما يتطلب هذا الإجراء")

    private fun requireArray(value: Any?): JSONArray = value as? JSONArray
        ?: throw ApiException("استجابة الخادم ليست قائمة كما يتطلب هذا الإجراء")
    private companion object {
        // State-changing requests advance one server-side device-proof counter. Keep only those
        // requests ordered; read-only requests are signed independently and may run concurrently.
        val mutationMutex = Mutex()
        const val LOCKED_COOKIE_PREFIX = "__alrueya_locked__="
        // 30 s hard cap on Retry-After: the server may send anything but we keep the UI responsive.
        const val MAX_RETRY_AFTER_SECONDS = 30L
        val AUTH_COMPLETION_PROCEDURES = setOf(
            "auth.login",
            "auth.twoFactorVerify",
        )
        val BASE_NATIVE_HEADERS = mapOf(
            "X-Alrueya-Client" to "android-native",
            "X-Alrueya-Client-Version" to "2",
            "X-Alrueya-Device-Proof-Version" to "1",
        )
    }
}

internal fun nativeChallengeTransportError(error: Throwable): ApiException = ApiException(
    "تعذر الوصول إلى خادم الشركة لتهيئة الجهاز. تحقق من الإنترنت ثم أعد المحاولة.",
    retryableTransportFailure = true,
    cause = error,
)

internal object NativeRequestSerializationPolicy {
    fun requiresSerialization(method: String): Boolean =
        !method.equals("GET", ignoreCase = true) && !method.equals("HEAD", ignoreCase = true)
}

internal object SessionCookieParser {
    private const val SESSION_COOKIE_NAME = "app_session_id"

    fun findSessionCookie(headers: List<String>): String? = headers
        .asSequence()
        .map { it.substringBefore(';').trim() }
        .filter { it.contains('=') }
        .firstOrNull { it.substringBefore('=').trim() == SESSION_COOKIE_NAME }
}

internal object OfflineReadCachePolicy {
    private const val MAX_AGE_MS = 24L * 60L * 60L * 1_000L
    private const val CLOCK_SKEW_MS = 5L * 60L * 1_000L
    private val cachedProcedures = setOf(
        "branches.list",
        "catalog.adminList",
        "catalog.forPurchase",
        "catalog.posList",
        "customers.get",
        "customers.search",
        "inventory.movementsRich",
        "inventory.onHand",
        "inventory.pendingAdjustments",
        "inventory.transferGet",
        "inventory.transfersList",
        "offline.catalogSnapshot",
        "offline.stockSnapshot",
        "stocktakes.get",
        "stocktakes.list",
        "stocktakes.monitor",
        "tasks.get",
        "tasks.list",
    )

    fun cacheKey(procedure: String, inputEnvelope: String): String? {
        if (procedure !in cachedProcedures) return null
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$procedure\n$inputEnvelope".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }

    fun accepts(snapshot: JSONObject, kind: String, userId: Long, now: Long): Boolean {
        if (snapshot.optString("kind") != kind || snapshot.optLong("userId", -1L) != userId) return false
        val savedAt = snapshot.optLong("savedAt", -1L)
        if (savedAt <= 0L || savedAt > now + CLOCK_SKEW_MS || now - savedAt > MAX_AGE_MS) return false
        return when (kind) {
            "object" -> snapshot.optJSONObject("payload") != null
            "array" -> snapshot.optJSONArray("payload") != null
            else -> false
        }
    }
}

/** SuperJSON represents JavaScript `undefined` with metadata, not as plain JSON null.
 * Optional tRPC object inputs reject `null`, so native no-input calls must preserve the
 * same wire value emitted by the web client instead of changing the contract's meaning. */
internal object TrpcInputSerializer {
    fun envelope(input: JSONObject?): JSONObject {
        val serialized = if (input == null) {
            JSONObject()
                .put("json", JSONObject.NULL)
                .put("meta", JSONObject().put("values", JSONArray().put("undefined")))
        } else {
            JSONObject().put("json", input)
        }
        return JSONObject().put("0", serialized)
    }
}

internal object TrpcResultType {
    fun objectOrNull(value: Any?): JSONObject? = when (value) {
        null -> null
        is JSONObject -> value
        else -> throw ApiException("استجابة الخادم ليست كائناً أو قيمة فارغة كما يتطلب هذا الإجراء")
    }
}

internal object TrpcEnvelopeParser {
    fun parse(payload: String, status: Int): Any {
        val json = parseResult(payload, status)
        if (json === JSONObject.NULL) throw ApiException("استجابة الخادم غير مكتملة", status)
        return json
    }

    fun parseNullable(payload: String, status: Int): Any? {
        val json = parseResult(payload, status)
        return if (json === JSONObject.NULL) null else json
    }

    private fun parseResult(payload: String, status: Int): Any {
        val item = when (val first = payload.trim().firstOrNull()) {
            '[' -> JSONArray(payload).optJSONObject(0)
            '{' -> JSONObject(payload)
            else -> null
        } ?: throw ApiException("صيغة استجابة الخادم غير صالحة", status)

        item.optJSONObject("error")?.let { error ->
            val errorJson = error.optJSONObject("json") ?: error
            val data = errorJson.optJSONObject("data") ?: error.optJSONObject("data")
            val message = errorJson.optString("message")
                ?.takeIf { it.isNotBlank() }
                ?: error.optString("message").takeIf { it.isNotBlank() }
                ?: "تعذر إكمال الطلب"
            val responseStatus = data?.optInt("httpStatus")?.takeIf { it > 0 } ?: status
            throw ApiException(
                message = message,
                status = responseStatus,
                code = data?.nullableString("code"),
                appCode = data?.nullableString("appCode"),
                correlationId = data?.nullableString("correlationId"),
                dbCode = data?.nullableString("dbCode"),
            )
        }

        val json = item.optJSONObject("result")
            ?.optJSONObject("data")
            ?.opt("json")
            ?: throw ApiException("استجابة الخادم غير مكتملة", status)
        return json
    }
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

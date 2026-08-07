package online.alarabiya.superapp.core.network

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.security.DeviceProofKey
import online.alarabiya.superapp.core.security.NativeDeviceChallenge
import online.alarabiya.superapp.core.security.SecureSessionStore
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class ApiException(
    message: String,
    val status: Int? = null,
    val code: String? = null,
    val appCode: String? = null,
    val correlationId: String? = null,
    val dbCode: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class TrpcClient(private val sessionStore: SecureSessionStore) {
    private val deviceProofKey = DeviceProofKey()

    init {
        require(NativeEndpointPolicy.isAllowed(BuildConfig.ERP_BASE_URL, BuildConfig.ENVIRONMENT)) {
            "Native API endpoint violates the environment transport policy"
        }
    }

    suspend fun query(procedure: String, input: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val envelope = inputEnvelope(input)
        val encoded = Uri.encode(envelope.toString())
        requireObject(execute("GET", "/api/trpc/$procedure?batch=1&input=$encoded", null))
    }

    suspend fun mutate(procedure: String, input: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        requireObject(execute("POST", "/api/trpc/$procedure?batch=1", inputEnvelope(input).toString()))
    }

    suspend fun queryArray(procedure: String, input: JSONObject? = null): JSONArray = withContext(Dispatchers.IO) {
        val envelope = inputEnvelope(input)
        val encoded = Uri.encode(envelope.toString())
        requireArray(execute("GET", "/api/trpc/$procedure?batch=1&input=$encoded", null))
    }

    suspend fun mutateArray(procedure: String, input: JSONObject? = null): JSONArray = withContext(Dispatchers.IO) {
        requireArray(execute("POST", "/api/trpc/$procedure?batch=1", inputEnvelope(input).toString()))
    }

    fun clearSession() {
        sessionStore.clear()
        deviceProofKey.clear()
    }

    private fun inputEnvelope(input: JSONObject?): JSONObject = TrpcInputSerializer.envelope(input)

    private fun execute(method: String, path: String, body: String?): Any = requestLock.withLock {
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
            persistSessionCookie(connection)
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val payload = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (payload.isBlank()) throw ApiException("لم يصل رد صالح من الخادم", status)
            return TrpcEnvelopeParser.parse(payload, status)
        } catch (error: ApiException) {
            throw error
        } catch (error: Exception) {
            throw ApiException("تعذر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.", cause = error)
        } finally {
            connection.disconnect()
        }
    }

    /** Fetches a credential-free, short-lived registration ticket without recursing through execute(). */
    private fun fetchNativeDeviceChallenge(): NativeDeviceChallenge {
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
            throw ApiException("تعذر تهيئة إثبات الجهاز الآمن", cause = error)
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
        val setCookie = connection.headerFields.entries
            .firstOrNull { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
            ?.value
            ?.firstOrNull()
            ?: return
        val pair = setCookie.substringBefore(';').trim()
        if (pair.contains('=')) sessionStore.saveCookie(pair)
    }

    private fun requireObject(value: Any): JSONObject = value as? JSONObject
        ?: throw ApiException("استجابة الخادم ليست كائناً كما يتطلب هذا الإجراء")

    private fun requireArray(value: Any): JSONArray = value as? JSONArray
        ?: throw ApiException("استجابة الخادم ليست قائمة كما يتطلب هذا الإجراء")
    private companion object {
        // Native push and foreground UI use separate clients; serialize proof counters globally.
        val requestLock = ReentrantLock()
        const val LOCKED_COOKIE_PREFIX = "__alrueya_locked__="
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

internal object TrpcEnvelopeParser {
    fun parse(payload: String, status: Int): Any {
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
        if (json == JSONObject.NULL) throw ApiException("استجابة الخادم غير مكتملة", status)
        return json
    }
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

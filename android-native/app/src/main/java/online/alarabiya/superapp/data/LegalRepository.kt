package online.alarabiya.superapp.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.network.NativeEndpointPolicy
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

data class LegalConfig(
    val appName: String,
    val dataControllerName: String,
    val privacyContactEmail: String?,
    val privacyPolicyVersion: String,
    val privacyPath: String,
)

data class LegalSection(
    val title: String,
    val body: String,
)

data class LegalDocument(
    val config: LegalConfig,
    val sections: List<LegalSection>,
    val publicUrl: String?,
)

interface LegalDataSource {
    suspend fun loadPrivacyPolicy(): LegalDocument
}

class LegalRepository(
    private val baseUrl: String = BuildConfig.ERP_BASE_URL,
    environment: String = BuildConfig.ENVIRONMENT,
) : LegalDataSource {
    init {
        require(NativeEndpointPolicy.isAllowed(baseUrl, environment)) {
            "Legal endpoint violates the environment transport policy"
        }
    }

    override suspend fun loadPrivacyPolicy(): LegalDocument = withContext(Dispatchers.IO) {
        runCatching { fetchRemoteConfig() }
            .getOrElse { LegalPolicyMapper.fallback(baseUrl) }
    }

    private fun fetchRemoteConfig(): LegalDocument {
        val connection = (URL(baseUrl.removeSuffix("/") + LEGAL_PATH).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Language", "ar-IQ,ar;q=0.9")
            setRequestProperty("User-Agent", "SuperAlarabiyaNative/${BuildConfig.VERSION_NAME} Android")
        }
        return try {
            if (connection.responseCode !in 200..299) return LegalPolicyMapper.fallback(baseUrl)
            val payload = connection.inputStream.use(::readBoundedUtf8)
            LegalPolicyMapper.fromJson(payload, baseUrl)
        } finally {
            connection.disconnect()
        }
    }

    private fun readBoundedUtf8(input: InputStream): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4 * 1024)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= MAX_RESPONSE_BYTES) { "Legal response is too large" }
            output.write(buffer, 0, count)
        }
        return output.toString(Charsets.UTF_8.name())
    }

    private companion object {
        const val LEGAL_PATH = "/api/public/legal"
        const val MAX_RESPONSE_BYTES = 64 * 1024
    }
}

internal object LegalPolicyMapper {
    private val emailPattern = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
    private val safeVersion = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

    fun fromJson(payload: String, baseUrl: String): LegalDocument {
        val json = JSONObject(payload)
        return fromValues(
            values = mapOf(
                "appName" to json.optString("appName"),
                "dataControllerName" to json.optString("dataControllerName"),
                "privacyContactEmail" to json.optString("privacyContactEmail"),
                "privacyPolicyVersion" to json.optString("privacyPolicyVersion"),
                "privacyPath" to json.optString("privacyPath"),
            ),
            baseUrl = baseUrl,
        )
    }

    internal fun fromValues(values: Map<String, String?>, baseUrl: String): LegalDocument {
        val fallback = fallbackConfig()
        val privacyPath = values["privacyPath"].orEmpty()
            .takeIf { it == "/privacy" }
            ?: fallback.privacyPath
        val config = LegalConfig(
            appName = values["appName"].orEmpty().cleanOr(fallback.appName),
            dataControllerName = values["dataControllerName"].orEmpty().cleanOr(fallback.dataControllerName),
            privacyContactEmail = values["privacyContactEmail"].orEmpty()
                .trim()
                .takeIf(emailPattern::matches),
            privacyPolicyVersion = values["privacyPolicyVersion"].orEmpty()
                .trim()
                .takeIf(safeVersion::matches)
                ?: fallback.privacyPolicyVersion,
            privacyPath = privacyPath,
        )
        return document(config, baseUrl)
    }

    fun fallback(baseUrl: String): LegalDocument = document(fallbackConfig(), baseUrl)

    private fun document(config: LegalConfig, baseUrl: String): LegalDocument = LegalDocument(
        config = config,
        sections = embeddedSections(config),
        publicUrl = if (config.privacyPath == "/privacy" && baseUrl.startsWith("https://")) {
            baseUrl.removeSuffix("/") + config.privacyPath
        } else {
            null
        },
    )

    private fun fallbackConfig() = LegalConfig(
        appName = "سوبر العربية",
        dataControllerName = "شركة الرؤية العربية",
        privacyContactEmail = null,
        privacyPolicyVersion = "2026-08-05",
        privacyPath = "/privacy",
    )

    private fun embeddedSections(config: LegalConfig): List<LegalSection> = listOf(
        LegalSection(
            "نطاق السياسة",
            "تنطبق هذه السياسة على تطبيق ${config.appName}. الجهة المتحكمة في بيانات هذا النشر هي ${config.dataControllerName}.",
        ),
        LegalSection(
            "البيانات",
            "يعالج النظام بيانات الحساب والموظف والفرع والدور، وسجلات العمل والحضور والراتب والإجازات والمهام المصرح بها.",
        ),
        LegalSection(
            "الاستخدام",
            "تُستخدم البيانات لإثبات الهوية، وتطبيق الصلاحيات، وتنفيذ المعاملات والخدمات الذاتية، وحماية سلامة السجلات.",
        ),
        LegalSection(
            "الإشعارات",
            "تُستخدم تفضيلات الإشعارات لتقديم التنبيهات المختارة. يمكن للمستخدم إيقاف الإشعارات أو تعديلها من إعدادات التطبيق والجهاز.",
        ),
        LegalSection(
            "المشاركة والاحتفاظ",
            "لا تُباع البيانات ولا تُستخدم للإعلانات. تقتصر المعالجة والمشاركة على مقدمي الخدمة المعتمدين وبالقدر اللازم للتشغيل والالتزام.",
        ),
        LegalSection(
            "الحماية والخيارات",
            "تُحمى الجلسات والبيانات بضوابط وصول وتشفير وسجلات تدقيق. يمكن للمستخدم مراجعة بياناته وتفضيلاته عبر الجهة الإدارية المخولة.",
        ),
        LegalSection(
            "الحسابات",
            "الحسابات تنشئها الإدارة المخولة وتديرها وفق علاقة العمل والصلاحيات المعتمدة.",
        ),
    )

    private fun String.cleanOr(fallback: String): String = trim().takeIf { it.length in 2..120 } ?: fallback
}

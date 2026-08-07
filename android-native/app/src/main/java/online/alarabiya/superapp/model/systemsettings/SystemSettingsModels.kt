package online.alarabiya.superapp.model.systemsettings

import online.alarabiya.superapp.model.AppBootstrap
import java.time.LocalDate
import java.time.ZoneOffset

data class SystemSettingsCapabilities(
    val canManageBranches: Boolean,
    val canReadIntegrations: Boolean,
    val canManageIntegrations: Boolean,
    val canReadTemplates: Boolean,
    val canSyncTemplates: Boolean,
    val canReadWhatsAppHub: Boolean,
    val canUpdateWhatsAppHub: Boolean,
    val canReadSystemInfo: Boolean,
    val canReadGovernance: Boolean,
    val canUpdateGovernance: Boolean,
) {
    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): SystemSettingsCapabilities {
            val role = bootstrap.user.role.trim().lowercase()
            val admin = role == "admin"
            val manager = admin || role == "manager"
            return SystemSettingsCapabilities(
                canManageBranches = admin,
                canReadIntegrations = admin,
                canManageIntegrations = admin,
                canReadTemplates = manager,
                canSyncTemplates = admin,
                canReadWhatsAppHub = manager,
                canUpdateWhatsAppHub = admin,
                canReadSystemInfo = admin,
                canReadGovernance = true,
                canUpdateGovernance = admin,
            )
        }
    }
}

enum class BranchType { MAIN, SALES;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: SALES }
}

data class AdminBranch(
    val id: Long,
    val name: String,
    val code: String,
    val type: BranchType,
    val address: String?,
    val phone: String?,
    val active: Boolean,
    val createdAt: String?,
)

data class BranchDraft(
    val id: Long? = null,
    val name: String = "",
    val code: String = "",
    val type: BranchType = BranchType.SALES,
    val address: String = "",
    val phone: String = "",
) {
    fun normalized() = copy(name = name.trim(), code = code.trim().uppercase(), address = address.trim(), phone = phone.trim())
    fun validate(): String? = when {
        name.trim().isEmpty() -> "اسم الفرع مطلوب"
        name.trim().length > 255 -> "اسم الفرع يتجاوز 255 حرفاً"
        !code.trim().uppercase().matches(Regex("^[A-Z0-9_-]{2,30}$")) -> "رمز الفرع يجب أن يكون 2–30 من الحروف الإنجليزية أو الأرقام أو _ -"
        address.trim().length > 1000 -> "العنوان يتجاوز 1000 حرف"
        phone.trim().length > 20 -> "رقم الهاتف يتجاوز 20 حرفاً"
        else -> null
    }
}

enum class IntegrationChannel { WHATSAPP, INSTAGRAM, STORE;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: STORE }
}
enum class IntegrationStatus { PENDING, ACTIVE, FAILED, DISABLED, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}

/** Contains public metadata and secret-presence flags only; secret/masked values never enter native state. */
data class ChannelIntegration(
    val id: Long,
    val branchId: Long,
    val branchName: String,
    val channel: IntegrationChannel,
    val displayName: String?,
    val phoneNumberId: String?,
    val wabaId: String?,
    val hasVerifyToken: Boolean,
    val hasAppSecret: Boolean,
    val hasAccessToken: Boolean,
    val status: IntegrationStatus,
    val lastVerifiedAt: String?,
    val lastError: String?,
    val webhookUrl: String?,
)

data class IntegrationMetadataDraft(
    val branchId: Long,
    val channel: IntegrationChannel,
    val displayName: String = "",
    val phoneNumberId: String = "",
    val wabaId: String = "",
) {
    fun validate(): String? = when {
        branchId <= 0 -> "حدد الفرع"
        displayName.trim().length > 120 -> "اسم العرض يتجاوز 120 حرفاً"
        phoneNumberId.trim().length > 80 || wabaId.trim().length > 80 -> "معرّف التكامل يتجاوز 80 حرفاً"
        else -> null
    }
}

data class IntegrationCryptoStatus(val ready: Boolean)
data class IntegrationVerifyResult(val ok: Boolean, val message: String)

enum class TemplateCategory { MARKETING, UTILITY, AUTHENTICATION, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}
enum class TemplateStatus { PENDING, APPROVED, REJECTED, PAUSED, DISABLED, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}
data class WhatsAppTemplate(
    val id: Long,
    val branchId: Long?,
    val name: String,
    val language: String,
    val category: TemplateCategory,
    val status: TemplateStatus,
    val body: String?,
    val variableCount: Int,
    val qualityScore: String?,
    val syncedAt: String?,
)
data class TemplateSyncResult(val synced: Int, val approved: Int)

enum class TriageMode { AUTO_ALL, KEYWORD_ONLY, MANUAL;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: AUTO_ALL }
}
data class WhatsAppHubSettings(
    val triageMode: TriageMode = TriageMode.AUTO_ALL,
    val autoTaskEnabled: Boolean = true,
    val hasBusinessHours: Boolean = false,
    val afterHoursReply: String? = null,
    val welcomeReply: String? = null,
    val throttlePerMinute: Int = 10,
    val optOutKeywords: String? = null,
    val campaignApprovalThreshold: Int = 500,
    val autoReplyAfterHours: Boolean = false,
    val autoReplyWelcome: Boolean = false,
    val flowArReminder: Boolean = false,
    val flowOrderReady: Boolean = false,
    val flowPurchaseThanks: Boolean = false,
    val flowConsignmentWithdraw: Boolean = false,
    val csatOnResolve: Boolean = false,
    val killSwitch: Boolean = false,
) {
    fun validate(): String? = when {
        throttlePerMinute !in 1..1000 -> "حد الإرسال يجب أن يكون بين 1 و1000"
        campaignApprovalThreshold < 0 -> "حد اعتماد الحملات لا يمكن أن يكون سالباً"
        afterHoursReply.orEmpty().length > 2000 || welcomeReply.orEmpty().length > 2000 || optOutKeywords.orEmpty().length > 2000 -> "النص يتجاوز 2000 حرف"
        else -> null
    }
}

data class SystemHealth(val ok: Boolean, val time: String?)
data class SystemCounts(val branches: Int, val users: Int, val products: Int, val customers: Int, val invoices: Int)
data class SafeBackupStatus(val count: Int, val totalKb: Long, val latest: String?)
data class PrinterStatus(val enabled: Boolean, val description: String?)
data class ScheduleStatus(val dailyAt: String?, val offsiteConfigured: Boolean)
/** Deliberately excludes database name/host, backup path, and destructive confirmation token. */
data class SafeSystemInfo(
    val counts: SystemCounts,
    val backups: SafeBackupStatus,
    val printer: PrinterStatus,
    val schedule: ScheduleStatus,
)

data class TaxSettings(
    val enabledByDefault: Boolean,
    val defaultTaxRatePercent: String,
    val taxRegistrationNumber: String?,
    val updatedAt: String?,
) {
    fun validate(): String? {
        val rate = defaultTaxRatePercent.trim().toDoubleOrNull() ?: return "نسبة الضريبة غير صالحة"
        return when {
            rate !in 0.0..100.0 -> "نسبة الضريبة يجب أن تكون بين 0 و100"
            taxRegistrationNumber.orEmpty().length > 50 -> "الرقم الضريبي يتجاوز 50 حرفاً"
            else -> null
        }
    }
}

data class OpeningMode(
    val enabled: Boolean,
    val endsAtYmd: String?,
    val maxNegativeQtyPerLine: Int,
    val active: Boolean,
    val updatedAt: String?,
) {
    fun validateForUpdate(today: LocalDate = LocalDate.now(ZoneOffset.UTC)): String? {
        if (maxNegativeQtyPerLine !in 1..10_000) return "الحد الأقصى يجب أن يكون بين 1 و10000"
        if (!enabled) return null
        val raw = endsAtYmd?.trim().takeUnless { it.isNullOrEmpty() } ?: return "تاريخ انتهاء فترة الافتتاح مطلوب"
        val end = runCatching { LocalDate.parse(raw) }.getOrNull() ?: return "صيغة التاريخ يجب أن تكون YYYY-MM-DD"
        return when {
            end.isBefore(today) -> "تاريخ الانتهاء لا يمكن أن يكون في الماضي"
            end.isAfter(today.plusDays(60)) -> "فترة الافتتاح لا يمكن أن تتجاوز 60 يوماً"
            else -> null
        }
    }
}

data class OpeningProgress(val branchId: Long, val branchName: String, val totalVariants: Int, val openedVariants: Int)

object NativeSystemSettingsBoundaries {
    const val SECRET_ROTATION = "إضافة أو تدوير مفاتيح التكامل تتم عبر قناة تشغيل آمنة خارج التطبيق."
    const val PERMANENT_DELETE = "حذف التكامل نهائياً غير متاح على الهاتف؛ استخدم التعطيل أو قناة الإدارة المراقبة."
    const val MAINTENANCE = "النسخ والاستعادة وإعادة ضبط قاعدة البيانات إجراءات تشغيلية خارج التطبيق."
    const val BUSINESS_HOURS = "تعديل جدول ساعات العمل ينتظر عقداً منظماً بدلاً من JSON حر."
}

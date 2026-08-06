package online.alarabiya.superapp.model.systemsettings

import org.json.JSONArray
import org.json.JSONObject

object SystemSettingsMappers {
    fun branches(root: JSONArray): List<AdminBranch> = root.maps(::branch)
    internal fun branches(rows: List<Any?>): List<AdminBranch> = rows.mapNotNull { it.stringMap()?.let(::branch) }

    fun integrations(root: JSONArray): List<ChannelIntegration> = root.maps(::integration)
    internal fun integrations(rows: List<Any?>): List<ChannelIntegration> = rows.mapNotNull { it.stringMap()?.let(::integration) }

    fun templates(root: JSONArray): List<WhatsAppTemplate> = root.maps(::template)
    internal fun templates(rows: List<Any?>): List<WhatsAppTemplate> = rows.mapNotNull { it.stringMap()?.let(::template) }

    fun crypto(root: JSONObject) = IntegrationCryptoStatus(root.optBoolean("ready"))
    fun verify(root: JSONObject) = IntegrationVerifyResult(root.optBoolean("ok"), root.text("message"))
    fun sync(root: JSONObject) = TemplateSyncResult(root.optInt("synced"), root.optInt("approved"))
    fun health(root: JSONObject) = SystemHealth(root.optBoolean("ok"), root.nullableText("time"))

    fun waHub(root: JSONObject): WhatsAppHubSettings = waHub(root.wireMap())
    internal fun waHub(root: Map<String, Any?>) = WhatsAppHubSettings(
        triageMode = TriageMode.fromWire(root.nullableText("triageMode")),
        autoTaskEnabled = root.bool("autoTaskEnabled", true),
        hasBusinessHours = root["businessHoursJson"] != null,
        afterHoursReply = root.nullableText("afterHoursReply"),
        welcomeReply = root.nullableText("welcomeReply"),
        throttlePerMinute = root.int("throttlePerMinute", 10),
        optOutKeywords = root.nullableText("optOutKeywords"),
        campaignApprovalThreshold = root.int("campaignApprovalThreshold", 500),
        autoReplyAfterHours = root.bool("autoReplyAfterHours"),
        autoReplyWelcome = root.bool("autoReplyWelcome"),
        flowArReminder = root.bool("flowArReminder"),
        flowOrderReady = root.bool("flowOrderReady"),
        flowPurchaseThanks = root.bool("flowPurchaseThanks"),
        flowConsignmentWithdraw = root.bool("flowConsignmentWithdraw"),
        csatOnResolve = root.bool("csatOnResolve"),
        killSwitch = root.bool("killSwitch"),
    )

    fun safeSystemInfo(root: JSONObject): SafeSystemInfo = safeSystemInfo(root.wireMap())
    internal fun safeSystemInfo(root: Map<String, Any?>): SafeSystemInfo {
        val counts = root.map("counts")
        val backups = root.map("backups")
        val printer = root.map("printer")
        val schedule = root.map("schedule")
        return SafeSystemInfo(
            counts = SystemCounts(counts.int("branches"), counts.int("users"), counts.int("products"), counts.int("customers"), counts.int("invoices")),
            backups = SafeBackupStatus(backups.int("count"), backups.long("totalKb"), backups.nullableText("latest")),
            printer = PrinterStatus(printer.bool("enabled"), printer.nullableText("description")),
            schedule = ScheduleStatus(schedule.nullableText("dailyAt"), schedule.bool("offsiteConfigured")),
        )
    }

    fun tax(root: JSONObject) = tax(root.wireMap())
    internal fun tax(root: Map<String, Any?>) = TaxSettings(
        enabledByDefault = root.bool("enabledByDefault"),
        defaultTaxRatePercent = root.text("defaultTaxRatePercent", "0"),
        taxRegistrationNumber = root.nullableText("taxRegistrationNumber"),
        updatedAt = root.nullableText("updatedAt"),
    )

    fun opening(root: JSONObject) = opening(root.wireMap())
    internal fun opening(root: Map<String, Any?>) = OpeningMode(
        enabled = root.bool("enabled"),
        endsAtYmd = root.nullableText("endsAtYmd"),
        maxNegativeQtyPerLine = root.int("maxNegativeQtyPerLine", 1),
        active = root.bool("active"),
        updatedAt = root.nullableText("updatedAt"),
    )

    fun openingProgress(root: JSONArray): List<OpeningProgress> = root.maps(::openingProgress)
    internal fun openingProgress(rows: List<Any?>): List<OpeningProgress> = rows.mapNotNull { it.stringMap()?.let(::openingProgress) }

    private fun branch(root: Map<String, Any?>) = AdminBranch(
        id = root.long("id"), name = root.text("name"), code = root.text("code"),
        type = BranchType.fromWire(root.nullableText("type")), address = root.nullableText("address"),
        phone = root.nullableText("phone"), active = root.bool("isActive"), createdAt = root.nullableText("createdAt"),
    )

    private fun integration(root: Map<String, Any?>) = ChannelIntegration(
        id = root.long("id"), branchId = root.long("branchId"), branchName = root.text("branchName"),
        channel = IntegrationChannel.fromWire(root.nullableText("channel")), displayName = root.nullableText("displayName"),
        phoneNumberId = root.nullableText("phoneNumberId"), wabaId = root.nullableText("wabaId"),
        hasVerifyToken = root.nullableText("verifyTokenMasked") != null,
        hasAppSecret = root.nullableText("appSecretMasked") != null,
        hasAccessToken = root.nullableText("accessTokenMasked") != null,
        status = IntegrationStatus.fromWire(root.nullableText("status")), lastVerifiedAt = root.nullableText("lastVerifiedAt"),
        lastError = root.nullableText("lastError"), webhookUrl = root.nullableText("webhookUrl"),
    )

    private fun template(root: Map<String, Any?>) = WhatsAppTemplate(
        id = root.long("id"), branchId = root.nullableLong("branchId"), name = root.text("name"),
        language = root.text("language"), category = TemplateCategory.fromWire(root.nullableText("category")),
        status = TemplateStatus.fromWire(root.nullableText("templateStatus")), body = root.nullableText("bodyText"),
        variableCount = root.int("variableCount"), qualityScore = root.nullableText("qualityScore"), syncedAt = root.nullableText("syncedAt"),
    )

    private fun openingProgress(root: Map<String, Any?>) = OpeningProgress(
        root.long("branchId"), root.text("branchName"), root.int("totalVariants"), root.int("openedVariants"),
    )
}

private fun <T> JSONArray.maps(mapper: (Map<String, Any?>) -> T): List<T> =
    (0 until length()).mapNotNull { opt(it).wire().stringMap()?.let(mapper) }
private fun JSONObject.wireMap(): Map<String, Any?> = keys().asSequence().associateWith { opt(it).wire() }
private fun Any?.wire(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> wireMap()
    is JSONArray -> (0 until length()).map { opt(it).wire() }
    else -> this
}
private fun Any?.stringMap(): Map<String, Any?>? = (this as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }
private fun Map<String, Any?>.map(key: String): Map<String, Any?> = this[key].stringMap() ?: emptyMap()
private fun Map<String, Any?>.nullableText(key: String): String? = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.text(key: String, default: String = "") = nullableText(key) ?: default
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val v = this[key]) { is Number -> v.toLong(); is String -> v.toLongOrNull(); else -> null }
private fun Map<String, Any?>.long(key: String) = nullableLong(key) ?: 0L
private fun Map<String, Any?>.int(key: String, default: Int = 0) = when (val v = this[key]) { is Number -> v.toInt(); is String -> v.toIntOrNull() ?: default; else -> default }
private fun Map<String, Any?>.bool(key: String, default: Boolean = false) = when (val v = this[key]) { is Boolean -> v; is Number -> v.toInt() != 0; is String -> v == "1" || v.equals("true", true); else -> default }
private fun JSONObject.nullableText(key: String): String? = takeUnless { isNull(key) }?.optString(key)?.takeIf(String::isNotBlank)
private fun JSONObject.text(key: String) = nullableText(key).orEmpty()

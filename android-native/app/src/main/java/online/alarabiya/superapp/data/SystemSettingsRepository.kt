package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.systemsettings.AdminBranch
import online.alarabiya.superapp.model.systemsettings.BranchDraft
import online.alarabiya.superapp.model.systemsettings.ChannelIntegration
import online.alarabiya.superapp.model.systemsettings.IntegrationCryptoStatus
import online.alarabiya.superapp.model.systemsettings.IntegrationMetadataDraft
import online.alarabiya.superapp.model.systemsettings.IntegrationVerifyResult
import online.alarabiya.superapp.model.systemsettings.OpeningMode
import online.alarabiya.superapp.model.systemsettings.OpeningProgress
import online.alarabiya.superapp.model.systemsettings.SafeSystemInfo
import online.alarabiya.superapp.model.systemsettings.SystemHealth
import online.alarabiya.superapp.model.systemsettings.SystemSettingsMappers
import online.alarabiya.superapp.model.systemsettings.TaxSettings
import online.alarabiya.superapp.model.systemsettings.TemplateSyncResult
import online.alarabiya.superapp.model.systemsettings.WhatsAppHubSettings
import online.alarabiya.superapp.model.systemsettings.WhatsAppTemplate
import org.json.JSONObject

interface SystemSettingsDataSource {
    suspend fun branches(): List<AdminBranch>
    suspend fun saveBranch(draft: BranchDraft)
    suspend fun setBranchActive(id: Long, active: Boolean)
    suspend fun cryptoStatus(): IntegrationCryptoStatus
    suspend fun integrations(): List<ChannelIntegration>
    suspend fun saveIntegrationMetadata(draft: IntegrationMetadataDraft)
    suspend fun verifyIntegration(id: Long): IntegrationVerifyResult
    suspend fun setIntegrationEnabled(id: Long, enabled: Boolean)
    suspend fun templates(): List<WhatsAppTemplate>
    suspend fun syncTemplates(branchId: Long): TemplateSyncResult
    suspend fun whatsAppHub(): WhatsAppHubSettings
    suspend fun updateWhatsAppHub(settings: WhatsAppHubSettings)
    suspend fun health(): SystemHealth
    suspend fun systemInfo(): SafeSystemInfo
    suspend fun taxSettings(): TaxSettings
    suspend fun updateTaxSettings(settings: TaxSettings)
    suspend fun openingMode(): OpeningMode
    suspend fun openingProgress(): List<OpeningProgress>
    suspend fun updateOpeningMode(mode: OpeningMode)
}

class SystemSettingsRepository(private val api: TrpcClient) : SystemSettingsDataSource {
    override suspend fun branches() = SystemSettingsMappers.branches(api.queryArray("branches.adminList"))

    override suspend fun saveBranch(draft: BranchDraft) {
        draft.validate()?.let { throw IllegalArgumentException(it) }
        val clean = draft.normalized()
        val input = JSONObject()
            .put("name", clean.name)
            .put("code", clean.code)
            .put("type", clean.type.name)
            .putNullable("address", clean.address)
            .putNullable("phone", clean.phone)
        if (clean.id == null) api.mutate("branches.create", input)
        else api.mutate("branches.update", input.put("id", clean.id))
    }

    override suspend fun setBranchActive(id: Long, active: Boolean) {
        require(id > 0) { "معرّف الفرع غير صالح" }
        api.mutate("branches.setActive", JSONObject().put("id", id).put("isActive", active))
    }

    override suspend fun cryptoStatus() = SystemSettingsMappers.crypto(api.query("integrations.cryptoReady"))
    override suspend fun integrations() = SystemSettingsMappers.integrations(api.queryArray("integrations.list"))

    /** Public metadata only. Secret keys are intentionally impossible to pass through this native contract. */
    override suspend fun saveIntegrationMetadata(draft: IntegrationMetadataDraft) {
        draft.validate()?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "integrations.upsert",
            JSONObject()
                .put("branchId", draft.branchId)
                .put("channel", draft.channel.name)
                .putNullable("displayName", draft.displayName)
                .putNullable("phoneNumberId", draft.phoneNumberId)
                .putNullable("wabaId", draft.wabaId),
        )
    }

    override suspend fun verifyIntegration(id: Long): IntegrationVerifyResult {
        require(id > 0) { "معرّف التكامل غير صالح" }
        return SystemSettingsMappers.verify(api.mutate("integrations.verify", JSONObject().put("integrationId", id)))
    }

    override suspend fun setIntegrationEnabled(id: Long, enabled: Boolean) {
        require(id > 0) { "معرّف التكامل غير صالح" }
        api.mutate(if (enabled) "integrations.enable" else "integrations.disable", JSONObject().put("integrationId", id))
    }

    override suspend fun templates() = SystemSettingsMappers.templates(api.queryArray("integrations.templates.list"))

    override suspend fun syncTemplates(branchId: Long): TemplateSyncResult {
        require(branchId > 0) { "حدد الفرع لمزامنة القوالب" }
        return SystemSettingsMappers.sync(api.mutate("integrations.syncTemplates", JSONObject().put("branchId", branchId)))
    }

    override suspend fun whatsAppHub() = SystemSettingsMappers.waHub(api.query("integrations.waHubSettings.get"))

    override suspend fun updateWhatsAppHub(settings: WhatsAppHubSettings) {
        settings.validate()?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "integrations.waHubSettings.update",
            JSONObject()
                .put("triageMode", settings.triageMode.name)
                .put("autoTaskEnabled", settings.autoTaskEnabled)
                .putNullable("afterHoursReply", settings.afterHoursReply)
                .putNullable("welcomeReply", settings.welcomeReply)
                .put("throttlePerMinute", settings.throttlePerMinute)
                .putNullable("optOutKeywords", settings.optOutKeywords)
                .put("campaignApprovalThreshold", settings.campaignApprovalThreshold)
                .put("autoReplyAfterHours", settings.autoReplyAfterHours)
                .put("autoReplyWelcome", settings.autoReplyWelcome)
                .put("flowArReminder", settings.flowArReminder)
                .put("flowOrderReady", settings.flowOrderReady)
                .put("flowPurchaseThanks", settings.flowPurchaseThanks)
                .put("flowConsignmentWithdraw", settings.flowConsignmentWithdraw)
                .put("csatOnResolve", settings.csatOnResolve)
                .put("killSwitch", settings.killSwitch),
        )
    }

    override suspend fun health() = SystemSettingsMappers.health(api.query("system.health"))
    override suspend fun systemInfo() = SystemSettingsMappers.safeSystemInfo(api.query("system.systemInfo"))
    override suspend fun taxSettings() = SystemSettingsMappers.tax(api.query("system.getTaxSettings"))

    override suspend fun updateTaxSettings(settings: TaxSettings) {
        settings.validate()?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "system.updateTaxSettings",
            JSONObject()
                .put("enabledByDefault", settings.enabledByDefault)
                .put("defaultTaxRatePercent", settings.defaultTaxRatePercent.trim())
                .putNullable("taxRegistrationNumber", settings.taxRegistrationNumber),
        )
    }

    override suspend fun openingMode() = SystemSettingsMappers.opening(api.query("system.getOpeningMode"))
    override suspend fun openingProgress() = SystemSettingsMappers.openingProgress(api.queryArray("system.getOpeningProgress"))

    override suspend fun updateOpeningMode(mode: OpeningMode) {
        mode.validateForUpdate()?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "system.updateOpeningMode",
            JSONObject()
                .put("enabled", mode.enabled)
                .put("endsAtYmd", mode.endsAtYmd?.trim()?.takeIf(String::isNotEmpty) ?: JSONObject.NULL)
                .put("maxNegativeQtyPerLine", mode.maxNegativeQtyPerLine),
        )
    }
}

private fun JSONObject.putNullable(key: String, value: String?): JSONObject =
    put(key, value?.trim()?.takeIf(String::isNotEmpty) ?: JSONObject.NULL)

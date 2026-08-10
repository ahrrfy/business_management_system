package online.alarabiya.superapp.feature.systemsettings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.SystemSettingsDataSource
import online.alarabiya.superapp.model.systemsettings.AdminBranch
import online.alarabiya.superapp.model.systemsettings.BackupMetadata
import online.alarabiya.superapp.model.systemsettings.BranchDraft
import online.alarabiya.superapp.model.systemsettings.ChannelIntegration
import online.alarabiya.superapp.model.systemsettings.IntegrationCryptoStatus
import online.alarabiya.superapp.model.systemsettings.IntegrationMetadataDraft
import online.alarabiya.superapp.model.systemsettings.OpeningMode
import online.alarabiya.superapp.model.systemsettings.OpeningProgress
import online.alarabiya.superapp.model.systemsettings.SafeSystemInfo
import online.alarabiya.superapp.model.systemsettings.SystemHealth
import online.alarabiya.superapp.model.systemsettings.SystemSettingsCapabilities
import online.alarabiya.superapp.model.systemsettings.TaxSettings
import online.alarabiya.superapp.model.systemsettings.TemplateSyncResult
import online.alarabiya.superapp.model.systemsettings.WhatsAppHubSettings
import online.alarabiya.superapp.model.systemsettings.WhatsAppTemplate
import online.alarabiya.superapp.model.systemsettings.KioskDevice
import online.alarabiya.superapp.model.systemsettings.KioskDeviceDraft
import online.alarabiya.superapp.model.systemsettings.OneTimeKioskToken

enum class SystemSettingsSection { Overview, Backups, Branches, KioskDevices, Integrations, WhatsApp, Governance }

internal fun SystemSettingsCapabilities.readableSections(): List<SystemSettingsSection> = buildList {
    if (canReadSystemInfo) add(SystemSettingsSection.Overview)
    if (canReadBackups) add(SystemSettingsSection.Backups)
    if (canManageBranches) add(SystemSettingsSection.Branches)
    if (canManageKioskDevices) add(SystemSettingsSection.KioskDevices)
    if (canReadIntegrations) add(SystemSettingsSection.Integrations)
    if (canReadTemplates || canReadWhatsAppHub) add(SystemSettingsSection.WhatsApp)
    if (canReadGovernance) add(SystemSettingsSection.Governance)
}

data class SystemSettingsUiState(
    val section: SystemSettingsSection = SystemSettingsSection.Overview,
    val branches: List<AdminBranch> = emptyList(),
    val integrations: List<ChannelIntegration> = emptyList(),
    val crypto: IntegrationCryptoStatus? = null,
    val templates: List<WhatsAppTemplate> = emptyList(),
    val whatsAppHub: WhatsAppHubSettings? = null,
    val health: SystemHealth? = null,
    val systemInfo: SafeSystemInfo? = null,
    val backups: List<BackupMetadata> = emptyList(),
    val backupCatalogReady: Boolean = false,
    val tax: TaxSettings? = null,
    val opening: OpeningMode? = null,
    val openingProgress: List<OpeningProgress> = emptyList(),
    val kioskDevices: List<KioskDevice> = emptyList(),
    val oneTimeKioskToken: OneTimeKioskToken? = null,
    val lastTemplateSync: TemplateSyncResult? = null,
    val loaded: Set<SystemSettingsSection> = emptySet(),
    val loading: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
)

internal object SystemSettingsReducer {
    fun initialized(state: SystemSettingsUiState, readable: List<SystemSettingsSection>): SystemSettingsUiState =
        state.copy(section = state.section.takeIf { it in readable } ?: readable.firstOrNull() ?: state.section)

    fun selected(state: SystemSettingsUiState, section: SystemSettingsSection) =
        state.copy(section = section, message = null, error = null)

    fun loading(state: SystemSettingsUiState) = state.copy(
        loading = true,
        error = null,
        message = null,
        loaded = state.loaded - state.section,
        backupCatalogReady = if (state.section == SystemSettingsSection.Backups) false else state.backupCatalogReady,
    )
    fun loaded(state: SystemSettingsUiState) = state.copy(
        loading = false,
        error = null,
        loaded = state.loaded + state.section,
        backupCatalogReady = state.backupCatalogReady || state.section == SystemSettingsSection.Backups,
    )
    fun busy(state: SystemSettingsUiState, key: String) = state.copy(busyKey = key, error = null, message = null)
    fun done(state: SystemSettingsUiState, message: String) = state.copy(busyKey = null, error = null, message = message)
    fun failed(state: SystemSettingsUiState, error: String) = state.copy(
        loading = false,
        busyKey = null,
        error = error,
        loaded = state.loaded - state.section,
        backupCatalogReady = if (state.section == SystemSettingsSection.Backups) false else state.backupCatalogReady,
    )
    fun committed(state: SystemSettingsUiState, message: String) = state.copy(
        loading = true,
        busyKey = null,
        error = null,
        message = message,
        loaded = state.loaded - state.section,
        backupCatalogReady = if (state.section == SystemSettingsSection.Backups) false else state.backupCatalogReady,
    )
    fun refreshAfterCommitFailed(state: SystemSettingsUiState, error: String) = failed(
        state,
        "تم تنفيذ الإجراء، لكن تعذر تحديث البيانات: $error",
    )
    fun acknowledgedKioskToken(state: SystemSettingsUiState) = state.copy(oneTimeKioskToken = null, message = null)
}

internal fun canMutateLoadedSystemSection(state: SystemSettingsUiState): Boolean =
    state.section in state.loaded && !state.loading && state.busyKey == null

internal fun requiresSystemSectionLoadGate(state: SystemSettingsUiState): Boolean =
    state.section !in state.loaded

internal fun canCreateOperationalBackup(state: SystemSettingsUiState, capabilities: SystemSettingsCapabilities): Boolean =
    capabilities.canCreateBackup &&
        state.section == SystemSettingsSection.Backups &&
        state.backupCatalogReady &&
        canMutateLoadedSystemSection(state)

class SystemSettingsViewModel(private val source: SystemSettingsDataSource) : ViewModel() {
    var state by mutableStateOf(SystemSettingsUiState())
        private set

    fun initialize(capabilities: SystemSettingsCapabilities) {
        state = SystemSettingsReducer.initialized(state, capabilities.readableSections())
        if (state.section !in state.loaded) refresh(capabilities)
    }

    fun select(section: SystemSettingsSection, capabilities: SystemSettingsCapabilities) {
        if (section !in capabilities.readableSections() || state.loading || state.busyKey != null) return
        state = SystemSettingsReducer.selected(state, section)
        if (section !in state.loaded) refresh(capabilities)
    }

    fun refresh(capabilities: SystemSettingsCapabilities) {
        if (state.loading || state.busyKey != null) return
        state = SystemSettingsReducer.loading(state)
        viewModelScope.launch {
            runCatching { loadSection(capabilities) }
                .onSuccess { state = SystemSettingsReducer.loaded(state) }
                .onFailure { state = SystemSettingsReducer.failed(state, it.userMessage()) }
        }
    }

    fun saveBranch(draft: BranchDraft, capabilities: SystemSettingsCapabilities) = mutate("branch:save", "تم حفظ الفرع", capabilities) {
        require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
        source.saveBranch(draft)
        val clean = draft.normalized()
        if (clean.id != null) state = state.copy(branches = state.branches.map { branch ->
            if (branch.id == clean.id) branch.copy(
                name = clean.name,
                code = clean.code,
                type = clean.type,
                address = clean.address.ifBlank { null },
                phone = clean.phone.ifBlank { null },
            ) else branch
        })
    }

    fun setBranchActive(branch: AdminBranch, active: Boolean, capabilities: SystemSettingsCapabilities) =
        mutate("branch:active:${branch.id}", if (active) "تم تفعيل الفرع" else "تم تعطيل الفرع", capabilities) {
            require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
            source.setBranchActive(branch.id, active)
            state = state.copy(branches = state.branches.map { if (it.id == branch.id) it.copy(active = active) else it })
        }

    fun saveIntegration(draft: IntegrationMetadataDraft, capabilities: SystemSettingsCapabilities) =
        mutate("integration:save", "تم حفظ البيانات العامة دون المساس بالأسرار", capabilities) {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية إدارة التكاملات" }
            require(state.crypto?.ready == true) { "خزنة التشفير غير جاهزة؛ أوقف التعديل وتواصل مع التشغيل" }
            source.saveIntegrationMetadata(draft)
            state = state.copy(integrations = state.integrations.map { integration ->
                if (integration.branchId == draft.branchId && integration.channel == draft.channel) integration.copy(
                    displayName = draft.displayName.trim().ifBlank { null },
                    phoneNumberId = draft.phoneNumberId.trim().ifBlank { null },
                    wabaId = draft.wabaId.trim().ifBlank { null },
                ) else integration
            })
        }

    fun verifyIntegration(integration: ChannelIntegration, capabilities: SystemSettingsCapabilities) =
        mutate("integration:verify:${integration.id}", "اكتمل اختبار الاتصال", capabilities) {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية اختبار التكامل" }
            val result = source.verifyIntegration(integration.id)
            require(result.ok) { result.message }
            state = state.copy(message = result.message)
        }

    fun setIntegrationEnabled(integration: ChannelIntegration, enabled: Boolean, capabilities: SystemSettingsCapabilities) =
        mutate("integration:enabled:${integration.id}", if (enabled) "تم تفعيل التكامل" else "تم تعطيل التكامل", capabilities) {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية إدارة التكاملات" }
            source.setIntegrationEnabled(integration.id, enabled)
            state = state.copy(integrations = state.integrations.map {
                if (it.id == integration.id) it.copy(status = if (enabled) online.alarabiya.superapp.model.systemsettings.IntegrationStatus.ACTIVE else online.alarabiya.superapp.model.systemsettings.IntegrationStatus.DISABLED) else it
            })
        }

    fun syncTemplates(branchId: Long, capabilities: SystemSettingsCapabilities) =
        mutate("templates:sync", "اكتملت مزامنة القوالب", capabilities) {
            require(capabilities.canSyncTemplates) { "لا تملك صلاحية مزامنة القوالب" }
            val result = source.syncTemplates(branchId)
            state = state.copy(lastTemplateSync = result)
        }

    fun updateWhatsAppHub(settings: WhatsAppHubSettings, capabilities: SystemSettingsCapabilities) =
        mutate("whatsapp:update", "تم تحديث ضوابط مركز WhatsApp", capabilities) {
            require(capabilities.canUpdateWhatsAppHub) { "لا تملك صلاحية تعديل مركز WhatsApp" }
            source.updateWhatsAppHub(settings)
            state = state.copy(whatsAppHub = settings)
        }

    fun updateTax(settings: TaxSettings, capabilities: SystemSettingsCapabilities) =
        mutate("governance:tax", "تم تحديث إعدادات الضريبة", capabilities) {
            require(capabilities.canUpdateGovernance) { "لا تملك صلاحية تعديل الحوكمة" }
            source.updateTaxSettings(settings)
            state = state.copy(tax = settings)
        }

    fun updateOpening(mode: OpeningMode, capabilities: SystemSettingsCapabilities) =
        mutate("governance:opening", "تم تحديث فترة الافتتاح", capabilities) {
            require(capabilities.canUpdateGovernance) { "لا تملك صلاحية تعديل الحوكمة" }
            source.updateOpeningMode(mode)
            state = state.copy(opening = mode)
        }

    fun createBackup(capabilities: SystemSettingsCapabilities) {
        if (!capabilities.canCreateBackup) {
            state = state.copy(error = "لا تملك صلاحية إنشاء نسخة احتياطية")
            return
        }
        mutate("backup:create", "تم إنشاء النسخة الاحتياطية", capabilities) {
            val created = source.backupNow()
            state = state.copy(backups = listOf(created) + state.backups.filterNot { it.name == created.name })
        }
    }

    fun createKioskDevice(draft: KioskDeviceDraft, capabilities: SystemSettingsCapabilities) =
        mutate("kiosk:create", "تم إنشاء الجهاز؛ احفظ رمز التسجيل الآن", capabilities) {
            require(capabilities.canManageKioskDevices) { "لا تملك صلاحية إدارة أجهزة قارئ الأسعار" }
            val secret = source.createKioskDevice(draft)
            val branch = state.branches.firstOrNull { it.id == draft.branchId }
            val device = KioskDevice(secret.deviceId, draft.branchId, branch?.name, draft.label.trim(), secret.tokenPrefix, true, null, null, null)
            state = state.copy(kioskDevices = listOf(device) + state.kioskDevices.filterNot { it.id == device.id }, oneTimeKioskToken = secret)
        }

    fun rotateKioskDevice(device: KioskDevice, capabilities: SystemSettingsCapabilities) =
        mutate("kiosk:rotate:${device.id}", "تم تدوير الرمز وإبطال الرمز السابق", capabilities) {
            require(capabilities.canManageKioskDevices) { "لا تملك صلاحية إدارة أجهزة قارئ الأسعار" }
            val secret = source.rotateKioskDevice(device.id)
            state = state.copy(kioskDevices = state.kioskDevices.map { if (it.id == device.id) it.copy(tokenPrefix = secret.tokenPrefix) else it }, oneTimeKioskToken = secret)
        }

    fun setKioskDeviceActive(device: KioskDevice, active: Boolean, capabilities: SystemSettingsCapabilities) =
        mutate("kiosk:active:${device.id}", if (active) "تم تفعيل الجهاز" else "تم إلغاء الجهاز وإبطال رمزه", capabilities) {
            require(capabilities.canManageKioskDevices) { "لا تملك صلاحية إدارة أجهزة قارئ الأسعار" }
            source.setKioskDeviceActive(device.id, active)
            state = state.copy(kioskDevices = state.kioskDevices.map { if (it.id == device.id) it.copy(active = active) else it })
        }

    fun removeKioskDevice(device: KioskDevice, capabilities: SystemSettingsCapabilities) =
        mutate("kiosk:remove:${device.id}", "تم حذف الجهاز", capabilities) {
            require(capabilities.canManageKioskDevices) { "لا تملك صلاحية إدارة أجهزة قارئ الأسعار" }
            source.removeKioskDevice(device.id)
            state = state.copy(kioskDevices = state.kioskDevices.filterNot { it.id == device.id })
        }

    /** Acknowledgement is the only exit: the raw token is immediately discarded from UI state. */
    fun acknowledgeKioskToken() {
        state = SystemSettingsReducer.acknowledgedKioskToken(state)
    }

    private suspend fun loadSection(capabilities: SystemSettingsCapabilities) {
        when (state.section) {
            SystemSettingsSection.Overview -> {
                require(capabilities.canReadSystemInfo) { "هذه الحالة متاحة للمدير العام فقط" }
                state = state.copy(health = source.health(), systemInfo = source.systemInfo())
            }
            SystemSettingsSection.Backups -> {
                require(capabilities.canReadBackups) { "لا تملك صلاحية عرض النسخ الاحتياطية" }
                state = state.copy(backups = source.backups())
            }
            SystemSettingsSection.Branches -> {
                require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
                state = state.copy(branches = source.branches())
            }
            SystemSettingsSection.KioskDevices -> {
                require(capabilities.canManageKioskDevices) { "لا تملك صلاحية إدارة أجهزة قارئ الأسعار" }
                state = state.copy(kioskDevices = source.kioskDevices(), branches = source.branches())
            }
            SystemSettingsSection.Integrations -> {
                require(capabilities.canReadIntegrations) { "لا تملك صلاحية عرض التكاملات" }
                state = state.copy(crypto = source.cryptoStatus(), integrations = source.integrations(), branches = source.branches())
            }
            SystemSettingsSection.WhatsApp -> {
                val templates = if (capabilities.canReadTemplates) source.templates() else emptyList()
                val hub = if (capabilities.canReadWhatsAppHub) source.whatsAppHub() else null
                val branches = if (capabilities.canSyncTemplates && state.branches.isEmpty()) source.branches() else state.branches
                state = state.copy(templates = templates, whatsAppHub = hub, branches = branches)
            }
            SystemSettingsSection.Governance -> {
                require(capabilities.canReadGovernance) { "لا تملك صلاحية عرض الحوكمة" }
                state = state.copy(
                    tax = source.taxSettings(), opening = source.openingMode(), openingProgress = source.openingProgress(),
                )
            }
        }
    }

    private fun mutate(
        key: String,
        success: String,
        capabilities: SystemSettingsCapabilities,
        operation: suspend () -> Unit,
    ) {
        if (!canMutateLoadedSystemSection(state)) {
            state = state.copy(error = "البيانات غير محدثة. أعد المحاولة لتحميل القسم قبل تنفيذ أي إجراء.", message = null)
            return
        }
        state = SystemSettingsReducer.busy(state, key)
        viewModelScope.launch {
            val mutation = runCatching { operation() }
            if (mutation.isFailure) {
                state = SystemSettingsReducer.failed(state, requireNotNull(mutation.exceptionOrNull()).userMessage())
                return@launch
            }

            state = SystemSettingsReducer.committed(state, state.message ?: success)
            val reload = runCatching { loadSection(capabilities) }
            state = if (reload.isSuccess) {
                SystemSettingsReducer.loaded(state)
            } else {
                SystemSettingsReducer.refreshAfterCommitFailed(state, requireNotNull(reload.exceptionOrNull()).userMessage())
            }
        }
    }

    companion object {
        fun factory(source: SystemSettingsDataSource): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = SystemSettingsViewModel(source) as T
        }
    }
}

private fun Throwable.userMessage(): String = message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

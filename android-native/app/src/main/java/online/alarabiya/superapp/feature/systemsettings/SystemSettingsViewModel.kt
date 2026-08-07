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

enum class SystemSettingsSection { Overview, Branches, Integrations, WhatsApp, Governance }

internal fun SystemSettingsCapabilities.readableSections(): List<SystemSettingsSection> = buildList {
    if (canReadSystemInfo) add(SystemSettingsSection.Overview)
    if (canManageBranches) add(SystemSettingsSection.Branches)
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
    val tax: TaxSettings? = null,
    val opening: OpeningMode? = null,
    val openingProgress: List<OpeningProgress> = emptyList(),
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

    fun loading(state: SystemSettingsUiState) = state.copy(loading = true, error = null, message = null)
    fun loaded(state: SystemSettingsUiState) = state.copy(loading = false, error = null, loaded = state.loaded + state.section)
    fun busy(state: SystemSettingsUiState, key: String) = state.copy(busyKey = key, error = null, message = null)
    fun done(state: SystemSettingsUiState, message: String) = state.copy(busyKey = null, error = null, message = message)
    fun failed(state: SystemSettingsUiState, error: String) = state.copy(loading = false, busyKey = null, error = error)
}

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

    fun saveBranch(draft: BranchDraft, capabilities: SystemSettingsCapabilities) = mutate("branch:save", "تم حفظ الفرع") {
        require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
        source.saveBranch(draft)
        state = state.copy(branches = source.branches())
    }

    fun setBranchActive(branch: AdminBranch, active: Boolean, capabilities: SystemSettingsCapabilities) =
        mutate("branch:active:${branch.id}", if (active) "تم تفعيل الفرع" else "تم تعطيل الفرع") {
            require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
            source.setBranchActive(branch.id, active)
            state = state.copy(branches = source.branches())
        }

    fun saveIntegration(draft: IntegrationMetadataDraft, capabilities: SystemSettingsCapabilities) =
        mutate("integration:save", "تم حفظ البيانات العامة دون المساس بالأسرار") {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية إدارة التكاملات" }
            require(state.crypto?.ready == true) { "خزنة التشفير غير جاهزة؛ أوقف التعديل وتواصل مع التشغيل" }
            source.saveIntegrationMetadata(draft)
            state = state.copy(integrations = source.integrations())
        }

    fun verifyIntegration(integration: ChannelIntegration, capabilities: SystemSettingsCapabilities) =
        mutate("integration:verify:${integration.id}", "اكتمل اختبار الاتصال") {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية اختبار التكامل" }
            val result = source.verifyIntegration(integration.id)
            require(result.ok) { result.message }
            state = state.copy(integrations = source.integrations(), message = result.message)
        }

    fun setIntegrationEnabled(integration: ChannelIntegration, enabled: Boolean, capabilities: SystemSettingsCapabilities) =
        mutate("integration:enabled:${integration.id}", if (enabled) "تم تفعيل التكامل" else "تم تعطيل التكامل") {
            require(capabilities.canManageIntegrations) { "لا تملك صلاحية إدارة التكاملات" }
            source.setIntegrationEnabled(integration.id, enabled)
            state = state.copy(integrations = source.integrations())
        }

    fun syncTemplates(branchId: Long, capabilities: SystemSettingsCapabilities) =
        mutate("templates:sync", "اكتملت مزامنة القوالب") {
            require(capabilities.canSyncTemplates) { "لا تملك صلاحية مزامنة القوالب" }
            val result = source.syncTemplates(branchId)
            state = state.copy(lastTemplateSync = result, templates = source.templates())
        }

    fun updateWhatsAppHub(settings: WhatsAppHubSettings, capabilities: SystemSettingsCapabilities) =
        mutate("whatsapp:update", "تم تحديث ضوابط مركز WhatsApp") {
            require(capabilities.canUpdateWhatsAppHub) { "لا تملك صلاحية تعديل مركز WhatsApp" }
            source.updateWhatsAppHub(settings)
            state = state.copy(whatsAppHub = source.whatsAppHub())
        }

    fun updateTax(settings: TaxSettings, capabilities: SystemSettingsCapabilities) =
        mutate("governance:tax", "تم تحديث إعدادات الضريبة") {
            require(capabilities.canUpdateGovernance) { "لا تملك صلاحية تعديل الحوكمة" }
            source.updateTaxSettings(settings)
            state = state.copy(tax = source.taxSettings())
        }

    fun updateOpening(mode: OpeningMode, capabilities: SystemSettingsCapabilities) =
        mutate("governance:opening", "تم تحديث فترة الافتتاح") {
            require(capabilities.canUpdateGovernance) { "لا تملك صلاحية تعديل الحوكمة" }
            source.updateOpeningMode(mode)
            state = state.copy(opening = source.openingMode(), openingProgress = source.openingProgress())
        }

    private suspend fun loadSection(capabilities: SystemSettingsCapabilities) {
        when (state.section) {
            SystemSettingsSection.Overview -> {
                require(capabilities.canReadSystemInfo) { "هذه الحالة متاحة للمدير العام فقط" }
                state = state.copy(health = source.health(), systemInfo = source.systemInfo())
            }
            SystemSettingsSection.Branches -> {
                require(capabilities.canManageBranches) { "لا تملك صلاحية إدارة الفروع" }
                state = state.copy(branches = source.branches())
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

    private fun mutate(key: String, success: String, operation: suspend () -> Unit) {
        if (state.loading || state.busyKey != null) return
        state = SystemSettingsReducer.busy(state, key)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = SystemSettingsReducer.done(state, state.message ?: success) }
                .onFailure { state = SystemSettingsReducer.failed(state, it.userMessage()) }
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

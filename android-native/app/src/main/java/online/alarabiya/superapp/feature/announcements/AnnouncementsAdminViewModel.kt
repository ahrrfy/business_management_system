package online.alarabiya.superapp.feature.announcements

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.AnnouncementsDataSource
import online.alarabiya.superapp.model.announcements.AnnouncementAudienceType
import online.alarabiya.superapp.model.announcements.AnnouncementsCapabilities
import online.alarabiya.superapp.model.announcements.CreateAnnouncementCommand

class AnnouncementsAdminViewModel(
    private val source: AnnouncementsDataSource,
    val capabilities: AnnouncementsCapabilities,
) : ViewModel() {
    var state by mutableStateOf(AnnouncementsAdminUiState())
        private set

    fun refresh() {
        if (state.loading) return
        state = state.copy(loading = state.items.isEmpty(), error = null)
        viewModelScope.launch {
            runCatching { source.manageList(state.includeInactive) }
                .onSuccess { state = AnnouncementsAdminReducer.loaded(state, it) }
                .onFailure { state = AnnouncementsAdminReducer.failed(state, it.userMessage()) }
        }
    }

    fun select(id: Long?) {
        state = AnnouncementsAdminReducer.select(state, id)
        if (id == null) return
        viewModelScope.launch {
            runCatching { source.manageDetail(id) }
                .onSuccess { detail -> state = AnnouncementsAdminReducer.detailLoaded(state, detail) }
                .onFailure { error -> if (state.selectedId == id) state = state.copy(error = error.userMessage()) }
        }
    }

    fun setIncludeInactive(value: Boolean) {
        if (value == state.includeInactive) return
        state = state.copy(includeInactive = value)
        refresh()
    }

    fun openEditor() {
        if (!capabilities.canManage) return
        state = AnnouncementsAdminReducer.openEditor(state)
    }

    fun closeEditor() {
        state = AnnouncementsAdminReducer.closeEditor(state)
    }

    fun create(command: CreateAnnouncementCommand) {
        if (!capabilities.canManage) return
        val started = AnnouncementsAdminReducer.operationStarted(state, "create") ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.create(command) }
                .onSuccess {
                    state = AnnouncementsAdminReducer.closeEditor(
                        AnnouncementsAdminReducer.operationDone(state, "أُنشئ الإعلان وأُرسل لـ${command.audienceLabel()}"),
                    )
                    refresh()
                }
                .onFailure { state = AnnouncementsAdminReducer.operationFailed(state, it.userMessage()) }
        }
    }

    fun toggleActive(id: Long, isActive: Boolean) {
        if (!capabilities.canManage) return
        val started = AnnouncementsAdminReducer.operationStarted(state, "active-$id") ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.setActive(id, isActive) }
                .onSuccess {
                    state = AnnouncementsAdminReducer.operationDone(state, if (isActive) "فُعّل الإعلان" else "عُطّل الإعلان")
                    refresh()
                    if (state.selectedId == id) reloadDetail(id)
                }
                .onFailure { state = AnnouncementsAdminReducer.operationFailed(state, it.userMessage()) }
        }
    }

    private fun reloadDetail(id: Long) {
        viewModelScope.launch {
            runCatching { source.manageDetail(id) }
                .onSuccess { detail -> state = AnnouncementsAdminReducer.detailLoaded(state, detail) }
                .onFailure { /* الفشل هنا لا يمسّ حالة القائمة — التفصيل ثانويّ. */ }
        }
    }
}

private fun CreateAnnouncementCommand.audienceLabel(): String = when (audienceType) {
    AnnouncementAudienceType.ALL -> "كل الموظفين"
    AnnouncementAudienceType.BRANCH -> "فرع #${audienceBranchId ?: "؟"}"
    AnnouncementAudienceType.ROLE -> audienceRole ?: "دور محدَّد"
}

private fun Throwable.userMessage(): String =
    message?.takeIf { it.isNotBlank() } ?: "تعذّر إكمال العملية"

class AnnouncementsAdminViewModelFactory(
    private val source: AnnouncementsDataSource,
    private val capabilities: AnnouncementsCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AnnouncementsAdminViewModel(source, capabilities) as T
}

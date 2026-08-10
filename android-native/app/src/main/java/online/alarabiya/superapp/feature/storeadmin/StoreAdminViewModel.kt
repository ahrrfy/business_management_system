package online.alarabiya.superapp.feature.storeadmin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.StoreAdminDataSource
import online.alarabiya.superapp.model.storeadmin.StoreAdminCapabilities
import online.alarabiya.superapp.model.storeadmin.StoreAdminSection
import online.alarabiya.superapp.model.storeadmin.StoreBannerDraft
import online.alarabiya.superapp.model.storeadmin.StoreSettingsDraft

class StoreAdminViewModel(private val source: StoreAdminDataSource, private val capabilities: StoreAdminCapabilities) : ViewModel() {
    var state by mutableStateOf(StoreAdminState())
        private set
    fun initialize() {
        if (!capabilities.canRead || state.loading) return
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { coroutineScope { async { source.settings() } to async { source.banners() } }.let { it.first.await() to it.second.await() } }
                .onSuccess {
                    val recoveredFromMutation = state.staleAfterMutation
                    state = state.copy(
                        loading = false,
                        initialized = true,
                        staleAfterMutation = false,
                        error = null,
                        notice = if (recoveredFromMutation) "تم تحديث العرض" else state.notice,
                        settings = it.first,
                        banners = it.second,
                    )
                }
                .onFailure { fail(it) }
        }
    }
    fun section(value: StoreAdminSection) { state = state.copy(section = value, error = null) }
    fun settings(value: StoreSettingsDraft) {
        if (state.canMutate(capabilities.canManage)) state = state.copy(settings = value)
    }
    fun saveSettings() = mutateAndReconcile("تم حفظ إعدادات المتجر") { snapshot ->
        snapshot.commitSettings(source.saveSettings(snapshot.settings))
    }
    fun newBanner() { if (state.canMutate(capabilities.canManage)) state = state.copy(editor = StoreBannerDraft()) }
    fun editBanner(value: StoreBannerDraft) { if (state.canMutate(capabilities.canManage)) state = state.copy(editor = value) }
    fun editor(value: StoreBannerDraft) {
        if (state.canMutate(capabilities.canManage)) state = state.copy(editor = value)
    }
    fun closeEditor() { if (!state.loading) state = state.copy(editor = null) }
    fun saveBanner() = mutateAndReconcile("تم حفظ البنر") { snapshot ->
        val value = requireNotNull(snapshot.editor) { "لا يوجد بنر قيد التحرير" }
        if (value.id == null) {
            val id = source.createBanner(value)
            require(id > 0) { "لم يُرجع الخادم معرّف البنر الجديد" }
            snapshot.commitBanner(value, id)
        } else {
            source.updateBanner(value)
            snapshot.commitBanner(value)
        }
    }
    fun askDelete(value: StoreBannerDraft) {
        if (state.canMutate(capabilities.canManage)) state = state.copy(pendingDelete = value)
    }
    fun cancelDelete() { if (!state.loading) state = state.copy(pendingDelete = null) }
    fun confirmDelete() = mutateAndReconcile("تم حذف البنر") { snapshot ->
        val id = requireNotNull(snapshot.pendingDelete?.id) { "لا يوجد بنر محدد للحذف" }
        source.removeBanner(id)
        snapshot.commitBannerDeleted(id)
    }
    private fun mutateAndReconcile(
        success: String,
        mutation: suspend (StoreAdminState) -> StoreAdminState,
    ) {
        if (!state.canMutate(capabilities.canManage)) return
        val snapshot = state
        state = state.copy(loading = true, error = null, notice = null)
        viewModelScope.launch {
            runCatching { mutation(snapshot) }
                .onSuccess { committed ->
                    state = committed.copy(loading = true, error = null, notice = success)
                    reconcileAfterMutation(success)
                }
                .onFailure { fail(it) }
        }
    }
    private suspend fun reconcileAfterMutation(success: String) {
        runCatching {
            coroutineScope {
                val settings = async { source.settings() }
                val banners = async { source.banners() }
                settings.await() to banners.await()
            }
        }.onSuccess { (settings, banners) ->
            state = state.copy(
                loading = false,
                initialized = true,
                staleAfterMutation = false,
                settings = settings,
                banners = banners,
                error = null,
                notice = success,
            )
        }.onFailure { error ->
            state = state.copy(
                loading = false,
                initialized = false,
                staleAfterMutation = true,
                error = error.message ?: "تعذر تحديث العرض",
                notice = STORE_ADMIN_REFRESH_REQUIRED,
            )
        }
    }
    private fun fail(error: Throwable) { state = state.copy(loading = false, error = error.message ?: "تعذر إكمال العملية") }
}

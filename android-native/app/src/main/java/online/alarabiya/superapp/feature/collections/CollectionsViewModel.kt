package online.alarabiya.superapp.feature.collections

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.CollectionsDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.collections.CancelCreditDecisionCommand
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.collections.CreditDecisionStatus

class CollectionsViewModel(
    private val source: CollectionsDataSource,
    val capabilities: CollectionsCapabilities,
) : ViewModel() {
    var state by mutableStateOf(CollectionsUiState())
        private set

    fun initialize() {
        if (!state.initialized && !state.locked) load(CollectionsBusy.INITIAL)
    }

    fun status(value: CreditDecisionStatus) {
        if (state.locked || state.status == value) return
        state = state.copy(status = value, rows = emptyList(), total = 0, hasMore = false, selectedId = null, cancelReason = "")
        load()
    }

    fun customerIdFilter(value: String) {
        state = state.copy(customerIdFilter = value.filter(Char::isDigit).take(18), error = null)
    }

    fun applyFilter() {
        val parsed = state.customerIdFilter.toLongOrNull()
        if (state.customerIdFilter.isNotBlank() && (parsed == null || parsed <= 0)) return fail("معرّف العميل غير صالح")
        state = state.copy(appliedCustomerId = parsed, selectedId = null, rows = emptyList())
        load()
    }

    fun clearFilter() {
        if (state.locked) return
        state = state.copy(customerIdFilter = "", appliedCustomerId = null, selectedId = null, rows = emptyList())
        load()
    }

    fun refresh() = load()

    fun loadMore() {
        if (state.hasMore) load(CollectionsBusy.LOAD_MORE, append = true)
    }

    fun select(id: Long?) {
        if (state.locked) return
        state = state.copy(
            selectedId = id?.takeIf { candidate -> state.rows.any { it.id == candidate } },
            cancelReason = "",
            error = null,
            notice = null,
        )
    }

    fun cancelReason(value: String) {
        state = state.copy(cancelReason = value.take(255), error = null)
    }

    fun cancelDecision() {
        val selected = state.selected ?: return fail("اختر قرار ائتمان")
        if (selected.status != CreditDecisionStatus.ACTIVE) return fail("القرار غير نشط")
        if (!capabilities.canCancelActiveDecision) return fail("لا توجد صلاحية إلغاء")
        val reason = state.cancelReason
        launch(CollectionsBusy.CANCEL) {
            source.cancelCreditDecision(CancelCreditDecisionCommand(selected.id, reason))
            val page = source.creditDecisions(state.status, state.appliedCustomerId, 0, PAGE_SIZE)
            state = state.copy(
                initialized = true,
                rows = page.rows,
                total = page.total,
                hasMore = page.hasMore,
                selectedId = null,
                cancelReason = "",
                notice = "أُلغي قرار الائتمان #${selected.id} وحُفظ السبب في سجل التدقيق",
            )
        }
    }

    fun clearMessage() { state = state.copy(error = null, notice = null) }

    private fun load(operation: CollectionsBusy = CollectionsBusy.LIST, append: Boolean = false) {
        if (!capabilities.canReadCreditDecisions) return fail("سجل قرارات الائتمان محصور بالمدير")
        launch(operation) {
            val offset = if (append) state.rows.size else 0
            val page = source.creditDecisions(state.status, state.appliedCustomerId, offset, PAGE_SIZE)
            val rows = if (append) (state.rows + page.rows).distinctBy { it.id } else page.rows
            state = state.copy(
                initialized = true,
                rows = rows,
                total = page.total,
                hasMore = offset + page.rows.size < page.total,
                selectedId = state.selectedId?.takeIf { id -> rows.any { it.id == id } },
            )
        }
    }

    private fun launch(operation: CollectionsBusy, block: suspend () -> Unit) {
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { if (state.busy == operation) state = state.copy(busy = null, initialized = true) }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    private fun fail(message: String) { state = state.failed(message) }
    private fun message(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    companion object { private const val PAGE_SIZE = 50 }
}

class CollectionsViewModelFactory(
    private val source: CollectionsDataSource,
    bootstrap: AppBootstrap,
) : ViewModelProvider.Factory {
    private val capabilities = CollectionsCapabilities.fromBootstrap(bootstrap)

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CollectionsViewModel(source, capabilities) as T
}

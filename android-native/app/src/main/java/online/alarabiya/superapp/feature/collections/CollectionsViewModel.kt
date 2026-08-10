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
import online.alarabiya.superapp.model.collections.CreateCreditDecisionDraft
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.collections.CollectionsValidation
import online.alarabiya.superapp.model.collections.CreditCustomerOption
import online.alarabiya.superapp.model.collections.CreditDecisionStatus
import java.util.UUID

class CollectionsViewModel(
    private val source: CollectionsDataSource,
    val capabilities: CollectionsCapabilities,
) : ViewModel() {
    var state by mutableStateOf(CollectionsUiState())
        private set

    fun initialize() {
        if (state.initialized || state.locked) return
        launch(CollectionsBusy.INITIAL) {
            val branches = source.branches()
            val initialBranch = capabilities.branchId ?: branches.firstOrNull()?.id
            state = state.branchesLoaded(branches).copy(createDraft = freshDraft(initialBranch))
            val page = source.creditDecisions(state.status, state.appliedCustomerId, 0, PAGE_SIZE)
            state = state.loaded(page.rows, page.total, page.hasMore, append = false)
        }
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
        if (!state.initialized || !state.catalogFresh) return fail("حدّث القائمة بنجاح قبل الإلغاء")
        val reason = state.cancelReason
        val started = state.start(CollectionsBusy.CANCEL) ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.cancelCreditDecision(CancelCreditDecisionCommand(selected.id, reason)) }
                .onFailure { state = state.failed(message(it)) }
                .onSuccess {
                    state = state.cancellationCommitted(selected.id)
                    state = state.copy(busy = CollectionsBusy.LIST)
                    runCatching { source.creditDecisions(state.status, state.appliedCustomerId, 0, PAGE_SIZE) }
                        .onSuccess { page -> state = state.loaded(page.rows, page.total, page.hasMore, append = false) }
                        .onFailure { state = state.refreshFailedAfterMutation(message(it)) }
                }
        }
    }

    fun openCreate() {
        if (state.locked || !capabilities.canCreateCreditDecision) return
        if (!state.catalogFresh || !state.branchesFresh) return fail("حدّث بيانات القرارات والفروع قبل الإصدار")
        val branchId = capabilities.branchId ?: state.createDraft.branchId ?: state.branches.firstOrNull()?.id
        if (branchId == null) return fail("لا يوجد فرع نشط لإصدار القرار")
        state = state.copy(
            createOpen = true,
            createDraft = freshDraft(branchId),
            customerQuery = "",
            customerOptions = emptyList(),
            customerOptionsFresh = false,
            error = null,
            notice = null,
        )
        searchCustomers()
    }

    fun closeCreate() {
        if (state.locked) return
        state = state.copy(createOpen = false, customerOptions = emptyList(), customerOptionsFresh = false, error = null)
    }

    fun createBranch(id: Long) {
        if (state.locked || !capabilities.canSelectBranch || state.branches.none { it.id == id }) return
        state = state.copy(
            createDraft = state.createDraft.copy(branchId = id, customerId = null, customerName = ""),
            customerOptions = emptyList(),
            customerOptionsFresh = false,
            error = null,
        )
        searchCustomers()
    }

    fun customerQuery(value: String) {
        state = state.copy(customerQuery = value.take(120), customerOptionsFresh = false, error = null)
    }

    fun searchCustomers() {
        val branchId = state.createDraft.branchId ?: return fail("اختر الفرع")
        val started = state.start(CollectionsBusy.CUSTOMERS) ?: return
        state = started.copy(customerOptionsFresh = false)
        viewModelScope.launch {
            runCatching { source.customerOptions(branchId, state.customerQuery) }
                .onSuccess { rows -> state = state.customerOptionsLoaded(rows) }
                .onFailure {
                    state = state.copy(
                        busy = null,
                        customerOptions = emptyList(),
                        customerOptionsFresh = false,
                        error = message(it),
                    )
                }
        }
    }

    fun selectCustomer(customer: CreditCustomerOption) {
        if (state.locked || state.customerOptions.none { it.id == customer.id }) return
        state = state.copy(
            createDraft = state.createDraft.copy(customerId = customer.id, customerName = customer.name),
            error = null,
        )
    }

    fun createAmount(value: String) {
        state = state.copy(createDraft = state.createDraft.copy(maxAmount = value.filter { it.isDigit() || it == '.' }.take(18)), error = null)
    }

    fun createTtl(value: String) {
        state = state.copy(createDraft = state.createDraft.copy(ttlMinutes = value.filter(Char::isDigit).take(4)), error = null)
    }

    fun createNotes(value: String) {
        state = state.copy(createDraft = state.createDraft.copy(notes = value.take(255)), error = null)
    }

    fun createDecision() {
        if (state.locked) return
        if (!state.customerOptionsFresh) return fail("حدّث قائمة العملاء واختر العميل منها")
        if (state.customerOptions.none { it.id == state.createDraft.customerId }) return fail("اختر عميلاً من نتائج الفرع")
        val command = CollectionsValidation.command(state.createDraft, capabilities)
            ?: return fail(CollectionsValidation.create(state.createDraft, capabilities) ?: "بيانات القرار غير مكتملة")
        val started = state.start(CollectionsBusy.CREATE) ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.createCreditDecision(command) }
                .onFailure {
                    // قد تكون الاستجابة ضاعت بعد الالتزام؛ نبقي UUID نفسه ليعيد الخادم النتيجة بلا تكرار.
                    state = state.copy(
                        busy = null,
                        catalogFresh = false,
                        error = message(it),
                        notice = "تعذر تأكيد النتيجة؛ أعد الإرسال بنفس الطلب أو حدّث السجل",
                    )
                }
                .onSuccess { decision ->
                    state = state.creationCommitted(decision, freshDraft(command.branchId))
                    state = state.copy(busy = CollectionsBusy.LIST)
                    runCatching { source.creditDecisions(state.status, state.appliedCustomerId, 0, PAGE_SIZE) }
                        .onSuccess { page -> state = state.loaded(page.rows, page.total, page.hasMore, append = false) }
                        .onFailure { state = state.refreshFailedAfterMutation(message(it)) }
                }
        }
    }

    fun clearMessage() { state = state.copy(error = null, notice = null) }

    private fun load(operation: CollectionsBusy = CollectionsBusy.LIST, append: Boolean = false) {
        if (!capabilities.canReadCreditDecisions) return fail("سجل قرارات الائتمان محصور بالمدير")
        launch(operation) {
            val offset = if (append) state.rows.size else 0
            val page = source.creditDecisions(state.status, state.appliedCustomerId, offset, PAGE_SIZE)
            state = state.loaded(page.rows, page.total, offset + page.rows.size < page.total, append)
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

    private fun freshDraft(branchId: Long?) = CreateCreditDecisionDraft(
        branchId = branchId,
        clientRequestId = UUID.randomUUID().toString(),
    )

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

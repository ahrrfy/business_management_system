package online.alarabiya.superapp.feature.shifts

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.ShiftDataSource
import online.alarabiya.superapp.model.shifts.ShiftAccessPolicy
import online.alarabiya.superapp.model.shifts.ShiftCloseCommand
import online.alarabiya.superapp.model.shifts.ShiftFilters
import online.alarabiya.superapp.model.shifts.ShiftMoney
import online.alarabiya.superapp.model.shifts.ShiftRecord
import online.alarabiya.superapp.model.shifts.ShiftType

class ShiftViewModel(
    private val source: ShiftDataSource,
    policy: ShiftAccessPolicy,
) : ViewModel() {
    private var pendingNavigationRefresh = false
    var state by mutableStateOf(
        ShiftUiState(
            policy = policy,
            loading = policy.canReadManagement,
            loaded = !policy.canReadManagement,
            filters = ShiftFilters(
                branchId = if (policy.canSelectBranch) "" else policy.branchId?.toString().orEmpty(),
            ),
        ),
    )
        private set

    init {
        if (policy.canReadManagement) refresh()
    }

    fun updateFilters(transform: (ShiftFilters) -> ShiftFilters) {
        if (state.loading || state.loadingMore || state.closing || !state.policy.canReadManagement) return
        state = state.copy(filters = transform(state.filters), error = null, notice = null)
    }

    fun applyFilters() {
        if (state.loading || state.loadingMore || state.closing || !state.policy.canReadManagement) return
        val validation = state.filters.validate(state.policy.canSelectBranch, state.policy.branchId)
        if (validation != null) {
            state = state.copy(error = validation)
            return
        }
        refresh()
    }

    fun clearFilters() {
        if (state.loading || state.loadingMore || state.closing || !state.policy.canReadManagement) return
        state = state.copy(
            filters = ShiftFilters(
                branchId = if (state.policy.canSelectBranch) "" else state.policy.branchId?.toString().orEmpty(),
            ),
            error = null,
            notice = null,
        )
        refresh()
    }

    fun applyNavigationArguments(arguments: Map<String, String>) {
        if (!state.policy.canReadManagement) return
        val next = state.applyExecutiveNavigation(arguments)
        if (next == state) return
        state = next
        if (state.loading || state.loadingMore || state.closing) pendingNavigationRefresh = true else refresh()
    }

    fun consumeBack(): Boolean {
        state = when {
            state.closeDraft != null && !state.closing -> state.copy(closeDraft = null, error = null)
            state.selectedShiftId != null -> state.copy(
                selectedShiftId = null,
                detail = ShiftDetailState.None,
                closeDraft = null,
                error = null,
            )
            else -> return false
        }
        return true
    }

    fun refresh() {
        if (state.loadingMore || state.closing || !state.policy.canReadManagement) return
        val validation = state.filters.validate(state.policy.canSelectBranch, state.policy.branchId)
        if (validation != null) {
            state = state.copy(loading = false, error = validation)
            return
        }
        state = state.copy(
            loading = true,
            error = null,
            notice = null,
            selectedShiftId = null,
            detail = ShiftDetailState.None,
            closeDraft = null,
        )
        viewModelScope.launch { load(reset = true) }
    }

    fun loadMore() {
        if (!ShiftStatePolicy.canLoadMore(state)) return
        state = state.copy(loadingMore = true, error = null)
        viewModelScope.launch { load(reset = false) }
    }

    fun selectShift(shiftId: Long?) {
        if (!state.loaded || state.loading || state.loadingMore || state.closing) return
        state = state.copy(selectedShiftId = shiftId, detail = ShiftDetailState.None, closeDraft = null, error = null)
        if (shiftId == null) return
        state = state.copy(detail = ShiftDetailState.Loading)
        viewModelScope.launch { loadReport(shiftId) }
    }

    fun retryDetail() {
        val shiftId = when (val detail = state.detail) {
            is ShiftDetailState.Error -> detail.shiftId
            else -> state.selectedShiftId
        } ?: return
        if (state.loading || state.loadingMore || state.closing) return
        state = state.copy(detail = ShiftDetailState.Loading, error = null)
        viewModelScope.launch { loadReport(shiftId) }
    }

    fun requestClose() {
        val report = (state.detail as? ShiftDetailState.Content)?.report ?: return
        if (!ShiftStatePolicy.canRequestClose(state, report.shift)) return
        val needsRecipient = report.expectedCash.isPositive()
        state = state.copy(
            closeDraft = ShiftCloseDraft(report.shift.id),
            handoverRecipients = emptyList(),
            handoverRecipientsLoading = needsRecipient,
            handoverRecipientsLoaded = !needsRecipient,
            handoverRecipientsError = null,
            error = null,
            notice = null,
        )
        if (needsRecipient) viewModelScope.launch { loadHandoverRecipients(report.shift.id) }
    }

    fun updateCloseCounted(value: String) {
        if (state.closing) return
        val clean = value.filter { it.isDigit() || it == '.' }.take(24)
        state.closeDraft?.let { state = state.copy(closeDraft = it.copy(countedCash = clean), error = null) }
    }

    fun updateCloseConfirmation(value: String) {
        if (state.closing) return
        val clean = value.filter { it.isDigit() || it == '.' }.take(24)
        state.closeDraft?.let { state = state.copy(closeDraft = it.copy(countedCashConfirmation = clean), error = null) }
    }

    fun acknowledgeClose(value: Boolean) {
        if (state.closing) return
        state.closeDraft?.let { state = state.copy(closeDraft = it.copy(acknowledged = value), error = null) }
    }

    fun selectHandoverRecipient(userId: Long?) {
        if (state.closing) return
        val selected = userId?.takeIf { id -> state.handoverRecipients.any { it.id == id } }
        state.closeDraft?.let {
            state = state.copy(
                closeDraft = it.copy(handoverRecipientUserId = selected),
                error = null,
            )
        }
    }

    fun retryHandoverRecipients() {
        if (state.closing || state.handoverRecipientsLoading) return
        val shiftId = state.closeDraft?.shiftId ?: return
        state = state.copy(
            handoverRecipients = emptyList(),
            handoverRecipientsLoading = true,
            handoverRecipientsLoaded = false,
            handoverRecipientsError = null,
        )
        viewModelScope.launch { loadHandoverRecipients(shiftId) }
    }

    fun dismissClose() {
        if (!state.closing) {
            state = state.copy(
                closeDraft = null,
                handoverRecipients = emptyList(),
                handoverRecipientsLoading = false,
                handoverRecipientsLoaded = false,
                handoverRecipientsError = null,
                error = null,
            )
        }
    }

    fun confirmClose() {
        if (state.closing) return
        val validation = ShiftStatePolicy.closeValidation(state)
        if (validation != null) {
            state = state.copy(error = validation)
            return
        }
        val draft = requireNotNull(state.closeDraft)
        val counted = requireNotNull(ShiftMoney.parseUnsigned(draft.countedCash))
        val recipientUserId = draft.handoverRecipientUserId.takeIf { counted.isPositive() }
        state = state.copy(closing = true, error = null, notice = null)
        viewModelScope.launch {
            runCatching { source.close(ShiftCloseCommand(draft.shiftId, counted, recipientUserId)) }
                .onSuccess { result ->
                    state = state.copy(
                        closing = false,
                        loading = true,
                        closeDraft = null,
                        handoverRecipients = emptyList(),
                        handoverRecipientsLoading = false,
                        handoverRecipientsLoaded = false,
                        handoverRecipientsError = null,
                        selectedShiftId = null,
                        detail = ShiftDetailState.None,
                        notice = when {
                            result.alreadyClosed -> "كانت الوردية مغلقة وتم تحديث التقرير"
                            counted.isPositive() -> {
                                val recipient = result.treasuryRecipientName ?: "المستلم المحدد"
                                "تم إغلاق الوردية وتحويل النقد إلى عهدة $recipient بانتظار عدّه وقبوله في الخزينة"
                            }
                            else -> "تم إغلاق الوردية وتثبيت المطابقة"
                        },
                    )
                    load(reset = true, preserveNotice = true)
                }
                .onFailure { error ->
                    state = state.copy(closing = false, error = error.userMessage())
                }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private suspend fun load(reset: Boolean, preserveNotice: Boolean = false) {
        val effectiveBranch = state.policy.effectiveBranch(state.filters.branchIdOrNull())
        val request = state.filters.copy(branchId = effectiveBranch?.toString().orEmpty())
        val cursor = if (reset) null else state.nextCursor
        runCatching {
            coroutineScope {
                val page = async { source.list(request, cursor) }
                val current = effectiveBranch?.let { branch ->
                    async {
                        val types = request.type?.let(::listOf) ?: ShiftType.entries
                        coroutineScope {
                            types.map { type -> async { source.current(branch, type) } }
                                .awaitAll()
                                .filterNotNull()
                        }
                    }
                }
                page.await() to current?.await().orEmpty()
            }
        }.onSuccess { (page, current) ->
            val rows = if (reset) page.rows else (state.rows + page.rows).distinctBy(ShiftRecord::id)
            val selectedStillExists = state.selectedShiftId?.let { selected -> rows.any { it.id == selected } } == true
            state = state.copy(
                loading = false,
                loaded = true,
                loadingMore = false,
                rows = rows,
                total = if (reset) page.total else state.total,
                hasMore = page.hasMore,
                nextCursor = page.nextCursor,
                currentShifts = current,
                currentChecked = effectiveBranch != null,
                selectedShiftId = state.selectedShiftId.takeIf { selectedStillExists },
                detail = state.detail.takeIf { selectedStillExists } ?: ShiftDetailState.None,
                error = null,
                notice = state.notice.takeIf { preserveNotice },
            )
            refreshPendingNavigationIfNeeded()
        }.onFailure { error ->
            state = state.copy(
                loading = false,
                loadingMore = false,
                loaded = if (reset) false else state.loaded,
                error = error.userMessage(),
                notice = state.notice.takeIf { preserveNotice },
            )
            refreshPendingNavigationIfNeeded()
        }
    }

    private fun refreshPendingNavigationIfNeeded() {
        if (!pendingNavigationRefresh) return
        pendingNavigationRefresh = false
        refresh()
    }

    private suspend fun loadReport(shiftId: Long) {
        runCatching { source.report(shiftId) }
            .onSuccess { report ->
                if (state.selectedShiftId == shiftId) state = state.copy(detail = ShiftDetailState.Content(report))
            }
            .onFailure { error ->
                if (state.selectedShiftId == shiftId) {
                    state = state.copy(detail = ShiftDetailState.Error(shiftId, error.userMessage()))
                }
            }
    }

    private suspend fun loadHandoverRecipients(shiftId: Long) {
        val report = (state.detail as? ShiftDetailState.Content)?.report
            ?.takeIf { it.shift.id == shiftId }
            ?: return
        runCatching { source.handoverRecipients() }
            .onSuccess { recipients ->
                if (state.closeDraft?.shiftId == shiftId) {
                    state = state.copy(
                        handoverRecipients = ShiftStatePolicy.eligibleHandoverRecipients(
                            report = report,
                            actorUserId = state.policy.actorId,
                            recipients = recipients,
                        ),
                        handoverRecipientsLoading = false,
                        handoverRecipientsLoaded = true,
                        handoverRecipientsError = null,
                    )
                }
            }
            .onFailure { error ->
                if (state.closeDraft?.shiftId == shiftId) {
                    state = state.copy(
                        handoverRecipients = emptyList(),
                        handoverRecipientsLoading = false,
                        handoverRecipientsLoaded = false,
                        handoverRecipientsError = error.userMessage(),
                    )
                }
            }
    }
}

private fun Throwable.userMessage(): String =
    message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

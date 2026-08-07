package online.alarabiya.superapp.feature.receivables

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.ReceivablesDataSource
import online.alarabiya.superapp.data.snapshot
import online.alarabiya.superapp.model.receivables.CardFilters
import online.alarabiya.superapp.model.receivables.InstallmentFilters
import online.alarabiya.superapp.model.receivables.InstallmentKind
import online.alarabiya.superapp.model.receivables.InstallmentLine
import online.alarabiya.superapp.model.receivables.InstallmentLineStatus
import online.alarabiya.superapp.model.receivables.InstallmentPaymentMethod
import online.alarabiya.superapp.model.receivables.InstallmentStatus
import online.alarabiya.superapp.model.receivables.NewInstallmentLine
import online.alarabiya.superapp.model.receivables.NewInstallmentPlan
import online.alarabiya.superapp.model.receivables.ReceivablesAccessPolicy
import online.alarabiya.superapp.model.receivables.ReceivablesSection
import online.alarabiya.superapp.model.receivables.ReconciliationDraft
import online.alarabiya.superapp.model.receivables.ReminderActionDraft
import online.alarabiya.superapp.model.receivables.ReminderFilter
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem

class ReceivablesViewModel(
    private val repository: ReceivablesDataSource,
    val accessPolicy: ReceivablesAccessPolicy,
) : ViewModel() {
    private val initialBranch = accessPolicy.assignedBranchId?.toString().orEmpty()

    var state by mutableStateOf(
        ReceivablesUiState(
            section = accessPolicy.readableSections.firstOrNull() ?: ReceivablesSection.INSTALLMENTS,
            installmentFilters = InstallmentFilters(branchId = initialBranch),
            reminderFilter = ReminderFilter(branchId = initialBranch),
            cardFilters = CardFilters(branchId = initialBranch),
        ),
    )
        private set

    init {
        if (accessPolicy.canRead(state.section)) load(state.section)
    }

    fun setSection(section: ReceivablesSection) {
        if (!accessPolicy.canRead(section) || section == state.section) return
        state = state.copy(
            section = section,
            selectedPlanId = null,
            selectedPlan = null,
            selectedReminderId = null,
            pendingAction = null,
            newPlan = null,
            error = null,
            notice = null,
        )
        if (section !in state.loadedSections) load(section)
    }

    fun refresh() = load(state.section, refresh = true)

    fun loadMore() {
        when {
            state.loadingMore || state.loading || state.refreshing -> Unit
            state.section == ReceivablesSection.INSTALLMENTS && state.installmentHasMore -> load(state.section, append = true)
            state.section == ReceivablesSection.CARD_ACCOUNT && state.cardHasMore -> load(state.section, append = true)
        }
    }

    fun updateInstallmentFilters(transform: InstallmentFilters.() -> InstallmentFilters) {
        if (state.busy()) return
        val next = state.installmentFilters.transform().let { filter ->
            if (accessPolicy.canFilterBranch) filter.copy(branchId = filter.branchId.filter(Char::isDigit))
            else filter.copy(branchId = initialBranch)
        }
        state = state.copy(installmentFilters = next, error = null)
    }

    fun applyInstallmentFilters() {
        val error = state.installmentFilters.validationError()
        if (error != null) state = state.copy(error = error) else load(ReceivablesSection.INSTALLMENTS, refresh = true)
    }

    fun selectPlan(planId: Long?) {
        if (planId == null) {
            state = state.copy(selectedPlanId = null, selectedPlan = null, detailLoading = false)
            return
        }
        if (state.installmentPlans.none { it.id == planId } || state.detailLoading) return
        state = state.copy(selectedPlanId = planId, selectedPlan = null, detailLoading = true, error = null)
        viewModelScope.launch {
            runCatching { repository.installmentPlan(planId) }
                .onSuccess { detail ->
                    val authoritativeListSummary = state.installmentPlans.firstOrNull { it.id == planId }
                    state = state.copy(
                        selectedPlan = authoritativeListSummary?.let { detail.copy(summary = it) } ?: detail,
                        detailLoading = false,
                    )
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun openNewPlan() {
        if (!accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) || state.busy()) return
        state = state.copy(
            newPlan = NewInstallmentPlan(branchId = accessPolicy.assignedBranchId?.toString() ?: state.installmentFilters.branchId),
            pendingAction = null,
            error = null,
        )
    }

    fun updateNewPlan(transform: NewInstallmentPlan.() -> NewInstallmentPlan) {
        if (!state.submitting) state.newPlan?.let { current ->
            val next = current.transform().let {
                if (accessPolicy.canFilterBranch) it else it.copy(branchId = initialBranch)
            }
            state = state.copy(newPlan = next, error = null)
        }
    }

    fun addPlanLine() = updateNewPlan { if (lines.size >= 60) this else copy(lines = lines + NewInstallmentLine()) }

    fun removePlanLine(index: Int) = updateNewPlan {
        if (lines.size <= 1 || index !in lines.indices) this else copy(lines = lines.filterIndexed { i, _ -> i != index })
    }

    fun updatePlanLine(index: Int, transform: NewInstallmentLine.() -> NewInstallmentLine) = updateNewPlan {
        if (index !in lines.indices) this else copy(lines = lines.mapIndexed { i, line -> if (i == index) line.transform() else line })
    }

    fun requestCreatePlan() {
        val draft = state.newPlan ?: return
        val error = draft.validationError()
        state = if (error == null) state.copy(pendingAction = ReceivablesPendingAction.CreatePlan(draft), error = null)
        else state.copy(error = error)
    }

    fun requestPay(line: InstallmentLine) {
        if (!canActOnInstallment(line) || line.status !in setOf(InstallmentLineStatus.PENDING, InstallmentLineStatus.BOUNCED)) return
        state = state.copy(pendingAction = ReceivablesPendingAction.PayLine(line), error = null, notice = null)
    }

    fun requestCancelPlan() {
        val plan = state.selectedPlan?.summary ?: return
        if (!accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) || plan.status != InstallmentStatus.ACTIVE) return
        state = state.copy(pendingAction = ReceivablesPendingAction.CancelPlan(plan), error = null, notice = null)
    }

    fun requestBounce(line: InstallmentLine) {
        if (!canActOnInstallment(line) || line.kind != InstallmentKind.CHECK ||
            line.status !in setOf(InstallmentLineStatus.PENDING, InstallmentLineStatus.PAID)
        ) return
        state = state.copy(pendingAction = ReceivablesPendingAction.BounceCheck(line), error = null, notice = null)
    }

    fun updatePendingAction(transform: ReceivablesPendingAction.() -> ReceivablesPendingAction) {
        if (!state.submitting) state.pendingAction?.let { current ->
            val next = current.transform().let { action ->
                if (!accessPolicy.canFilterBranch && action is ReceivablesPendingAction.Reconcile) {
                    action.copy(draft = action.draft.copy(branchId = initialBranch))
                } else action
            }
            state = state.copy(pendingAction = next, error = null)
        }
    }

    fun closeOverlay() {
        if (!state.submitting) state = state.copy(pendingAction = null, newPlan = null, error = null)
    }

    fun updateReminderFilter(filter: ReminderFilter) {
        if (state.busy()) return
        val aggregateAllowed = when (state.section) {
            ReceivablesSection.CUSTOMER_REMINDERS -> accessPolicy.canReadOpeningReceivables
            ReceivablesSection.SUPPLIER_REMINDERS -> accessPolicy.canReadAllPayables
            else -> false
        }
        state = state.copy(
            reminderFilter = filter.copy(
                branchId = if (accessPolicy.canFilterBranch) filter.branchId.filter(Char::isDigit) else initialBranch,
                aggregate = filter.aggregate && aggregateAllowed,
            ),
            error = null,
        )
    }

    fun applyReminderFilter() {
        val filter = state.reminderFilter
        val error = filter.validationError(branchRequired = !filter.aggregate)
        if (error != null) state = state.copy(error = error) else load(state.section, refresh = true)
    }

    fun setReminderHistoryMode(history: Boolean) {
        state = state.copy(reminderHistoryMode = history, selectedReminderId = null)
    }

    fun selectReminder(subjectId: Long?) {
        state = if (subjectId == null || state.reminderQueue.any { it.subject.id == subjectId }) {
            state.copy(selectedReminderId = subjectId)
        } else state
    }

    fun requestReminder(item: ReminderQueueItem, kind: ReminderActionDraft.Kind) {
        val section = item.subject.ledger.section()
        if (!accessPolicy.canWrite(section) || !canWriteCurrentReminderScope(item)) return
        state = state.copy(
            pendingAction = ReceivablesPendingAction.Reminder(ReminderActionDraft(item, kind)),
            error = null,
            notice = null,
        )
    }

    fun updateCardFilters(transform: CardFilters.() -> CardFilters) {
        if (state.busy()) return
        val next = state.cardFilters.transform().let { filter ->
            if (accessPolicy.canFilterBranch) filter.copy(branchId = filter.branchId.filter(Char::isDigit))
            else filter.copy(branchId = initialBranch)
        }
        state = state.copy(cardFilters = next, error = null)
    }

    fun applyCardFilters() {
        val error = state.cardFilters.validationError()
        if (error != null) state = state.copy(error = error) else load(ReceivablesSection.CARD_ACCOUNT, refresh = true)
    }

    fun openReconciliation() {
        if (!accessPolicy.canCreateReconciliation || state.busy()) return
        val branch = accessPolicy.assignedBranchId?.toString() ?: state.cardFilters.branchId
        state = state.copy(
            pendingAction = ReceivablesPendingAction.Reconcile(ReconciliationDraft(branchId = branch)),
            error = null,
            notice = null,
        )
    }

    fun confirmAction() {
        val action = state.pendingAction ?: return
        if (state.submitting) return
        val error = action.validationError()
        if (error != null) {
            state = state.copy(error = error)
            return
        }
        state = state.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { execute(action) }
                .onSuccess { result ->
                    val section = action.destination()
                    state = state.copy(
                        submitting = false,
                        pendingAction = null,
                        newPlan = null,
                        selectedPlan = null,
                        selectedPlanId = null,
                        selectedReminderId = null,
                        notice = result,
                    )
                    load(section, refresh = true, keepNotice = true)
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private suspend fun execute(action: ReceivablesPendingAction): String = when (action) {
        is ReceivablesPendingAction.CreatePlan -> {
            val id = repository.createInstallmentPlan(action.draft)
            "أُنشئت خطة الأقساط #$id"
        }
        is ReceivablesPendingAction.PayLine -> {
            val result = repository.payInstallment(action.line.id, action.method, action.note.takeIf(String::isNotBlank))
            if (result.status == "PENDING_APPROVAL") "السند ${result.voucherNumber} بانتظار اعتماد مستقل"
            else "تم تسجيل السداد بالسند ${result.voucherNumber}"
        }
        is ReceivablesPendingAction.CancelPlan -> {
            repository.cancelInstallmentPlan(action.plan.id, action.reason)
            "تم إلغاء الخطة"
        }
        is ReceivablesPendingAction.BounceCheck -> {
            val reversed = repository.bounceLegacyCheck(action.line.id, action.note.takeIf(String::isNotBlank))
            if (reversed) "سُجّل ارتجاع الشيك وعُكس أثر التحصيل" else "سُجّل ارتجاع الشيك المعلّق"
        }
        is ReceivablesPendingAction.Reminder -> {
            val draft = action.draft
            val branch = requireNotNull(state.reminderFilter.branchIdOrNull()) { "حدّد الفرع قبل الإجراء" }
            if (draft.kind == ReminderActionDraft.Kind.SEND_API) {
                val result = repository.sendReminder(draft.item.snapshot(), branch)
                if (!result.sent) throw IllegalStateException(result.reason ?: "لم يرسل الخادم التذكير")
                "أُدرج التذكير للإرسال"
            } else {
                repository.skipReminder(
                    draft.item.snapshot(), branch, draft.reason,
                    draft.promisedDate.takeIf(String::isNotBlank),
                )
                if (draft.promisedDate.isBlank()) "سُجّل قرار عدم الإرسال" else "سُجّل موعد المتابعة"
            }
        }
        is ReceivablesPendingAction.Reconcile -> {
            repository.createCardReconciliation(action.draft)
            "حُفظت لقطة المطابقة بحساب الخادم"
        }
    }

    private fun load(
        section: ReceivablesSection,
        refresh: Boolean = false,
        append: Boolean = false,
        keepNotice: Boolean = false,
    ) {
        if (!accessPolicy.canRead(section) || state.loading || state.refreshing || state.loadingMore) return
        if (section in setOf(ReceivablesSection.CUSTOMER_REMINDERS, ReceivablesSection.SUPPLIER_REMINDERS)) {
            val validation = state.reminderFilter.validationError(branchRequired = !state.reminderFilter.aggregate)
            if (validation != null) {
                state = state.copy(error = null, notice = validation, loadedSections = state.loadedSections + section)
                return
            }
        }
        val notice = state.notice
        state = state.startLoading(refresh, append).let { if (keepNotice) it.copy(notice = notice) else it }
        viewModelScope.launch {
            runCatching {
                when (section) {
                    ReceivablesSection.INSTALLMENTS -> loadInstallments(append)
                    ReceivablesSection.CUSTOMER_REMINDERS -> loadReminders(ReminderLedger.RECEIVABLE)
                    ReceivablesSection.SUPPLIER_REMINDERS -> loadReminders(ReminderLedger.PAYABLE)
                    ReceivablesSection.CARD_ACCOUNT -> loadCard(append)
                    ReceivablesSection.ACCOUNTS -> state = state.copy(accountGroups = repository.accountTree())
                }
            }.onSuccess {
                state = state.finishLoading(section).let { if (keepNotice) it.copy(notice = notice) else it }
                val requested = state.section.takeIf {
                    it != section && it !in state.loadedSections && accessPolicy.canRead(it)
                }
                if (requested != null) load(requested)
            }.onFailure { state = state.failed(it.userMessage()) }
        }
    }

    private suspend fun loadInstallments(append: Boolean) {
        val offset = if (append) state.installmentPlans.size else 0
        val page = repository.installmentPlans(state.installmentFilters, offset)
        val branch = state.installmentFilters.branchId.toLongOrNull()
        val due = if (append) state.dueInstallments else repository.dueInstallments(branch, state.installmentFilters.dueDays)
        state = state.copy(
            installmentPlans = if (append) (state.installmentPlans + page.rows).distinctBy { it.id } else page.rows,
            installmentHasMore = page.hasMore,
            dueInstallments = due,
        )
    }

    private suspend fun loadReminders(ledger: ReminderLedger) {
        val filter = state.reminderFilter
        val branch = filter.branchIdOrNull()
        state = state.copy(
            reminderQueue = repository.reminderQueue(ledger, branch, filter.aggregate),
            reminderHistory = repository.reminderHistory(ledger, branch, filter.aggregate),
        )
    }

    private suspend fun loadCard(append: Boolean) {
        val offset = if (append) state.cardMovements.size else 0
        val page = repository.cardMovements(state.cardFilters, offset)
        if (append) {
            state = state.copy(
                cardMovements = (state.cardMovements + page.rows).distinctBy { it.receiptId },
                cardMovementCount = page.count,
                cardHasMore = page.hasMore,
            )
        } else {
            val branch = state.cardFilters.branchId.toLongOrNull()
            state = state.copy(
                cardSummary = repository.cardSummary(branch),
                cardMovements = page.rows,
                cardMovementCount = page.count,
                cardHasMore = page.hasMore,
                reconciliations = repository.cardReconciliations(branch),
            )
        }
    }

    private fun canActOnInstallment(line: InstallmentLine): Boolean =
        accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) && state.selectedPlan?.lines?.any { it.id == line.id } == true

    private fun canWriteCurrentReminderScope(item: ReminderQueueItem): Boolean {
        val branchReady = state.reminderFilter.branchIdOrNull() != null
        val unsafePayablesAggregate = item.subject.ledger == ReminderLedger.PAYABLE && state.reminderFilter.aggregate
        return branchReady && !unsafePayablesAggregate && state.reminderQueue.any { it.subject == item.subject }
    }
}

private fun ReceivablesUiState.busy() = loading || refreshing || loadingMore || submitting

private fun ReminderLedger.section(): ReceivablesSection = when (this) {
    ReminderLedger.RECEIVABLE -> ReceivablesSection.CUSTOMER_REMINDERS
    ReminderLedger.PAYABLE -> ReceivablesSection.SUPPLIER_REMINDERS
}

private fun ReceivablesPendingAction.destination(): ReceivablesSection = when (this) {
    is ReceivablesPendingAction.CreatePlan,
    is ReceivablesPendingAction.PayLine,
    is ReceivablesPendingAction.CancelPlan,
    is ReceivablesPendingAction.BounceCheck -> ReceivablesSection.INSTALLMENTS
    is ReceivablesPendingAction.Reminder -> draft.item.subject.ledger.section()
    is ReceivablesPendingAction.Reconcile -> ReceivablesSection.CARD_ACCOUNT
}

private fun ReceivablesPendingAction.validationError(): String? = when (this) {
    is ReceivablesPendingAction.CreatePlan -> draft.validationError()
    is ReceivablesPendingAction.PayLine -> when {
        note.length > 255 -> "الملاحظة أطول من الحد المسموح"
        line.status !in setOf(InstallmentLineStatus.PENDING, InstallmentLineStatus.BOUNCED) -> "القسط غير قابل للسداد"
        else -> null
    }
    is ReceivablesPendingAction.CancelPlan ->
        if (reason.trim().length !in 3..500) "سبب الإلغاء مطلوب (3 أحرف على الأقل)" else null
    is ReceivablesPendingAction.BounceCheck -> when {
        line.kind != InstallmentKind.CHECK -> "الارتجاع متاح لشيك قديم فقط"
        note.length > 255 -> "الملاحظة أطول من الحد المسموح"
        else -> null
    }
    is ReceivablesPendingAction.Reminder -> draft.validationError()
    is ReceivablesPendingAction.Reconcile -> draft.validationError()
}

private fun Throwable.userMessage(): String = message?.takeIf(String::isNotBlank)
    ?: "تعذّر إكمال العملية"

class ReceivablesViewModelFactory(
    private val repository: ReceivablesDataSource,
    private val accessPolicy: ReceivablesAccessPolicy,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        ReceivablesViewModel(repository, accessPolicy) as T
}

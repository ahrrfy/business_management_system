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

private data class ReceivablesCommit(
    val notice: String,
    val reduce: (ReceivablesUiState) -> ReceivablesUiState = { it },
)

private typealias ReceivablesReducer = (ReceivablesUiState) -> ReceivablesUiState

class ReceivablesViewModel(
    private val repository: ReceivablesDataSource,
    val accessPolicy: ReceivablesAccessPolicy,
) : ViewModel() {
    private val initialBranch = accessPolicy.assignedBranchId?.toString().orEmpty()
    private var pendingExecutiveRemindersRefresh = false

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

    fun applyNavigationArguments(arguments: Map<String, String>) {
        val recognized = arguments["bucket"] in setOf("ar-30", "ar-60", "ar-90") ||
            arguments["view"] == "creditExposure"
        if (!recognized || !accessPolicy.canRead(ReceivablesSection.CUSTOMER_REMINDERS)) return
        val next = state.applyExecutiveNavigation(
            arguments = arguments,
            canReadCustomerReminders = accessPolicy.canRead(ReceivablesSection.CUSTOMER_REMINDERS),
        )
        state = next
        if (state.busy()) pendingExecutiveRemindersRefresh = true
        else load(ReceivablesSection.CUSTOMER_REMINDERS, refresh = true)
    }

    fun setSection(section: ReceivablesSection) {
        if (!accessPolicy.canRead(section) || section == state.section) return
        state = state.copy(
            section = section,
            executiveView = if (section == ReceivablesSection.CUSTOMER_REMINDERS) state.executiveView else null,
            selectedPlanId = null,
            selectedPlan = null,
            selectedReminderId = null,
            pendingAction = null,
            newPlan = null,
            error = null,
            notice = null,
        )
        if (!state.isFresh(section)) load(section, refresh = section in state.loadedSections)
    }

    fun refresh() = load(state.section, refresh = true)

    fun loadMore() {
        when {
            !state.canInteract(state.section) -> Unit
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
        if (
            !state.canInteract(ReceivablesSection.INSTALLMENTS) ||
            state.installmentPlans.none { it.id == planId }
        ) return
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
                .onFailure { state = state.failed(it.userMessage(), ReceivablesSection.INSTALLMENTS) }
        }
    }

    fun openNewPlan() {
        if (!accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) || !state.canInteract(ReceivablesSection.INSTALLMENTS)) return
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
        if (!state.canInteract(ReceivablesSection.INSTALLMENTS)) return
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
        if (
            !accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) ||
            !state.canInteract(ReceivablesSection.INSTALLMENTS) ||
            plan.status != InstallmentStatus.ACTIVE
        ) return
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
        if (error != null) state = state.copy(error = error)
        else {
            state = state.copy(executiveView = null, selectedReminderId = null)
            load(state.section, refresh = true)
        }
    }

    fun setReminderHistoryMode(history: Boolean) {
        if (!state.canInteract(state.section)) return
        state = state.copy(reminderHistoryMode = history, selectedReminderId = null)
    }

    fun selectReminder(subjectId: Long?) {
        if (!state.canInteract(state.section)) return
        state = if (subjectId == null || state.reminderQueue.any { it.subject.id == subjectId }) {
            state.copy(selectedReminderId = subjectId)
        } else state
    }

    fun requestReminder(item: ReminderQueueItem, kind: ReminderActionDraft.Kind) {
        val section = item.subject.ledger.section()
        if (!accessPolicy.canWrite(section) || !state.canInteract(section) || !canWriteCurrentReminderScope(item)) return
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
        if (!accessPolicy.canCreateReconciliation || !state.canInteract(ReceivablesSection.CARD_ACCOUNT)) return
        val branch = accessPolicy.assignedBranchId?.toString() ?: state.cardFilters.branchId
        state = state.copy(
            pendingAction = ReceivablesPendingAction.Reconcile(ReconciliationDraft(branchId = branch)),
            error = null,
            notice = null,
        )
    }

    fun confirmAction() {
        val action = state.pendingAction ?: return
        val section = action.destination()
        if (!state.canInteract(section)) return
        val error = action.validationError()
        if (error != null) {
            state = state.copy(error = error)
            return
        }
        state = state.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { execute(action) }
                .onSuccess { committed ->
                    // Persist the acknowledged outcome before reconciliation. A failed refresh may
                    // hide the stale queue, but it must never reopen the action or invite a repeat.
                    state = state.commit(section, committed.reduce).copy(
                        selectedPlan = null,
                        selectedPlanId = null,
                        selectedReminderId = null,
                        notice = committed.notice,
                    )
                    load(section, refresh = true, keepNotice = true)
                }
                .onFailure { state = state.failed(it.userMessage(), section) }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private suspend fun execute(action: ReceivablesPendingAction): ReceivablesCommit = when (action) {
        is ReceivablesPendingAction.CreatePlan -> {
            val id = repository.createInstallmentPlan(action.draft)
            ReceivablesCommit("أُنشئت خطة الأقساط #$id")
        }
        is ReceivablesPendingAction.PayLine -> {
            val result = repository.payInstallment(action.line.id, action.method, action.note.takeIf(String::isNotBlank))
            val notice = if (result.status == "PENDING_APPROVAL") {
                "السند ${result.voucherNumber} بانتظار اعتماد مستقل"
            } else {
                "تم تسجيل السداد بالسند ${result.voucherNumber}"
            }
            ReceivablesCommit(notice) { current ->
                val paid = result.status != "PENDING_APPROVAL"
                val plans = current.installmentPlans.map { plan ->
                    if (plan.id == action.line.planId && result.planCompleted) {
                        plan.copy(status = InstallmentStatus.COMPLETED)
                    } else {
                        plan
                    }
                }
                current.copy(
                    installmentPlans = plans,
                    dueInstallments = if (paid) current.dueInstallments.filterNot { it.lineId == action.line.id }
                        else current.dueInstallments,
                    selectedPlan = current.selectedPlan?.let { detail ->
                        detail.copy(
                            summary = plans.firstOrNull { it.id == detail.summary.id } ?: detail.summary,
                            lines = detail.lines.map { line ->
                                if (line.id == action.line.id && paid) {
                                    line.copy(status = InstallmentLineStatus.PAID, receiptId = result.receiptId)
                                } else {
                                    line
                                }
                            },
                        )
                    },
                )
            }
        }
        is ReceivablesPendingAction.CancelPlan -> {
            repository.cancelInstallmentPlan(action.plan.id, action.reason)
            ReceivablesCommit("تم إلغاء الخطة") { current ->
                current.copy(
                    installmentPlans = current.installmentPlans.map { plan ->
                        if (plan.id == action.plan.id) plan.copy(status = InstallmentStatus.CANCELLED) else plan
                    },
                    dueInstallments = current.dueInstallments.filterNot { it.planId == action.plan.id },
                    selectedPlan = current.selectedPlan?.takeIf { it.summary.id != action.plan.id },
                )
            }
        }
        is ReceivablesPendingAction.BounceCheck -> {
            val reversed = repository.bounceLegacyCheck(action.line.id, action.note.takeIf(String::isNotBlank))
            val notice = if (reversed) "سُجّل ارتجاع الشيك وعُكس أثر التحصيل" else "سُجّل ارتجاع الشيك المعلّق"
            ReceivablesCommit(notice) { current ->
                current.copy(
                    selectedPlan = current.selectedPlan?.let { detail ->
                        detail.copy(lines = detail.lines.map { line ->
                            if (line.id == action.line.id) line.copy(status = InstallmentLineStatus.BOUNCED) else line
                        })
                    },
                )
            }
        }
        is ReceivablesPendingAction.Reminder -> {
            val draft = action.draft
            val branch = requireNotNull(state.reminderFilter.branchIdOrNull()) { "حدّد الفرع قبل الإجراء" }
            if (draft.kind == ReminderActionDraft.Kind.SEND_API) {
                val result = repository.sendReminder(draft.item.snapshot(), branch)
                if (!result.sent) throw IllegalStateException(result.reason ?: "لم يرسل الخادم التذكير")
                ReceivablesCommit("أُدرج التذكير للإرسال") { current -> current.afterReminderCommit(draft.item) }
            } else {
                repository.skipReminder(
                    draft.item.snapshot(), branch, draft.reason,
                    draft.promisedDate.takeIf(String::isNotBlank),
                )
                val notice = if (draft.promisedDate.isBlank()) "سُجّل قرار عدم الإرسال" else "سُجّل موعد المتابعة"
                ReceivablesCommit(notice) { current -> current.afterReminderCommit(draft.item) }
            }
        }
        is ReceivablesPendingAction.Reconcile -> {
            val reconciliation = repository.createCardReconciliation(action.draft)
            ReceivablesCommit("حُفظت لقطة المطابقة بحساب الخادم") { current ->
                current.copy(reconciliations = listOf(reconciliation) + current.reconciliations.filterNot {
                    it.id == reconciliation.id
                })
            }
        }
    }

    private fun load(
        section: ReceivablesSection,
        refresh: Boolean = false,
        append: Boolean = false,
        keepNotice: Boolean = false,
    ) {
        if (!accessPolicy.canRead(section) || state.busy()) return
        if (section in setOf(ReceivablesSection.CUSTOMER_REMINDERS, ReceivablesSection.SUPPLIER_REMINDERS)) {
            val validation = state.reminderFilter.validationError(branchRequired = !state.reminderFilter.aggregate)
            if (validation != null) {
                state = state.copy(
                    freshSections = state.freshSections - section,
                    error = validation,
                    notice = null,
                )
                return
            }
        }
        val notice = state.notice
        val safeBase = if (refresh) {
            state.copy(
                pendingAction = null,
                newPlan = null,
                selectedPlanId = null,
                selectedPlan = null,
                selectedReminderId = null,
            )
        } else {
            state
        }
        state = safeBase.startLoading(refresh, append, section).let { if (keepNotice) it.copy(notice = notice) else it }
        viewModelScope.launch {
            runCatching {
                when (section) {
                    ReceivablesSection.INSTALLMENTS -> loadInstallments(append)
                    ReceivablesSection.CUSTOMER_REMINDERS -> loadReminders(ReminderLedger.RECEIVABLE)
                    ReceivablesSection.SUPPLIER_REMINDERS -> loadReminders(ReminderLedger.PAYABLE)
                    ReceivablesSection.CARD_ACCOUNT -> loadCard(append)
                    ReceivablesSection.ACCOUNTS -> {
                        val groups = repository.accountTree()
                        val reducer: ReceivablesReducer = { current -> current.copy(accountGroups = groups) }
                        reducer
                    }
                }
            }.onSuccess { reducer ->
                state = reducer(state).finishLoading(section).let { if (keepNotice) it.copy(notice = notice) else it }
                if (pendingExecutiveRemindersRefresh) {
                    pendingExecutiveRemindersRefresh = false
                    load(ReceivablesSection.CUSTOMER_REMINDERS, refresh = true)
                    return@onSuccess
                }
                val requested = state.section.takeIf {
                    it != section && it !in state.loadedSections && accessPolicy.canRead(it)
                }
                if (requested != null) load(requested)
            }.onFailure {
                state = state.failed(it.userMessage(), section)
                if (pendingExecutiveRemindersRefresh) {
                    pendingExecutiveRemindersRefresh = false
                    load(ReceivablesSection.CUSTOMER_REMINDERS, refresh = true)
                }
            }
        }
    }

    private suspend fun loadInstallments(append: Boolean): ReceivablesReducer {
        val offset = if (append) state.installmentPlans.size else 0
        val page = repository.installmentPlans(state.installmentFilters, offset)
        val branch = state.installmentFilters.branchId.toLongOrNull()
        val due = if (append) state.dueInstallments else repository.dueInstallments(branch, state.installmentFilters.dueDays)
        return { current ->
            current.copy(
                installmentPlans = if (append) (current.installmentPlans + page.rows).distinctBy { it.id } else page.rows,
                installmentHasMore = page.hasMore,
                dueInstallments = due,
            )
        }
    }

    private suspend fun loadReminders(ledger: ReminderLedger): ReceivablesReducer {
        val filter = state.reminderFilter
        val branch = filter.branchIdOrNull()
        val queue = repository.reminderQueue(ledger, branch, filter.aggregate)
        val history = repository.reminderHistory(ledger, branch, filter.aggregate)
        return { current -> current.copy(reminderQueue = queue, reminderHistory = history) }
    }

    private suspend fun loadCard(append: Boolean): ReceivablesReducer {
        val offset = if (append) state.cardMovements.size else 0
        val page = repository.cardMovements(state.cardFilters, offset)
        if (append) return { current ->
            current.copy(
                cardMovements = (current.cardMovements + page.rows).distinctBy { it.receiptId },
                cardMovementCount = page.count,
                cardHasMore = page.hasMore,
            )
        }
        val branch = state.cardFilters.branchId.toLongOrNull()
        val summary = repository.cardSummary(branch)
        val reconciliations = repository.cardReconciliations(branch)
        return { current ->
            current.copy(
                cardSummary = summary,
                cardMovements = page.rows,
                cardMovementCount = page.count,
                cardHasMore = page.hasMore,
                reconciliations = reconciliations,
            )
        }
    }

    private fun canActOnInstallment(line: InstallmentLine): Boolean =
        accessPolicy.canWrite(ReceivablesSection.INSTALLMENTS) &&
            state.canInteract(ReceivablesSection.INSTALLMENTS) &&
            state.selectedPlan?.lines?.any { it.id == line.id } == true

    private fun canWriteCurrentReminderScope(item: ReminderQueueItem): Boolean {
        val branchReady = state.reminderFilter.branchIdOrNull() != null
        val unsafePayablesAggregate = item.subject.ledger == ReminderLedger.PAYABLE && state.reminderFilter.aggregate
        return branchReady && !unsafePayablesAggregate && state.reminderQueue.any { it.subject == item.subject }
    }
}

private fun ReceivablesUiState.busy() = loading || refreshing || loadingMore || submitting || detailLoading

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

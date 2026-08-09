package online.alarabiya.superapp.feature.receivables

import java.math.BigDecimal
import online.alarabiya.superapp.model.receivables.AccountGroup
import online.alarabiya.superapp.model.receivables.CardFilters
import online.alarabiya.superapp.model.receivables.CardMovement
import online.alarabiya.superapp.model.receivables.CardReconciliation
import online.alarabiya.superapp.model.receivables.CardSummary
import online.alarabiya.superapp.model.receivables.DueInstallment
import online.alarabiya.superapp.model.receivables.InstallmentFilters
import online.alarabiya.superapp.model.receivables.InstallmentLine
import online.alarabiya.superapp.model.receivables.InstallmentPaymentMethod
import online.alarabiya.superapp.model.receivables.InstallmentPlanDetail
import online.alarabiya.superapp.model.receivables.InstallmentPlanSummary
import online.alarabiya.superapp.model.receivables.NewInstallmentPlan
import online.alarabiya.superapp.model.receivables.ReceivablesSection
import online.alarabiya.superapp.model.receivables.ReconciliationDraft
import online.alarabiya.superapp.model.receivables.ReminderActionDraft
import online.alarabiya.superapp.model.receivables.ReminderFilter
import online.alarabiya.superapp.model.receivables.ReminderHistoryItem
import online.alarabiya.superapp.model.receivables.ReminderQueueItem

sealed interface ReceivablesPendingAction {
    data class CreatePlan(val draft: NewInstallmentPlan) : ReceivablesPendingAction
    data class PayLine(
        val line: InstallmentLine,
        val method: InstallmentPaymentMethod = InstallmentPaymentMethod.CASH,
        val note: String = "",
    ) : ReceivablesPendingAction

    data class CancelPlan(val plan: InstallmentPlanSummary, val reason: String = "") : ReceivablesPendingAction
    data class BounceCheck(val line: InstallmentLine, val note: String = "") : ReceivablesPendingAction
    data class Reminder(val draft: ReminderActionDraft) : ReceivablesPendingAction
    data class Reconcile(val draft: ReconciliationDraft) : ReceivablesPendingAction
}

enum class ExecutiveReceivablesView { AR_30, AR_60, AR_90, CREDIT_EXPOSURE }

data class ReceivablesUiState(
    val section: ReceivablesSection,
    val loadedSections: Set<ReceivablesSection> = emptySet(),
    val freshSections: Set<ReceivablesSection> = emptySet(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val notice: String? = null,

    val installmentFilters: InstallmentFilters = InstallmentFilters(),
    val installmentPlans: List<InstallmentPlanSummary> = emptyList(),
    val installmentHasMore: Boolean = false,
    val dueInstallments: List<DueInstallment> = emptyList(),
    val selectedPlanId: Long? = null,
    val selectedPlan: InstallmentPlanDetail? = null,
    val detailLoading: Boolean = false,
    val newPlan: NewInstallmentPlan? = null,

    val reminderFilter: ReminderFilter = ReminderFilter(),
    val reminderHistoryMode: Boolean = false,
    val executiveView: ExecutiveReceivablesView? = null,
    val reminderQueue: List<ReminderQueueItem> = emptyList(),
    val reminderHistory: List<ReminderHistoryItem> = emptyList(),
    val selectedReminderId: Long? = null,

    val cardFilters: CardFilters = CardFilters(),
    val cardSummary: CardSummary? = null,
    val cardMovements: List<CardMovement> = emptyList(),
    val cardMovementCount: Int = 0,
    val cardHasMore: Boolean = false,
    val reconciliations: List<CardReconciliation> = emptyList(),

    val accountGroups: List<AccountGroup> = emptyList(),
    val pendingAction: ReceivablesPendingAction? = null,
) {
    fun isFresh(section: ReceivablesSection = this.section): Boolean = section in freshSections

    fun canInteract(section: ReceivablesSection = this.section): Boolean =
        isFresh(section) && !loading && !refreshing && !loadingMore && !submitting && !detailLoading

    val visibleReminderQueue: List<ReminderQueueItem>
        get() = when (executiveView) {
            ExecutiveReceivablesView.AR_30 -> reminderQueue.filter { it.daysOverdue in 31..60 }
            ExecutiveReceivablesView.AR_60 -> reminderQueue.filter { it.daysOverdue in 61..90 }
            ExecutiveReceivablesView.AR_90 -> reminderQueue.filter { it.daysOverdue >= 91 }
            ExecutiveReceivablesView.CREDIT_EXPOSURE -> reminderQueue.sortedByDescending {
                runCatching { BigDecimal(it.totalUnpaid.value) }.getOrDefault(BigDecimal.ZERO)
            }
            null -> reminderQueue
        }

    val selectedReminder: ReminderQueueItem?
        get() = visibleReminderQueue.firstOrNull { it.subject.id == selectedReminderId }

    fun startLoading(
        refresh: Boolean,
        append: Boolean = false,
        section: ReceivablesSection = this.section,
    ): ReceivablesUiState = copy(
        freshSections = freshSections - section,
        loading = !refresh && !append,
        refreshing = refresh && !append,
        loadingMore = append,
        error = null,
        notice = null,
    )

    fun finishLoading(section: ReceivablesSection): ReceivablesUiState = copy(
        loadedSections = loadedSections + section,
        freshSections = freshSections + section,
        loading = false,
        refreshing = false,
        loadingMore = false,
        error = null,
    )

    fun failed(
        message: String,
        section: ReceivablesSection = this.section,
    ): ReceivablesUiState = copy(
        freshSections = freshSections - section,
        loading = false,
        refreshing = false,
        loadingMore = false,
        submitting = false,
        detailLoading = false,
        error = message,
    )

    fun commit(section: ReceivablesSection, reducer: (ReceivablesUiState) -> ReceivablesUiState): ReceivablesUiState =
        reducer(this).copy(
            freshSections = freshSections - section,
            submitting = false,
            pendingAction = null,
            newPlan = null,
        )
}

internal fun ReceivablesUiState.applyExecutiveNavigation(
    arguments: Map<String, String>,
    canReadCustomerReminders: Boolean,
): ReceivablesUiState {
    if (!canReadCustomerReminders) return this
    val view = when {
        arguments["bucket"] == "ar-30" -> ExecutiveReceivablesView.AR_30
        arguments["bucket"] == "ar-60" -> ExecutiveReceivablesView.AR_60
        arguments["bucket"] == "ar-90" -> ExecutiveReceivablesView.AR_90
        arguments["view"] == "creditExposure" -> ExecutiveReceivablesView.CREDIT_EXPOSURE
        else -> return this
    }
    return copy(
        section = ReceivablesSection.CUSTOMER_REMINDERS,
        executiveView = view,
        reminderHistoryMode = false,
        selectedReminderId = null,
        pendingAction = null,
        error = null,
        notice = null,
    )
}

internal fun ReceivablesUiState.afterReminderCommit(item: ReminderQueueItem): ReceivablesUiState = copy(
    reminderQueue = reminderQueue.filterNot { it.subject == item.subject },
    selectedReminderId = null,
)

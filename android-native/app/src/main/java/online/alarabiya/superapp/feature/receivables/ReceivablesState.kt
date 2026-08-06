package online.alarabiya.superapp.feature.receivables

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

data class ReceivablesUiState(
    val section: ReceivablesSection,
    val loadedSections: Set<ReceivablesSection> = emptySet(),
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
    val selectedReminder: ReminderQueueItem?
        get() = reminderQueue.firstOrNull { it.subject.id == selectedReminderId }

    fun startLoading(refresh: Boolean, append: Boolean = false): ReceivablesUiState = copy(
        loading = !refresh && !append,
        refreshing = refresh && !append,
        loadingMore = append,
        error = null,
        notice = null,
    )

    fun finishLoading(section: ReceivablesSection): ReceivablesUiState = copy(
        loadedSections = loadedSections + section,
        loading = false,
        refreshing = false,
        loadingMore = false,
        error = null,
    )

    fun failed(message: String): ReceivablesUiState = copy(
        loading = false,
        refreshing = false,
        loadingMore = false,
        submitting = false,
        detailLoading = false,
        error = message,
    )
}

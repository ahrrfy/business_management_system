package online.alarabiya.superapp.feature.accountingControls

import online.alarabiya.superapp.model.accountingControls.AccountGroup
import online.alarabiya.superapp.model.accountingControls.AccountingControlsSection
import online.alarabiya.superapp.model.accountingControls.ActivePeriodLock
import online.alarabiya.superapp.model.accountingControls.ExchangeDraft
import online.alarabiya.superapp.model.accountingControls.ExchangeHouse
import online.alarabiya.superapp.model.accountingControls.ExchangeReconciliation
import online.alarabiya.superapp.model.accountingControls.ExchangeStatement
import online.alarabiya.superapp.model.accountingControls.PendingExchangeDeposit
import online.alarabiya.superapp.model.accountingControls.PeriodHistoryEvent
import online.alarabiya.superapp.model.accountingControls.ReconciliationCommand
import online.alarabiya.superapp.model.accountingControls.YearEndSnapshot

enum class AccountingControlsBusy {
    INITIAL,
    ACCOUNTS,
    EXCHANGE,
    EXCHANGE_STATEMENT,
    EXCHANGE_MUTATION,
    EXCHANGE_APPROVAL,
    RECONCILIATION,
    PERIODS,
    PERIOD_MUTATION,
    YEAR_END,
    YEAR_CLOSE,
}

data class AccountingControlsUiState(
    val initialized: Boolean = false,
    val section: AccountingControlsSection = AccountingControlsSection.ACCOUNTS,
    val busy: AccountingControlsBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val accountGroups: List<AccountGroup> = emptyList(),
    val accountQuery: String = "",
    val exchangeQuery: String = "",
    val exchangeHouses: List<ExchangeHouse> = emptyList(),
    val selectedExchangeHouseId: Long? = null,
    val exchangeStatement: ExchangeStatement? = null,
    val pendingDeposits: List<PendingExchangeDeposit> = emptyList(),
    val exchangeDraft: ExchangeDraft = ExchangeDraft(),
    val exchangeRequestId: String? = null,
    val reconciliationDraft: ReconciliationCommand = ReconciliationCommand(0, "", ""),
    val reconciliation: ExchangeReconciliation? = null,
    val activeLock: ActivePeriodLock? = null,
    val periodHistory: List<PeriodHistoryEvent> = emptyList(),
    val lockDate: String = "",
    val lockNotes: String = "",
    val unlockReason: String = "",
    val unlockPassword: String = "",
    val yearSnapshots: List<YearEndSnapshot> = emptyList(),
    val closeYearText: String = "",
    val closeCompanyWide: Boolean = true,
) {
    val locked get() = busy != null
    val selectedExchangeHouse get() = exchangeHouses.firstOrNull { it.id == selectedExchangeHouseId }
    val filteredAccountGroups: List<AccountGroup>
        get() {
            val q = accountQuery.trim()
            if (q.isEmpty()) return accountGroups
            return accountGroups.map { group ->
                group.copy(rows = group.rows.filter { it.code.contains(q, true) || it.name.contains(q, true) })
            }.filter { it.rows.isNotEmpty() }
        }

    fun start(operation: AccountingControlsBusy): AccountingControlsUiState? =
        if (locked) null else copy(busy = operation, error = null, notice = null)

    fun failed(message: String) = copy(
        initialized = true,
        busy = null,
        error = message,
        notice = null,
        unlockPassword = "",
    )
}

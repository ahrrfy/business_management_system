package online.alarabiya.superapp.feature.accountingControls

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.AccountingControlsDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import online.alarabiya.superapp.model.accountingControls.AccountingControlsSection
import online.alarabiya.superapp.model.accountingControls.ExchangeCommand
import online.alarabiya.superapp.model.accountingControls.ExchangeDraft
import online.alarabiya.superapp.model.accountingControls.ExchangeOperationKind
import online.alarabiya.superapp.model.accountingControls.ReconciliationCommand

class AccountingControlsViewModel(
    private val source: AccountingControlsDataSource,
    val capabilities: AccountingControlsCapabilities,
) : ViewModel() {
    var state by mutableStateOf(AccountingControlsUiState(section = firstSection(capabilities)))
        private set

    fun initialize() {
        if (!state.initialized && !state.locked) loadSection(state.section, AccountingControlsBusy.INITIAL)
    }

    fun section(value: AccountingControlsSection) {
        if (!allowed(value)) return fail("هذه المساحة غير متاحة ضمن صلاحيات الجلسة")
        state = state.copy(section = value, error = null, notice = null, unlockPassword = "")
        loadSection(value, when (value) {
            AccountingControlsSection.ACCOUNTS -> AccountingControlsBusy.ACCOUNTS
            AccountingControlsSection.EXCHANGE -> AccountingControlsBusy.EXCHANGE
            AccountingControlsSection.PERIODS -> AccountingControlsBusy.PERIODS
            AccountingControlsSection.YEAR_END -> AccountingControlsBusy.YEAR_END
        })
    }

    fun accountQuery(value: String) { state = state.copy(accountQuery = value.take(80)) }
    fun exchangeQuery(value: String) { state = state.copy(exchangeQuery = value.take(120)) }
    fun searchExchange() = loadExchange()

    fun selectExchangeHouse(id: Long?) {
        state = state.copy(
            selectedExchangeHouseId = id,
            exchangeStatement = null,
            reconciliation = null,
            reconciliationDraft = state.reconciliationDraft.copy(houseId = id ?: 0),
            error = null,
            notice = null,
        )
        if (id != null) launch(AccountingControlsBusy.EXCHANGE_STATEMENT) {
            state = state.copy(exchangeStatement = source.exchangeStatement(id))
        }
    }

    fun exchangeDraft(value: ExchangeDraft) {
        state = state.copy(
            exchangeDraft = value.copy(
                amount = value.amount.take(40),
                exchangeRate = value.exchangeRate.take(40),
                notes = value.notes.take(500),
            ),
            exchangeRequestId = null,
            error = null,
            notice = null,
        )
    }

    fun submitExchange() {
        val houseId = state.selectedExchangeHouseId ?: return fail("اختر الصيرفة")
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال للعملية")
        if (!capabilities.canWriteExchange) return fail("صلاحية الصيرفة للقراءة فقط")
        val requestId = state.exchangeRequestId ?: UUID.randomUUID().toString()
        state = state.copy(exchangeRequestId = requestId)
        val draft = state.exchangeDraft
        launch(AccountingControlsBusy.EXCHANGE_MUTATION) {
            val result = source.executeExchange(
                ExchangeCommand(
                    houseId = houseId,
                    branchId = branchId,
                    kind = draft.kind,
                    currency = draft.currency,
                    amount = draft.amount,
                    exchangeRate = draft.exchangeRate,
                    notes = draft.notes,
                    confirmNegative = draft.confirmNegative,
                    clientRequestId = requestId,
                ),
            )
            val refreshed = refreshExchangeData(houseId)
            val remainsPending = result.pendingApproval || refreshed.second.any { it.id == result.transactionId }
            state = state.copy(
                exchangeHouses = refreshed.first,
                pendingDeposits = refreshed.second,
                exchangeStatement = refreshed.third,
                exchangeDraft = ExchangeDraft(),
                exchangeRequestId = null,
                notice = if (remainsPending) "سُجل الإيداع وبانتظار اعتماد ثانٍ" else "سُجلت الحركة ${result.transactionNumber}",
            )
        }
    }

    fun approveDeposit(transactionId: Long) {
        if (!capabilities.canWriteExchange) return fail("لا توجد صلاحية اعتماد")
        launch(AccountingControlsBusy.EXCHANGE_APPROVAL) {
            source.approveExchangeDeposit(transactionId)
            val selected = state.selectedExchangeHouseId
            val refreshed = if (selected != null) refreshExchangeData(selected) else null
            state = state.copy(
                exchangeHouses = refreshed?.first ?: source.exchangeHouses(state.exchangeQuery),
                pendingDeposits = refreshed?.second ?: source.pendingExchangeDeposits(),
                exchangeStatement = refreshed?.third ?: state.exchangeStatement,
                notice = "تم اعتماد إيداع الدولار",
            )
        }
    }

    fun reconciliationDraft(value: ReconciliationCommand) {
        state = state.copy(reconciliationDraft = value, reconciliation = null, error = null)
    }

    fun reconcile() {
        launch(AccountingControlsBusy.RECONCILIATION) {
            state = state.copy(reconciliation = source.reconcileExchange(state.reconciliationDraft))
        }
    }

    fun lockDate(value: String) { state = state.copy(lockDate = value.filter { it.isDigit() || it == '-' }.take(10)) }
    fun lockNotes(value: String) { state = state.copy(lockNotes = value.take(255)) }
    fun unlockReason(value: String) { state = state.copy(unlockReason = value.take(500)) }
    fun unlockPassword(value: String) { state = state.copy(unlockPassword = value.take(128)) }

    fun lockPeriod() {
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        launch(AccountingControlsBusy.PERIOD_MUTATION) {
            source.lockPeriod(state.lockDate, state.lockNotes)
            val status = source.activePeriodLock()
            val history = source.periodHistory()
            state = state.copy(activeLock = status, periodHistory = history, lockDate = "", lockNotes = "", notice = "تم إقفال الفترة")
        }
    }

    fun unlockPeriod() {
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        launch(AccountingControlsBusy.PERIOD_MUTATION) {
            val unlocked = source.unlockPeriod(state.unlockReason, state.unlockPassword)
            val status = source.activePeriodLock()
            val history = source.periodHistory()
            state = state.copy(
                activeLock = status,
                periodHistory = history,
                unlockReason = "",
                unlockPassword = "",
                notice = if (unlocked) "تم فتح أحدث فترة مع حفظ الأثر التدقيقي" else "لا توجد فترة نشطة لفتحها",
            )
        }
    }

    fun closeYearText(value: String) { state = state.copy(closeYearText = value.filter(Char::isDigit).take(4)) }
    fun closeCompanyWide(value: Boolean) { state = state.copy(closeCompanyWide = value) }

    fun closeYear() {
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        val year = state.closeYearText.toIntOrNull() ?: return fail("أدخل سنة صحيحة")
        val branchId = if (state.closeCompanyWide) null else capabilities.branchId
            ?: return fail("لا يوجد فرع فعّال للإقفال الفرعي")
        launch(AccountingControlsBusy.YEAR_CLOSE) {
            val result = source.closeYear(year, branchId)
            state = state.copy(
                yearSnapshots = source.yearEndSnapshots(),
                closeYearText = "",
                notice = "أُقفلت سنة ${result.year} وثُبت صافي الربح ${result.netProfit}",
            )
        }
    }

    fun clearMessage() { state = state.copy(error = null, notice = null) }

    private fun loadSection(section: AccountingControlsSection, busy: AccountingControlsBusy) = when (section) {
        AccountingControlsSection.ACCOUNTS -> loadAccounts(busy)
        AccountingControlsSection.EXCHANGE -> loadExchange(busy)
        AccountingControlsSection.PERIODS -> loadPeriods(busy)
        AccountingControlsSection.YEAR_END -> loadYearEnd(busy)
    }

    private fun loadAccounts(busy: AccountingControlsBusy = AccountingControlsBusy.ACCOUNTS) {
        if (!capabilities.canReadAccounts) return fail("لا توجد صلاحية للتقارير المالية")
        launch(busy) { state = state.copy(initialized = true, accountGroups = source.accountTree()) }
    }

    private fun loadExchange(busy: AccountingControlsBusy = AccountingControlsBusy.EXCHANGE) {
        if (!capabilities.canReadExchange) return fail("عقد كشف الصيرفة الحالي غير مقيّد بالفرع")
        launch(busy) {
            val loaded = coroutineScope {
                val houses = async { source.exchangeHouses(state.exchangeQuery) }
                val pending = async { source.pendingExchangeDeposits() }
                houses.await() to pending.await()
            }
            state = state.copy(
                initialized = true,
                exchangeHouses = loaded.first,
                pendingDeposits = loaded.second,
                selectedExchangeHouseId = state.selectedExchangeHouseId?.takeIf { id -> loaded.first.any { it.id == id } },
            )
        }
    }

    private fun loadPeriods(busy: AccountingControlsBusy = AccountingControlsBusy.PERIODS) {
        if (!capabilities.canGovernPeriods) return fail("إدارة الفترات محصورة بمدير النظام")
        launch(busy) {
            val loaded = coroutineScope {
                val status = async { source.activePeriodLock() }
                val history = async { source.periodHistory() }
                status.await() to history.await()
            }
            state = state.copy(initialized = true, activeLock = loaded.first, periodHistory = loaded.second)
        }
    }

    private fun loadYearEnd(busy: AccountingControlsBusy = AccountingControlsBusy.YEAR_END) {
        if (!capabilities.canGovernPeriods) return fail("الإقفال السنوي محصور بمدير النظام")
        launch(busy) { state = state.copy(initialized = true, yearSnapshots = source.yearEndSnapshots()) }
    }

    private suspend fun refreshExchangeData(houseId: Long): Triple<List<online.alarabiya.superapp.model.accountingControls.ExchangeHouse>, List<online.alarabiya.superapp.model.accountingControls.PendingExchangeDeposit>, online.alarabiya.superapp.model.accountingControls.ExchangeStatement> = coroutineScope {
        val houses = async { source.exchangeHouses(state.exchangeQuery) }
        val pending = async { source.pendingExchangeDeposits() }
        val statement = async { source.exchangeStatement(houseId) }
        Triple(houses.await(), pending.await(), statement.await())
    }

    private fun allowed(section: AccountingControlsSection) = when (section) {
        AccountingControlsSection.ACCOUNTS -> capabilities.canReadAccounts
        AccountingControlsSection.EXCHANGE -> capabilities.canReadExchange
        AccountingControlsSection.PERIODS, AccountingControlsSection.YEAR_END -> capabilities.canGovernPeriods
    }

    private fun launch(operation: AccountingControlsBusy, block: suspend () -> Unit) {
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { if (state.busy == operation) state = state.copy(busy = null, initialized = true) }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    private fun fail(value: String) { state = state.failed(value) }
    private fun message(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    companion object {
        private fun firstSection(capabilities: AccountingControlsCapabilities) = when {
            capabilities.canReadAccounts -> AccountingControlsSection.ACCOUNTS
            capabilities.canReadExchange -> AccountingControlsSection.EXCHANGE
            capabilities.canGovernPeriods -> AccountingControlsSection.PERIODS
            else -> AccountingControlsSection.ACCOUNTS
        }
    }
}

class AccountingControlsViewModelFactory(
    private val source: AccountingControlsDataSource,
    bootstrap: AppBootstrap,
) : ViewModelProvider.Factory {
    private val capabilities = AccountingControlsCapabilities.fromBootstrap(bootstrap)

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AccountingControlsViewModel(source, capabilities) as T
}

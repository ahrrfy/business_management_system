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
        if (!state.currentSectionLoaded && !state.locked) {
            loadSection(state.section, AccountingControlsBusy.INITIAL)
        }
    }

    fun section(value: AccountingControlsSection) {
        if (!allowed(value)) return fail("هذه المساحة غير متاحة ضمن صلاحيات الجلسة")
        state = state.copy(section = value, error = null, notice = null, unlockPassword = "")
        loadSection(value, busyFor(value))
    }

    fun retryCurrentSection() {
        if (!state.locked && allowed(state.section)) loadSection(state.section, busyFor(state.section))
    }

    fun refreshFinancialReconciliation() {
        if (state.section == AccountingControlsSection.FINANCIAL_RECONCILIATION) {
            loadFinancialReconciliation()
        }
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
        if (!requireSuccessfulLoad(AccountingControlsSection.EXCHANGE)) return
        val houseId = state.selectedExchangeHouseId ?: return fail("اختر الصيرفة")
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال للعملية")
        if (!capabilities.canWriteExchange) return fail("صلاحية الصيرفة للقراءة فقط")
        val requestId = state.exchangeRequestId ?: UUID.randomUUID().toString()
        state = state.copy(exchangeRequestId = requestId)
        val draft = state.exchangeDraft
        launchMutation(AccountingControlsBusy.EXCHANGE_MUTATION, AccountingControlsSection.EXCHANGE, "سُجلت حركة الصيرفة") {
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
            state = state.copy(
                exchangeDraft = ExchangeDraft(),
                exchangeRequestId = null,
                notice = if (result.pendingApproval) "سُجل الإيداع وبانتظار اعتماد ثانٍ" else "سُجلت الحركة ${result.transactionNumber}",
            )
        }
    }

    fun approveDeposit(transactionId: Long) {
        if (!requireSuccessfulLoad(AccountingControlsSection.EXCHANGE)) return
        if (!capabilities.canWriteExchange) return fail("لا توجد صلاحية اعتماد")
        launchMutation(AccountingControlsBusy.EXCHANGE_APPROVAL, AccountingControlsSection.EXCHANGE, "تم اعتماد إيداع الدولار") {
            source.approveExchangeDeposit(transactionId)
            state = state.copy(
                pendingDeposits = state.pendingDeposits.filterNot { it.id == transactionId },
                notice = "تم اعتماد إيداع الدولار",
            )
        }
    }

    fun reconciliationDraft(value: ReconciliationCommand) {
        state = state.copy(reconciliationDraft = value, reconciliation = null, error = null)
    }

    fun reconcile() {
        if (!requireSuccessfulLoad(AccountingControlsSection.EXCHANGE)) return
        launch(AccountingControlsBusy.RECONCILIATION) {
            state = state.copy(reconciliation = source.reconcileExchange(state.reconciliationDraft))
        }
    }

    fun lockDate(value: String) { state = state.copy(lockDate = value.filter { it.isDigit() || it == '-' }.take(10)) }
    fun lockNotes(value: String) { state = state.copy(lockNotes = value.take(255)) }
    fun unlockReason(value: String) { state = state.copy(unlockReason = value.take(500)) }
    fun unlockPassword(value: String) { state = state.copy(unlockPassword = value.take(128)) }

    fun lockPeriod() {
        if (!requireSuccessfulLoad(AccountingControlsSection.PERIODS)) return
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        launchMutation(AccountingControlsBusy.PERIOD_MUTATION, AccountingControlsSection.PERIODS, "تم إقفال الفترة") {
            source.lockPeriod(state.lockDate, state.lockNotes)
            state = state.copy(lockDate = "", lockNotes = "", notice = "تم إقفال الفترة")
        }
    }

    fun unlockPeriod() {
        if (!requireSuccessfulLoad(AccountingControlsSection.PERIODS)) return
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        launchMutation(AccountingControlsBusy.PERIOD_MUTATION, AccountingControlsSection.PERIODS, "تم فتح الفترة") {
            val unlocked = source.unlockPeriod(state.unlockReason, state.unlockPassword)
            state = state.copy(
                activeLock = if (unlocked) null else state.activeLock,
                unlockReason = "",
                unlockPassword = "",
                notice = if (unlocked) "تم فتح أحدث فترة مع حفظ الأثر التدقيقي" else "لا توجد فترة نشطة لفتحها",
            )
        }
    }

    fun closeYearText(value: String) { state = state.copy(closeYearText = value.filter(Char::isDigit).take(4)) }
    fun closeCompanyWide(value: Boolean) { state = state.copy(closeCompanyWide = value) }

    fun closeYear() {
        if (!requireSuccessfulLoad(AccountingControlsSection.YEAR_END)) return
        if (!capabilities.canGovernPeriods) return fail("هذا الإجراء لمدير النظام فقط")
        val year = state.closeYearText.toIntOrNull() ?: return fail("أدخل سنة صحيحة")
        val branchId = if (state.closeCompanyWide) null else capabilities.branchId
            ?: return fail("لا يوجد فرع فعّال للإقفال الفرعي")
        launchMutation(AccountingControlsBusy.YEAR_CLOSE, AccountingControlsSection.YEAR_END, "تم إقفال السنة") {
            val result = source.closeYear(year, branchId)
            state = state.copy(
                closeYearText = "",
                notice = "أُقفلت سنة ${result.year} وثُبت صافي الربح ${result.netProfit}",
            )
        }
    }

    fun clearMessage() { state = state.copy(error = null, notice = null) }

    private fun loadSection(section: AccountingControlsSection, busy: AccountingControlsBusy) = when (section) {
        AccountingControlsSection.ACCOUNTS -> loadAccounts(busy)
        AccountingControlsSection.FINANCIAL_RECONCILIATION -> loadFinancialReconciliation(busy)
        AccountingControlsSection.EXCHANGE -> loadExchange(busy)
        AccountingControlsSection.PERIODS -> loadPeriods(busy)
        AccountingControlsSection.YEAR_END -> loadYearEnd(busy)
    }

    private fun loadAccounts(busy: AccountingControlsBusy = AccountingControlsBusy.ACCOUNTS) {
        if (!capabilities.canReadAccounts) return fail("لا توجد صلاحية للتقارير المالية")
        launch(busy, AccountingControlsSection.ACCOUNTS) {
            state = state.copy(accountGroups = source.accountTree())
        }
    }

    private fun loadFinancialReconciliation(
        busy: AccountingControlsBusy = AccountingControlsBusy.FINANCIAL_RECONCILIATION,
    ) {
        if (!capabilities.canReadFinancialReconciliation) {
            return fail("المطابقة المالية الشاملة محصورة بمدير النظام أو المالك")
        }
        launch(busy, AccountingControlsSection.FINANCIAL_RECONCILIATION) {
            state = state.copy(financialReconciliation = source.financialReconciliation())
        }
    }

    private fun loadExchange(busy: AccountingControlsBusy = AccountingControlsBusy.EXCHANGE) {
        if (!capabilities.canReadExchange) return fail("عقد كشف الصيرفة الحالي غير مقيّد بالفرع")
        launch(busy, AccountingControlsSection.EXCHANGE) {
            val loaded = coroutineScope {
                val houses = async { source.exchangeHouses(state.exchangeQuery) }
                val pending = async { source.pendingExchangeDeposits() }
                houses.await() to pending.await()
            }
            state = state.copy(
                exchangeHouses = loaded.first,
                pendingDeposits = loaded.second,
                selectedExchangeHouseId = state.selectedExchangeHouseId?.takeIf { id -> loaded.first.any { it.id == id } },
            )
        }
    }

    private fun loadPeriods(busy: AccountingControlsBusy = AccountingControlsBusy.PERIODS) {
        if (!capabilities.canGovernPeriods) return fail("إدارة الفترات محصورة بمدير النظام")
        launch(busy, AccountingControlsSection.PERIODS) {
            val loaded = coroutineScope {
                val status = async { source.activePeriodLock() }
                val history = async { source.periodHistory() }
                status.await() to history.await()
            }
            state = state.copy(activeLock = loaded.first, periodHistory = loaded.second)
        }
    }

    private fun loadYearEnd(busy: AccountingControlsBusy = AccountingControlsBusy.YEAR_END) {
        if (!capabilities.canGovernPeriods) return fail("الإقفال السنوي محصور بمدير النظام")
        launch(busy, AccountingControlsSection.YEAR_END) {
            state = state.copy(yearSnapshots = source.yearEndSnapshots())
        }
    }

    private suspend fun refreshExchangeData(houseId: Long): Triple<List<online.alarabiya.superapp.model.accountingControls.ExchangeHouse>, List<online.alarabiya.superapp.model.accountingControls.PendingExchangeDeposit>, online.alarabiya.superapp.model.accountingControls.ExchangeStatement> = coroutineScope {
        val houses = async { source.exchangeHouses(state.exchangeQuery) }
        val pending = async { source.pendingExchangeDeposits() }
        val statement = async { source.exchangeStatement(houseId) }
        Triple(houses.await(), pending.await(), statement.await())
    }

    private fun allowed(section: AccountingControlsSection) = when (section) {
        AccountingControlsSection.ACCOUNTS -> capabilities.canReadAccounts
        AccountingControlsSection.FINANCIAL_RECONCILIATION -> capabilities.canReadFinancialReconciliation
        AccountingControlsSection.EXCHANGE -> capabilities.canReadExchange
        AccountingControlsSection.PERIODS, AccountingControlsSection.YEAR_END -> capabilities.canGovernPeriods
    }

    private fun launch(
        operation: AccountingControlsBusy,
        successfulSection: AccountingControlsSection? = null,
        block: suspend () -> Unit,
    ) {
        val started = state.start(operation, invalidateSection = successfulSection) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess {
                    if (state.busy == operation) {
                        state = if (successfulSection == null) {
                            state.copy(busy = null)
                        } else {
                            state.successfulLoad(successfulSection)
                        }
                    }
                }
                .onFailure { if (state.busy == operation) state = state.failed(message(it)) }
        }
    }

    private fun launchMutation(
        operation: AccountingControlsBusy,
        section: AccountingControlsSection,
        success: String,
        block: suspend () -> Unit,
    ) {
        val started = state.start(operation, invalidateSection = section) ?: return
        state = started
        viewModelScope.launch {
            val mutation = runCatching { block() }
            if (mutation.isFailure) {
                if (state.busy == operation) state = state.failed(message(requireNotNull(mutation.exceptionOrNull())))
                return@launch
            }

            if (state.busy != operation) return@launch
            state = state.copy(notice = state.notice ?: success)
            val reload = runCatching { refreshAfterMutation(section) }
            state = if (reload.isSuccess) {
                state.successfulLoad(section)
            } else {
                state.refreshAfterMutationFailed(message(requireNotNull(reload.exceptionOrNull())))
            }
        }
    }

    private suspend fun refreshAfterMutation(section: AccountingControlsSection) {
        when (section) {
            AccountingControlsSection.EXCHANGE -> {
                val selected = state.selectedExchangeHouseId
                if (selected != null) {
                    val refreshed = refreshExchangeData(selected)
                    state = state.copy(
                        exchangeHouses = refreshed.first,
                        pendingDeposits = refreshed.second,
                        exchangeStatement = refreshed.third,
                    )
                } else {
                    val refreshed = coroutineScope {
                        val houses = async { source.exchangeHouses(state.exchangeQuery) }
                        val pending = async { source.pendingExchangeDeposits() }
                        houses.await() to pending.await()
                    }
                    state = state.copy(exchangeHouses = refreshed.first, pendingDeposits = refreshed.second)
                }
            }
            AccountingControlsSection.PERIODS -> {
                val refreshed = coroutineScope {
                    val lock = async { source.activePeriodLock() }
                    val history = async { source.periodHistory() }
                    lock.await() to history.await()
                }
                state = state.copy(activeLock = refreshed.first, periodHistory = refreshed.second)
            }
            AccountingControlsSection.YEAR_END -> state = state.copy(yearSnapshots = source.yearEndSnapshots())
            AccountingControlsSection.ACCOUNTS,
            AccountingControlsSection.FINANCIAL_RECONCILIATION,
            -> error("هذا القسم لا يملك إجراء تعديل أصلياً")
        }
    }

    private fun requireSuccessfulLoad(section: AccountingControlsSection): Boolean {
        if (state.canMutate(section)) return true
        if (!state.hasSuccessfulLoad(section)) {
            fail("تعذر تنفيذ الإجراء قبل تحميل بيانات المساحة بنجاح")
        }
        return false
    }

    private fun fail(value: String) { state = state.failed(value) }
    private fun message(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    companion object {
        private fun busyFor(section: AccountingControlsSection) = when (section) {
            AccountingControlsSection.ACCOUNTS -> AccountingControlsBusy.ACCOUNTS
            AccountingControlsSection.FINANCIAL_RECONCILIATION -> AccountingControlsBusy.FINANCIAL_RECONCILIATION
            AccountingControlsSection.EXCHANGE -> AccountingControlsBusy.EXCHANGE
            AccountingControlsSection.PERIODS -> AccountingControlsBusy.PERIODS
            AccountingControlsSection.YEAR_END -> AccountingControlsBusy.YEAR_END
        }

        private fun firstSection(capabilities: AccountingControlsCapabilities) = when {
            capabilities.canReadAccounts -> AccountingControlsSection.ACCOUNTS
            capabilities.canReadFinancialReconciliation -> AccountingControlsSection.FINANCIAL_RECONCILIATION
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

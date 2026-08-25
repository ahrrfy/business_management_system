package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.accountingControls.AccountGroup
import online.alarabiya.superapp.model.accountingControls.AccountType
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import online.alarabiya.superapp.model.accountingControls.AccountingControlsValidation
import online.alarabiya.superapp.model.accountingControls.ActivePeriodLock
import online.alarabiya.superapp.model.accountingControls.ExchangeCommand
import online.alarabiya.superapp.model.accountingControls.ExchangeCurrency
import online.alarabiya.superapp.model.accountingControls.ExchangeHouse
import online.alarabiya.superapp.model.accountingControls.ExchangeOperationKind
import online.alarabiya.superapp.model.accountingControls.ExchangeOperationResult
import online.alarabiya.superapp.model.accountingControls.ExchangeReconciliation
import online.alarabiya.superapp.model.accountingControls.ExchangeStatement
import online.alarabiya.superapp.model.accountingControls.ExchangeStatementSummary
import online.alarabiya.superapp.model.accountingControls.ExchangeTransaction
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationAxis
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationReport
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationSection
import online.alarabiya.superapp.model.accountingControls.LedgerAccount
import online.alarabiya.superapp.model.accountingControls.PendingExchangeDeposit
import online.alarabiya.superapp.model.accountingControls.PeriodHistoryEvent
import online.alarabiya.superapp.model.accountingControls.ReconciliationCommand
import online.alarabiya.superapp.model.accountingControls.YearCloseResult
import online.alarabiya.superapp.model.accountingControls.YearEndSnapshot
import org.json.JSONArray
import org.json.JSONObject

interface AccountingControlsDataSource {
    suspend fun accountTree(): List<AccountGroup>
    suspend fun financialReconciliation(): FinancialReconciliationReport
    suspend fun exchangeHouses(query: String = ""): List<ExchangeHouse>
    suspend fun exchangeStatement(houseId: Long): ExchangeStatement
    suspend fun pendingExchangeDeposits(): List<PendingExchangeDeposit>
    suspend fun executeExchange(command: ExchangeCommand): ExchangeOperationResult
    suspend fun approveExchangeDeposit(transactionId: Long): ExchangeOperationResult
    suspend fun reconcileExchange(command: ReconciliationCommand): ExchangeReconciliation
    suspend fun activePeriodLock(): ActivePeriodLock?
    suspend fun periodHistory(): List<PeriodHistoryEvent>
    suspend fun lockPeriod(cutoffDate: String, notes: String): Long
    suspend fun unlockPeriod(reason: String, password: String): Boolean
    suspend fun yearEndSnapshots(): List<YearEndSnapshot>
    suspend fun closeYear(year: Int, branchId: Long?): YearCloseResult
}

class AccountingControlsRepository(
    private val api: TrpcClient,
    private val capabilities: AccountingControlsCapabilities,
) : AccountingControlsDataSource {
    override suspend fun accountTree(): List<AccountGroup> {
        require(capabilities.canReadAccounts) { "لا توجد صلاحية قراءة للتقارير وشجرة الحسابات" }
        return api.queryArray("accounts.tree").objects().mapNotNull(JSONObject::toAccountGroupOrNull)
    }

    override suspend fun financialReconciliation(): FinancialReconciliationReport {
        require(capabilities.canReadFinancialReconciliation) {
            "المطابقة المالية الشاملة محصورة بمدير النظام أو المالك"
        }
        return api.query("reports.reconcileSummary").toFinancialReconciliationReport()
    }

    override suspend fun exchangeHouses(query: String): List<ExchangeHouse> {
        requireExchangeRead()
        return api.queryArray(
            "exchange.list",
            JSONObject().put("q", query.trim()).put("activeOnly", false).put("limit", 100).put("offset", 0),
        ).objects().mapNotNull(JSONObject::toExchangeHouseOrNull)
    }

    override suspend fun exchangeStatement(houseId: Long): ExchangeStatement {
        requireExchangeRead()
        require(houseId > 0) { "معرّف الصيرفة غير صالح" }
        return api.query("exchange.statement", JSONObject().put("exchangeHouseId", houseId)).toExchangeStatement()
    }

    override suspend fun pendingExchangeDeposits(): List<PendingExchangeDeposit> {
        requireExchangeRead()
        return api.queryArray("exchange.pendingDeposits", JSONObject()).objects()
            .mapNotNull(JSONObject::toPendingDepositOrNull)
    }

    override suspend fun executeExchange(command: ExchangeCommand): ExchangeOperationResult {
        requireExchangeWrite(command.branchId)
        AccountingControlsValidation.exchange(command)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("exchangeHouseId", command.houseId)
            .put("branchId", command.branchId)
            .put("clientRequestId", command.clientRequestId)
            .put("notes", command.notes.trim())
        return when (command.kind) {
            ExchangeOperationKind.DEPOSIT -> {
                input.put("amount", command.amount).put("currency", command.currency.name)
                if (command.currency == ExchangeCurrency.USD) input.put("exchangeRate", command.exchangeRate)
                api.mutate("exchange.deposit", input).toExchangeOperation()
            }
            ExchangeOperationKind.WITHDRAW -> {
                input.put("amount", command.amount)
                    .put("currency", command.currency.name)
                    .put("confirmNegative", command.confirmNegative)
                api.mutate("exchange.withdraw", input).toExchangeOperation()
            }
            ExchangeOperationKind.BUY_USD -> {
                input.put("usdAmount", command.amount)
                    .put("exchangeRate", command.exchangeRate)
                    .put("confirmNegative", command.confirmNegative)
                api.mutate("exchange.buyUsd", input).toExchangeOperation()
            }
        }
    }

    override suspend fun approveExchangeDeposit(transactionId: Long): ExchangeOperationResult {
        requireExchangeWrite(requireNotNull(capabilities.branchId))
        require(transactionId > 0) { "معرّف الحركة غير صالح" }
        return api.mutate("exchange.approveDeposit", JSONObject().put("txnId", transactionId)).toExchangeOperation()
    }

    override suspend fun reconcileExchange(command: ReconciliationCommand): ExchangeReconciliation {
        requireExchangeRead()
        AccountingControlsValidation.reconciliation(command)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("exchangeHouseId", command.houseId)
            .put("statedBalanceIqd", command.statedIqd)
            .put("statedBalanceUsd", command.statedUsd)
        command.asOfDate.takeIf(String::isNotBlank)?.let { input.put("asOfDate", it) }
        return api.query("exchange.reconcile", input).toReconciliation()
    }

    override suspend fun activePeriodLock(): ActivePeriodLock? {
        requireGovernance()
        val response = api.query("periodLock.status")
        return response.optJSONObject("lock")?.toActivePeriodLockOrNull()
    }

    override suspend fun periodHistory(): List<PeriodHistoryEvent> {
        requireGovernance()
        return api.query("periodLock.history", JSONObject().put("limit", 100))
            .optJSONArray("rows").objects().mapNotNull(JSONObject::toPeriodHistoryOrNull)
    }

    override suspend fun lockPeriod(cutoffDate: String, notes: String): Long {
        requireGovernance()
        AccountingControlsValidation.periodLock(cutoffDate)?.let { throw IllegalArgumentException(it) }
        return api.mutate(
            "periodLock.lock",
            JSONObject().put("cutoffDate", cutoffDate).put("notes", notes.trim()),
        ).optLong("id").takeIf { it > 0 } ?: error("لم يُرجع الخادم معرّف القفل")
    }

    override suspend fun unlockPeriod(reason: String, password: String): Boolean {
        requireGovernance()
        AccountingControlsValidation.unlock(reason, password)?.let { throw IllegalArgumentException(it) }
        return api.mutate(
            "periodLock.unlock",
            JSONObject().put("reason", reason.trim()).put("password", password),
        ).optBoolean("unlocked")
    }

    override suspend fun yearEndSnapshots(): List<YearEndSnapshot> {
        requireGovernance()
        return api.query("yearEnd.list", JSONObject()).optJSONArray("rows").objects()
            .mapNotNull(JSONObject::toYearEndSnapshotOrNull)
    }

    override suspend fun closeYear(year: Int, branchId: Long?): YearCloseResult {
        requireGovernance()
        require(year in 2020..2100) { "السنة خارج النطاق المسموح" }
        val input = JSONObject().put("year", year).put("branchId", branchId ?: JSONObject.NULL)
        return api.mutate("yearEnd.close", input).toYearCloseResult()
    }

    private fun requireExchangeRead() {
        require(capabilities.canReadExchange) {
            "كشف الصيرفة الحالي شامل للفروع؛ لا يتاح إلا لدور مالي على مستوى الشركة"
        }
    }

    private fun requireExchangeWrite(branchId: Long) {
        require(capabilities.canWriteExchange && capabilities.branchId == branchId) {
            "لا توجد صلاحية كتابة صيرفة لفرع الجلسة"
        }
    }

    private fun requireGovernance() {
        require(capabilities.canGovernPeriods) { "إقفال الفترات والسنوات محصور بمدير النظام" }
    }
}

internal fun JSONObject.toAccountGroupOrNull(): AccountGroup? {
    val type = runCatching { AccountType.valueOf(optString("type")) }.getOrNull() ?: return null
    val label = optString("label").takeIf(String::isNotBlank) ?: return null
    return AccountGroup(type, label, optJSONArray("rows").objects().mapNotNull(JSONObject::toLedgerAccountOrNull))
}

internal fun JSONObject.toFinancialReconciliationReport(): FinancialReconciliationReport {
    val runAt = nullableText("runAt") ?: error("وقت تشغيل المطابقة المالية مفقود")
    val payload = optJSONObject("sections") ?: error("محاور المطابقة المالية مفقودة")
    val axes = listOf(
        "customers" to FinancialReconciliationAxis.CUSTOMERS,
        "suppliers" to FinancialReconciliationAxis.SUPPLIERS,
        "delivery" to FinancialReconciliationAxis.DELIVERY,
        "inventory" to FinancialReconciliationAxis.INVENTORY,
        "ledger" to FinancialReconciliationAxis.LEDGER,
        // Tier-2 #4 (٢٦/٨): محور طلبات المتجر × الإرساليات. غيابه من الخريطة كان يجعل
        // Android يرمي «إجمالي المطابقة المالية غير متسق» عند أوّل انحرافٍ يكشفه الخادم.
        "onlineOrders" to FinancialReconciliationAxis.ONLINE_ORDERS,
    )
    val sections = axes.map { (key, axis) ->
        val section = payload.optJSONObject(key) ?: error("محور المطابقة المالية مفقود: $key")
        val issueCount = section.requiredNonNegativeInt("issueCount")
        val balanced = section.opt("balanced") as? Boolean
            ?: error("حالة محور المطابقة المالية مفقودة: $key")
        require(balanced == (issueCount == 0)) { "حالة محور المطابقة المالية غير متسقة: $key" }
        FinancialReconciliationSection(axis = axis, issueCount = issueCount)
    }
    val report = FinancialReconciliationReport(runAt = runAt, sections = sections)
    val totalIssueCount = requiredNonNegativeInt("totalIssueCount")
    val balanced = opt("balanced") as? Boolean ?: error("حالة المطابقة المالية مفقودة")
    require(totalIssueCount == report.totalIssueCount) { "إجمالي المطابقة المالية غير متسق" }
    require(balanced == report.balanced) { "حالة المطابقة المالية غير متسقة" }
    return report
}

internal fun JSONObject.toLedgerAccountOrNull(): LedgerAccount? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val type = runCatching { AccountType.valueOf(optString("type")) }.getOrNull() ?: return null
    return LedgerAccount(
        id = id,
        code = optString("code"),
        name = optString("name"),
        type = type,
        parentId = nullableLong("parentId"),
        systemRole = nullableText("systemRole"),
        active = optBoolean("isActive", true),
        sortOrder = optInt("sortOrder"),
    )
}

internal fun JSONObject.toExchangeHouse(): ExchangeHouse = toExchangeHouseOrNull()
    ?: error("بيانات الصيرفة غير مكتملة")

internal fun JSONObject.toExchangeHouseOrNull(): ExchangeHouse? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val name = optString("name").takeIf(String::isNotBlank) ?: return null
    return ExchangeHouse(
        id = id,
        name = name,
        phone = nullableText("phone"),
        balanceIqd = money("balanceIqd"),
        balanceUsd = money("balanceUsd"),
        usdCostRate = nullableText("usdCostRate") ?: "0",
        active = optBoolean("isActive", true),
    )
}

internal fun JSONObject.toExchangeOperation(): ExchangeOperationResult {
    val id = optLong("txnId").takeIf { it > 0 } ?: error("لم يُرجع الخادم معرّف الحركة")
    return ExchangeOperationResult(
        transactionId = id,
        transactionNumber = optString("txnNumber"),
        pendingApproval = optBoolean("pendingApproval") || optString("status") == "PENDING_APPROVAL",
        newRate = nullableText("newRate"),
    )
}

internal fun JSONObject.toPendingDepositOrNull(): PendingExchangeDeposit? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return PendingExchangeDeposit(
        id = id,
        transactionNumber = optString("txnNumber"),
        houseId = optLong("exchangeHouseId"),
        houseName = optString("houseName", "صيرفة #${optLong("exchangeHouseId")}"),
        branchId = nullableLong("branchId"),
        usdAmount = money("usdAmount"),
        exchangeRate = nullableText("exchangeRate") ?: "0",
        notes = nullableText("notes"),
        createdBy = nullableLong("createdBy"),
        createdAt = nullableText("createdAt"),
    )
}

internal fun JSONObject.toExchangeStatement(): ExchangeStatement {
    val houseJson = optJSONObject("house") ?: error("بيانات الصيرفة مفقودة")
    val house = houseJson.toExchangeHouse()
    val transactions = optJSONArray("transactions").objects().mapNotNull(JSONObject::toExchangeTransactionOrNull)
    val summary = optJSONObject("summary") ?: JSONObject()
    return ExchangeStatement(
        house = house,
        transactions = transactions,
        summary = ExchangeStatementSummary(
            depositIqd = summary.money("totalDepositIqd"),
            withdrawIqd = summary.money("totalWithdrawIqd"),
            depositUsd = summary.money("totalDepositUsd"),
            withdrawUsd = summary.money("totalWithdrawUsd"),
            settledIqd = summary.money("totalSettledIqd"),
            feesIqd = summary.money("totalFeesIqd"),
            fxDifference = summary.money("totalFxDiff"),
            usdBought = summary.money("totalUsdBought"),
            currentIqd = summary.money("currentBalanceIqd"),
            currentUsd = summary.money("currentBalanceUsd"),
        ),
    )
}

internal fun JSONObject.toExchangeTransactionOrNull(): ExchangeTransaction? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val currency = runCatching { ExchangeCurrency.valueOf(optString("currency")) }.getOrDefault(ExchangeCurrency.IQD)
    return ExchangeTransaction(
        id = id,
        transactionNumber = optString("txnNumber"),
        type = optString("type"),
        currency = currency,
        iqdAmount = money("iqdAmount"),
        usdAmount = money("usdAmount"),
        exchangeRate = nullableText("exchangeRate") ?: "0",
        feeIqd = money("commissionIqd"),
        fxDifference = money("fxDiff"),
        balanceIqdAfter = money("balanceIqdAfter"),
        balanceUsdAfter = money("balanceUsdAfter"),
        status = optString("status"),
        branchName = nullableText("branchName"),
        createdByName = nullableText("createdByName"),
        createdAt = nullableText("createdAt"),
    )
}

internal fun JSONObject.toReconciliation() = ExchangeReconciliation(
    asOfDate = nullableText("asOfDate"),
    ourIqd = money("ourBalanceIqd"),
    ourUsd = money("ourBalanceUsd"),
    statedIqd = money("statedBalanceIqd"),
    statedUsd = money("statedBalanceUsd"),
    differenceIqd = money("diffIqd"),
    differenceUsd = money("diffUsd"),
    matched = optBoolean("matched"),
    pendingCount = optJSONArray("pending")?.length() ?: 0,
)

internal fun JSONObject.toActivePeriodLockOrNull(): ActivePeriodLock? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return ActivePeriodLock(
        id = id,
        cutoffDate = optString("cutoffDate"),
        lockedAt = nullableText("lockedAt"),
        lockedBy = optLong("lockedBy"),
        notes = nullableText("notes"),
    )
}

internal fun JSONObject.toPeriodHistoryOrNull(): PeriodHistoryEvent? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return PeriodHistoryEvent(
        id = id,
        action = optString("action"),
        userName = optString("userName", "—"),
        createdAt = nullableText("createdAt"),
        cutoffDate = nullableText("cutoffDate"),
        notes = nullableText("notes"),
        reason = nullableText("reason"),
    )
}

internal fun JSONObject.toYearEndSnapshotOrNull(): YearEndSnapshot? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return YearEndSnapshot(
        id = id,
        year = optInt("year"),
        branchId = nullableLong("branchId"),
        closedAt = nullableText("closedAt"),
        closedBy = optLong("closedBy"),
        totalRevenue = money("totalRevenue"),
        totalCogs = money("totalCogs"),
        totalExpenses = money("totalExpenses"),
        netProfit = money("netProfit"),
        retainedEarningsEntryId = nullableLong("retainedEarningsEntryId"),
    )
}

internal fun JSONObject.toYearCloseResult() = YearCloseResult(
    snapshotId = optLong("snapshotId"),
    periodLockId = optLong("periodLockId"),
    retainedEarningsEntryId = nullableLong("retainedEarningsEntryId"),
    year = optInt("year"),
    branchId = nullableLong("branchId"),
    totalRevenue = money("totalRevenue"),
    totalCogs = money("totalCogs"),
    totalExpenses = money("totalExpenses"),
    netProfit = money("netProfit"),
)

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    val source = this@objects ?: return@buildList
    for (index in 0 until source.length()) source.optJSONObject(index)?.let(::add)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONObject.money(key: String): String = nullableText(key) ?: "0"

private fun JSONObject.requiredNonNegativeInt(key: String): Int {
    val value = opt(key) as? Number ?: error("قيمة مطلوبة مفقودة: $key")
    val long = value.toLong()
    require(value.toDouble() == long.toDouble() && long in 0..Int.MAX_VALUE.toLong()) {
        "قيمة خارج النطاق: $key"
    }
    return long.toInt()
}

package online.alarabiya.superapp.model.accountingControls

import online.alarabiya.superapp.model.AppBootstrap

enum class ControlAccess {
    NONE,
    READ,
    FULL;

    val canRead get() = this != NONE
    val canWrite get() = this == FULL

    companion object {
        fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class AccountingControlsCapabilities(
    val role: String,
    val isOwner: Boolean,
    val branchId: Long?,
    val allBranches: Boolean,
    val reports: ControlAccess,
    val treasury: ControlAccess,
) {
    private val effectiveRole get() = if (isOwner) "admin" else role.lowercase()
    val isAdministrator get() = effectiveRole == "admin"
    val canReadAccounts get() = reports.canRead && effectiveRole in REPORT_ROLES
    val canReadFinancialReconciliation get() = isAdministrator
    val canGovernPeriods get() = isAdministrator
    val canReadExchange get() = treasury.canRead && effectiveRole in COMPANY_TREASURY_ROLES
    val canWriteExchange get() = treasury.canWrite && effectiveRole in COMPANY_TREASURY_ROLES && branchId != null

    companion object {
        private val REPORT_ROLES = setOf("admin", "manager", "accountant", "auditor")
        private val COMPANY_TREASURY_ROLES = setOf("admin", "manager")

        fun fromBootstrap(value: AppBootstrap) = AccountingControlsCapabilities(
            role = value.user.role,
            isOwner = value.isOwner || value.user.isOwner,
            branchId = value.branchId,
            allBranches = value.allBranches,
            reports = ControlAccess.wire(value.modules.firstOrNull { it.key == "reports" }?.access),
            treasury = ControlAccess.wire(value.modules.firstOrNull { it.key == "treasury" }?.access),
        )
    }
}

enum class AccountingControlsSection { ACCOUNTS, FINANCIAL_RECONCILIATION, EXCHANGE, PERIODS, YEAR_END }

/**
 * The five independent integrity checks returned by reports.reconcile. This is deliberately
 * distinct from [ExchangeReconciliation], which compares one exchange-house statement.
 */
enum class FinancialReconciliationAxis { CUSTOMERS, SUPPLIERS, DELIVERY, INVENTORY, LEDGER, ONLINE_ORDERS }

data class FinancialReconciliationSection(
    val axis: FinancialReconciliationAxis,
    val issueCount: Int,
) {
    val balanced get() = issueCount == 0
}

/**
 * Privacy-minimised mobile projection of reports.reconcile. Entity identifiers, names, expected
 * balances, actual balances and notes are intentionally discarded at the repository boundary.
 */
data class FinancialReconciliationReport(
    val runAt: String,
    val sections: List<FinancialReconciliationSection>,
) {
    val totalIssueCount get() = sections.sumOf(FinancialReconciliationSection::issueCount)
    val balanced get() = totalIssueCount == 0
}

enum class AccountType { ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE }

data class LedgerAccount(
    val id: Long,
    val code: String,
    val name: String,
    val type: AccountType,
    val parentId: Long?,
    val systemRole: String?,
    val active: Boolean,
    val sortOrder: Int,
)

data class AccountGroup(val type: AccountType, val label: String, val rows: List<LedgerAccount>)

data class ExchangeHouse(
    val id: Long,
    val name: String,
    val phone: String?,
    val balanceIqd: String,
    val balanceUsd: String,
    val usdCostRate: String,
    val active: Boolean,
)

enum class ExchangeOperationKind { DEPOSIT, WITHDRAW, BUY_USD }
enum class ExchangeCurrency { IQD, USD }

data class ExchangeDraft(
    val kind: ExchangeOperationKind = ExchangeOperationKind.DEPOSIT,
    val currency: ExchangeCurrency = ExchangeCurrency.IQD,
    val amount: String = "",
    val exchangeRate: String = "",
    val notes: String = "",
    val confirmNegative: Boolean = false,
)

data class ExchangeCommand(
    val houseId: Long,
    val branchId: Long,
    val kind: ExchangeOperationKind,
    val currency: ExchangeCurrency,
    val amount: String,
    val exchangeRate: String = "",
    val notes: String = "",
    val confirmNegative: Boolean = false,
    val clientRequestId: String,
)

data class ExchangeOperationResult(
    val transactionId: Long,
    val transactionNumber: String,
    val pendingApproval: Boolean,
    val newRate: String?,
)

data class PendingExchangeDeposit(
    val id: Long,
    val transactionNumber: String,
    val houseId: Long,
    val houseName: String,
    val branchId: Long?,
    val usdAmount: String,
    val exchangeRate: String,
    val notes: String?,
    val createdBy: Long?,
    val createdAt: String?,
)

data class ExchangeTransaction(
    val id: Long,
    val transactionNumber: String,
    val type: String,
    val currency: ExchangeCurrency,
    val iqdAmount: String,
    val usdAmount: String,
    val exchangeRate: String,
    val feeIqd: String,
    val fxDifference: String,
    val balanceIqdAfter: String,
    val balanceUsdAfter: String,
    val status: String,
    val branchName: String?,
    val createdByName: String?,
    val createdAt: String?,
)

data class ExchangeStatementSummary(
    val depositIqd: String,
    val withdrawIqd: String,
    val depositUsd: String,
    val withdrawUsd: String,
    val settledIqd: String,
    val feesIqd: String,
    val fxDifference: String,
    val usdBought: String,
    val currentIqd: String,
    val currentUsd: String,
)

data class ExchangeStatement(
    val house: ExchangeHouse,
    val transactions: List<ExchangeTransaction>,
    val summary: ExchangeStatementSummary,
)

data class ReconciliationCommand(
    val houseId: Long,
    val statedIqd: String,
    val statedUsd: String,
    val asOfDate: String = "",
)

data class ExchangeReconciliation(
    val asOfDate: String?,
    val ourIqd: String,
    val ourUsd: String,
    val statedIqd: String,
    val statedUsd: String,
    val differenceIqd: String,
    val differenceUsd: String,
    val matched: Boolean,
    val pendingCount: Int,
)

data class ActivePeriodLock(
    val id: Long,
    val cutoffDate: String,
    val lockedAt: String?,
    val lockedBy: Long,
    val notes: String?,
)

data class PeriodHistoryEvent(
    val id: Long,
    val action: String,
    val userName: String,
    val createdAt: String?,
    val cutoffDate: String?,
    val notes: String?,
    val reason: String?,
)

data class YearEndSnapshot(
    val id: Long,
    val year: Int,
    val branchId: Long?,
    val closedAt: String?,
    val closedBy: Long,
    val totalRevenue: String,
    val totalCogs: String,
    val totalExpenses: String,
    val netProfit: String,
    val retainedEarningsEntryId: Long?,
)

data class YearCloseResult(
    val snapshotId: Long,
    val periodLockId: Long,
    val retainedEarningsEntryId: Long?,
    val year: Int,
    val branchId: Long?,
    val totalRevenue: String,
    val totalCogs: String,
    val totalExpenses: String,
    val netProfit: String,
)

object AccountingControlsValidation {
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")
    private val signedMoney = Regex("^-?\\d+(\\.\\d{1,2})?$")
    private val rate = Regex("^\\d+(\\.\\d{1,4})?$")
    private val ymd = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun exchange(command: ExchangeCommand): String? = when {
        command.houseId <= 0 || command.branchId <= 0 -> "حدّد الصيرفة والفرع"
        !money.matches(command.amount) || command.amount.toDoubleOrNull()?.let { it <= 0 } != false -> "المبلغ غير صالح"
        (command.kind == ExchangeOperationKind.BUY_USD ||
            command.kind == ExchangeOperationKind.DEPOSIT && command.currency == ExchangeCurrency.USD) &&
            (!rate.matches(command.exchangeRate) || command.exchangeRate.toDoubleOrNull()?.let { it <= 0 } != false) -> "سعر الصرف غير صالح"
        command.clientRequestId.isBlank() -> "مفتاح منع التكرار مفقود"
        else -> null
    }

    fun reconciliation(command: ReconciliationCommand): String? = when {
        command.houseId <= 0 -> "اختر الصيرفة"
        !signedMoney.matches(command.statedIqd) || !signedMoney.matches(command.statedUsd) -> "أرصدة الكشف غير صالحة"
        command.asOfDate.isNotBlank() && !ymd.matches(command.asOfDate) -> "تاريخ القطع غير صالح"
        else -> null
    }

    fun periodLock(cutoffDate: String): String? = if (ymd.matches(cutoffDate)) null else "التاريخ يجب أن يكون YYYY-MM-DD"
    fun unlock(reason: String, password: String): String? = when {
        reason.trim().length < 10 -> "سبب الفتح يجب ألا يقل عن 10 أحرف"
        password.isBlank() -> "كلمة مرور المدير مطلوبة"
        else -> null
    }
}

object AccountingControlsContractGaps {
    const val EXCHANGE_BRANCH_READ =
        "exchange list/get/statement/pendingDeposits do not scope transactions to the actor branch. Native exchange access is limited to company-wide admin/manager roles."
    const val EXCHANGE_ADMIN_BRANCH =
        "exchange money mutations require a branch. Native writes remain disabled when bootstrap has no active branch, including company admin sessions."
    const val EXCHANGE_SETTLEMENT_PICKERS =
        "exchange.settle is idempotent but requires authoritative supplier/purchase-order selection; this workspace does not accept raw identifiers as a substitute."
    const val NON_IDEMPOTENT_MASTER_WRITES =
        "exchange create/update/setActive expose no clientRequestId and are omitted from the native control plane."
    const val PERIOD_OPERATION_CAPABILITIES =
        "periodLock/yearEnd are role-only admin procedures and are not represented as operation capabilities in bootstrap."
    const val YEAR_END_PREVIEW =
        "yearEnd.close has no preview/dry-run contract; native confirmation can show intent but not independently calculate financial totals."
}

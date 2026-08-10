package online.alarabiya.superapp.model.finance

import online.alarabiya.superapp.model.AppBootstrap
import java.math.BigDecimal
import java.math.RoundingMode

@JvmInline
value class MoneyText private constructor(val value: String) {
    override fun toString(): String = value

    companion object {
        fun parseUnsigned(raw: String): MoneyText? {
            val clean = raw.trim()
            if (!clean.matches(Regex("^\\d+(\\.\\d{1,2})?$"))) return null
            return runCatching {
                val amount = BigDecimal(clean)
                if (amount.signum() < 0) null else MoneyText(amount.setScale(2, RoundingMode.UNNECESSARY).toPlainString())
            }.getOrNull()
        }

        fun fromServer(raw: String?): MoneyText = runCatching {
            MoneyText(BigDecimal(raw?.trim().orEmpty().ifBlank { "0" }).setScale(2, RoundingMode.HALF_UP).toPlainString())
        }.getOrElse { MoneyText("0.00") }
    }
}

enum class FinanceSection(val label: String) {
    OVERVIEW("الخزينة"),
    MOVEMENTS("الحركات"),
    VOUCHERS("السندات"),
    EXPENSES("المصروفات"),
    TRANSFERS("التحويلات"),
    CARD_ACCOUNT("حساب البطاقة"),
    ACCOUNTS("الحسابات"),
}

enum class FinanceItemKind { MOVEMENT, VOUCHER, EXPENSE, TRANSFER, CARD_MOVEMENT, ACCOUNT }

data class FinanceItemKey(val kind: FinanceItemKind, val id: String)

data class BranchCashBalance(
    val branchId: Long,
    val branchName: String,
    val drawerBalance: MoneyText,
    val treasuryBalance: MoneyText?,
    val openShifts: Int,
)

data class TreasuryOverview(
    val branches: List<BranchCashBalance>,
    val todayReceipts: MoneyText,
    val todayExpenses: MoneyText,
    val pendingIncomingTransfers: Int,
    val hideTreasury: Boolean,
    val generatedAt: String,
)

data class FinanceMovement(
    val key: FinanceItemKey,
    val direction: String,
    val amount: MoneyText,
    val paymentMethod: String,
    val sourceLabel: String,
    val branchName: String?,
    val description: String?,
    val reference: String?,
    val createdAt: String,
)

data class VoucherSummary(
    val key: FinanceItemKey,
    val number: String,
    val direction: String,
    val amount: MoneyText,
    val paymentMethod: String,
    val approvalStatus: String,
    val status: String,
    val description: String?,
    val counterparty: String?,
    val branchId: Long,
    val createdAt: String,
    val referenceNumber: String? = null,
    val voucherDate: String? = null,
    val categoryName: String? = null,
    val invoiceNumber: String? = null,
    val createdByName: String? = null,
    val approvedByName: String? = null,
)

data class ExpenseSummary(
    val key: FinanceItemKey,
    val category: String,
    val amount: MoneyText,
    val paymentMethod: String,
    val source: String,
    val status: String,
    val description: String?,
    val reference: String?,
    val branchName: String?,
    val expenseDate: String,
)

data class CashTransferSummary(
    val key: FinanceItemKey,
    val number: String,
    val fromBranchId: Long,
    val fromBranchName: String,
    val toBranchId: Long,
    val toBranchName: String,
    val amount: MoneyText,
    val status: String,
    val sentBy: Long?,
    val sentAt: String,
    val notes: String?,
    val cancellationReason: String?,
)

data class CardAccountSummary(
    val branchId: Long?,
    val balance: MoneyText,
    val todayIn: MoneyText,
    val todayOut: MoneyText,
    val movementCount: Int,
    val lastDifference: MoneyText?,
)

data class CardMovement(
    val key: FinanceItemKey,
    val direction: String,
    val amount: MoneyText,
    val runningBalance: MoneyText?,
    val branchName: String?,
    val partyName: String?,
    val reference: String?,
    val description: String?,
    val cardLastFour: String?,
    val source: String,
    val createdAt: String,
    val reversed: Boolean,
)

data class AccountSummary(
    val key: FinanceItemKey,
    val code: String,
    val name: String,
    val type: String,
    val parentId: Long?,
    val systemRole: String?,
    val active: Boolean,
)

sealed interface FinanceCreation {
    val branchId: Long
    val clientRequestId: String

    data class Voucher(
        override val branchId: Long,
        val voucherType: String,
        val amount: MoneyText,
        val paymentMethod: String,
        val partyType: String,
        val description: String,
        val counterpartyName: String?,
        override val clientRequestId: String,
    ) : FinanceCreation

    data class Expense(
        override val branchId: Long,
        val category: String,
        val amount: MoneyText,
        val paymentMethod: String,
        val description: String,
        val payee: String?,
        override val clientRequestId: String,
    ) : FinanceCreation

    data class Transfer(
        override val branchId: Long,
        val toBranchId: Long,
        val amount: MoneyText,
        val notes: String?,
        val confirmNegative: Boolean,
        override val clientRequestId: String,
    ) : FinanceCreation

    data class Funding(
        override val branchId: Long,
        val amount: MoneyText,
        val description: String,
        val notes: String?,
        override val clientRequestId: String,
    ) : FinanceCreation
}

data class FinanceAccessPolicy(
    val readableSections: Set<FinanceSection>,
    val writableSections: Set<FinanceSection>,
    val canFundTreasury: Boolean,
    val canReceiveOrCancelTransfer: Boolean,
    val branchId: Long?,
    val canSelectBranch: Boolean,
    val userId: Long,
    val isAdministrator: Boolean,
) {
    fun canRead(section: FinanceSection): Boolean = section in readableSections
    fun canWrite(section: FinanceSection): Boolean = section in writableSections
    fun canReceive(transfer: CashTransferSummary): Boolean =
        canReceiveOrCancelTransfer && transfer.status == "IN_TRANSIT" && (
            isAdministrator || (branchId == transfer.toBranchId && userId != transfer.sentBy)
        )

    fun canCancel(transfer: CashTransferSummary): Boolean =
        canReceiveOrCancelTransfer && transfer.status == "IN_TRANSIT" && (
            isAdministrator || branchId == transfer.fromBranchId
        )

    companion object {
        fun fromBootstrap(
            bootstrap: AppBootstrap,
            effectiveBranchId: Long? = bootstrap.branchId,
        ): FinanceAccessPolicy {
            val levels = bootstrap.modules.associate { it.key to it.access.uppercase() }
            fun reads(module: String) = levels[module] == "READ" || levels[module] == "FULL"
            fun writes(module: String) = levels[module] == "FULL"
            val role = bootstrap.user.role.lowercase()
            val treasuryOperator = role in setOf("admin", "manager", "accountant")
            val manager = role == "admin" || role == "manager"
            val reportViewer = role in setOf("admin", "manager", "accountant", "auditor")

            val readable = buildSet {
                if (reads("treasury")) add(FinanceSection.OVERVIEW)
                if (reads("treasury")) add(FinanceSection.MOVEMENTS)
                if (reads("treasury") && treasuryOperator) {
                    add(FinanceSection.VOUCHERS)
                    add(FinanceSection.TRANSFERS)
                }
                if (reads("expenses")) add(FinanceSection.EXPENSES)
                if (reads("reports") && reportViewer) {
                    add(FinanceSection.CARD_ACCOUNT)
                    add(FinanceSection.ACCOUNTS)
                }
            }
            val writable = buildSet {
                if (writes("treasury") && treasuryOperator && effectiveBranchId != null) {
                    add(FinanceSection.VOUCHERS)
                }
                // cashTransferService enforces admin/manager even though the router uses the broader
                // treasury gateway that also admits accountants.
                if (writes("treasury") && manager && (role == "admin" || effectiveBranchId != null)) {
                    add(FinanceSection.TRANSFERS)
                }
                // expenses.create is currently guarded by expensesManagerProcedure.
                if (writes("expenses") && manager) add(FinanceSection.EXPENSES)
            }
            return FinanceAccessPolicy(
                readableSections = readable,
                writableSections = writable,
                canFundTreasury = writes("treasury") && manager && (role == "admin" || effectiveBranchId != null),
                canReceiveOrCancelTransfer = FinanceSection.TRANSFERS in writable,
                branchId = effectiveBranchId,
                canSelectBranch = role == "admin",
                userId = bootstrap.user.id,
                isAdministrator = role == "admin",
            )
        }
    }
}

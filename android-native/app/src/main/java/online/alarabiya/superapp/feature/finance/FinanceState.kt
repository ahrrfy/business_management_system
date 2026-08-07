package online.alarabiya.superapp.feature.finance

import online.alarabiya.superapp.data.CardMovementsPage
import online.alarabiya.superapp.data.ExpensePage
import online.alarabiya.superapp.data.FinancePage
import online.alarabiya.superapp.model.finance.AccountSummary
import online.alarabiya.superapp.model.finance.CardAccountSummary
import online.alarabiya.superapp.model.finance.CardMovement
import online.alarabiya.superapp.model.finance.CashTransferSummary
import online.alarabiya.superapp.model.finance.ExpenseSummary
import online.alarabiya.superapp.model.finance.FinanceCreation
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceItemKind
import online.alarabiya.superapp.model.finance.FinanceMovement
import online.alarabiya.superapp.model.finance.FinanceSection
import online.alarabiya.superapp.model.finance.MoneyText
import online.alarabiya.superapp.model.finance.TreasuryOverview
import online.alarabiya.superapp.model.finance.VoucherSummary

enum class FinanceComposerKind { VOUCHER, EXPENSE, TRANSFER, FUNDING }

data class FinanceDraft(
    val kind: FinanceComposerKind,
    val branchId: String,
    val amount: String = "",
    val description: String = "",
    val secondaryText: String = "",
    val targetBranchId: String = "",
    val paymentMethod: String = "CASH",
    val voucherType: String = "RECEIPT",
    val partyType: String = "OTHER",
    val confirmNegative: Boolean = false,
    val clientRequestId: String,
) {
    fun validationError(): String? {
        val source = branchId.toLongOrNull()?.takeIf { it > 0 }
            ?: return "اختر فرعاً صالحاً"
        val money = MoneyText.parseUnsigned(amount) ?: return "أدخل مبلغاً صحيحاً بمنزلتين عشريتين كحد أقصى"
        if (money.value == "0.00") return "يجب أن يكون المبلغ أكبر من صفر"
        if (kind != FinanceComposerKind.TRANSFER && description.trim().isEmpty()) return "الوصف مطلوب"
        if (description.length > 500 || secondaryText.length > 500) return "النص يجب ألا يتجاوز 500 حرف"
        if (kind == FinanceComposerKind.TRANSFER) {
            val target = targetBranchId.toLongOrNull()?.takeIf { it > 0 }
                ?: return "أدخل معرّف الفرع المستلم"
            if (source == target) return "لا يمكن التحويل إلى الفرع نفسه"
        }
        return null
    }

    fun toCommand(): FinanceCreation {
        validationError()?.let { throw IllegalArgumentException(it) }
        val source = branchId.toLong()
        val money = requireNotNull(MoneyText.parseUnsigned(amount))
        return when (kind) {
            FinanceComposerKind.VOUCHER -> FinanceCreation.Voucher(
                branchId = source,
                voucherType = voucherType,
                amount = money,
                paymentMethod = paymentMethod,
                partyType = partyType,
                description = description.trim(),
                counterpartyName = secondaryText.trim().takeIf(String::isNotEmpty),
                clientRequestId = clientRequestId,
            )
            FinanceComposerKind.EXPENSE -> FinanceCreation.Expense(
                branchId = source,
                category = secondaryText.trim().ifBlank { "OTHER" },
                amount = money,
                paymentMethod = paymentMethod,
                description = description.trim(),
                payee = null,
                clientRequestId = clientRequestId,
            )
            FinanceComposerKind.TRANSFER -> FinanceCreation.Transfer(
                branchId = source,
                toBranchId = targetBranchId.toLong(),
                amount = money,
                notes = secondaryText.trim().takeIf(String::isNotEmpty),
                confirmNegative = confirmNegative,
                clientRequestId = clientRequestId,
            )
            FinanceComposerKind.FUNDING -> FinanceCreation.Funding(
                branchId = source,
                amount = money,
                description = description.trim(),
                notes = secondaryText.trim().takeIf(String::isNotEmpty),
                clientRequestId = clientRequestId,
            )
        }
    }
}

enum class TransferAction { RECEIVE, CANCEL }

data class PendingTransferAction(
    val transferKey: FinanceItemKey,
    val action: TransferAction,
    val reason: String = "",
)

data class FinanceUiState(
    val section: FinanceSection,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadedSections: Set<FinanceSection> = emptySet(),
    val hasMoreSections: Set<FinanceSection> = emptySet(),
    val overview: TreasuryOverview? = null,
    val movements: List<FinanceMovement> = emptyList(),
    val vouchers: List<VoucherSummary> = emptyList(),
    val expenses: List<ExpenseSummary> = emptyList(),
    val expenseTotal: MoneyText = MoneyText.fromServer("0"),
    val expenseCount: Int = 0,
    val transfers: List<CashTransferSummary> = emptyList(),
    val cardSummary: CardAccountSummary? = null,
    val cardMovements: List<CardMovement> = emptyList(),
    val accounts: List<AccountSummary> = emptyList(),
    val selectedKey: FinanceItemKey? = null,
    val detailLoadingKey: FinanceItemKey? = null,
    val composer: FinanceDraft? = null,
    val createConfirmation: FinanceDraft? = null,
    val transferConfirmation: PendingTransferAction? = null,
    val submitting: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
) {
    val visibleKeys: Set<FinanceItemKey>
        get() = when (section) {
            FinanceSection.OVERVIEW -> emptySet()
            FinanceSection.MOVEMENTS -> movements.mapTo(mutableSetOf()) { it.key }
            FinanceSection.VOUCHERS -> vouchers.mapTo(mutableSetOf()) { it.key }
            FinanceSection.EXPENSES -> expenses.mapTo(mutableSetOf()) { it.key }
            FinanceSection.TRANSFERS -> transfers.mapTo(mutableSetOf()) { it.key }
            FinanceSection.CARD_ACCOUNT -> cardMovements.mapTo(mutableSetOf()) { it.key }
            FinanceSection.ACCOUNTS -> accounts.mapTo(mutableSetOf()) { it.key }
        }

    fun startLoading(refresh: Boolean) = copy(
        loading = !refresh,
        refreshing = refresh,
        error = null,
        notice = null,
    )

    fun finishLoading(section: FinanceSection): FinanceUiState {
        val retained = selectedKey?.takeIf { it in visibleKeys }
        return copy(
            loading = false,
            refreshing = false,
            loadedSections = loadedSections + section,
            selectedKey = retained,
            detailLoadingKey = null,
            error = null,
        )
    }

    private fun withMore(section: FinanceSection, hasMore: Boolean) = copy(
        hasMoreSections = if (hasMore) hasMoreSections + section else hasMoreSections - section,
    )

    fun withMovements(page: FinancePage<FinanceMovement>, append: Boolean = false) =
        copy(movements = if (append) movements + page.rows else page.rows)
            .withMore(FinanceSection.MOVEMENTS, page.hasMore)
    fun withVouchers(page: FinancePage<VoucherSummary>, append: Boolean = false) =
        copy(vouchers = if (append) vouchers + page.rows else page.rows)
            .withMore(FinanceSection.VOUCHERS, page.hasMore)
    fun withExpenses(page: ExpensePage, append: Boolean = false) = copy(
        expenses = if (append) expenses + page.rows else page.rows,
        expenseTotal = page.activeTotal,
        expenseCount = page.activeCount,
    ).withMore(FinanceSection.EXPENSES, page.hasMore)
    fun withTransfers(page: FinancePage<CashTransferSummary>, append: Boolean = false) =
        copy(transfers = if (append) transfers + page.rows else page.rows)
            .withMore(FinanceSection.TRANSFERS, page.hasMore)
    fun withCard(page: CardMovementsPage, append: Boolean = false) =
        copy(cardMovements = if (append) cardMovements + page.rows else page.rows)
            .withMore(FinanceSection.CARD_ACCOUNT, page.hasMore)

    fun failed(message: String) = copy(
        loading = false,
        refreshing = false,
        submitting = false,
        createConfirmation = null,
        transferConfirmation = null,
        detailLoadingKey = null,
        error = message,
    )
}

fun FinanceUiState.select(key: FinanceItemKey?): FinanceUiState =
    if (key == null || key in visibleKeys) copy(selectedKey = key, error = null) else this

fun FinanceItemKey.numericId(): Long? = id.toLongOrNull()?.takeIf { it > 0 }

fun FinanceSection.expectedKind(): FinanceItemKind? = when (this) {
    FinanceSection.MOVEMENTS -> FinanceItemKind.MOVEMENT
    FinanceSection.VOUCHERS -> FinanceItemKind.VOUCHER
    FinanceSection.EXPENSES -> FinanceItemKind.EXPENSE
    FinanceSection.TRANSFERS -> FinanceItemKind.TRANSFER
    FinanceSection.CARD_ACCOUNT -> FinanceItemKind.CARD_MOVEMENT
    FinanceSection.ACCOUNTS -> FinanceItemKind.ACCOUNT
    FinanceSection.OVERVIEW -> null
}

package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.finance.AccountSummary
import online.alarabiya.superapp.model.finance.BranchCashBalance
import online.alarabiya.superapp.model.finance.CardAccountSummary
import online.alarabiya.superapp.model.finance.CardMovement
import online.alarabiya.superapp.model.finance.CashTransferSummary
import online.alarabiya.superapp.model.finance.ExpenseSummary
import online.alarabiya.superapp.model.finance.FinanceCreation
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceItemKind
import online.alarabiya.superapp.model.finance.FinanceMovement
import online.alarabiya.superapp.model.finance.MoneyText
import online.alarabiya.superapp.model.finance.TreasuryOverview
import online.alarabiya.superapp.model.finance.VoucherSummary
import org.json.JSONArray
import org.json.JSONObject

data class FinancePage<T>(val rows: List<T>, val hasMore: Boolean)

data class ExpensePage(
    val rows: List<ExpenseSummary>,
    val activeTotal: MoneyText,
    val activeCount: Int,
    val hasMore: Boolean,
)

data class CardMovementsPage(
    val rows: List<CardMovement>,
    val totalIn: MoneyText,
    val totalOut: MoneyText,
    val net: MoneyText,
    val hasMore: Boolean,
)

data class FinanceCreationReceipt(
    val id: Long?,
    val reference: String?,
    val idempotent: Boolean,
)

data class TreasuryDashboardPayload(
    val drawerBalances: List<DrawerBalancePayload>,
    val treasuryBalances: List<TreasuryBalancePayload>,
    val todayReceiptsTotal: String,
    val todayExpensesTotal: String,
    val pendingIncomingTransfers: Int,
    val hideTreasury: Boolean,
    val generatedAt: String,
)

data class DrawerBalancePayload(
    val branchId: Long,
    val branchName: String,
    val expectedCash: String,
    val openShiftsCount: Int,
)

data class TreasuryBalancePayload(val branchId: Long, val balance: String)

data class VoucherPayload(
    val id: Long,
    val voucherNumber: String,
    val branchId: Long,
    val direction: String,
    val amount: String,
    val paymentMethod: String,
    val approvalStatus: String,
    val status: String,
    val description: String?,
    val counterpartyName: String?,
    val createdAt: String,
    val referenceNumber: String? = null,
    val voucherDate: String? = null,
    val categoryName: String? = null,
    val invoiceNumber: String? = null,
    val createdByName: String? = null,
    val approvedByName: String? = null,
)

object FinanceMapper {
    fun treasury(payload: TreasuryDashboardPayload): TreasuryOverview {
        val treasuryByBranch = payload.treasuryBalances.associate { it.branchId to it.balance }
        return TreasuryOverview(
            branches = payload.drawerBalances.map { drawer ->
                BranchCashBalance(
                    branchId = drawer.branchId,
                    branchName = drawer.branchName,
                    drawerBalance = MoneyText.fromServer(drawer.expectedCash),
                    treasuryBalance = treasuryByBranch[drawer.branchId]
                        ?.takeUnless { payload.hideTreasury }
                        ?.let { MoneyText.fromServer(it) },
                    openShifts = drawer.openShiftsCount,
                )
            },
            todayReceipts = MoneyText.fromServer(payload.todayReceiptsTotal),
            todayExpenses = MoneyText.fromServer(payload.todayExpensesTotal),
            pendingIncomingTransfers = payload.pendingIncomingTransfers,
            hideTreasury = payload.hideTreasury,
            generatedAt = payload.generatedAt,
        )
    }

    fun voucher(payload: VoucherPayload): VoucherSummary? {
        if (payload.id <= 0 || payload.branchId <= 0) return null
        return VoucherSummary(
            key = FinanceItemKey(FinanceItemKind.VOUCHER, payload.id.toString()),
            number = payload.voucherNumber,
            direction = payload.direction,
            amount = MoneyText.fromServer(payload.amount),
            paymentMethod = payload.paymentMethod,
            approvalStatus = payload.approvalStatus,
            status = payload.status,
            description = payload.description,
            counterparty = payload.counterpartyName,
            branchId = payload.branchId,
            createdAt = payload.createdAt,
            referenceNumber = payload.referenceNumber,
            voucherDate = payload.voucherDate,
            categoryName = payload.categoryName,
            invoiceNumber = payload.invoiceNumber,
            createdByName = payload.createdByName,
            approvedByName = payload.approvedByName,
        )
    }
}

interface FinanceDataSource {
    suspend fun loadOverview(branchId: Long?): TreasuryOverview
    suspend fun loadMovements(branchId: Long?, offset: Int = 0): FinancePage<FinanceMovement>
    suspend fun loadVouchers(branchId: Long?, offset: Int = 0): FinancePage<VoucherSummary>
    suspend fun loadVoucher(receiptId: Long): VoucherSummary
    suspend fun loadExpenses(branchId: Long?, offset: Int = 0): ExpensePage
    suspend fun loadTransfers(branchId: Long?, offset: Int = 0): FinancePage<CashTransferSummary>
    suspend fun loadCardSummary(branchId: Long?): CardAccountSummary
    suspend fun loadCardMovements(branchId: Long?, offset: Int = 0): CardMovementsPage
    suspend fun loadAccounts(): List<AccountSummary>
    suspend fun create(command: FinanceCreation): FinanceCreationReceipt
    suspend fun receiveTransfer(transferId: Long)
    suspend fun cancelTransfer(transferId: Long, reason: String)
}

/**
 * Typed native facade over the existing finance contracts.
 *
 * Known API gaps (2026-08-06):
 * - expenses and cash transfers have no dedicated detail query; their list rows are the detail source.
 * - expense list rows omit `createdBy`; the native surface therefore does not expose cancellation because
 *   it cannot pre-enforce the server's maker-checker rule without a truthful detail contract.
 * - transfer receive/cancel and card reconciliation have no idempotency key. The native UI serializes taps,
 *   but the server's state transition remains the final concurrency guard.
 * - there is no branch-directory query in this contract group, so transfer creation accepts a numeric target
 *   branch identifier until a permission-scoped directory is exposed.
 * - bootstrap reports effective access but not whether a nonstandard report grant is explicit; accounts/card
 *   views therefore follow the server's standard report-viewer roles conservatively.
 * - voucher creation rejects a branchless session, including an administrator.
 */
class FinanceRepository(private val api: TrpcClient) : FinanceDataSource {
    override suspend fun loadOverview(branchId: Long?): TreasuryOverview {
        val json = api.query("treasury.getDashboard", optionalBranch(branchId))
        return FinanceMapper.treasury(json.toDashboardPayload())
    }

    override suspend fun loadMovements(branchId: Long?, offset: Int): FinancePage<FinanceMovement> {
        val input = optionalBranch(branchId).put("limit", PAGE_SIZE).put("offset", offset)
        val response = api.query("treasury.getRecentMovements", input)
        return FinancePage(
            rows = response.optJSONArray("rows").objects().mapNotNull(JSONObject::toMovement),
            hasMore = response.optBoolean("hasMore"),
        )
    }

    override suspend fun loadVouchers(branchId: Long?, offset: Int): FinancePage<VoucherSummary> {
        val input = optionalBranch(branchId).put("limit", PAGE_SIZE).put("offset", offset)
        val rows = api.queryArray("vouchers.list", input).objects()
            .mapNotNull { FinanceMapper.voucher(it.toVoucherPayload()) }
        return FinancePage(rows, rows.size == PAGE_SIZE)
    }

    override suspend fun loadVoucher(receiptId: Long): VoucherSummary {
        require(receiptId > 0) { "معرّف السند غير صالح" }
        val json = api.query("vouchers.get", JSONObject().put("receiptId", receiptId))
        return FinanceMapper.voucher(json.toVoucherPayload())
            ?: throw IllegalStateException("لم يعد السند متاحاً")
    }

    override suspend fun loadExpenses(branchId: Long?, offset: Int): ExpensePage {
        val input = optionalBranch(branchId).put("limit", PAGE_SIZE).put("offset", offset)
        val response = api.query("expenses.list", input)
        val totals = response.optJSONObject("totals") ?: JSONObject()
        return ExpensePage(
            rows = response.optJSONArray("rows").objects().mapNotNull(JSONObject::toExpense),
            activeTotal = MoneyText.fromServer(totals.nullableText("active")),
            activeCount = totals.optInt("count"),
            hasMore = response.optBoolean("hasMore"),
        )
    }

    override suspend fun loadTransfers(branchId: Long?, offset: Int): FinancePage<CashTransferSummary> {
        val input = optionalBranch(branchId)
            .put("direction", "ALL")
            .put("limit", PAGE_SIZE)
            .put("offset", offset)
        val rows = api.queryArray("cashTransfers.list", input).objects().mapNotNull(JSONObject::toTransfer)
        return FinancePage(rows, rows.size == PAGE_SIZE)
    }

    override suspend fun loadCardSummary(branchId: Long?): CardAccountSummary {
        val json = api.query("cardAccount.summary", optionalBranch(branchId))
        return CardAccountSummary(
            branchId = json.nullableLong("branchId"),
            balance = MoneyText.fromServer(json.nullableText("balance")),
            todayIn = MoneyText.fromServer(json.nullableText("todayIn")),
            todayOut = MoneyText.fromServer(json.nullableText("todayOut")),
            movementCount = json.optInt("movementCount"),
            lastDifference = json.optJSONObject("lastReconciliation")
                ?.nullableText("difference")?.let { MoneyText.fromServer(it) },
        )
    }

    override suspend fun loadCardMovements(branchId: Long?, offset: Int): CardMovementsPage {
        val input = optionalBranch(branchId).put("limit", PAGE_SIZE).put("offset", offset)
        val json = api.query("cardAccount.movements", input)
        return CardMovementsPage(
            rows = json.optJSONArray("rows").objects().mapNotNull(JSONObject::toCardMovement),
            totalIn = MoneyText.fromServer(json.nullableText("totalIn")),
            totalOut = MoneyText.fromServer(json.nullableText("totalOut")),
            net = MoneyText.fromServer(json.nullableText("net")),
            hasMore = json.optBoolean("hasMore"),
        )
    }

    override suspend fun loadAccounts(): List<AccountSummary> =
        api.queryArray("accounts.list").objects().mapNotNull(JSONObject::toAccount)

    override suspend fun create(command: FinanceCreation): FinanceCreationReceipt {
        val (procedure, input) = when (command) {
            is FinanceCreation.Voucher -> "vouchers.create" to JSONObject()
                .put("voucherType", command.voucherType)
                .put("branchId", command.branchId)
                .put("amount", command.amount.value)
                .put("paymentMethod", command.paymentMethod)
                .put("partyType", command.partyType)
                .put("description", command.description)
                .putNullable("counterpartyName", command.counterpartyName)
                .put("clientRequestId", command.clientRequestId)
            is FinanceCreation.Expense -> "expenses.create" to JSONObject()
                .put("branchId", command.branchId)
                .put("category", command.category)
                .put("amount", command.amount.value)
                .put("paymentMethod", command.paymentMethod)
                .put("source", "CASH")
                .put("description", command.description)
                .putNullable("payee", command.payee)
                .put("clientRequestId", command.clientRequestId)
            is FinanceCreation.Transfer -> "cashTransfers.send" to JSONObject()
                .put("fromBranchId", command.branchId)
                .put("toBranchId", command.toBranchId)
                .put("amount", command.amount.value)
                .putNullable("notes", command.notes)
                .put("confirmNegative", command.confirmNegative)
                .put("clientRequestId", command.clientRequestId)
            is FinanceCreation.Funding -> "treasury.fundTreasury" to JSONObject()
                .put("branchId", command.branchId)
                .put("amount", command.amount.value)
                .put("description", command.description)
                .putNullable("notes", command.notes)
                .put("clientRequestId", command.clientRequestId)
        }
        val response = api.mutate(procedure, input)
        return response.toCreationReceipt()
    }

    override suspend fun receiveTransfer(transferId: Long) {
        require(transferId > 0) { "معرّف التحويل غير صالح" }
        api.mutate("cashTransfers.receive", JSONObject().put("transferId", transferId))
    }

    override suspend fun cancelTransfer(transferId: Long, reason: String) {
        require(transferId > 0) { "معرّف التحويل غير صالح" }
        val clean = reason.trim()
        require(clean.length in 3..500) { "سبب الإلغاء يجب أن يكون بين 3 و500 حرف" }
        api.mutate("cashTransfers.cancel", JSONObject().put("transferId", transferId).put("reason", clean))
    }

    private companion object { const val PAGE_SIZE = 50 }
}

private fun optionalBranch(branchId: Long?) = JSONObject().apply { branchId?.let { put("branchId", it) } }

private fun JSONObject.toDashboardPayload() = TreasuryDashboardPayload(
    drawerBalances = optJSONArray("drawerBalances").objects().map {
        DrawerBalancePayload(
            branchId = it.optLong("branchId"),
            branchName = it.optString("branchName"),
            expectedCash = it.optString("expectedCash", "0"),
            openShiftsCount = it.optInt("openShiftsCount"),
        )
    },
    treasuryBalances = optJSONArray("treasuryBalances").objects().map {
        TreasuryBalancePayload(it.optLong("branchId"), it.optString("balance", "0"))
    },
    todayReceiptsTotal = optString("todayReceiptsTotal", "0"),
    todayExpensesTotal = optString("todayExpensesTotal", "0"),
    pendingIncomingTransfers = optInt("pendingIncomingTransfers"),
    hideTreasury = optBoolean("hideTreasury"),
    generatedAt = optString("generatedAt"),
)

private fun JSONObject.toVoucherPayload() = VoucherPayload(
    id = optLong("id"),
    voucherNumber = optString("voucherNumber"),
    branchId = optLong("branchId"),
    direction = optString("direction"),
    amount = optString("amount", "0"),
    paymentMethod = optString("paymentMethod"),
    approvalStatus = optString("approvalStatus"),
    status = optString("status"),
    description = nullableText("description"),
    counterpartyName = nullableText("partyName") ?: nullableText("counterpartyName"),
    createdAt = optString("createdAt"),
    referenceNumber = nullableText("referenceNumber"),
    voucherDate = nullableText("voucherDate"),
    categoryName = nullableText("categoryName"),
    invoiceNumber = nullableText("invoiceNumber"),
    createdByName = nullableText("createdByName"),
    approvedByName = nullableText("approvedByName"),
)

private fun JSONObject.toMovement(): FinanceMovement? {
    val id = nullableText("id") ?: return null
    return FinanceMovement(
        key = FinanceItemKey(FinanceItemKind.MOVEMENT, id),
        direction = optString("direction"),
        amount = MoneyText.fromServer(nullableText("amount")),
        paymentMethod = optString("paymentMethodLabel").ifBlank { optString("paymentMethod") },
        sourceLabel = optString("source"),
        branchName = nullableText("branchName"),
        description = nullableText("description"),
        reference = nullableText("voucherNumber"),
        createdAt = optString("createdAt"),
    )
}

private fun JSONObject.toExpense(): ExpenseSummary? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return ExpenseSummary(
        key = FinanceItemKey(FinanceItemKind.EXPENSE, id.toString()),
        category = optString("category"),
        amount = MoneyText.fromServer(nullableText("amount")),
        paymentMethod = optString("paymentMethod"),
        source = optString("source"),
        status = optString("status"),
        description = nullableText("description"),
        reference = nullableText("referenceNumber"),
        branchName = nullableText("branchName"),
        expenseDate = optString("expenseDate"),
    )
}

private fun JSONObject.toTransfer(): CashTransferSummary? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return CashTransferSummary(
        key = FinanceItemKey(FinanceItemKind.TRANSFER, id.toString()),
        number = optString("transferNumber"),
        fromBranchId = optLong("fromBranchId"),
        fromBranchName = optString("fromBranchName"),
        toBranchId = optLong("toBranchId"),
        toBranchName = optString("toBranchName"),
        amount = MoneyText.fromServer(nullableText("amount")),
        status = optString("status"),
        sentBy = nullableLong("sentBy"),
        sentAt = optString("sentAt"),
        notes = nullableText("notes"),
        cancellationReason = nullableText("cancellationReason"),
    )
}

private fun JSONObject.toCardMovement(): CardMovement? {
    val id = optLong("receiptId").takeIf { it > 0 } ?: return null
    return CardMovement(
        key = FinanceItemKey(FinanceItemKind.CARD_MOVEMENT, id.toString()),
        direction = optString("direction"),
        amount = MoneyText.fromServer(nullableText("amount")),
        runningBalance = nullableText("runningBalance")?.let { MoneyText.fromServer(it) },
        branchName = nullableText("branchName"),
        partyName = nullableText("partyName"),
        reference = nullableText("referenceNumber") ?: nullableText("voucherNumber"),
        description = nullableText("description"),
        cardLastFour = nullableText("cardLastFour"),
        source = optString("source"),
        createdAt = optString("createdAt"),
        reversed = optBoolean("reversed"),
    )
}

private fun JSONObject.toAccount(): AccountSummary? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return AccountSummary(
        key = FinanceItemKey(FinanceItemKind.ACCOUNT, id.toString()),
        code = optString("code"),
        name = optString("name"),
        type = optString("type"),
        parentId = nullableLong("parentId"),
        systemRole = nullableText("systemRole"),
        active = optBoolean("isActive", true),
    )
}

private fun JSONObject.toCreationReceipt(): FinanceCreationReceipt {
    val id = listOf("receiptId", "expenseId", "transferId", "id")
        .firstNotNullOfOrNull { key -> nullableLong(key)?.takeIf { it > 0 } }
    val reference = listOf("voucherNumber", "transferNumber", "referenceNumber")
        .firstNotNullOfOrNull { key -> nullableText(key) }
    return FinanceCreationReceipt(id, reference, optBoolean("idempotent"))
}

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it != 0L }

private fun JSONObject.putNullable(key: String, value: String?): JSONObject = apply {
    value?.trim()?.takeIf(String::isNotEmpty)?.let { put(key, it) }
}

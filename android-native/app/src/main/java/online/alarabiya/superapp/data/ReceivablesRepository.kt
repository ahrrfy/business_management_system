package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.receivables.AccountGroup
import online.alarabiya.superapp.model.receivables.AccountType
import online.alarabiya.superapp.model.receivables.CardDirection
import online.alarabiya.superapp.model.receivables.CardFilters
import online.alarabiya.superapp.model.receivables.CardMovement
import online.alarabiya.superapp.model.receivables.CardMovementPage
import online.alarabiya.superapp.model.receivables.CardReconciliation
import online.alarabiya.superapp.model.receivables.CardSource
import online.alarabiya.superapp.model.receivables.CardSummary
import online.alarabiya.superapp.model.receivables.DueInstallment
import online.alarabiya.superapp.model.receivables.InstallmentFilters
import online.alarabiya.superapp.model.receivables.InstallmentKind
import online.alarabiya.superapp.model.receivables.InstallmentLine
import online.alarabiya.superapp.model.receivables.InstallmentLineStatus
import online.alarabiya.superapp.model.receivables.InstallmentPage
import online.alarabiya.superapp.model.receivables.InstallmentPaymentMethod
import online.alarabiya.superapp.model.receivables.InstallmentPaymentResult
import online.alarabiya.superapp.model.receivables.InstallmentPlanDetail
import online.alarabiya.superapp.model.receivables.InstallmentPlanSummary
import online.alarabiya.superapp.model.receivables.InstallmentStatus
import online.alarabiya.superapp.model.receivables.LedgerAccount
import online.alarabiya.superapp.model.receivables.NewInstallmentPlan
import online.alarabiya.superapp.model.receivables.ReceivablesMoney
import online.alarabiya.superapp.model.receivables.ReconciliationDraft
import online.alarabiya.superapp.model.receivables.ReminderHistoryItem
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem
import online.alarabiya.superapp.model.receivables.ReminderSendResult
import online.alarabiya.superapp.model.receivables.ReminderStatus
import online.alarabiya.superapp.model.receivables.ReminderSubject
import org.json.JSONArray
import org.json.JSONObject

data class ReminderSnapshot(
    val ledger: ReminderLedger,
    val subjectId: Long,
    val totalUnpaid: String,
    val oldestDocumentDate: String,
    val daysOverdue: Int,
    val openingBalance: Boolean,
)

interface ReceivablesDataSource {
    suspend fun installmentPlans(filters: InstallmentFilters, offset: Int = 0): InstallmentPage
    suspend fun installmentPlan(planId: Long): InstallmentPlanDetail
    suspend fun dueInstallments(branchId: Long?, days: Int): List<DueInstallment>
    suspend fun createInstallmentPlan(draft: NewInstallmentPlan): Long
    suspend fun payInstallment(lineId: Long, method: InstallmentPaymentMethod, note: String?): InstallmentPaymentResult
    suspend fun cancelInstallmentPlan(planId: Long, reason: String)
    suspend fun bounceLegacyCheck(lineId: Long, note: String?): Boolean

    suspend fun reminderQueue(ledger: ReminderLedger, branchId: Long?, aggregate: Boolean): List<ReminderQueueItem>
    suspend fun reminderHistory(ledger: ReminderLedger, branchId: Long?, aggregate: Boolean): List<ReminderHistoryItem>
    suspend fun sendReminder(snapshot: ReminderSnapshot, branchId: Long): ReminderSendResult
    suspend fun skipReminder(snapshot: ReminderSnapshot, branchId: Long, reason: String, promisedDate: String?)

    suspend fun cardSummary(branchId: Long?): CardSummary
    suspend fun cardMovements(filters: CardFilters, offset: Int = 0): CardMovementPage
    suspend fun cardReconciliations(branchId: Long?): List<CardReconciliation>
    suspend fun createCardReconciliation(draft: ReconciliationDraft): CardReconciliation
    suspend fun accountTree(): List<AccountGroup>
}

/**
 * Contract notes (2026-08-06):
 * - installment list has cursor-like offset/hasMore only when q/from/to are absent. Server-side filtered search
 *   scans at most the first 200 base rows, so the UI does not describe it as exhaustive.
 * - dueSoon is capped at 200 and exposes no count/hasMore. The UI flags a full result as potentially truncated.
 * - reminder queues are complete server decisions (aging, promises and cooldown). Native never recomputes debt,
 *   overdue eligibility or message amounts. History is a limit-only 30-day view without a next-page contract.
 * - manual WhatsApp logSent is intentionally unsupported: logging after an external app return cannot prove send.
 *   Only sendViaApi is offered, behind an explicit native confirmation; a skipped server result remains unsent.
 * - AP all-branch queue has no per-row branch provenance, so write actions are disabled in aggregate mode.
 * - account tree is read-only. Reconciliation difference/system balance and installment sums are server-calculated.
 * - installment create/cancel, reminder actions and reconciliation do not accept a clientRequestId. Native blocks
 *   duplicate taps but does not auto-retry an ambiguous mutation; installment pay is idempotent on the server.
 * - no permission-scoped branch directory is exposed by these contracts. Administrator filters therefore accept a
 *   validated numeric branch id instead of inventing branch choices.
 * - bootstrap lacks explicit-grant provenance, so policy is conservative for nonstandard roles.
 */
class ReceivablesRepository(private val api: TrpcClient) : ReceivablesDataSource {
    override suspend fun installmentPlans(filters: InstallmentFilters, offset: Int): InstallmentPage {
        filters.validationError()?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("limit", PAGE_SIZE).put("offset", offset.coerceAtLeast(0))
        filters.branchId.toLongOrNull()?.let { input.put("branchId", it) }
        filters.customerId.toLongOrNull()?.let { input.put("customerId", it) }
        filters.status?.let { input.put("status", it.name) }
        filters.query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it) }
        filters.from.takeIf(String::isNotBlank)?.let { input.put("from", it) }
        filters.to.takeIf(String::isNotBlank)?.let { input.put("to", it) }
        val json = api.query("installments.list", input)
        return InstallmentPage(
            rows = json.optJSONArray("rows").objects().mapNotNull(JSONObject::toInstallmentSummary),
            hasMore = json.optBoolean("hasMore"),
        )
    }

    override suspend fun installmentPlan(planId: Long): InstallmentPlanDetail {
        require(planId > 0) { "معرّف الخطة غير صالح" }
        val json = api.query("installments.get", JSONObject().put("planId", planId))
        val summary = json.toInstallmentSummary() ?: throw IllegalStateException("تعذّر قراءة الخطة")
        return InstallmentPlanDetail(summary, json.optJSONArray("lines").objects().mapNotNull(JSONObject::toInstallmentLine))
    }

    override suspend fun dueInstallments(branchId: Long?, days: Int): List<DueInstallment> {
        require(days in 0..90) { "نافذة الاستحقاق غير صالحة" }
        val input = JSONObject().put("days", days)
        branchId?.let { require(it > 0); input.put("branchId", it) }
        return api.queryArray("installments.dueSoon", input).objects().mapNotNull(JSONObject::toDueInstallment)
    }

    override suspend fun createInstallmentPlan(draft: NewInstallmentPlan): Long {
        draft.validationError()?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("customerId", draft.customerId.toLong())
            .put("branchId", draft.branchId.toLong())
            .put("totalAmount", ReceivablesMoney.validatedInput(draft.totalAmount)!!.value)
            .put("downPayment", ReceivablesMoney.validatedInput(draft.downPayment.ifBlank { "0" })!!.value)
            .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("lines", JSONArray().apply {
                draft.lines.forEach { line ->
                    put(
                        JSONObject()
                            .put("dueDate", line.dueDate)
                            .put("amount", ReceivablesMoney.validatedInput(line.amount)!!.value),
                    )
                }
            })
        draft.invoiceId.toLongOrNull()?.let { input.put("invoiceId", it) }
        return api.mutate("installments.create", input).getLong("planId")
    }

    override suspend fun payInstallment(
        lineId: Long,
        method: InstallmentPaymentMethod,
        note: String?,
    ): InstallmentPaymentResult {
        require(lineId > 0) { "معرّف القسط غير صالح" }
        val input = JSONObject().put("lineId", lineId).put("paymentMethod", method.name)
        note?.trim()?.takeIf(String::isNotEmpty)?.let { input.put("note", it.take(255)) }
        val result = api.mutate("installments.pay", input)
        return InstallmentPaymentResult(
            status = result.optString("status"),
            receiptId = result.getLong("receiptId"),
            voucherNumber = result.optString("voucherNumber"),
            planCompleted = result.optBoolean("planCompleted"),
        )
    }

    override suspend fun cancelInstallmentPlan(planId: Long, reason: String) {
        require(planId > 0) { "معرّف الخطة غير صالح" }
        require(reason.trim().length in 3..500) { "سبب الإلغاء مطلوب (3 أحرف على الأقل)" }
        api.mutate("installments.cancel", JSONObject().put("planId", planId).put("reason", reason.trim()))
    }

    override suspend fun bounceLegacyCheck(lineId: Long, note: String?): Boolean {
        require(lineId > 0) { "معرّف القسط غير صالح" }
        val input = JSONObject().put("lineId", lineId)
        note?.trim()?.takeIf(String::isNotEmpty)?.let { input.put("note", it.take(255)) }
        return api.mutate("installments.bounce", input).optBoolean("reversed")
    }

    override suspend fun reminderQueue(
        ledger: ReminderLedger,
        branchId: Long?,
        aggregate: Boolean,
    ): List<ReminderQueueItem> {
        val input = reminderScope(ledger, branchId, aggregate)
        val procedure = if (ledger == ReminderLedger.RECEIVABLE) "arReminders.queue" else "apReminders.queue"
        return api.queryArray(procedure, input).objects().mapNotNull { it.toReminderQueue(ledger) }
    }

    override suspend fun reminderHistory(
        ledger: ReminderLedger,
        branchId: Long?,
        aggregate: Boolean,
    ): List<ReminderHistoryItem> {
        val input = reminderScope(ledger, branchId, aggregate).put("limit", REMINDER_HISTORY_LIMIT)
        val procedure = if (ledger == ReminderLedger.RECEIVABLE) "arReminders.history" else "apReminders.history"
        return api.queryArray(procedure, input).objects().mapNotNull { it.toReminderHistory(ledger) }
    }

    override suspend fun sendReminder(snapshot: ReminderSnapshot, branchId: Long): ReminderSendResult {
        require(branchId > 0) { "حدّد الفرع قبل الإرسال" }
        val procedure = if (snapshot.ledger == ReminderLedger.RECEIVABLE) "arReminders.sendViaApi" else "apReminders.sendViaApi"
        val result = api.mutate(procedure, reminderAction(snapshot, branchId))
        return ReminderSendResult(
            sent = result.optBoolean("sent"),
            reminderId = result.optLong("reminderId").takeIf { it > 0 },
            reason = result.nullableText("reason"),
        )
    }

    override suspend fun skipReminder(
        snapshot: ReminderSnapshot,
        branchId: Long,
        reason: String,
        promisedDate: String?,
    ) {
        require(branchId > 0) { "حدّد الفرع قبل التأجيل" }
        require(reason.trim().isNotEmpty()) { "سبب التأجيل أو التخطّي مطلوب" }
        val procedure = if (snapshot.ledger == ReminderLedger.RECEIVABLE) "arReminders.logSkipped" else "apReminders.logSkipped"
        api.mutate(
            procedure,
            reminderAction(snapshot, branchId)
                .put("skipReason", reason.trim().take(255))
                .put("promisedDate", promisedDate?.takeIf(String::isNotBlank) ?: JSONObject.NULL),
        )
    }

    override suspend fun cardSummary(branchId: Long?): CardSummary {
        val input = JSONObject().apply { branchId?.let { put("branchId", it) } }
        return api.query("cardAccount.summary", input).toCardSummary()
    }

    override suspend fun cardMovements(filters: CardFilters, offset: Int): CardMovementPage {
        filters.validationError()?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("limit", PAGE_SIZE).put("offset", offset.coerceAtLeast(0))
        filters.branchId.toLongOrNull()?.let { input.put("branchId", it) }
        filters.from.takeIf(String::isNotBlank)?.let { input.put("from", it) }
        filters.to.takeIf(String::isNotBlank)?.let { input.put("to", it) }
        filters.query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it) }
        filters.direction?.let { input.put("direction", it.name) }
        filters.source?.let { input.put("sourceType", it.name) }
        val json = api.query("cardAccount.movements", input)
        return CardMovementPage(
            rows = json.optJSONArray("rows").objects().mapNotNull(JSONObject::toCardMovement),
            count = json.optInt("count"),
            totalIn = ReceivablesMoney.fromServer(json.nullableText("totalIn")),
            totalOut = ReceivablesMoney.fromServer(json.nullableText("totalOut")),
            net = ReceivablesMoney.fromServer(json.nullableText("net")),
            hasMore = json.optBoolean("hasMore"),
            branchId = json.nullableLong("branchId"),
        )
    }

    override suspend fun cardReconciliations(branchId: Long?): List<CardReconciliation> {
        val input = JSONObject().put("limit", RECONCILIATION_LIMIT)
        branchId?.let { input.put("branchId", it) }
        return api.queryArray("cardAccount.reconciliations", input).objects().mapNotNull(JSONObject::toCardReconciliation)
    }

    override suspend fun createCardReconciliation(draft: ReconciliationDraft): CardReconciliation {
        draft.validationError()?.let { throw IllegalArgumentException(it) }
        val result = api.mutate(
            "cardAccount.createReconciliation",
            JSONObject()
                .put("branchId", draft.branchId.toLong())
                .put("asOfDate", draft.asOfDate)
                .put("statementBalance", ReceivablesMoney.validatedInput(draft.statementBalance)!!.value)
                .put("statementLabel", draft.statementLabel.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
                .put("note", draft.note.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL),
        )
        return result.toCardReconciliation() ?: throw IllegalStateException("تعذّر قراءة نتيجة المطابقة")
    }

    override suspend fun accountTree(): List<AccountGroup> = api.queryArray("accounts.tree").objects().mapNotNull { group ->
        val type = AccountType.fromServer(group.optString("type")) ?: return@mapNotNull null
        AccountGroup(
            type = type,
            label = group.optString("label", type.label),
            rows = group.optJSONArray("rows").objects().mapNotNull(JSONObject::toAccount),
        )
    }

    private fun reminderScope(ledger: ReminderLedger, branchId: Long?, aggregate: Boolean): JSONObject = JSONObject().apply {
        if (aggregate) {
            put(if (ledger == ReminderLedger.RECEIVABLE) "openingScope" else "allBranches", true)
        } else {
            require(branchId != null && branchId > 0) { "حدّد الفرع أولاً" }
            put("branchId", branchId)
        }
    }

    private fun reminderAction(snapshot: ReminderSnapshot, branchId: Long) = JSONObject()
        .put(if (snapshot.ledger == ReminderLedger.RECEIVABLE) "customerId" else "supplierId", snapshot.subjectId)
        .put("totalUnpaidSnapshot", snapshot.totalUnpaid)
        .put(if (snapshot.ledger == ReminderLedger.RECEIVABLE) "oldestInvoiceDate" else "oldestPoDate", snapshot.oldestDocumentDate)
        .put("daysOverdue", snapshot.daysOverdue)
        .put("branchId", branchId)
        .apply {
            if (snapshot.ledger == ReminderLedger.RECEIVABLE && snapshot.openingBalance) put("isOpeningBalance", true)
        }

    private companion object {
        const val PAGE_SIZE = 50
        const val REMINDER_HISTORY_LIMIT = 200
        const val RECONCILIATION_LIMIT = 100
    }
}

fun ReminderQueueItem.snapshot(): ReminderSnapshot = ReminderSnapshot(
    ledger = subject.ledger,
    subjectId = subject.id,
    totalUnpaid = totalUnpaid.value,
    oldestDocumentDate = oldestDocumentDate,
    daysOverdue = daysOverdue,
    openingBalance = isOpeningBalance,
)

private fun JSONObject.toInstallmentSummary(): InstallmentPlanSummary? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val status = InstallmentStatus.fromServer(optString("status")) ?: return null
    val branchId = optLong("branchId").takeIf { it > 0 } ?: return null
    return InstallmentPlanSummary(
        id = id,
        customerId = optLong("customerId"),
        customerName = optString("customerName"),
        customerPhone = nullableText("customerPhone"),
        invoiceId = nullableLong("invoiceId"),
        branchId = branchId,
        totalAmount = ReceivablesMoney.fromServer(nullableText("totalAmount")),
        downPayment = ReceivablesMoney.fromServer(nullableText("downPayment")),
        status = status,
        notes = nullableText("notes"),
        createdAt = nullableText("createdAt").orEmpty(),
        totalLines = optInt("totalLines"),
        paidLines = optInt("paidLines"),
        paidAmount = ReceivablesMoney.fromServer(nullableText("paidAmount")),
        nextDueDate = nullableText("nextDueDate"),
    )
}

private fun JSONObject.toInstallmentLine(): InstallmentLine? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val kind = runCatching { InstallmentKind.valueOf(optString("kind").uppercase()) }.getOrNull() ?: return null
    val status = InstallmentLineStatus.fromServer(optString("status")) ?: return null
    return InstallmentLine(
        id = id,
        planId = optLong("planId"),
        sequence = optInt("seq"),
        dueDate = optString("dueDate").take(10),
        amount = ReceivablesMoney.fromServer(nullableText("amount")),
        kind = kind,
        checkNumber = nullableText("checkNumber"),
        bankName = nullableText("bankName"),
        status = status,
        receiptId = nullableLong("receiptId"),
        paidAt = nullableText("paidAt"),
        note = nullableText("note"),
    )
}

private fun JSONObject.toDueInstallment(): DueInstallment? {
    val lineId = optLong("lineId").takeIf { it > 0 } ?: return null
    val kind = runCatching { InstallmentKind.valueOf(optString("kind").uppercase()) }.getOrNull() ?: return null
    return DueInstallment(
        lineId = lineId,
        planId = optLong("planId"),
        branchId = optLong("branchId"),
        customerId = optLong("customerId"),
        customerName = optString("customerName"),
        customerPhone = nullableText("customerPhone"),
        sequence = optInt("seq"),
        dueDate = optString("dueDate").take(10),
        amount = ReceivablesMoney.fromServer(nullableText("amount")),
        kind = kind,
        checkNumber = nullableText("checkNumber"),
        bankName = nullableText("bankName"),
        daysOverdue = optInt("daysOverdue").coerceAtLeast(0),
    )
}

private fun JSONObject.toReminderQueue(ledger: ReminderLedger): ReminderQueueItem? {
    val idKey = if (ledger == ReminderLedger.RECEIVABLE) "customerId" else "supplierId"
    val nameKey = if (ledger == ReminderLedger.RECEIVABLE) "customerName" else "supplierName"
    val dateKey = if (ledger == ReminderLedger.RECEIVABLE) "oldestInvoiceDate" else "oldestPoDate"
    val id = optLong(idKey).takeIf { it > 0 } ?: return null
    return ReminderQueueItem(
        subject = ReminderSubject(ledger, id, optString(nameKey), nullableText("phone")),
        totalUnpaid = ReceivablesMoney.fromServer(nullableText("totalUnpaid")),
        oldestDocumentDate = optString(dateKey).take(10),
        daysOverdue = optInt("daysOverdue").coerceAtLeast(0),
        lastReminderAt = nullableText("lastReminderAt"),
        lastReminderStatus = nullableText("lastReminderStatus")?.let(::reminderStatus),
        promisedDate = nullableText("promisedDate"),
        isPromiseDue = optBoolean("isPromiseDue"),
        isOpeningBalance = ledger == ReminderLedger.RECEIVABLE && optBoolean("isOpeningBalance"),
    )
}

private fun JSONObject.toReminderHistory(ledger: ReminderLedger): ReminderHistoryItem? {
    val idKey = if (ledger == ReminderLedger.RECEIVABLE) "customerId" else "supplierId"
    val nameKey = if (ledger == ReminderLedger.RECEIVABLE) "customerName" else "supplierName"
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val status = reminderStatus(optString("status")) ?: return null
    return ReminderHistoryItem(
        id = id,
        subject = ReminderSubject(ledger, optLong(idKey), optString(nameKey), null),
        totalUnpaid = ReceivablesMoney.fromServer(nullableText("totalUnpaidSnapshot")),
        daysOverdue = optInt("daysOverdue").coerceAtLeast(0),
        status = status,
        skipReason = nullableText("skipReason"),
        promisedDate = nullableText("promisedDate"),
        createdBy = optLong("createdBy"),
        createdAt = nullableText("createdAt").orEmpty(),
    )
}

private fun JSONObject.toCardSummary(): CardSummary {
    val branchId = nullableLong("branchId")
    return CardSummary(
        branchId = branchId,
        balance = ReceivablesMoney.fromServer(nullableText("balance")),
        totalIn = ReceivablesMoney.fromServer(nullableText("totalIn")),
        totalOut = ReceivablesMoney.fromServer(nullableText("totalOut")),
        todayIn = ReceivablesMoney.fromServer(nullableText("todayIn")),
        todayOut = ReceivablesMoney.fromServer(nullableText("todayOut")),
        movementCount = optInt("movementCount"),
        lastReconciliation = optJSONObject("lastReconciliation")?.let { row ->
            branchId?.let {
                CardReconciliation(
                    id = 0,
                    branchId = it,
                    branchName = null,
                    asOfDate = row.optString("asOfDate").take(10),
                    systemBalance = ReceivablesMoney.fromServer(row.nullableText("systemBalance")),
                    statementBalance = ReceivablesMoney.fromServer(row.nullableText("statementBalance")),
                    difference = ReceivablesMoney.fromServer(row.nullableText("difference")),
                    statementLabel = null,
                    note = null,
                    createdByName = null,
                    createdAt = row.nullableText("createdAt"),
                )
            }
        },
    )
}

private fun JSONObject.toCardMovement(): CardMovement? {
    val id = optLong("receiptId").takeIf { it > 0 } ?: return null
    val direction = runCatching { CardDirection.valueOf(optString("direction").uppercase()) }.getOrNull() ?: return null
    val source = runCatching { CardSource.valueOf(optString("source").uppercase()) }.getOrNull() ?: CardSource.OTHER
    return CardMovement(
        receiptId = id,
        branchId = nullableLong("branchId"),
        branchName = nullableText("branchName"),
        createdAt = nullableText("createdAt"),
        direction = direction,
        amount = ReceivablesMoney.fromServer(nullableText("amount")),
        runningBalance = nullableText("runningBalance")?.let(ReceivablesMoney::fromServer),
        lastFour = nullableText("cardLastFour"),
        reference = nullableText("referenceNumber"),
        voucherNumber = nullableText("voucherNumber"),
        invoiceId = nullableLong("invoiceId"),
        source = source,
        partyName = nullableText("partyName"),
        description = nullableText("description"),
        createdByName = nullableText("createdByName"),
        reversed = optBoolean("reversed"),
    )
}

private fun JSONObject.toCardReconciliation(): CardReconciliation? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val branchId = optLong("branchId").takeIf { it > 0 } ?: return null
    return CardReconciliation(
        id = id,
        branchId = branchId,
        branchName = nullableText("branchName"),
        asOfDate = optString("asOfDate").take(10),
        systemBalance = ReceivablesMoney.fromServer(nullableText("systemBalance")),
        statementBalance = ReceivablesMoney.fromServer(nullableText("statementBalance")),
        difference = ReceivablesMoney.fromServer(nullableText("difference")),
        statementLabel = nullableText("statementLabel"),
        note = nullableText("note"),
        createdByName = nullableText("createdByName"),
        createdAt = nullableText("createdAt"),
    )
}

private fun JSONObject.toAccount(): LedgerAccount? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val type = AccountType.fromServer(optString("type")) ?: return null
    return LedgerAccount(
        id = id,
        code = optString("code"),
        name = optString("name"),
        type = type,
        parentId = nullableLong("parentId"),
        systemRole = nullableText("systemRole"),
        active = optBoolean("isActive"),
        sortOrder = optInt("sortOrder"),
    )
}

private fun reminderStatus(raw: String): ReminderStatus? =
    ReminderStatus.entries.firstOrNull { it.name == raw.uppercase() }

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

package online.alarabiya.superapp.model.shifts

object ShiftMappers {
    fun page(root: Map<String, Any?>): ShiftPage {
        val rows = root.list("rows").mapNotNull { it.asMapOrNull()?.let(::record) }
        return ShiftPage(
            rows = rows,
            total = root.int("total"),
            hasMore = root.boolean("hasMore"),
            nextCursor = root.longOrNull("nextCursor"),
        )
    }

    fun report(root: Map<String, Any?>): ShiftReport? {
        val shift = root.map("shift")?.let(::record) ?: return null
        return ShiftReport(
            shift = shift,
            payments = root.list("payments").mapNotNull { item ->
                val payment = item.asMapOrNull() ?: return@mapNotNull null
                val method = payment.text("method")
                val direction = payment.text("direction")
                val total = ShiftMoney.fromServerOrNull(payment.textOrNull("total")) ?: return@mapNotNull null
                if (method.isBlank() || direction.isBlank()) return@mapNotNull null
                ShiftPayment(
                    method = method,
                    direction = direction,
                    total = total,
                    count = payment.int("count"),
                )
            },
            expectedCash = ShiftMoney.fromServerOrNull(root.textOrNull("expectedCash")) ?: return null,
            invoiceCount = root.int("invoiceCount"),
            salesTotal = ShiftMoney.fromServerOrNull(root.textOrNull("salesTotal")) ?: return null,
            workOrderInvoiceCount = root.int("woInvoicesCount"),
            workOrderInvoiceTotal = ShiftMoney.fromServerOrNull(root.textOrNull("woInvoicesTotal")) ?: return null,
            heldDepositsCount = root.int("heldDepositsCount"),
            heldDepositsTotal = ShiftMoney.fromServerOrNull(root.textOrNull("heldDepositsTotal")) ?: return null,
            lateSyncedCount = root.int("lateSyncedCount"),
            lateSyncedTotal = ShiftMoney.fromServerOrNull(root.textOrNull("lateSyncedTotal")) ?: return null,
        )
    }

    fun current(root: Map<String, Any?>): CurrentShift? {
        val id = root.long("id")
        val branchId = root.long("branchId")
        val userId = root.long("userId")
        val status = ShiftStatus.fromWire(root.textOrNull("status")) ?: return null
        val type = ShiftType.fromWire(root.textOrNull("shiftType")) ?: return null
        if (id <= 0 || branchId <= 0 || userId <= 0) return null
        return CurrentShift(
            id = id,
            branchId = branchId,
            userId = userId,
            openingBalance = ShiftMoney.fromServerOrNull(root.textOrNull("openingBalance")) ?: return null,
            status = status,
            type = type,
            openedAt = root.text("openedAt"),
        )
    }

    fun closeResult(root: Map<String, Any?>): ShiftCloseResult? {
        val id = root.long("shiftId")
        if (id <= 0) return null
        val treasuryReturn = root.map("treasuryReturn")
        return ShiftCloseResult(
            shiftId = id,
            openingBalance = ShiftMoney.fromServerOrNull(root.textOrNull("openingBalance")) ?: return null,
            expectedCash = ShiftMoney.fromServerOrNull(root.textOrNull("expectedCash")) ?: return null,
            countedCash = ShiftMoney.fromServerOrNull(root.textOrNull("countedCash")) ?: return null,
            variance = ShiftMoney.fromServerOrNull(root.textOrNull("variance")) ?: return null,
            reconciliationStatus = root.textOrNull("reconciliationStatus"),
            requiresManagerReview = root.boolean("requiresManagerReview"),
            alreadyClosed = root.boolean("alreadyClosed"),
            treasuryHandoverNumber = treasuryReturn?.textOrNull("handoverNumber"),
        )
    }

    private fun record(root: Map<String, Any?>): ShiftRecord? {
        val id = root.long("id")
        val branchId = root.long("branchId")
        val userId = root.long("userId")
        val status = ShiftStatus.fromWire(root.textOrNull("status")) ?: return null
        val type = ShiftType.fromWire(root.textOrNull("shiftType")) ?: return null
        if (id <= 0 || branchId <= 0 || userId <= 0) return null
        return ShiftRecord(
            id = id,
            branchId = branchId,
            branchName = root.textOrNull("branchName"),
            userId = userId,
            userName = root.textOrNull("userName"),
            openingBalance = ShiftMoney.fromServerOrNull(root.textOrNull("openingBalance")) ?: return null,
            expectedCash = root.textOrNull("expectedCash")?.let(ShiftMoney::fromServerOrNull),
            countedCash = root.textOrNull("countedCash")?.let(ShiftMoney::fromServerOrNull),
            variance = root.textOrNull("variance")?.let(ShiftMoney::fromServerOrNull),
            status = status,
            type = type,
            openedAt = root.text("openedAt"),
            closedAt = root.textOrNull("closedAt"),
        )
    }
}

private fun Any?.asMapOrNull(): Map<String, Any?>? = when (this) {
    is Map<*, *> -> entries.associate { (key, value) -> key.toString() to value }
    else -> null
}

private fun Map<String, Any?>.map(key: String): Map<String, Any?>? = get(key).asMapOrNull()
private fun Map<String, Any?>.list(key: String): List<Any?> = get(key) as? List<Any?> ?: emptyList()
private fun Map<String, Any?>.text(key: String): String = textOrNull(key).orEmpty()
private fun Map<String, Any?>.textOrNull(key: String): String? = get(key)?.takeUnless { it === NullValue }?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String): Long = longOrNull(key) ?: 0L
private fun Map<String, Any?>.longOrNull(key: String): Long? = when (val value = get(key)) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.int(key: String): Int = when (val value = get(key)) {
    is Number -> value.toInt()
    is String -> value.toIntOrNull() ?: 0
    else -> 0
}
private fun Map<String, Any?>.boolean(key: String): Boolean = when (val value = get(key)) {
    is Boolean -> value
    is String -> value.equals("true", ignoreCase = true)
    is Number -> value.toInt() != 0
    else -> false
}

/** Marker used only by pure mapper fixtures when they need to model JSON null explicitly. */
internal data object NullValue

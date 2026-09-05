package online.alarabiya.superapp.model.inventory

import org.json.JSONArray
import org.json.JSONObject

object InventoryMappers {
    fun balances(root: JSONArray): List<StockBalance> = balances(root.toWireList())
    internal fun balances(root: List<Any?>): List<StockBalance> = root.mapNotNull { value ->
        value.asMap()?.let { row ->
            StockBalance(
                variantId = row.long("variantId"),
                branchId = row.long("branchId"),
                productName = row.text("productName"),
                variantName = row.nullableText("variantName"),
                sku = row.text("sku"),
                quantity = row.int("quantity"),
                minimum = row.int("minStock"),
                reorderPoint = row.int("reorderPoint"),
                isLow = row.bool("isLow"),
                lastCountedAt = row.nullableText("lastCountedAt"),
            )
        }
    }

    fun movements(root: JSONObject): MovementPage = movements(root.toWireMap())
    internal fun movements(root: Map<String, Any?>): MovementPage = MovementPage(
        rows = root.list("rows").mapNotNull { value -> value.asMap()?.let(::movement) },
        hasMore = root.bool("hasMore"),
        nextCursor = root.nullableLong("nextCursor"),
    )

    private fun movement(row: Map<String, Any?>) = InventoryMovement(
        id = row.long("id"),
        at = row.nullableText("createdAt"),
        type = MovementType.fromWire(row.nullableText("movementType")),
        quantity = row.int("quantity"),
        variantId = row.long("variantId"),
        productName = row.text("productName"),
        variantName = row.nullableText("variantName"),
        sku = row.text("sku"),
        branchName = row.text("branchName"),
        relatedBranchName = row.nullableText("relatedBranchName"),
        referenceType = row.nullableText("referenceType"),
        referenceId = row.nullableLong("referenceId"),
        notes = row.nullableText("notes"),
        createdByName = row.nullableText("createdByName"),
    )

    fun transfers(root: JSONObject): TransferPage = transfers(root.toWireMap())
    internal fun transfers(root: Map<String, Any?>): TransferPage = TransferPage(
        rows = root.list("rows").mapNotNull { value -> value.asMap()?.let(::transferSummary) },
        nextCursor = root.nullableLong("nextCursor"),
    )

    private fun transferSummary(row: Map<String, Any?>) = TransferSummary(
        id = row.long("id"),
        number = row.text("transferNumber"),
        fromBranchId = row.long("fromBranchId"),
        fromBranchName = row.text("fromBranchName"),
        toBranchId = row.long("toBranchId"),
        toBranchName = row.text("toBranchName"),
        status = TransferStatus.fromWire(row.nullableText("status")),
        reason = row.nullableText("reason"),
        sent = row.int("totalSentBase"),
        received = row.nullableInt("totalReceivedBase"),
        linesCount = row.int("linesCount"),
        createdAt = row.nullableText("createdAt"),
    )

    fun transfer(root: JSONObject): TransferDetail = transfer(root.toWireMap())
    internal fun transfer(row: Map<String, Any?>) = TransferDetail(
        id = row.long("id"),
        number = row.text("transferNumber"),
        fromBranchId = row.long("fromBranchId"),
        fromBranchName = row.text("fromBranchName"),
        toBranchId = row.long("toBranchId"),
        toBranchName = row.text("toBranchName"),
        status = TransferStatus.fromWire(row.nullableText("status")),
        reason = row.nullableText("reason"),
        notes = row.nullableText("notes"),
        receiveNotes = row.nullableText("receiveNotes"),
        createdAt = row.nullableText("createdAt"),
        createdByName = row.nullableText("createdByName"),
        lines = row.list("lines").mapNotNull { value -> value.asMap()?.let { line ->
            TransferLine(
                id = line.long("id"),
                variantId = line.long("variantId"),
                productName = line.text("productName"),
                variantName = line.nullableText("variantName"),
                sku = line.text("sku"),
                quantitySent = line.int("quantitySent"),
                quantityReceived = line.nullableInt("quantityReceived"),
                note = line.nullableText("note"),
            )
        } },
    )

    fun adjustments(root: JSONArray): List<AdjustmentRequest> = adjustments(root.toWireList())
    internal fun adjustments(root: List<Any?>): List<AdjustmentRequest> = root.mapNotNull { value ->
        value.asMap()?.let { row ->
            AdjustmentRequest(
                id = row.long("id"),
                variantId = row.long("variantId"),
                branchId = row.long("branchId"),
                productName = row.text("productName"),
                variantName = row.nullableText("variantName"),
                sku = row.text("sku"),
                expectedQuantity = row.int("expectedQuantity"),
                currentQuantity = row.int("currentQuantity"),
                targetQuantity = row.int("targetQuantity"),
                status = AdjustmentStatus.fromWire(row.nullableText("status")),
                notes = row.nullableText("notes"),
                createdBy = row.nullableLong("createdBy"),
                createdByName = row.nullableText("createdByName"),
                createdAt = row.nullableText("createdAt"),
                rejectionReason = row.nullableText("rejectionReason"),
            )
        }
    }

    fun stocktakes(root: JSONArray): List<StocktakeSummary> = stocktakes(root.toWireList())
    internal fun stocktakes(root: List<Any?>): List<StocktakeSummary> = root.mapNotNull { value ->
        value.asMap()?.let(::stocktakeSummary)
    }

    private fun stocktakeSummary(row: Map<String, Any?>) = StocktakeSummary(
        id = row.long("id"),
        code = row.text("code"),
        name = row.text("name"),
        branchId = row.long("branchId"),
        branchName = row.text("branchName"),
        scopeLabel = row.text("scopeLabel"),
        status = StocktakeStatus.fromWire(row.nullableText("status")),
        itemCount = row.int("itemCount"),
        countedCount = row.int("countedCount"),
        createdAt = row.nullableText("createdAt"),
        createdByName = row.text("createdByName"),
    )

    fun stocktake(detail: JSONObject, monitor: JSONObject): StocktakeDetail =
        stocktake(detail.toWireMap(), monitor.toWireMap())

    internal fun stocktake(detail: Map<String, Any?>, monitor: Map<String, Any?>): StocktakeDetail {
        val session = detail.obj("session").orEmpty()
        val progress = detail.obj("progress").orEmpty()
        val summary = stocktakeSummary(
            session + mapOf(
                "itemCount" to progress.int("total"),
                "countedCount" to progress.int("counted"),
            ),
        )
        return StocktakeDetail(
            summary = summary,
            blind = session.bool("blind"),
            notes = session.nullableText("notes"),
            assignments = detail.list("assignments").mapNotNull { value -> value.asMap()?.let { row ->
                StocktakeAssignment(
                    id = row.long("id"),
                    name = row.text("name"),
                    method = row.text("method"),
                    zone = row.nullableText("zone"),
                    status = row.text("status"),
                    counted = row.int("counted"),
                )
            } },
            total = progress.int("total"),
            counted = progress.int("counted"),
            recentCounts = monitor.list("recentCounts").mapNotNull { value -> value.asMap()?.let { row ->
                StocktakeRecentCount(
                    variantId = row.long("variantId"),
                    productName = row.text("variantLabel"),
                    variantName = null,
                    quantity = row.int("qty"),
                    byName = row.nullableText("byName"),
                    at = row.nullableText("at"),
                )
            } },
        )
    }

    fun countAssignments(root: JSONArray): List<CountAssignment> = countAssignments(root.toWireList())
    internal fun countAssignments(root: List<Any?>): List<CountAssignment> = root.mapNotNull { value ->
        value.asMap()?.let { row ->
            CountAssignment(
                sessionCode = row.text("sessionCode"),
                sessionName = row.text("sessionName"),
                branchId = row.long("branchId"),
                assignmentId = row.long("assignmentId"),
                status = row.text("assignmentStatus"),
                zone = row.nullableText("zone"),
                lastActivityAt = row.nullableText("lastActivityAt"),
            )
        }
    }

    fun countSession(root: JSONObject): CountSession = countSession(root.toWireMap())
    internal fun countSession(root: Map<String, Any?>): CountSession {
        val state = root.obj("state") ?: error("لم يعد الخادم حالة الجرد")
        val session = state.obj("session").orEmpty()
        val assignment = state.obj("assignment").orEmpty()
        val mine = state.obj("progress")?.obj("mine").orEmpty()
        val recountReasons = state.list("recountTasks").mapNotNull { it.asMap() }
            .associate { it.long("variantId") to it.text("reason") }
        return CountSession(
            code = session.text("code"),
            name = session.text("name"),
            branchName = session.text("branchName"),
            assignmentName = assignment.text("name"),
            zone = assignment.nullableText("zone"),
            counted = mine.int("counted"),
            total = mine.int("total"),
            countMethod = session.text("countMethod", "FREE"),
            items = state.list("items").mapNotNull { value -> value.asMap()?.let { row ->
                CountItem(
                    variantId = row.long("variantId"),
                    productName = row.text("productName"),
                    variantName = row.nullableText("variantName"),
                    sku = row.text("sku"),
                    counted = row.bool("counted"),
                    myQuantity = row.obj("myCount")?.nullableInt("qty"),
                    colleagueCounted = row.bool("colleagueCounted"),
                    recountReason = recountReasons[row.long("variantId")],
                    units = row.list("units").mapNotNull { unitValue -> unitValue.asMap()?.let { unit ->
                        CountUnit(
                            name = unit.text("unitName"),
                            factor = unit.text("factor", "1"),
                            barcode = unit.nullableText("barcode"),
                            aliases = unit.list("aliases").mapNotNull { it?.toString()?.takeIf(String::isNotBlank) },
                        )
                    } },
                )
            } },
        )
    }

    fun branches(root: JSONArray): List<InventoryBranch> = branches(root.toWireList())
    internal fun branches(root: List<Any?>): List<InventoryBranch> = root.mapNotNull { value ->
        value.asMap()?.let { row -> InventoryBranch(row.long("id"), row.text("name"), row.nullableText("code")) }
    }
}

private fun JSONObject.toWireMap(): Map<String, Any?> = buildMap {
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        put(key, opt(key).toWireValue())
    }
}

private fun JSONArray.toWireList(): List<Any?> = buildList {
    for (index in 0 until length()) add(opt(index).toWireValue())
}

private fun Any?.toWireValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toWireMap()
    is JSONArray -> toWireList()
    else -> this
}

private fun Any?.asMap(): Map<String, Any?>? =
    (this as? Map<*, *>)?.entries?.associate { (key, value) -> key.toString() to value }

private fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key].asMap()
private fun Map<String, Any?>.list(key: String): List<Any?> = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.text(key: String, default: String = ""): String = nullableText(key) ?: default
private fun Map<String, Any?>.nullableText(key: String): String? = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String): Long = nullableLong(key) ?: 0L
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val value = this[key]) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.int(key: String): Int = nullableInt(key) ?: 0
private fun Map<String, Any?>.nullableInt(key: String): Int? = nullableLong(key)?.toInt()
private fun Map<String, Any?>.bool(key: String): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value.equals("true", true) || value == "1"
    else -> false
}

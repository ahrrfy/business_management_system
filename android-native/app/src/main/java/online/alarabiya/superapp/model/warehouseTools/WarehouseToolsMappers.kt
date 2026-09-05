package online.alarabiya.superapp.model.warehouseTools

import org.json.JSONArray
import org.json.JSONObject

object WarehouseToolsMappers {
    fun signedBarcode(root: JSONObject) = signedBarcode(root.wireMap())
    internal fun signedBarcode(row: Map<String, Any?>) = SignedBarcodeResult(
        valid = row.bool("valid"),
        documentType = row.optText("docType"),
        number = row.optText("number"),
        date = row.optText("date"),
        amount = row.optText("amount"),
        branchId = row.optLong("branchId"),
    )

    fun assignments(root: JSONArray) = assignments(root.wireList())
    internal fun assignments(rows: List<Any?>) = rows.mapNotNull { value -> value.map()?.let { row ->
        CountAssignment(
            sessionCode = row.text("sessionCode"),
            sessionName = row.text("sessionName"),
            branchId = row.long("branchId"),
            assignmentId = row.long("assignmentId"),
            status = row.text("assignmentStatus"),
            zone = row.optText("zone"),
            lastActivityAt = row.optText("lastActivityAt"),
        )
    } }

    fun assignmentsJson(values: List<CountAssignment>) = JSONArray().apply { values.forEach { value -> put(JSONObject()
        .put("sessionCode", value.sessionCode).put("sessionName", value.sessionName).put("branchId", value.branchId)
        .put("assignmentId", value.assignmentId).put("assignmentStatus", value.status).put("zone", value.zone ?: JSONObject.NULL)
        .put("lastActivityAt", value.lastActivityAt ?: JSONObject.NULL)) } }

    fun cachedAssignments(root: JSONArray): List<CountAssignment> = assignments(root.wireList())

    fun countSession(state: JSONObject, version: String) = countSession(state.wireMap(), version)
    internal fun countSession(state: Map<String, Any?>, version: String): CountSession {
        val session = state.obj("session").orEmpty()
        val assignment = state.obj("assignment").orEmpty()
        val progress = state.obj("progress").orEmpty()
        val mine = progress.obj("mine").orEmpty()
        val all = progress.obj("session").orEmpty()
        val recounts = state.list("recountTasks").mapNotNull { it.map() }
            .associate { it.long("variantId") to it.text("reason") }
        return CountSession(
            version = version,
            code = session.text("code"),
            name = session.text("name"),
            branchName = session.text("branchName"),
            sessionStatus = session.text("status"),
            duplicatePolicy = session.text("dupPolicy"),
            blind = session.bool("blind"),
            assignmentId = assignment.long("id"),
            assignmentName = assignment.text("name"),
            assignmentStatus = assignment.text("status"),
            zone = assignment.optText("zone"),
            mineCounted = mine.int("counted"),
            mineTotal = mine.int("total"),
            sessionCounted = all.int("counted"),
            sessionTotal = all.int("total"),
            countMethod = session.text("countMethod", "FREE"),
            items = state.list("items").mapNotNull { value -> value.map()?.let { row ->
                CountItem(
                    variantId = row.long("variantId"),
                    productName = row.text("productName"),
                    variantName = row.optText("variantName"),
                    sku = row.text("sku"),
                    counted = row.bool("counted"),
                    myCount = row.obj("myCount")?.let { count -> MyCount(count.int("qty"), count.optText("at"), count.optText("unitBreakdown")) },
                    colleagueCounted = row.bool("colleagueCounted"),
                    units = row.list("units").mapNotNull { unitValue -> unitValue.map()?.let { unit ->
                        CountUnit(unit.text("unitName"), unit.text("factor", "1"), unit.optText("barcode"), unit.list("aliases").mapNotNull { it?.toString() })
                    } },
                    recountReason = recounts[row.long("variantId")],
                )
            } },
        )
    }

    fun countReceipt(root: JSONObject) = CountReceipt(
        kind = root.optString("kind"),
        verifyMatch = if (root.isNull("verifyMatch")) null else root.optBoolean("verifyMatch"),
        idempotent = root.optBoolean("idempotent"),
    )

    fun finish(root: JSONObject) = FinishCountResult(root.optBoolean("sessionMovedToReview"))

    fun warehouseSnapshot(catalog: JSONObject, stock: JSONArray, userId: Long, branchId: Long, syncedAt: String) =
        warehouseSnapshot(catalog.wireMap(), stock.wireList(), userId, branchId, syncedAt)

    internal fun warehouseSnapshot(catalog: Map<String, Any?>, stock: List<Any?>, userId: Long, branchId: Long, syncedAt: String): WarehouseSnapshot {
        val stockByVariant = stock.mapNotNull { it.map() }.associate { it.long("variantId") to it.int("qty") }
        return WarehouseSnapshot(
            userId = userId,
            branchId = branchId,
            catalogVersion = catalog.text("version"),
            generatedAt = catalog.text("generatedAt"),
            syncedAt = syncedAt,
            items = catalog.list("rows").mapNotNull { value -> value.map()?.let { row ->
                WarehouseCatalogItem(
                    productUnitId = row.long("productUnitId"),
                    productId = row.long("productId"),
                    productName = row.text("productName"),
                    variantId = row.long("variantId"),
                    variantName = row.optText("variantName"),
                    sku = row.text("sku"),
                    unitName = row.text("unitName"),
                    conversionFactor = row.text("conversionFactor", "1"),
                    barcodes = row.list("allBarcodes").mapNotNull { it?.toString() },
                    isBaseUnit = row.bool("isBaseUnit"),
                    stockBase = stockByVariant[row.long("variantId")],
                )
            } },
        )
    }

    fun withStock(cached: WarehouseSnapshot, stock: JSONArray, syncedAt: String): WarehouseSnapshot {
        val stockByVariant = stock.wireList().mapNotNull { it.map() }.associate { it.long("variantId") to it.int("qty") }
        return cached.copy(syncedAt = syncedAt, items = cached.items.map { it.copy(stockBase = stockByVariant[it.variantId]) })
    }

    fun snapshotJson(value: WarehouseSnapshot) = JSONObject()
        .put("schema", 1).put("userId", value.userId).put("branchId", value.branchId)
        .put("catalogVersion", value.catalogVersion).put("generatedAt", value.generatedAt).put("syncedAt", value.syncedAt)
        .put("items", JSONArray().apply { value.items.forEach { row -> put(JSONObject()
            .put("productUnitId", row.productUnitId).put("productId", row.productId).put("productName", row.productName)
            .put("variantId", row.variantId).put("variantName", row.variantName ?: JSONObject.NULL).put("sku", row.sku)
            .put("unitName", row.unitName).put("conversionFactor", row.conversionFactor).put("barcodes", JSONArray(row.barcodes))
            .put("isBaseUnit", row.isBaseUnit).put("stockBase", row.stockBase ?: JSONObject.NULL)) } })

    fun cachedSnapshot(root: JSONObject): WarehouseSnapshot? {
        if (root.optInt("schema") != 1) return null
        return WarehouseSnapshot(
            userId = root.optLong("userId"), branchId = root.optLong("branchId"), catalogVersion = root.optString("catalogVersion"),
            generatedAt = root.optString("generatedAt"), syncedAt = root.optString("syncedAt"),
            items = root.optJSONArray("items").objects().map { row -> WarehouseCatalogItem(
                productUnitId = row.optLong("productUnitId"), productId = row.optLong("productId"), productName = row.optString("productName"),
                variantId = row.optLong("variantId"), variantName = row.nullableString("variantName"), sku = row.optString("sku"),
                unitName = row.optString("unitName"), conversionFactor = row.optString("conversionFactor", "1"),
                barcodes = row.optJSONArray("barcodes").strings(), isBaseUnit = row.optBoolean("isBaseUnit"),
                stockBase = if (row.isNull("stockBase")) null else row.optInt("stockBase"),
            ) },
        )
    }

    fun countJson(value: CountSession) = JSONObject()
        .put("schema", 2).put("version", value.version).put("code", value.code).put("name", value.name)
        .put("branchName", value.branchName).put("sessionStatus", value.sessionStatus).put("duplicatePolicy", value.duplicatePolicy)
        .put("blind", value.blind).put("countMethod", value.countMethod).put("assignmentId", value.assignmentId).put("assignmentName", value.assignmentName)
        .put("assignmentStatus", value.assignmentStatus).put("zone", value.zone ?: JSONObject.NULL)
        .put("mineCounted", value.mineCounted).put("mineTotal", value.mineTotal).put("sessionCounted", value.sessionCounted).put("sessionTotal", value.sessionTotal)
        .put("items", JSONArray().apply { value.items.forEach { item -> put(JSONObject()
            .put("variantId", item.variantId).put("productName", item.productName).put("variantName", item.variantName ?: JSONObject.NULL)
            .put("sku", item.sku).put("counted", item.counted).put("colleagueCounted", item.colleagueCounted)
            .put("recountReason", item.recountReason ?: JSONObject.NULL)
            .put("myCount", item.myCount?.let { JSONObject().put("quantity", it.quantity).put("at", it.at ?: JSONObject.NULL).put("unitBreakdown", it.unitBreakdown ?: JSONObject.NULL) } ?: JSONObject.NULL)
            .put("units", JSONArray().apply { item.units.forEach { unit -> put(JSONObject().put("name", unit.name).put("factor", unit.factor).put("barcode", unit.barcode ?: JSONObject.NULL).put("aliases", JSONArray(unit.aliases))) } })) } })

    fun cachedCount(root: JSONObject): CountSession? {
        if (root.optInt("schema") != 2) return null
        return CountSession(
            version = root.optString("version"), code = root.optString("code"), name = root.optString("name"), branchName = root.optString("branchName"),
            sessionStatus = root.optString("sessionStatus"), duplicatePolicy = root.optString("duplicatePolicy"), blind = root.optBoolean("blind"),
            countMethod = root.optString("countMethod", "FREE"),
            assignmentId = root.optLong("assignmentId"), assignmentName = root.optString("assignmentName"), assignmentStatus = root.optString("assignmentStatus"),
            zone = root.nullableString("zone"), mineCounted = root.optInt("mineCounted"), mineTotal = root.optInt("mineTotal"),
            sessionCounted = root.optInt("sessionCounted"), sessionTotal = root.optInt("sessionTotal"),
            items = root.optJSONArray("items").objects().map { item -> CountItem(
                variantId = item.optLong("variantId"), productName = item.optString("productName"), variantName = item.nullableString("variantName"), sku = item.optString("sku"),
                counted = item.optBoolean("counted"), myCount = item.optJSONObject("myCount")?.let { MyCount(it.optInt("quantity"), it.nullableString("at"), it.nullableString("unitBreakdown")) },
                colleagueCounted = item.optBoolean("colleagueCounted"), units = item.optJSONArray("units").objects().map { unit ->
                    CountUnit(unit.optString("name"), unit.optString("factor", "1"), unit.nullableString("barcode"), unit.optJSONArray("aliases").strings())
                }, recountReason = item.nullableString("recountReason"),
            ) },
        )
    }

    fun pendingJson(values: List<PendingCount>) = JSONArray().apply { values.forEach { value -> put(JSONObject()
        .put("sessionCode", value.sessionCode).put("variantId", value.variantId).put("quantityBase", value.quantityBase)
        .put("unitBreakdown", value.unitBreakdown).put("clientRequestId", value.clientRequestId).put("createdAt", value.createdAt)
        .put("entryMethod", value.entryMethod).put("scannedBarcode", value.scannedBarcode ?: JSONObject.NULL)
        .put("status", value.status.name).put("lastError", value.lastError ?: JSONObject.NULL)) } }

    fun pending(root: JSONArray): List<PendingCount> = root.objects().map { row -> PendingCount(
        sessionCode = row.optString("sessionCode"), variantId = row.optLong("variantId"), quantityBase = row.optInt("quantityBase"),
        unitBreakdown = row.optString("unitBreakdown"), clientRequestId = row.optString("clientRequestId"), createdAt = row.optString("createdAt"),
        status = PendingCountStatus.entries.firstOrNull { it.name == row.optString("status") } ?: PendingCountStatus.QUEUED,
        lastError = row.nullableString("lastError"),
        entryMethod = row.optString("entryMethod", "SEARCH_PICK"),
        scannedBarcode = row.nullableString("scannedBarcode"),
    ) }
}

private fun JSONObject.wireMap(): Map<String, Any?> = buildMap { val keys = keys(); while (keys.hasNext()) { val key = keys.next(); put(key, opt(key).wire()) } }
private fun JSONArray?.wireList(): List<Any?> = if (this == null) emptyList() else buildList { for (index in 0 until length()) add(opt(index).wire()) }
private fun Any?.wire(): Any? = when (this) { null, JSONObject.NULL -> null; is JSONObject -> wireMap(); is JSONArray -> wireList(); else -> this }
private fun Any?.map(): Map<String, Any?>? = (this as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }
private fun Map<String, Any?>.obj(key: String) = this[key].map()
private fun Map<String, Any?>.list(key: String): List<Any?> = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.optText(key: String) = this[key]?.toString()?.takeIf { it.isNotBlank() }
private fun Map<String, Any?>.text(key: String, default: String = "") = optText(key) ?: default
private fun Map<String, Any?>.optLong(key: String): Long? = when (val value = this[key]) { is Number -> value.toLong(); is String -> value.toLongOrNull(); else -> null }
private fun Map<String, Any?>.long(key: String) = optLong(key) ?: 0L
private fun Map<String, Any?>.int(key: String) = optLong(key)?.toInt() ?: 0
private fun Map<String, Any?>.bool(key: String) = when (val value = this[key]) { is Boolean -> value; is Number -> value.toInt() != 0; is String -> value == "1" || value.equals("true", true); else -> false }
private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else buildList { for (index in 0 until length()) optJSONObject(index)?.let(::add) }
private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else buildList { for (index in 0 until length()) optString(index).takeIf(String::isNotBlank)?.let(::add) }
private fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

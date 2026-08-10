package online.alarabiya.superapp.model.operations

import org.json.JSONArray
import org.json.JSONObject

object OperationsMappers {
    fun assets(root: JSONArray): List<AssetSummary> = assets(root.toWireList())

    internal fun assets(root: List<Any?>): List<AssetSummary> = root.mapNotNull { raw ->
        raw.asMap()?.let { row -> assetSummary(row) }
    }

    fun assetDetail(root: JSONObject): AssetDetail = assetDetail(root.toWireMap())

    internal fun assetDetail(root: Map<String, Any?>): AssetDetail {
        val summary = assetSummary(root) ?: throw IllegalArgumentException("Invalid asset payload")
        return AssetDetail(
            summary = summary,
            brand = root.textOrNull("brand"),
            serial = root.textOrNull("serial"),
            supplierId = root.longOrNull("supplierId"),
            supplierName = root.textOrNull("supplierName"),
            salvageValue = root.text("salvageValue", "0"),
            usefulLifeYears = root.int("usefulLifeYears").coerceAtLeast(1),
            depreciationMethod = DepreciationMethod.fromWire(root.textOrNull("depreciationMethod")),
            accumulatedDepreciation = root.text("accumulated", root.text("accumulatedDepreciation", "0")),
            maintenanceTotal = root.text("maintTotal", "0"),
            disposalDate = root.textOrNull("disposalDate"),
            disposalReason = root.textOrNull("disposalReason"),
            disposalValue = root.textOrNull("disposalValue"),
            documents = root.list("docs").mapNotNull { raw ->
                val row = raw.asMap() ?: return@mapNotNull null
                val id = row.long("id")
                val title = row.text("title")
                if (id <= 0 || title.isBlank()) return@mapNotNull null
                AssetDocument(id = id, title = title, dataUrl = row.textOrNull("dataUrl"))
            },
            maintenance = root.list("maintenance").mapNotNull { raw ->
                val row = raw.asMap() ?: return@mapNotNull null
                val id = row.long("id")
                val type = row.text("type")
                if (id <= 0 || type.isBlank()) return@mapNotNull null
                AssetMaintenanceRecord(
                    id = id,
                    date = row.textOrNull("maintDate"),
                    type = type,
                    vendor = row.textOrNull("vendor"),
                    cost = row.text("cost", "0"),
                    note = row.textOrNull("note"),
                )
            },
            custody = root.list("custody").mapNotNull { raw ->
                val row = raw.asMap() ?: return@mapNotNull null
                val id = row.long("id")
                if (id <= 0) return@mapNotNull null
                AssetCustodyRecord(
                    id = id,
                    employeeName = row.textOrNull("employeeName"),
                    fromDate = row.textOrNull("fromDate"),
                    toDate = row.textOrNull("toDate"),
                    note = row.textOrNull("note"),
                )
            },
            limitedToScopedSummary = false,
        )
    }

    fun scopedAssetDetail(summary: AssetSummary): AssetDetail = AssetDetail(
        summary = summary,
        brand = null,
        serial = null,
        supplierId = null,
        supplierName = null,
        salvageValue = "0",
        usefulLifeYears = 1,
        depreciationMethod = DepreciationMethod.StraightLine,
        accumulatedDepreciation = "0",
        maintenanceTotal = "0",
        disposalDate = null,
        disposalReason = null,
        disposalValue = null,
        documents = emptyList(),
        maintenance = emptyList(),
        custody = emptyList(),
        limitedToScopedSummary = true,
    )

    fun assetFormOptions(root: JSONObject): AssetFormOptions = assetFormOptions(root.toWireMap())

    internal fun assetFormOptions(root: Map<String, Any?>): AssetFormOptions = AssetFormOptions(
        employees = root.list("employees").mapNotNull { raw ->
            val row = raw.asMap() ?: return@mapNotNull null
            val id = row.long("id")
            val name = row.text("name")
            if (id <= 0 || name.isBlank()) return@mapNotNull null
            AssetFormOption(
                id = id,
                name = name,
                branchId = row.longOrNull("branchId"),
                subtitle = row.textOrNull("position"),
            )
        },
        branches = root.list("branches").mapNotNull { raw ->
            val row = raw.asMap() ?: return@mapNotNull null
            val id = row.long("id")
            val name = row.text("name")
            if (id <= 0 || name.isBlank()) null else AssetFormOption(id = id, name = name)
        },
        suppliers = root.list("suppliers").mapNotNull { raw ->
            val row = raw.asMap() ?: return@mapNotNull null
            val id = row.long("id")
            val name = row.text("name")
            if (id <= 0 || name.isBlank()) null else AssetFormOption(id = id, name = name)
        },
    )

    fun assetDocument(root: JSONObject): AssetDocument = assetDocument(root.toWireMap())

    internal fun assetDocument(root: Map<String, Any?>): AssetDocument {
        val id = root.long("id")
        val title = root.text("title")
        require(id > 0 && title.isNotBlank()) { "Invalid asset document payload" }
        return AssetDocument(id = id, title = title, dataUrl = root.textOrNull("dataUrl"))
    }

    fun depreciationResult(root: JSONObject): AssetDepreciationResult = depreciationResult(root.toWireMap())

    internal fun depreciationResult(root: Map<String, Any?>): AssetDepreciationResult {
        val period = root.text("period")
        require(Regex("^\\d{4}-(0[1-9]|1[0-2])$").matches(period)) { "Invalid depreciation payload" }
        return AssetDepreciationResult(
            period = period,
            assetsPosted = root.int("assetsPosted").coerceAtLeast(0),
            totalDepreciation = root.text("totalDepreciation", "0"),
        )
    }

    fun myCommission(root: JSONObject): MyCommissionStatus = myCommission(root.toWireMap())

    internal fun myCommission(root: Map<String, Any?>): MyCommissionStatus {
        val settled = root.map("settled")
        return MyCommissionStatus(
            period = root.text("period"),
            employeeName = root.text("employeeName"),
            planName = root.textOrNull("planName"),
            sales = root.text("sales", "0"),
            returns = root.text("returns", "0"),
            consignmentDeduction = root.text("consignDeduction", "0"),
            carryIn = root.text("carryIn", "0"),
            effectiveBase = root.text("effectiveBase", "0"),
            target = root.textOrNull("target"),
            achievementPct = root.textOrNull("achievementPct"),
            projectedCommission = root.text("projectedCommission", "0"),
            settledAmount = settled?.textOrNull("commissionAmount"),
            settledApproved = settled?.textOrNull("status") == "approved",
            history = root.list("history").mapNotNull { raw ->
                val row = raw.asMap() ?: return@mapNotNull null
                val period = row.text("period")
                if (!PERIOD.matches(period)) return@mapNotNull null
                CommissionHistoryEntry(
                    period = period,
                    effectiveBase = row.text("effectiveBase", "0"),
                    commissionAmount = row.text("commissionAmount", "0"),
                    approved = row.textOrNull("status") == "approved",
                )
            },
        )
    }

    fun consignmentPage(root: JSONObject, offset: Int, limit: Int): ConsignmentPage =
        consignmentPage(root.toWireMap(), offset, limit)

    internal fun consignmentPage(root: Map<String, Any?>, offset: Int, limit: Int): ConsignmentPage =
        ConsignmentPage(
            rows = root.list("rows").mapNotNull { raw -> raw.asMap()?.let(::consignmentSummary) },
            total = root.int("total").coerceAtLeast(0),
            offset = offset.coerceAtLeast(0),
            limit = limit.coerceIn(1, 500),
        )

    fun consignmentDetail(root: JSONObject): ConsignmentNoteDetail = consignmentDetail(root.toWireMap())

    internal fun consignmentDetail(root: Map<String, Any?>): ConsignmentNoteDetail {
        val summary = consignmentSummary(root) ?: throw IllegalArgumentException("Invalid consignment payload")
        return ConsignmentNoteDetail(
            summary = summary,
            consignorPhone = root.textOrNull("consignorPhone"),
            notes = root.textOrNull("notes"),
            hasAttachment = root.textOrNull("attachmentUrl") != null,
            lines = root.list("lines").mapNotNull { raw ->
                val row = raw.asMap() ?: return@mapNotNull null
                val id = row.long("id")
                val variantId = row.long("variantId")
                val productName = row.text("productName")
                if (id <= 0 || variantId <= 0 || productName.isBlank()) return@mapNotNull null
                ConsignmentLine(
                    id = id,
                    directionIn = row.textOrNull("lineDirection") == "IN",
                    variantId = variantId,
                    productName = productName,
                    sku = row.textOrNull("sku"),
                    quantity = row.text("quantity", "0"),
                    baseQuantity = row.text("baseQuantity", "0"),
                    // Cost/share snapshots are intentionally not represented in the native UI.
                    unitShare = null,
                    notes = row.textOrNull("notes"),
                )
            },
            limitedToScopedSummary = false,
        )
    }

    fun scopedConsignmentDetail(summary: ConsignmentNoteSummary): ConsignmentNoteDetail =
        ConsignmentNoteDetail(
            summary = summary,
            consignorPhone = null,
            notes = null,
            hasAttachment = summary.hasAttachment,
            lines = emptyList(),
            limitedToScopedSummary = true,
        )

    fun consignorProducts(root: JSONArray): List<ConsignorProduct> = consignorProducts(root.toWireList())

    internal fun consignorProducts(root: List<Any?>): List<ConsignorProduct> = root.mapNotNull { raw ->
        val row = raw.asMap() ?: return@mapNotNull null
        val variantId = row.long("variantId")
        val productUnitId = row.long("productUnitId")
        val name = row.text("productName")
        if (variantId <= 0 || productUnitId <= 0 || name.isBlank()) return@mapNotNull null
        ConsignorProduct(
            variantId = variantId,
            productUnitId = productUnitId,
            productName = name,
            sku = row.textOrNull("sku"),
            color = row.textOrNull("color"),
            unitName = row.textOrNull("unitName"),
        )
    }

    private fun assetSummary(row: Map<String, Any?>): AssetSummary? {
        val id = row.long("id")
        val code = row.text("code")
        val name = row.text("name")
        if (id <= 0 || code.isBlank() || name.isBlank()) return null
        return AssetSummary(
            id = id,
            code = code,
            name = name,
            category = AssetCategory.fromWire(row.textOrNull("category")),
            status = AssetStatus.fromWire(row.textOrNull("status")),
            branchId = row.longOrNull("branchId"),
            branchName = row.textOrNull("branchName"),
            location = row.textOrNull("location"),
            custodianId = row.longOrNull("custodianId"),
            custodianName = row.textOrNull("custodianName"),
            purchaseDate = row.textOrNull("purchaseDate"),
            purchaseValue = row.text("purchaseValue", "0"),
            bookValue = row.text("bookValue", "0"),
            depreciationPct = row.text("depPct", "0"),
            condition = row.textOrNull("condition"),
            warrantyEnd = row.textOrNull("warrantyEnd"),
        )
    }

    private fun consignmentSummary(row: Map<String, Any?>): ConsignmentNoteSummary? {
        val id = row.long("id")
        val number = row.text("noteNumber")
        val consignorId = row.long("consignorId")
        val consignorName = row.text("consignorName")
        val branchId = row.long("branchId")
        if (id <= 0 || number.isBlank() || consignorId <= 0 || consignorName.isBlank() || branchId <= 0) return null
        return ConsignmentNoteSummary(
            id = id,
            noteNumber = number,
            type = ConsignmentNoteType.fromWire(row.textOrNull("noteType")),
            consignorId = consignorId,
            consignorName = consignorName,
            branchId = branchId,
            hasAttachment = row.boolean("hasAttachment") || row.textOrNull("attachmentUrl") != null,
            createdAt = row.textOrNull("createdAt"),
        )
    }

    private val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
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

private fun Map<String, Any?>.list(key: String): List<Any?> = this[key] as? List<Any?> ?: emptyList()
private fun Map<String, Any?>.map(key: String): Map<String, Any?>? = this[key].asMap()
private fun Map<String, Any?>.text(key: String, fallback: String = ""): String = textOrNull(key) ?: fallback
private fun Map<String, Any?>.textOrNull(key: String): String? = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String): Long = longOrNull(key) ?: 0L
private fun Map<String, Any?>.longOrNull(key: String): Long? = when (val value = this[key]) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.int(key: String): Int = when (val value = this[key]) {
    is Number -> value.toInt()
    is String -> value.toIntOrNull() ?: 0
    else -> 0
}
private fun Map<String, Any?>.boolean(key: String): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value == "1" || value.equals("true", ignoreCase = true)
    else -> false
}

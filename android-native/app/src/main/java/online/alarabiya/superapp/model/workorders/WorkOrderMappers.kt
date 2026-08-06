package online.alarabiya.superapp.model.workorders

import org.json.JSONArray
import org.json.JSONObject

object WorkOrderMappers {
    fun orderList(value: JSONArray) = orderList(value.wireList())
    internal fun orderList(value: List<Any?>): List<WorkOrderSummary> = value.mapNotNull { it.map()?.let { row ->
        WorkOrderSummary(
            id = row.long("id"), number = row.text("orderNumber"), title = row.text("title"), quantity = row.int("quantity"),
            status = WorkOrderStatus.wire(row.optText("status")), priority = WorkOrderPriority.wire(row.optText("priority")),
            channel = row.optText("receptionChannel"), salePrice = row.text("salePrice", "0"), deposit = row.text("deposit", "0"),
            dueDate = row.optText("dueDate"), createdAt = row.optText("createdAt"), assignedTo = row.optLong("assignedTo"),
            assigneeName = row.optText("assigneeName"), customerName = row.optText("customerName"),
            hasDelivery = row.bool("hasDelivery"), deliveryAddress = row.optText("deliveryAddress"),
            consignmentStatus = row.optText("consignmentStatus"), deliveryPartyName = row.optText("deliveryPartyName"),
        )
    } }

    fun counts(value: JSONObject) = counts(value.wireMap())
    internal fun counts(row: Map<String, Any?>) = WorkOrderCounts(row.int("received"), row.int("inProgress"), row.int("ready"), row.int("delivered"), row.int("cancelled"), row.int("late"))

    fun order(value: JSONObject, timeline: JSONArray) = order(value.wireMap(), timeline.wireList())
    internal fun order(row: Map<String, Any?>, timeline: List<Any?> = emptyList()) = WorkOrderDetail(
        id = row.long("id"), number = row.text("orderNumber"), title = row.text("title"), customizationText = row.optText("customizationText"),
        quantity = row.int("quantity"), status = WorkOrderStatus.wire(row.optText("status")), priority = WorkOrderPriority.wire(row.optText("priority")),
        branchId = row.long("branchId"), customerId = row.optLong("customerId"), customerName = row.optText("customerName"), customerPhone = row.optText("customerPhone"),
        materialsCost = row.optText("materialsCost"), laborCost = row.optText("laborCost"), salePrice = row.text("salePrice", "0"), deposit = row.text("deposit", "0"),
        dueDate = row.optText("dueDate"), hasDelivery = row.bool("hasDelivery"), deliveryAddress = row.optText("deliveryAddress"), deliveryPhone = row.optText("deliveryPhone"),
        deliveryCost = row.optText("deliveryCost"), assignedTo = row.optLong("assignedTo"), assigneeName = row.optText("assigneeName"), workStartedAt = row.optText("workStartedAt"),
        workSeconds = row.optLong("workSeconds"), deliveredAt = row.optText("deliveredAt"),
        materials = row.list("materials").mapNotNull { it.map()?.let { material -> WorkOrderMaterial(
            material.long("id"), material.long("variantId"), listOfNotNull(material.optText("productName"), material.optText("variantName")).joinToString(" · "),
            material.text("sku"), material.int("baseQuantity"), material.optText("unitCost"),
        ) } },
        timeline = timeline.mapNotNull { it.map()?.let { event -> WorkOrderTimeline(event.long("id"), event.text("action"), event.optText("createdAt"), event.optText("userName")) } },
    )

    fun staff(value: JSONArray) = value.wireList().mapNotNull { it.map()?.let { row -> StaffOption(row.long("id"), row.text("name")) } }
    fun printServices(value: JSONArray) = printServices(value.wireList())
    internal fun printServices(value: List<Any?>) = value.mapNotNull { it.map()?.let { row -> PrintService(
        row.long("productId"), row.text("productName"), row.long("variantId"), row.text("sku"), row.long("productUnitId"), row.text("unitName"), row.optText("categoryName"), row.optText("price"),
    ) } }

    fun pricing(value: JSONObject) = pricing(value.wireMap())
    internal fun pricing(root: Map<String, Any?>): PricingBundle {
        val settings = root.obj("settings").orEmpty()
        fun options(key: String, priceKey: String) = root.list(key).mapNotNull { value ->
            val row = value.map() ?: return@mapNotNull null
            if (row["isActive"] != null && !row.bool("isActive")) return@mapNotNull null
            PricingOption(row.long("id"), row.text("name"), row.text("unit"), row.text(priceKey, "0"))
        }.filter { it.id > 0 }
        return PricingBundle(
            mode = settings.text("pricingMode"), margin = settings.text("defaultMarginPercent", "0"), setupFee = settings.text("setupFee", "0"),
            paperUpcharges = options("paperUpcharges", "upcharge"), wideMedia = options("wideMedia", "pricePerSqm"), finishings = options("finishings", "price"),
        )
    }

    fun estimate(value: JSONObject) = estimate(value.wireMap())
    internal fun estimate(row: Map<String, Any?>) = PrintEstimate(
        category = row.text("category"), units = row.int("units"), faces = row.optInt("faces"), sheets = row.optInt("sheets"), areaSqm = row.optText("areaSqm"),
        totalCost = row.text("totalCost", "0"), suggestedPrice = row.text("suggestedPrice", "0"), unitPrice = row.text("unitPrice", "0"),
        lines = row.list("lines").mapNotNull { it.map()?.let { line -> EstimateLine(line.text("label"), line.text("amount", "0"), line.optText("detail")) } },
    )

    fun productions(value: JSONObject) = productions(value.wireMap())
    internal fun productions(root: Map<String, Any?>) = Pair(
        root.list("rows").mapNotNull { it.map()?.let { row -> ProductionSummary(
            row.long("id"), row.text("docNumber"), row.long("branchId"), row.text("branchName"), ProductionStatus.wire(row.optText("status")), row.int("outputQty"), row.text("totalCost", "0"), row.optText("createdAt"),
        ) } },
        root.bool("hasMore"),
    )

    fun production(value: JSONObject) = production(value.wireMap())
    internal fun production(row: Map<String, Any?>): ProductionDetail {
        fun lines(key: String) = row.list(key).mapNotNull { it.map()?.let { line -> ProductionLine(
            line.long("id"), line.text("direction"), listOfNotNull(line.optText("productName"), line.optText("variantName")).joinToString(" · "),
            line.text("sku"), line.int("baseQuantity"), line.optText("lineCost"), line.optText("allocatedCost"),
        ) } }
        return ProductionDetail(
            row.long("id"), row.text("docNumber"), row.long("branchId"), ProductionStatus.wire(row.optText("status")), row.text("branchName"), row.optInt("batchQty"), row.optInt("goodQty"), row.optInt("scrapQty"),
            row.text("totalCost", "0"), row.optText("recipeName"), row.optLong("linkedWorkOrderId"), lines("inputs"), lines("outputs"),
        )
    }

    fun recipes(value: JSONArray) = recipes(value.wireList())
    internal fun recipes(value: List<Any?>) = value.mapNotNull { it.map()?.let { row -> RecipeSummary(
        row.long("id"), row.text("name"), row.text("outputProductName"), row.text("outputUnitName"), row.int("linesCount"), row.bool("isActive"),
    ) } }

    fun recipePreview(value: JSONObject) = recipePreview(value.wireMap())
    internal fun recipePreview(row: Map<String, Any?>) = RecipePreview(
        row.long("recipeId"), row.text("outputName"), row.optInt("outputBase") ?: row.int("good"), row.text("laborCost", "0"), row.text("materialsCost", "0"), row.text("totalCost", "0"), row.bool("anyShort"),
        row.list("inputs").mapNotNull { it.map()?.let { line -> RecipePreviewLine(line.text("productName"), line.text("sku"), line.optInt("baseQuantity") ?: line.int("consumed"), line.optInt("available"), line.text("lineCost", "0")) } },
    )
}

private fun JSONObject.wireMap(): Map<String, Any?> = buildMap { val keys = keys(); while (keys.hasNext()) { val key = keys.next(); put(key, opt(key).wire()) } }
private fun JSONArray.wireList(): List<Any?> = buildList { for (index in 0 until length()) add(opt(index).wire()) }
private fun Any?.wire(): Any? = when (this) { null, JSONObject.NULL -> null; is JSONObject -> wireMap(); is JSONArray -> wireList(); else -> this }
private fun Any?.map(): Map<String, Any?>? = (this as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }
private fun Map<String, Any?>.obj(key: String) = this[key].map()
private fun Map<String, Any?>.list(key: String): List<Any?> = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.optText(key: String) = this[key]?.toString()?.takeIf { it.isNotBlank() }
private fun Map<String, Any?>.text(key: String, default: String = "") = optText(key) ?: default
private fun Map<String, Any?>.optLong(key: String): Long? = when (val v = this[key]) { is Number -> v.toLong(); is String -> v.toLongOrNull(); else -> null }
private fun Map<String, Any?>.long(key: String) = optLong(key) ?: 0L
private fun Map<String, Any?>.optInt(key: String) = optLong(key)?.toInt()
private fun Map<String, Any?>.int(key: String) = optInt(key) ?: 0
private fun Map<String, Any?>.bool(key: String) = when (val v = this[key]) { is Boolean -> v; is Number -> v.toInt() != 0; is String -> v == "1" || v.equals("true", true); else -> false }

package online.alarabiya.superapp.model.purchasing

import org.json.JSONArray
import org.json.JSONObject

object PurchasingMappers {
    fun catalog(root: JSONArray) = catalog(root.toWireList())
    internal fun catalog(root: List<Any?>) = root.mapNotNull { it.asMap()?.let { row ->
        PurchaseCatalogItem(
            productId = row.long("productId"), productName = row.text("productName", "صنف"), variantId = row.long("variantId"),
            variantName = row.nullableText("variantName"), sku = row.text("sku"), productUnitId = row.long("productUnitId"),
            unitName = row.text("unitName"), conversionFactor = row.text("conversionFactor", "1"), baseUnit = row.bool("isBaseUnit"),
            costPriceBase = row.text("costPriceBase", "0"), stockBase = row.int("stockBase"),
        )
    } }

    fun suppliers(root: JSONObject) = suppliers(root.toWireMap())
    internal fun suppliers(root: Map<String, Any?>) = SupplierPage(
        rows = root.list("rows").mapNotNull { it.asMap()?.let(::supplier) },
        total = root.int("total"),
    )

    fun supplier(root: JSONObject): SupplierDetail = supplierDetail(root.toWireMap())
    internal fun supplierDetail(root: Map<String, Any?>): SupplierDetail {
        val source = root.map("supplier") ?: root
        return SupplierDetail(
            summary = supplier(source),
            email = source.nullableText("email"), address = source.nullableText("address"),
            taxId = source.nullableText("taxId"), productTypes = source.nullableText("productTypes"),
            category = source.nullableText("supplierCategory"), leadTimeDays = source.nullableInt("leadTimeDays"),
            minimumOrderAmount = source.nullableText("minOrderAmount"), rating = source.nullableText("rating"),
            iban = source.nullableText("iban"), bankName = source.nullableText("bankName"),
            notes = source.nullableText("notes"), openingBalance = root.nullableText("openingBalance") ?: source.nullableText("openingBalance"),
        )
    }

    fun orders(root: JSONArray) = orders(root.toWireList())
    internal fun orders(root: List<Any?>): List<PurchaseOrderSummary> = root.mapNotNull { it.asMap()?.let(::order) }

    fun order(root: JSONObject): PurchaseOrderDetail = orderDetail(root.toWireMap())
    internal fun orderDetail(root: Map<String, Any?>): PurchaseOrderDetail = PurchaseOrderDetail(
        summary = order(root), subtotal = root.nullableText("subtotal"), taxAmount = root.nullableText("taxAmount"),
        taxRatePercent = root.nullableText("taxRatePercent"), notes = root.nullableText("notes"),
        lines = root.list("items").mapNotNull { it.asMap()?.let { row ->
            PurchaseOrderLine(
                id = row.long("id"), variantId = row.long("variantId"), productUnitId = row.long("productUnitId"),
                productName = row.text("productName", "صنف"), variantName = row.nullableText("variantName"), sku = row.nullableText("sku"),
                unitName = row.nullableText("unitName"), quantity = row.text("quantity", "0"), baseQuantity = row.int("baseQuantity"),
                receivedBaseQuantity = row.int("receivedBaseQuantity"), unitPrice = row.nullableText("unitPrice"), total = row.nullableText("total"),
                usdUnitPrice = row.nullableText("usdUnitPrice"), usdTotal = row.nullableText("usdTotal"),
            )
        } },
    )

    fun returns(root: JSONObject) = returns(root.toWireMap())
    internal fun returns(root: Map<String, Any?>) = PurchaseReturnPage(
        rows = root.list("rows").mapNotNull { it.asMap()?.let { row ->
            PurchaseReturnSummary(
                id = row.long("id"), date = row.nullableText("entryDate"), supplierId = row.long("supplierId"),
                branchId = row.long("branchId"), purchaseOrderId = row.nullableLong("purchaseOrderId"),
                amount = row.text("amount", "0"), notes = row.nullableText("notes"),
            )
        } }, total = root.int("total"),
    )

    fun reminderQueue(root: JSONArray) = reminderQueue(root.toWireList())
    internal fun reminderQueue(root: List<Any?>) = root.mapNotNull { it.asMap()?.let { row ->
        ReminderQueueItem(
            supplierId = row.long("supplierId"), supplierName = row.text("supplierName", "مورد"), phone = row.nullableText("phone"),
            totalUnpaid = row.text("totalUnpaid", "0"), oldestPoDate = row.text("oldestPoDate"), daysOverdue = row.int("daysOverdue"),
            lastReminderAt = row.nullableText("lastReminderAt"), lastStatus = row.nullableText("lastStatus"),
            promisedDate = row.nullableText("promisedDate"), promiseDue = row.bool("isPromiseDue"),
        )
    } }

    fun reminderHistory(root: JSONArray) = reminderHistory(root.toWireList())
    internal fun reminderHistory(root: List<Any?>) = root.mapNotNull { it.asMap()?.let { row ->
        ReminderHistoryItem(
            id = row.long("id"), supplierId = row.long("supplierId"), supplierName = row.text("supplierName", "مورد"),
            totalUnpaidSnapshot = row.text("totalUnpaidSnapshot", "0"), daysOverdue = row.int("daysOverdue"), status = row.text("status"),
            skipReason = row.nullableText("skipReason"), promisedDate = row.nullableText("promisedDate"),
            createdBy = row.nullableLong("createdBy"), createdAt = row.nullableText("createdAt"),
        )
    } }

    private fun supplier(row: Map<String, Any?>) = SupplierSummary(
        id = row.long("id"), name = row.text("name", "مورد"), phone = row.nullableText("phone"), whatsapp = row.nullableText("whatsapp"),
        city = row.nullableText("city"), paymentTerms = row.nullableText("paymentTerms"), currentBalance = row.nullableText("currentBalance"),
        currentBalanceUsd = row.nullableText("currentBalanceUsd"), legacyCode = row.nullableText("legacyCode"),
        kind = row.enum("supplierKind", SupplierKind.UNKNOWN), active = row.bool("isActive", true),
    )

    private fun order(row: Map<String, Any?>) = PurchaseOrderSummary(
        id = row.long("id"), number = row.text("poNumber", "PO-${row.long("id")}"), orderDate = row.nullableText("orderDate"),
        supplierId = row.long("supplierId"), supplierName = row.nullableText("supplierName"), branchId = row.long("branchId"),
        total = row.nullableText("total"), paidAmount = row.nullableText("paidAmount"), shippingCost = row.nullableText("shippingCost"),
        customsCost = row.nullableText("customsCost"), agreedCurrency = row.enum("agreedCurrency", Currency.IQD),
        usdTotal = row.nullableText("usdTotal"), paidUsd = row.nullableText("paidUsd"), returnedUsd = row.nullableText("returnedUsd"),
        agreedRate = row.nullableText("agreedRate"), status = row.enum("status", PurchaseStatus.UNKNOWN), version = row.int("version"),
    )
}

private fun JSONObject.toWireMap(): Map<String, Any?> = buildMap {
    val iterator = keys(); while (iterator.hasNext()) { val key = iterator.next(); put(key, opt(key).toWire()) }
}
private fun JSONArray.toWireList(): List<Any?> = buildList { for (index in 0 until length()) add(opt(index).toWire()) }
private fun Any?.toWire(): Any? = when (this) { null, JSONObject.NULL -> null; is JSONObject -> toWireMap(); is JSONArray -> toWireList(); else -> this }
private fun Any?.asMap(): Map<String, Any?>? = (this as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }
private fun Map<String, Any?>.map(key: String): Map<String, Any?>? = this[key].asMap()
private fun Map<String, Any?>.list(key: String): List<Any?> = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.text(key: String, fallback: String = "") = nullableText(key) ?: fallback
private fun Map<String, Any?>.nullableText(key: String) = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String) = nullableLong(key) ?: 0L
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val value = this[key]) { is Number -> value.toLong(); is String -> value.toLongOrNull(); else -> null }
private fun Map<String, Any?>.int(key: String) = nullableLong(key)?.toInt() ?: 0
private fun Map<String, Any?>.nullableInt(key: String) = nullableLong(key)?.toInt()
private fun Map<String, Any?>.bool(key: String, fallback: Boolean = false): Boolean = when (val value = this[key]) { is Boolean -> value; is Number -> value.toInt() != 0; is String -> value == "1" || value.equals("true", true); else -> fallback }
private inline fun <reified T : Enum<T>> Map<String, Any?>.enum(key: String, fallback: T) = enumValues<T>().firstOrNull { it.name == nullableText(key) } ?: fallback

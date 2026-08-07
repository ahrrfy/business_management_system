package online.alarabiya.superapp.model.sales

import org.json.JSONArray
import org.json.JSONObject

object SalesMappers {
    fun catalog(root: JSONArray): List<CatalogSaleItem> = catalog(root.toWireList())
    internal fun catalog(root: List<Any?>): List<CatalogSaleItem> = root.mapNotNull { value ->
        value.asMap()?.let { row ->
            CatalogSaleItem(
                productId = row.long("productId"),
                productName = row.text("productName"),
                variantId = row.long("variantId"),
                variantName = row.nullableText("variantName"),
                color = row.nullableText("color"),
                size = row.nullableText("size"),
                sku = row.text("sku"),
                productUnitId = row.long("productUnitId"),
                unitName = row.text("unitName"),
                conversionFactor = row.text("conversionFactor", "1"),
                barcode = row.nullableText("barcode"),
                serverPrice = row.nullableText("price"),
                availableBase = row.int("availableBase"),
                openedAt = row.nullableText("openedAt"),
                isService = row.bool("isService"),
                isBundle = row.bool("isBundle"),
                isContractPrice = row.bool("isContractPrice"),
                promotionName = row.nullableText("promotionName"),
            )
        }
    }

    fun customers(root: JSONObject): List<SalesCustomer> = customers(root.toWireMap())
    internal fun customers(root: Map<String, Any?>): List<SalesCustomer> = root.list("rows").mapNotNull { value ->
        value.asMap()?.let { row ->
            SalesCustomer(
                id = row.long("id"),
                name = row.text("name"),
                phone = row.nullableText("phone") ?: row.nullableText("whatsapp"),
                priceTier = row.enum("defaultPriceTier", PriceTier.RETAIL),
            )
        }
    }

    fun shifts(root: JSONObject): List<RetailShift> = shifts(root.toWireMap())
    internal fun shifts(root: Map<String, Any?>): List<RetailShift> = root.list("rows").mapNotNull { value ->
        value.asMap()?.let { row ->
            RetailShift(
                id = row.long("id"),
                branchId = row.long("branchId"),
                userId = row.long("userId"),
                userName = row.nullableText("userName"),
                status = row.text("status"),
                openedAt = row.nullableText("openedAt"),
            )
        }
    }

    fun creation(root: JSONObject): SaleCreation = creation(root.toWireMap())
    internal fun creation(root: Map<String, Any?>): SaleCreation = SaleCreation(
        invoiceId = root.long("invoiceId"),
        invoiceNumber = root.text("invoiceNumber"),
        total = root.text("total", "0"),
        status = root.text("status"),
        idempotentReplay = root.bool("idempotentReplay"),
    )

    fun page(root: JSONObject): SalesPage = page(root.toWireMap())
    internal fun page(root: Map<String, Any?>): SalesPage = SalesPage(
        rows = root.list("rows").mapNotNull { value -> value.asMap()?.let(::summary) },
        nextCursor = root.nullableLong("nextCursor"),
        hasMore = root.bool("hasMore"),
    )

    fun detail(root: JSONObject): SaleDetail = detail(root.toWireMap())
    internal fun detail(root: Map<String, Any?>): SaleDetail = SaleDetail(
        id = root.long("id"),
        invoiceNumber = root.text("invoiceNumber"),
        branchId = root.long("branchId"),
        customerName = root.nullableText("customerName"),
        invoiceDate = root.nullableText("invoiceDate"),
        subtotal = root.text("subtotal", "0"),
        discountAmount = root.text("discountAmount", "0"),
        taxAmount = root.text("taxAmount", "0"),
        total = root.text("total", "0"),
        paidAmount = root.text("paidAmount", "0"),
        returnedTotal = root.text("returnedTotal", "0"),
        status = root.text("status"),
        paymentMethod = root.nullableText("paymentMethod"),
        notes = root.nullableText("notes"),
        items = root.list("items").mapNotNull { value -> value.asMap()?.let { row ->
            SaleLine(
                id = row.long("id"),
                productName = row.text("productName"),
                variantName = row.nullableText("variantName"),
                unitName = row.nullableText("unitName"),
                sku = row.nullableText("sku"),
                quantity = row.text("quantity", "0"),
                baseQuantity = row.int("baseQuantity"),
                returnedBaseQuantity = row.int("returnedBaseQuantity"),
                unitPrice = row.text("unitPrice", "0"),
                discountAmount = row.text("discountAmount", "0"),
                total = row.text("total", "0"),
            )
        } },
        payments = root.list("payments").mapNotNull { value -> value.asMap()?.let { row ->
            SalePayment(
                id = row.long("id"),
                direction = row.text("direction"),
                amount = row.text("amount", "0"),
                paymentMethod = row.text("paymentMethod"),
                status = row.text("status"),
                createdAt = row.nullableText("createdAt"),
                referenceNumber = row.nullableText("referenceNumber"),
            )
        } },
        returns = root.list("returns").mapNotNull { value -> value.asMap()?.let { row ->
            SaleReturnEntry(
                id = row.long("id"),
                amount = row.text("amount", "0"),
                performedByName = row.nullableText("performedByName"),
                createdAt = row.nullableText("createdAt"),
            )
        } },
    )

    fun returnableInvoice(root: JSONObject): ReturnableInvoice = returnableInvoice(root.toWireMap())
    internal fun returnableInvoice(root: Map<String, Any?>): ReturnableInvoice = ReturnableInvoice(
        id = root.long("id"),
        invoiceNumber = root.text("invoiceNumber"),
        branchId = root.long("branchId"),
        customerName = root.nullableText("customerName"),
        total = root.text("total", "0"),
        paidAmount = root.text("paidAmount", "0"),
        status = root.text("status"),
        paymentMethod = root.nullableText("paymentMethod"),
        items = root.list("items").mapNotNull { value -> value.asMap()?.let { row ->
            ReturnableLine(
                invoiceItemId = row.long("invoiceItemId"),
                productName = row.text("productName"),
                variantLabel = row.nullableText("variantLabel"),
                unitName = row.text("unitName"),
                baseQuantity = row.int("baseQuantity"),
                returnedBaseQuantity = row.int("returnedBaseQuantity"),
                remaining = row.int("remaining"),
                unitPrice = row.text("unitPrice", "0"),
                total = row.text("total", "0"),
            )
        } },
    )

    fun returnCreation(root: JSONObject): ReturnCreation = returnCreation(root.toWireMap())
    internal fun returnCreation(root: Map<String, Any?>): ReturnCreation = ReturnCreation(
        invoiceId = root.long("invoiceId"),
        returnedTotal = root.text("returnedTotal", "0"),
        fullyReturned = root.bool("fullyReturned"),
        idempotentReplay = root.bool("idempotentReplay"),
    )

    private fun summary(row: Map<String, Any?>) = SaleSummary(
        id = row.long("id"),
        invoiceNumber = row.text("invoiceNumber"),
        invoiceDate = row.nullableText("invoiceDate"),
        total = row.text("total", "0"),
        paidAmount = row.text("paidAmount", "0"),
        returnedTotal = row.text("returnedTotal", "0"),
        status = row.text("status"),
        paymentMethod = row.nullableText("paymentMethod"),
        customerName = row.nullableText("customerName"),
        salespersonName = row.nullableText("salespersonName"),
        branchId = row.long("branchId"),
        shiftId = row.nullableLong("shiftId"),
    )
}

private fun JSONObject.toWireMap(): Map<String, Any?> = buildMap {
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        put(key, opt(key).toWire())
    }
}

private fun JSONArray.toWireList(): List<Any?> = buildList {
    for (index in 0 until length()) add(opt(index).toWire())
}

private fun Any?.toWire(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toWireMap()
    is JSONArray -> toWireList()
    else -> this
}

private fun Any?.asMap(): Map<String, Any?>? =
    (this as? Map<*, *>)?.entries?.associate { (key, value) -> key.toString() to value }

private fun Map<String, Any?>.list(key: String): List<Any?> = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.text(key: String, default: String = ""): String = nullableText(key) ?: default
private fun Map<String, Any?>.nullableText(key: String): String? = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String): Long = nullableLong(key) ?: 0L
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val value = this[key]) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.int(key: String): Int = nullableLong(key)?.toInt() ?: 0
private fun Map<String, Any?>.bool(key: String): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value.equals("true", true) || value == "1"
    else -> false
}
private inline fun <reified T : Enum<T>> Map<String, Any?>.enum(key: String, default: T): T =
    enumValues<T>().firstOrNull { it.name == nullableText(key) } ?: default

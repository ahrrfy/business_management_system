package online.alarabiya.superapp.model.store

import org.json.JSONArray
import org.json.JSONObject

object StoreMappers {
    fun orders(root: JSONArray): List<StoreOrderSummary> = orders(root.toWireList())

    internal fun orders(root: List<Any?>): List<StoreOrderSummary> = root.mapNotNull { value ->
        value.asStringMap()?.let { row -> runCatching { orderSummary(row) }.getOrNull() }
    }

    fun orderDetail(root: JSONObject): StoreOrderDetail = orderDetail(root.toWireMap())

    internal fun orderDetail(root: Map<String, Any?>): StoreOrderDetail = StoreOrderDetail(
        summary = orderSummary(root),
        branchId = root.long("branchId"),
        address = root.nullableText("addressText"),
        subtotal = root.text("subtotal", "0"),
        deliveryPartyName = root.nullableText("deliveryPartyName"),
        items = root.list("items").mapNotNull { value ->
            value.asStringMap()?.let { item ->
                StoreOrderLine(
                    productName = item.text("productName"),
                    variantLabel = item.nullableText("variantLabel"),
                    unitName = item.nullableText("unitName"),
                    quantity = item.text("quantity", "0"),
                    unitPrice = item.text("unitPrice", "0"),
                    total = item.text("total", "0"),
                )
            }
        },
    )

    fun parties(root: JSONArray): List<DeliveryPartyOption> = parties(root.toWireList())

    internal fun parties(root: List<Any?>): List<DeliveryPartyOption> = root.mapNotNull { value ->
        value.asStringMap()?.let { party ->
            val id = party.long("id")
            val name = party.text("name")
            if (id <= 0 || name.isBlank()) null
            else DeliveryPartyOption(
                id = id,
                name = name,
                phone = party.nullableText("phone"),
                currentBalance = party.text("currentBalance", "0"),
                isActive = party.bool("isActive"),
            )
        }
    }

    fun counts(root: JSONObject): Map<StoreOrderStatus, Int> = counts(root.toWireMap())

    internal fun counts(root: Map<String, Any?>): Map<StoreOrderStatus, Int> = StoreOrderStatus.entries.associateWith {
        root.int(it.wire).coerceAtLeast(0)
    }

    fun courierWorkspace(root: JSONObject): CourierWorkspace = courierWorkspace(root.toWireMap())

    internal fun courierWorkspace(root: Map<String, Any?>): CourierWorkspace = CourierWorkspace(
        linked = root.bool("linked"),
        partyName = root.nullableText("partyName"),
        custodyBalance = root.text("custodyBalance", "0"),
        toDeliver = root.list("toDeliver").mapNotNull { courierDelivery(it.asStringMap()) },
        delivered = root.list("delivered").mapNotNull { courierDelivery(it.asStringMap()) },
    )

    private fun orderSummary(row: Map<String, Any?>): StoreOrderSummary {
        val id = row.long("id")
        val orderNumber = row.text("orderNumber")
        require(id > 0 && orderNumber.isNotBlank()) { "Invalid store order payload" }
        return StoreOrderSummary(
            id = id,
            orderNumber = orderNumber,
            status = StoreOrderStatus.fromWire(row.nullableText("status")),
            customerName = row.nullableText("customerName"),
            customerPhone = row.nullableText("customerPhone"),
            governorate = row.nullableText("governorate"),
            total = row.text("total", "0"),
            deliveryFee = row.text("deliveryFee", "0"),
            deliveryPartyId = row.nullableLong("deliveryPartyId"),
            cancelReason = row.nullableText("cancelReason"),
            itemCount = row.int("itemCount"),
            createdAt = row.nullableText("createdAt"),
        )
    }

    private fun courierDelivery(row: Map<String, Any?>?): CourierDelivery? = row?.let {
        val id = it.long("id")
        val orderNumber = it.text("orderNumber")
        if (id <= 0 || orderNumber.isBlank()) return@let null
        CourierDelivery(
            id = id,
            orderNumber = orderNumber,
            status = StoreOrderStatus.fromWire(it.nullableText("status")),
            customerName = it.nullableText("customerName"),
            customerPhone = it.nullableText("customerPhone"),
            governorate = it.nullableText("governorate"),
            address = it.nullableText("address"),
            orderTotal = it.text("orderTotal", "0"),
            codDue = it.text("codDue", "0"),
            createdAt = it.nullableText("createdAt"),
        )
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

private fun Any?.asStringMap(): Map<String, Any?>? =
    (this as? Map<*, *>)?.entries?.associate { (key, value) -> key.toString() to value }

private fun Map<String, Any?>.list(key: String): List<Any?> = this[key] as? List<Any?> ?: emptyList()
private fun Map<String, Any?>.text(key: String, fallback: String = ""): String = nullableText(key) ?: fallback
private fun Map<String, Any?>.nullableText(key: String): String? = this[key]?.toString()?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.long(key: String): Long = nullableLong(key) ?: 0L
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val value = this[key]) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.int(key: String): Int = when (val value = this[key]) {
    is Number -> value.toInt()
    is String -> value.toIntOrNull() ?: 0
    else -> 0
}
private fun Map<String, Any?>.bool(key: String): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value == "1" || value.equals("true", ignoreCase = true)
    else -> false
}

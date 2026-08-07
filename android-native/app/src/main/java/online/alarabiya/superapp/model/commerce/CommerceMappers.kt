package online.alarabiya.superapp.model.commerce

import org.json.JSONArray
import org.json.JSONObject

object CommerceMappers {
    fun branches(root: JSONArray): List<CommerceBranch> =
        (0 until root.length()).mapNotNull { root.opt(it).toWireValue().asStringMap()?.let(::branch) }

    internal fun branches(rows: List<Any?>): List<CommerceBranch> =
        rows.mapNotNull { it.asStringMap()?.let(::branch) }

    fun giftPage(root: JSONObject): GiftPage = giftPage(root.toWireMap())

    internal fun giftPage(root: Map<String, Any?>): GiftPage = GiftPage(
        rows = root.list("rows").mapNotNull { it.asStringMap()?.let(::giftSummary) },
        total = root.int("total"),
        hasMore = root.bool("hasMore"),
        nextCursor = root.nullableLong("nextCursor"),
    )

    fun giftDetail(root: JSONObject): GiftDetail = giftDetail(root.toWireMap())

    internal fun giftDetail(root: Map<String, Any?>): GiftDetail = GiftDetail(
        id = root.long("id"),
        number = root.text("giftNumber"),
        direction = root.giftDirection(),
        branchId = root.long("branchId"),
        status = GiftStatus.fromWire(root.nullableText("status")),
        type = root.nullableText("giftType"),
        reason = root.nullableText("reason"),
        sellable = root.bool("sellable"),
        partyName = root.nullableText("partyName"),
        partyPhone = root.nullableText("partyPhone"),
        createdAt = root.nullableText("createdAt"),
        lines = root.list("lines").mapNotNull { value ->
            value.asStringMap()?.let { line ->
                GiftLine(
                    productName = line.text("productName"),
                    sku = line.nullableText("sku"),
                    unitName = line.nullableText("unitName"),
                    quantity = line.text("quantity", "0"),
                    baseQuantity = line.text("baseQuantity", "0"),
                )
            }
        },
    )

    fun reservationPage(root: JSONObject): ReservationPage = reservationPage(root.toWireMap())

    internal fun reservationPage(root: Map<String, Any?>): ReservationPage = ReservationPage(
        rows = root.list("rows").mapNotNull { it.asStringMap()?.let(::reservationSummary) },
        hasMore = root.bool("hasMore"),
    )

    fun reservationDetail(root: JSONObject): ReservationDetail = reservationDetail(root.toWireMap())

    internal fun reservationDetail(root: Map<String, Any?>): ReservationDetail = ReservationDetail(
        summary = reservationSummary(root),
        total = root.text("total", "0"),
        hasUnpriced = root.bool("hasUnpriced"),
        lines = root.list("lines").mapNotNull { value ->
            value.asStringMap()?.let { line ->
                ReservationLine(
                    id = line.long("id"),
                    productName = line.text("productName"),
                    variantName = line.nullableText("variantName"),
                    unitName = line.nullableText("unitName"),
                    quantity = line.text("quantity", "0"),
                    fulfilledBase = line.text("fulfilledBase", "0"),
                    quotedUnitPrice = line.nullableText("quotedUnitPrice"),
                    lineTotal = line.nullableText("lineTotal"),
                )
            }
        },
    )

    fun conversion(root: JSONObject): ReservationConversion = conversion(root.toWireMap())

    internal fun conversion(root: Map<String, Any?>): ReservationConversion = ReservationConversion(
        reservationId = root.long("reservationId"),
        invoiceId = root.long("invoiceId"),
        invoiceNumber = root.text("invoiceNumber"),
        total = root.text("total", "0"),
        status = root.text("status"),
        idempotentReplay = root.bool("idempotentReplay"),
    )

    fun digitalCards(root: JSONArray): List<DigitalCard> =
        (0 until root.length()).mapNotNull { root.opt(it).toWireValue().asStringMap()?.let(::digitalCard) }

    internal fun digitalCards(rows: List<Any?>): List<DigitalCard> =
        rows.mapNotNull { it.asStringMap()?.let(::digitalCard) }

    fun confirmedCard(root: JSONObject): ConfirmedDigitalCard = confirmedCard(root.toWireMap())

    internal fun confirmedCard(root: Map<String, Any?>): ConfirmedDigitalCard = ConfirmedDigitalCard(
        card = digitalCard(root),
        sellPrice = root.text("sellPrice"),
        priceVersionId = root.long("priceVersionId"),
    )

    fun subscriptions(root: JSONArray): List<DigitalSubscription> =
        (0 until root.length()).mapNotNull { root.opt(it).toWireValue().asStringMap()?.let(::subscription) }

    internal fun subscriptions(rows: List<Any?>): List<DigitalSubscription> =
        rows.mapNotNull { it.asStringMap()?.let(::subscription) }

    private fun giftSummary(root: Map<String, Any?>): GiftSummary = GiftSummary(
        id = root.long("id"),
        number = root.text("giftNumber"),
        direction = root.giftDirection(),
        branchId = root.long("branchId"),
        status = GiftStatus.fromWire(root.nullableText("status")),
        type = root.nullableText("giftType"),
        reason = root.nullableText("reason"),
        sellable = root.bool("sellable"),
        supplierName = root.nullableText("supplierName"),
        customerName = root.nullableText("customerName"),
        estimatedValue = root.nullableText("estimatedValue"),
        totalCost = root.nullableText("totalCost"),
        createdAt = root.nullableText("createdAt"),
    )

    private fun reservationSummary(root: Map<String, Any?>): ReservationSummary = ReservationSummary(
        id = root.long("id"),
        number = root.text("reservationNumber"),
        branchId = root.long("branchId"),
        customerId = root.nullableLong("customerId"),
        contactName = root.nullableText("contactName"),
        contactPhone = root.nullableText("contactPhone"),
        channel = root.nullableText("channel"),
        status = ReservationStatus.fromWire(root.nullableText("status")),
        expiresAt = root.nullableText("expiresAt"),
        notes = root.nullableText("notes"),
        createdAt = root.nullableText("createdAt"),
    )

    private fun digitalCard(root: Map<String, Any?>): DigitalCard = DigitalCard(
        offeringId = root.long("offeringId"),
        name = root.text("name"),
        providerId = root.long("providerId"),
        providerName = root.text("providerName"),
        offeringType = root.text("offeringType"),
        requiresStudentData = root.bool("requiresStudentData"),
        faceValue = root.nullableText("faceValue"),
        sellPrice = root.nullableText("sellPrice"),
        priceVersionId = root.nullableLong("priceVersionId"),
        imageUrl = root.nullableText("imageUrl"),
        colorToken = root.nullableText("cardColorToken"),
        favorite = root.bool("isFavorite"),
        availability = DigitalCardAvailability.fromWire(root.nullableText("availability")),
    )

    private fun subscription(root: Map<String, Any?>): DigitalSubscription = DigitalSubscription(
        id = root.long("id"),
        offeringName = root.text("offeringName"),
        branchId = root.long("branchId"),
        invoiceId = root.long("invoiceId"),
        studentName = root.text("studentName"),
        durationDays = root.int("durationDays"),
        startsAt = root.nullableText("startsAt"),
        expiresAt = root.nullableText("expiresAt"),
        status = root.text("status"),
    )

    private fun branch(root: Map<String, Any?>): CommerceBranch = CommerceBranch(
        id = root.long("id"),
        name = root.text("name"),
        code = root.nullableText("code"),
    )
}

private fun Map<String, Any?>.giftDirection(): GiftDirection =
    GiftDirection.entries.firstOrNull { it.name == nullableText("direction") } ?: GiftDirection.IN

private fun JSONObject.toWireMap(): Map<String, Any?> = buildMap {
    val keys = keys()
    while (keys.hasNext()) {
        val key = keys.next()
        put(key, opt(key).toWireValue())
    }
}

private fun Any?.toWireValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toWireMap()
    is JSONArray -> (0 until length()).map { opt(it).toWireValue() }
    else -> this
}

private fun Any?.asStringMap(): Map<String, Any?>? =
    (this as? Map<*, *>)?.entries?.associate { (key, value) -> key.toString() to value }

private fun Map<String, Any?>.list(key: String): List<Any?> = this[key] as? List<Any?> ?: emptyList()
private fun Map<String, Any?>.text(key: String, default: String = ""): String = nullableText(key) ?: default
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
    is String -> value.equals("true", ignoreCase = true) || value == "1"
    else -> false
}

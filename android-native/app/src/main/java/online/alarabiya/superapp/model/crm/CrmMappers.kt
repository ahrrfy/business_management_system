package online.alarabiya.superapp.model.crm

import org.json.JSONArray
import org.json.JSONObject

object CrmMappers {
    fun customerPage(root: JSONObject): CustomerPage = customerPage(root.toWireMap())

    internal fun customerPage(root: Map<String, Any?>): CustomerPage = CustomerPage(
        rows = root.list("rows").mapNotNull(::customerSummary),
        total = root.int("total"),
    )

    fun customerDetail(root: JSONObject): CustomerDetail = customerDetail(root.toWireMap())

    internal fun customerDetail(root: Map<String, Any?>): CustomerDetail = CustomerDetail(
        id = root.long("id"),
        name = root.text("name"),
        phone = root.nullableText("phone"),
        phone2 = root.nullableText("phone2"),
        phone3 = root.nullableText("phone3"),
        whatsapp = root.nullableText("whatsapp"),
        address = root.nullableText("address"),
        city = root.nullableText("city"),
        district = root.nullableText("district"),
        customerType = CustomerType.fromWire(root.nullableText("customerType")),
        priceTier = root.priceTier("defaultPriceTier"),
        creditLimit = root.nullableText("creditLimit"),
        currentBalance = root.nullableText("currentBalance"),
        openingBalance = root.nullableText("openingBalance"),
        notes = root.nullableText("notes"),
        waConsent = root.nullableText("waConsent"),
        isActive = root.bool("isActive", default = true),
    )

    fun customerFollowUpPage(root: JSONObject): CustomerFollowUpPage = customerFollowUpPage(root.toWireMap())

    internal fun customerFollowUpPage(root: Map<String, Any?>): CustomerFollowUpPage = CustomerFollowUpPage(
        rows = root.list("rows").mapNotNull(::customerFollowUp),
        total = root.int("total"),
    )

    fun dueCustomerFollowUps(root: JSONArray): List<CustomerFollowUp> = dueCustomerFollowUps(root.toWireList())

    internal fun dueCustomerFollowUps(root: List<Any?>): List<CustomerFollowUp> =
        root.mapNotNull(::customerFollowUp)

    fun contractPrices(root: JSONArray): List<CustomerContractPrice> = contractPrices(root.toWireList())

    internal fun contractPrices(root: List<Any?>): List<CustomerContractPrice> = root.mapNotNull { value ->
        value.asStringMap()?.let { row ->
            CustomerContractPrice(
                id = row.long("id"),
                customerId = row.long("customerId"),
                productUnitId = row.long("productUnitId"),
                price = row.text("price", "0"),
                isActive = row.bool("isActive", default = true),
                note = row.nullableText("note"),
                updatedAt = row.nullableText("updatedAt"),
                productId = row.long("productId"),
                productName = row.text("productName"),
                variantName = row.nullableText("variantName"),
                color = row.nullableText("color"),
                size = row.nullableText("size"),
                sku = row.text("sku"),
                unitName = row.text("unitName"),
            )
        }
    }

    fun contractPricePage(root: JSONObject): CustomerContractPricePage = contractPricePage(root.toWireMap())

    internal fun contractPricePage(root: Map<String, Any?>): CustomerContractPricePage = CustomerContractPricePage(
        rows = contractPrices(root.list("rows")),
        total = root.int("total"),
        hasMore = root.bool("hasMore"),
        nextCursor = root.nullableText("nextCursor"),
    )

    fun quotationPage(root: JSONObject): QuotationPage = quotationPage(root.toWireMap())

    internal fun quotationPage(root: Map<String, Any?>): QuotationPage = QuotationPage(
        rows = root.list("rows").mapNotNull { value ->
            value.asStringMap()?.let { row ->
                QuotationSummary(
                    id = row.long("id"),
                    quoteNumber = row.text("quoteNumber"),
                    quoteDate = row.nullableText("quoteDate"),
                    validUntil = row.nullableText("validUntil"),
                    total = row.text("total", "0"),
                    status = QuotationStatus.fromWire(row.nullableText("status")),
                    convertedInvoiceId = row.nullableLong("convertedInvoiceId"),
                    customerId = row.nullableLong("customerId"),
                    customerName = row.nullableText("customerName"),
                    customerPhone = row.nullableText("customerPhone"),
                )
            }
        },
        hasMore = root.bool("hasMore"),
        nextCursor = root.nullableLong("nextCursor"),
    )

    fun quotationDetail(root: JSONObject): QuotationDetail = quotationDetail(root.toWireMap())

    internal fun quotationDetail(root: Map<String, Any?>): QuotationDetail = QuotationDetail(
        id = root.long("id"),
        quoteNumber = root.text("quoteNumber"),
        branchId = root.long("branchId"),
        customerId = root.nullableLong("customerId"),
        customerName = root.nullableText("customerName"),
        customerPhone = root.nullableText("customerPhone"),
        priceTier = root.priceTier("priceTier"),
        quoteDate = root.nullableText("quoteDate"),
        validUntil = root.nullableText("validUntil"),
        subtotal = root.text("subtotal", "0"),
        taxAmount = root.text("taxAmount", "0"),
        taxRatePercent = root.text("taxRatePercent", "0"),
        discountAmount = root.text("discountAmount", "0"),
        total = root.text("total", "0"),
        status = QuotationStatus.fromWire(root.nullableText("status")),
        convertedInvoiceId = root.nullableLong("convertedInvoiceId"),
        notes = root.nullableText("notes"),
        items = root.list("items").mapNotNull { value ->
            value.asStringMap()?.let { row ->
                QuotationLine(
                    id = row.long("id"),
                    variantId = row.long("variantId"),
                    productUnitId = row.long("productUnitId"),
                    productName = row.text("productName"),
                    variantName = row.nullableText("variantName"),
                    unitName = row.nullableText("unitName"),
                    sku = row.nullableText("sku"),
                    quantity = row.text("quantity", "0"),
                    unitPrice = row.text("unitPrice", "0"),
                    discountAmount = row.text("discountAmount", "0"),
                    total = row.text("total", "0"),
                )
            }
        },
    )

    fun catalogOptions(root: JSONArray): List<CatalogOption> = catalogOptions(root.toWireList())

    internal fun catalogOptions(root: List<Any?>): List<CatalogOption> = root.mapNotNull { value ->
        value.asStringMap()?.let { row ->
            CatalogOption(
                productId = row.long("productId"),
                productName = row.text("productName"),
                variantId = row.long("variantId"),
                variantName = row.nullableText("variantName"),
                productUnitId = row.long("productUnitId"),
                unitName = row.text("unitName"),
                sku = row.text("sku"),
                price = row.nullableText("price"),
                promotionEffectivePrice = row.nullableText("promotionEffectivePrice"),
                availableBase = row.int("availableBase"),
                isService = row.bool("isService"),
            )
        }
    }

    fun branches(root: JSONArray): List<BranchOption> = branches(root.toWireList())

    internal fun branches(root: List<Any?>): List<BranchOption> = root.mapNotNull { value ->
        value.asStringMap()?.let { row ->
            BranchOption(id = row.long("id"), name = row.text("name"), code = row.nullableText("code"))
        }
    }

    fun campaigns(root: JSONArray): List<CampaignSummary> = campaigns(root.toWireList())

    internal fun campaigns(root: List<Any?>): List<CampaignSummary> = root.mapNotNull { value ->
        value.asStringMap()?.let { row ->
            CampaignSummary(
                id = row.long("id"),
                name = row.text("name"),
                objective = row.nullableText("objective"),
                branchId = row.nullableLong("branchId"),
                startsOn = row.nullableText("startsOn"),
                endsOn = row.nullableText("endsOn"),
                status = CampaignStatus.fromWire(row.nullableText("status")),
            )
        }
    }

    fun dashboard(root: JSONObject): CrmDashboard = dashboard(root.toWireMap())

    internal fun dashboard(root: Map<String, Any?>): CrmDashboard {
        val campaigns = root.obj("campaigns")
        val programs = root.obj("couponPrograms")
        val redemptions = root.obj("redemptions")
        return CrmDashboard(
            campaignsTotal = campaigns?.int("total") ?: 0,
            campaignsActive = campaigns?.int("active") ?: 0,
            programsTotal = programs?.int("total") ?: 0,
            programsActive = programs?.int("active") ?: 0,
            redemptionsTotal = redemptions?.int("total") ?: 0,
            redemptionDiscount = redemptions?.text("discount", "0") ?: "0",
        )
    }

    private fun customerSummary(value: Any?): CustomerSummary? = value.asStringMap()?.let { row ->
        CustomerSummary(
            id = row.long("id"),
            name = row.text("name"),
            phone = row.nullableText("phone"),
            whatsapp = row.nullableText("whatsapp"),
            city = row.nullableText("city"),
            district = row.nullableText("district"),
            customerType = CustomerType.fromWire(row.nullableText("customerType")),
            priceTier = row.priceTier("defaultPriceTier"),
            creditLimit = row.nullableText("creditLimit"),
            currentBalance = row.nullableText("currentBalance"),
            legacyCode = row.nullableText("legacyCode"),
            isActive = row.bool("isActive", default = true),
        )
    }

    private fun customerFollowUp(value: Any?): CustomerFollowUp? = value.asStringMap()?.let { row ->
        CustomerFollowUp(
            id = row.long("id"),
            customerId = row.long("customerId"),
            customerName = row.nullableText("customerName"),
            customerPhone = row.nullableText("customerPhone"),
            note = row.text("note"),
            followUpDate = row.nullableText("followUpDate"),
            isResolved = row.bool("isResolved"),
            createdByName = row.nullableText("createdByName"),
            branchId = row.nullableLong("branchId"),
            createdAt = row.nullableText("createdAt"),
        ).takeIf { it.id > 0 && it.customerId > 0 }
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

private fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key].asStringMap()
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
private fun Map<String, Any?>.bool(key: String, default: Boolean = false): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value.equals("true", ignoreCase = true) || value == "1"
    else -> default
}
private fun Map<String, Any?>.priceTier(key: String): PriceTier =
    PriceTier.entries.firstOrNull { it.name == nullableText(key) } ?: PriceTier.RETAIL

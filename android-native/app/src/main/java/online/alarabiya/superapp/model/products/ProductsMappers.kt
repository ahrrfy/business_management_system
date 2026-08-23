package online.alarabiya.superapp.model.products

import org.json.JSONArray
import org.json.JSONObject

object ProductsMappers {
    fun page(root: JSONObject): ProductPage = page(root.map())
    internal fun page(root: Map<String, Any?>) = ProductPage(
        rows = root.list("rows").mapNotNull { it.asMap()?.let(::row) },
        total = root.int("total"),
    )

    fun barcode(root: JSONObject): BarcodeResult = barcode(root.map())
    internal fun barcode(root: Map<String, Any?>) = BarcodeResult(
        productId = root.long("productId"), variantId = root.long("variantId"), productUnitId = root.long("productUnitId"),
        label = listOfNotNull(root.text("productName"), root.textOrNull("variantName"), root.textOrNull("unitName")).joinToString(" • "),
        sku = root.text("sku"), barcode = root.textOrNull("barcode"), price = root.textOrNull("price"), availableBase = root.int("availableBase"),
    )

    fun bundle(components: JSONObject, impact: JSONObject): BundleDetails = bundle(components.map(), impact.map())
    internal fun bundle(components: Map<String, Any?>, impact: Map<String, Any?>) = BundleDetails(
        name = components.textOrNull("bundleProductName"),
        components = components.list("components").mapNotNull { value -> value.asMap()?.let { row ->
            BundleComponent(
                variantId = row.long("componentVariantId"), quantityBase = row.int("componentBaseQuantity"),
                unitId = row.longOrNull("componentUnitId"), productName = row.text("componentProductName"),
                sku = row.text("componentSku"), active = row.bool("isActive"), costPrice = row.textOrNull("componentCostPrice"),
            )
        } },
        affectedInvoiceLines = impact.int("affectedInvoiceLineCount"),
        totalInvoiceLines = impact.int("totalInvoiceLineCount"),
    )

    fun wavePreview(root: JSONObject): PriceWavePreview = wavePreview(root.map())
    internal fun wavePreview(root: Map<String, Any?>) = PriceWavePreview(
        rows = root.list("rows").mapNotNull { value -> value.asMap()?.let { row ->
            PriceWavePreviewRow(
                productUnitId = row.long("productUnitId"), productName = row.text("productName"), sku = row.text("sku"),
                unitName = row.text("unitName"), tier = row.enum("priceTier", ProductTier.RETAIL), oldPrice = row.text("oldPrice"),
                newPrice = row.text("newPrice"), costPrice = row.text("costPrice"), belowCost = row.bool("belowCost"),
            )
        } },
        belowCostCount = root.int("belowCostCount"),
    )

    fun appliedWave(root: JSONObject) = AppliedPriceWave(root.optLong("waveId"), root.optInt("totalRows"))
    fun waves(root: JSONArray): List<PriceWaveSummary> = waves(root.list())
    internal fun waves(root: List<Any?>) = root.mapNotNull { value -> value.asMap()?.let { row ->
        PriceWaveSummary(
            id = row.long("id"), name = row.text("name"), changeType = row.enum("changeType", PriceChangeType.INCREASE_PERCENT),
            changeValue = row.text("changeValue"), totalRows = row.int("totalRows"), appliedAt = row.textOrNull("appliedAt"),
        )
    } }

    fun printSettings(root: JSONObject): PrintPricingSettings = printSettings(root.map())
    internal fun printSettings(root: Map<String, Any?>): PrintPricingSettings {
        val settings = root.mapOrEmpty("settings")
        return PrintPricingSettings(
            pricingMode = settings.text("pricingMode", "MARGIN"), defaultMarginPercent = settings.text("defaultMarginPercent", "0"),
            setupFee = settings.text("setupFee", "0"),
            facePrices = root.list("facePrices").mapNotNull { it.asMap()?.let { r -> FacePrice(r.long("id"), r.text("paperSize"), r.text("colorMode"), r.text("pricePerFace")) } },
            paperUpcharges = root.list("paperUpcharges").mapNotNull { it.asMap()?.let { r -> PrintOption(r.long("id"), r.text("name"), r.text("unit"), r.text("upcharge"), r.bool("isActive")) } },
            wideMedia = root.list("wideMedia").mapNotNull { it.asMap()?.let { r -> WideMedia(r.long("id"), r.text("name"), r.text("pricePerSqm"), r.bool("isActive")) } },
            finishings = root.list("finishings").mapNotNull { it.asMap()?.let { r -> PrintOption(r.long("id"), r.text("name"), r.text("unit"), r.text("price"), r.bool("isActive")) } },
        )
    }

    fun estimate(root: JSONObject): PrintEstimate = estimate(root.map())
    internal fun estimate(root: Map<String, Any?>) = PrintEstimate(
        category = root.enum("category", PrintCategory.SMALL), faces = root.intOrNull("faces"), sheets = root.intOrNull("sheets"),
        areaSqm = root.textOrNull("areaSqm"), units = root.int("units"),
        lines = root.list("lines").mapNotNull { it.asMap()?.let { r -> PrintCostLine(r.text("key"), r.text("label"), r.text("amount"), r.textOrNull("detail")) } },
        totalCost = root.text("totalCost"), pricingMode = root.text("pricingMode"), marginPercent = root.text("marginPercent"),
        suggestedPrice = root.text("suggestedPrice"), unitPrice = root.text("unitPrice"),
    )

    private fun row(r: Map<String, Any?>) = ProductRow(
        productId = r.long("productId"), productName = r.text("productName"), productType = r.textOrNull("productType"),
        brand = r.textOrNull("brand"), modelName = r.textOrNull("modelName"), description = r.textOrNull("description"),
        productActive = r.bool("productIsActive"), categoryName = r.textOrNull("categoryName"), isService = r.bool("isService"),
        isBundle = r.bool("isBundle"), isConsignment = r.bool("isConsignment"), variantId = r.longOrNull("variantId"),
        variantName = r.textOrNull("variantName"), variantKind = r.textOrNull("variantKind"),
        color = r.textOrNull("color"), size = r.textOrNull("size"), sku = r.textOrNull("sku"),
        variantActive = r.boolOrNull("variantIsActive"), productUnitId = r.longOrNull("productUnitId"), unitName = r.textOrNull("unitName"),
        conversionFactor = r.textOrNull("conversionFactor"), barcode = r.textOrNull("barcode"),
        barcodeAliases = r.list("barcodeAliases").mapNotNull { it?.toString() }, unitActive = r.boolOrNull("unitIsActive"),
        retailPrice = r.textOrNull("price"), wholesalePrice = r.textOrNull("wholesalePrice"),
        governmentPrice = r.textOrNull("governmentPrice"), costPrice = r.textOrNull("costPrice"), stockBase = r.int("stockBase"),
    )
}

private fun JSONObject.map(): Map<String, Any?> = buildMap { val keys = keys(); while (keys.hasNext()) { val key = keys.next(); put(key, opt(key).wire()) } }
private fun JSONArray.list(): List<Any?> = buildList { for (i in 0 until length()) add(opt(i).wire()) }
private fun Any?.wire(): Any? = when (this) { null, JSONObject.NULL -> null; is JSONObject -> map(); is JSONArray -> list(); else -> this }
private fun Any?.asMap(): Map<String, Any?>? = (this as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }
private fun Map<String, Any?>.list(key: String) = (this[key] as? List<*>)?.toList().orEmpty()
private fun Map<String, Any?>.mapOrEmpty(key: String) = this[key].asMap().orEmpty()
private fun Map<String, Any?>.textOrNull(key: String) = this[key]?.toString()?.takeIf { it.isNotBlank() }
private fun Map<String, Any?>.text(key: String, fallback: String = "") = textOrNull(key) ?: fallback
private fun Map<String, Any?>.longOrNull(key: String): Long? = when (val value = this[key]) { is Number -> value.toLong(); is String -> value.toLongOrNull(); else -> null }
private fun Map<String, Any?>.long(key: String) = longOrNull(key) ?: 0
private fun Map<String, Any?>.intOrNull(key: String) = longOrNull(key)?.toInt()
private fun Map<String, Any?>.int(key: String) = intOrNull(key) ?: 0
private fun Map<String, Any?>.boolOrNull(key: String): Boolean? = when (val value = this[key]) { is Boolean -> value; is Number -> value.toInt() != 0; is String -> value.equals("true", true) || value == "1"; else -> null }
private fun Map<String, Any?>.bool(key: String) = boolOrNull(key) ?: false
private inline fun <reified T : Enum<T>> Map<String, Any?>.enum(key: String, fallback: T) = enumValues<T>().firstOrNull { it.name == textOrNull(key) } ?: fallback

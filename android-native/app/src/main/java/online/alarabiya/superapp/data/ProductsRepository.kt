package online.alarabiya.superapp.data

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.products.AppliedPriceWave
import online.alarabiya.superapp.model.products.BarcodeResult
import online.alarabiya.superapp.model.products.BundleDetails
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PriceWavePreview
import online.alarabiya.superapp.model.products.PriceWaveSummary
import online.alarabiya.superapp.model.products.PrintEstimate
import online.alarabiya.superapp.model.products.PrintEstimateDraft
import online.alarabiya.superapp.model.products.PrintPricingSettings
import online.alarabiya.superapp.model.products.ProductPage
import online.alarabiya.superapp.model.products.ProductCategory
import online.alarabiya.superapp.model.products.ProductEditorDraft
import online.alarabiya.superapp.model.products.ProductEditorValidation
import online.alarabiya.superapp.model.products.ProductUnitDraft as NativeProductUnitDraft
import online.alarabiya.superapp.model.products.ProductVariantDraft
import online.alarabiya.superapp.model.products.BarcodeAlias
import online.alarabiya.superapp.model.products.ProductTier
import online.alarabiya.superapp.model.products.ProductsMappers
import online.alarabiya.superapp.model.products.ProductsValidation
import org.json.JSONArray
import org.json.JSONObject

interface ProductsDataSource {
    suspend fun products(branchId: Long, query: String, includeInactive: Boolean, offset: Int = 0): ProductPage
    suspend fun barcode(branchId: Long, barcode: String, tier: ProductTier): BarcodeResult?
    suspend fun bundle(variantId: Long): BundleDetails
    suspend fun setActive(productId: Long, active: Boolean)
    suspend fun previewWave(draft: PriceWaveDraft): PriceWavePreview
    suspend fun applyWave(draft: PriceWaveDraft): AppliedPriceWave
    suspend fun waves(): List<PriceWaveSummary>
    suspend fun printSettings(): PrintPricingSettings
    suspend fun estimatePrint(draft: PrintEstimateDraft): PrintEstimate
    suspend fun categories(manager: Boolean): List<ProductCategory>
    suspend fun createProduct(draft: ProductEditorDraft): Long
    suspend fun productForEdit(productId: Long): ProductEditorDraft
    suspend fun updateProduct(draft: ProductEditorDraft)
    suspend fun createCategory(name: String, parentId: Long?): ProductCategory
    suspend fun updateCategory(category: ProductCategory)
    suspend fun barcodeAliases(productUnitId: Long): List<BarcodeAlias>
    suspend fun addBarcodeAlias(productUnitId: Long, barcode: String, note: String)
    suspend fun removeBarcodeAlias(id: Long)
}

class ProductsRepository(private val api: TrpcClient) : ProductsDataSource {
    override suspend fun products(branchId: Long, query: String, includeInactive: Boolean, offset: Int): ProductPage {
        require(branchId > 0) { "لا يوجد فرع صالح لعرض المنتجات" }
        return ProductsMappers.page(
            api.query(
                "catalog.adminList",
                JSONObject().put("branchId", branchId).put("q", query.trim().take(120))
                    .put("includeInactive", includeInactive).put("limit", 80).put("offset", offset.coerceAtLeast(0)),
            ),
        )
    }

    override suspend fun barcode(branchId: Long, barcode: String, tier: ProductTier): BarcodeResult? {
        val normalized = barcode.trim()
        require(normalized.isNotEmpty()) { "أدخل باركوداً صالحاً" }
        // adminList searches both primary and alias barcodes and returns an object even for no match.
        // catalog.byBarcode returns null for a miss, which the current native object-only transport cannot represent.
        return products(branchId, normalized, false).rows.firstOrNull { row ->
            row.barcode == normalized || normalized in row.barcodeAliases
        }?.let { row ->
            val variantId = row.variantId ?: return@let null
            val unitId = row.productUnitId ?: return@let null
            BarcodeResult(row.productId, variantId, unitId, row.label, row.sku.orEmpty(), row.barcode, row.price(tier), row.stockBase)
        }
    }

    override suspend fun bundle(variantId: Long): BundleDetails = coroutineScope {
        require(variantId > 0) { "معرّف البكج غير صالح" }
        val components = async { api.query("bundles.getComponents", JSONObject().put("bundleVariantId", variantId)) }
        val impact = async { api.query("bundles.previewImpact", JSONObject().put("bundleVariantId", variantId)) }
        ProductsMappers.bundle(components.await(), impact.await())
    }

    override suspend fun setActive(productId: Long, active: Boolean) {
        require(productId > 0) { "معرّف المنتج غير صالح" }
        api.mutate("catalog.setProductActive", JSONObject().put("productId", productId).put("isActive", active))
    }

    override suspend fun previewWave(draft: PriceWaveDraft): PriceWavePreview {
        ProductsValidation.wave(draft, false)?.let { throw IllegalArgumentException(it) }
        return ProductsMappers.wavePreview(api.mutate("priceWaves.preview", ProductsWire.wavePreview(draft)))
    }

    override suspend fun applyWave(draft: PriceWaveDraft): AppliedPriceWave {
        ProductsValidation.wave(draft, true)?.let { throw IllegalArgumentException(it) }
        return ProductsMappers.appliedWave(api.mutate("priceWaves.applyWave", ProductsWire.waveApply(draft)))
    }

    override suspend fun waves(): List<PriceWaveSummary> = ProductsMappers.waves(
        api.queryArray("priceWaves.list", JSONObject().put("limit", 50)),
    )

    override suspend fun printSettings(): PrintPricingSettings = ProductsMappers.printSettings(api.query("printPricing.settings"))

    override suspend fun estimatePrint(draft: PrintEstimateDraft): PrintEstimate {
        ProductsValidation.estimate(draft)?.let { throw IllegalArgumentException(it) }
        return ProductsMappers.estimate(api.query("printPricing.estimate", ProductsWire.printEstimate(draft)))
    }

    override suspend fun categories(manager: Boolean): List<ProductCategory> {
        val rows = api.queryArray(if (manager) "catalog.categoriesAdmin" else "catalog.categories")
        return (0 until rows.length()).mapNotNull { index ->
            rows.optJSONObject(index)?.let { ProductCategory(it.optLong("id"), it.optString("name"), it.optLongOrNull("parentId"), it.optIntOrNull("productCount") ?: it.optIntOrNull("productsCount")) }
        }
    }

    override suspend fun createProduct(draft: ProductEditorDraft): Long {
        ProductEditorValidation.validate(draft)?.let { throw IllegalArgumentException(it) }
        return api.mutate("catalog.createProduct", ProductsWire.createProduct(draft)).optLong("productId")
    }

    override suspend fun productForEdit(productId: Long): ProductEditorDraft {
        require(productId > 0)
        return ProductsWire.editor(api.query("catalog.getForEdit", JSONObject().put("productId", productId)))
    }

    override suspend fun updateProduct(draft: ProductEditorDraft) {
        requireNotNull(draft.productId)
        ProductEditorValidation.validate(draft)?.let { throw IllegalArgumentException(it) }
        api.mutate("catalog.updateProduct", ProductsWire.updateProduct(draft))
    }

    override suspend fun createCategory(name: String, parentId: Long?): ProductCategory {
        require(name.trim().isNotEmpty()) { "اسم الفئة مطلوب" }
        val result = api.mutate("catalog.createCategory", JSONObject().put("name", name.trim()).putNullable("parentId", parentId))
        return ProductCategory(result.optLong("id"), result.optString("name", name.trim()), parentId)
    }

    override suspend fun updateCategory(category: ProductCategory) {
        api.mutate("catalog.updateCategory", JSONObject().put("id", category.id).put("name", category.name.trim()).putNullable("parentId", category.parentId))
    }

    override suspend fun barcodeAliases(productUnitId: Long): List<BarcodeAlias> {
        val root = api.query("catalog.listUnitBarcodes", JSONObject().put("productUnitId", productUnitId))
        val rows = root.optJSONArray("aliases") ?: JSONArray()
        return (0 until rows.length()).mapNotNull { i -> rows.optJSONObject(i)?.let { BarcodeAlias(it.optLong("id"), it.optString("barcode"), it.optString("note").takeIf(String::isNotBlank)) } }
    }

    override suspend fun addBarcodeAlias(productUnitId: Long, barcode: String, note: String) {
        require(barcode.trim().isNotEmpty()) { "الباركود مطلوب" }
        api.mutate("catalog.addUnitBarcodeAlias", JSONObject().put("productUnitId", productUnitId).put("barcode", barcode.trim()).putNullable("note", note.trim().takeIf(String::isNotEmpty)))
    }

    override suspend fun removeBarcodeAlias(id: Long) {
        api.mutate("catalog.removeUnitBarcodeAlias", JSONObject().put("id", id))
    }
}

internal object ProductsWire {
    private fun prices(unit: NativeProductUnitDraft) = JSONArray().also { rows ->
        listOf(ProductTier.RETAIL to unit.retailPrice, ProductTier.WHOLESALE to unit.wholesalePrice, ProductTier.GOVERNMENT to unit.governmentPrice)
            .filter { it.second.isNotBlank() }.forEach { rows.put(JSONObject().put("priceTier", it.first.name).put("price", it.second)) }
    }

    private fun unit(unit: NativeProductUnitDraft, editing: Boolean) = JSONObject().also { json ->
        if (editing) unit.id?.let { json.put("id", it) }
        json.put("unitName", unit.name.trim()).put("conversionFactor", unit.factor).putNullable("barcode", unit.barcode.trim().takeIf(String::isNotEmpty))
            .put("isBaseUnit", unit.isBase).put("isStoreSaleUnit", unit.isStoreSale).put("prices", prices(unit))
    }

    private fun variant(variant: ProductVariantDraft, editing: Boolean) = JSONObject().also { json ->
        if (editing) json.put("id", requireNotNull(variant.id))
        json.put("sku", variant.sku.trim()).putNullable("variantName", variant.name.trim().takeIf(String::isNotEmpty))
            .putNullable("color", variant.color.trim().takeIf(String::isNotEmpty)).putNullable("size", variant.size.trim().takeIf(String::isNotEmpty))
            .put("costPrice", variant.costPrice).putNullable("costChangeReason", variant.costChangeReason.trim().takeIf(String::isNotEmpty))
            .put("units", JSONArray(variant.units.map { unit(it, editing) }))
    }

    fun createProduct(draft: ProductEditorDraft) = JSONObject().put("name", draft.name.trim())
        .putNullable("productType", draft.productType.trim().takeIf(String::isNotEmpty)).putNullable("brand", draft.brand.trim().takeIf(String::isNotEmpty))
        .putNullable("modelName", draft.modelName.trim().takeIf(String::isNotEmpty)).putNullable("description", draft.description.trim().takeIf(String::isNotEmpty))
        .putNullable("categoryId", draft.categoryId).put("isService", draft.service).put("variants", JSONArray(draft.variants.map { variant(it, false) }))

    fun updateProduct(draft: ProductEditorDraft) = JSONObject().put("productId", requireNotNull(draft.productId)).put("name", draft.name.trim())
        .putNullable("categoryId", draft.categoryId).put("isActive", draft.active).put("variants", JSONArray(draft.variants.map { variant(it, true) }))

    fun editor(root: JSONObject): ProductEditorDraft {
        val drafts = mutableListOf<ProductVariantDraft>()
        val variants = root.optJSONArray("variants") ?: JSONArray()
        for (i in 0 until variants.length()) {
            val variant = variants.optJSONObject(i) ?: continue
            val unitDrafts = mutableListOf<NativeProductUnitDraft>()
            val units = variant.optJSONArray("units") ?: JSONArray()
            for (j in 0 until units.length()) {
                val unit = units.optJSONObject(j) ?: continue
                val prices = unit.optJSONArray("prices") ?: JSONArray()
                fun price(tier: String): String {
                    for (k in 0 until prices.length()) {
                        val row = prices.optJSONObject(k) ?: continue
                        if (row.optString("priceTier") == tier) return row.optString("price")
                    }
                    return ""
                }
                unitDrafts += NativeProductUnitDraft(
                    id = unit.optLong("id"), name = unit.optString("unitName"), factor = unit.optString("conversionFactor", "1"),
                    barcode = unit.optString("barcode"), retailPrice = price("RETAIL"), wholesalePrice = price("WHOLESALE"),
                    governmentPrice = price("GOVERNMENT"), isBase = unit.optBoolean("isBaseUnit"), isStoreSale = unit.optBoolean("isStoreSaleUnit"),
                )
            }
            drafts += ProductVariantDraft(
                id = variant.optLong("id"), sku = variant.optString("sku"), name = variant.optString("variantName"),
                color = variant.optString("color"), size = variant.optString("size"), costPrice = variant.optString("costPrice", "0"),
                units = unitDrafts,
            )
        }
        return ProductEditorDraft(
            productId = root.optLong("id"), name = root.optString("name"), categoryId = root.optLongOrNull("categoryId"),
            active = root.optBoolean("isActive", true), service = root.optBoolean("isService"), variants = drafts,
        )
    }
    private fun filters(draft: PriceWaveDraft) = JSONObject().also { filters ->
        draft.productSearch.trim().takeIf { it.isNotEmpty() }?.let { filters.put("productSearch", it.take(120)) }
        draft.tier?.let { filters.put("priceTier", it.name) }
    }

    fun wavePreview(draft: PriceWaveDraft) = JSONObject()
        .put("filters", filters(draft)).put("changeType", draft.changeType.name).put("changeValue", draft.changeValue.trim())

    fun waveApply(draft: PriceWaveDraft) = wavePreview(draft)
        .put("name", draft.name.trim().take(255)).put("allowBelowCost", draft.allowBelowCost).also { input ->
            draft.description.trim().takeIf { it.isNotEmpty() }?.let { input.put("description", it.take(2_000)) }
            draft.reason.trim().takeIf { it.isNotEmpty() }?.let { input.put("reason", it.take(255)) }
        }

    fun printEstimate(draft: PrintEstimateDraft): JSONObject {
        val input = JSONObject().put("category", draft.category.name).put("applySetupFee", draft.applySetupFee)
            .put("finishingIds", JSONArray(draft.finishingIds.toList()))
        draft.marginOverride.trim().takeIf { it.isNotEmpty() }?.let { input.put("marginPercentOverride", it) }
        return when (draft.category) {
            online.alarabiya.superapp.model.products.PrintCategory.SMALL -> input
                .put("paperSize", draft.paperSize).put("colorMode", draft.colorMode).put("sides", draft.sides)
                .put("copies", draft.copies.toInt()).put("pagesPerCopy", draft.pagesPerCopy.toInt()).also { json ->
                    draft.paperUpchargeId?.let { json.put("paperUpchargeId", it) }
                }
            online.alarabiya.superapp.model.products.PrintCategory.WIDE -> input
                .put("mediaId", requireNotNull(draft.mediaId)).put("width", draft.width.trim()).put("height", draft.height.trim())
                .put("quantity", draft.quantity.toInt())
        }
    }
}

private fun JSONObject.putNullable(key: String, value: Any?): JSONObject = put(key, value ?: JSONObject.NULL)
private fun JSONObject.optLongOrNull(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)
private fun JSONObject.optIntOrNull(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key)

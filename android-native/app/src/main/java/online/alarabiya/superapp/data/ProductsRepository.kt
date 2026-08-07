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
}

internal object ProductsWire {
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

package online.alarabiya.superapp.model.products

import online.alarabiya.superapp.model.AppBootstrap

enum class ProductsAccess { NONE, READ, FULL;
    val canRead get() = this != NONE
    val canWrite get() = this == FULL
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: NONE }
}

data class ProductsCapabilities(
    val access: ProductsAccess,
    val branchId: Long?,
    val role: String,
) {
    val canBrowse get() = access.canRead && branchId != null
    val canManage get() = access.canWrite && branchId != null
    // printPricing uses managerProcedure, not the products grant.
    val canUsePrintPricing get() = role == "admin" || role == "manager"

    companion object {
        fun fromBootstrap(value: AppBootstrap) = ProductsCapabilities(
            access = ProductsAccess.wire(value.modules.firstOrNull { it.key == "products" }?.access),
            branchId = value.branchId,
            role = value.user.role,
        )
    }
}

enum class ProductsSection { CATALOG, PRICE_WAVES, PRINT_PRICING }
enum class ProductTier { RETAIL, WHOLESALE, GOVERNMENT }

data class ProductCategory(val id: Long, val name: String, val parentId: Long? = null, val productCount: Int? = null)

data class ProductUnitDraft(
    val id: Long? = null,
    val name: String = "حبة",
    val factor: String = "1",
    val barcode: String = "",
    val retailPrice: String = "",
    val wholesalePrice: String = "",
    val governmentPrice: String = "",
    val isBase: Boolean = true,
    val isStoreSale: Boolean = true,
)

data class ProductVariantDraft(
    val id: Long? = null,
    val sku: String = "",
    val name: String = "",
    val color: String = "",
    val size: String = "",
    val costPrice: String = "0",
    val costChangeReason: String = "",
    val units: List<ProductUnitDraft> = listOf(ProductUnitDraft()),
)

data class ProductEditorDraft(
    val productId: Long? = null,
    val name: String = "",
    val productType: String = "",
    val brand: String = "",
    val modelName: String = "",
    val description: String = "",
    val categoryId: Long? = null,
    val active: Boolean = true,
    val service: Boolean = false,
    val variants: List<ProductVariantDraft> = listOf(ProductVariantDraft()),
)

data class BarcodeAlias(val id: Long, val barcode: String, val note: String?)

object ProductEditorValidation {
    private val decimal = Regex("^\\d+(\\.\\d{1,3})?$")
    fun validate(draft: ProductEditorDraft): String? {
        if (draft.name.trim().isEmpty()) return "اسم المنتج مطلوب"
        if (draft.variants.isEmpty()) return "أضف متغيراً واحداً على الأقل"
        draft.variants.forEachIndexed { index, variant ->
            if (variant.sku.trim().isEmpty()) return "رمز SKU مطلوب للمتغير ${index + 1}"
            if (!decimal.matches(variant.costPrice)) return "تكلفة المتغير ${index + 1} غير صالحة"
            if (variant.units.isEmpty()) return "أضف وحدة واحدة على الأقل للمتغير ${index + 1}"
            if (variant.units.count { it.isBase } != 1) return "حدد وحدة أساس واحدة للمتغير ${index + 1}"
            variant.units.forEach { unit ->
                if (unit.name.trim().isEmpty()) return "اسم الوحدة مطلوب"
                if (!decimal.matches(unit.factor) || unit.factor.toDoubleOrNull() == 0.0) return "معامل الوحدة غير صالح"
                listOf(unit.retailPrice, unit.wholesalePrice, unit.governmentPrice).filter(String::isNotBlank).forEach {
                    if (!decimal.matches(it)) return "أحد أسعار البيع غير صالح"
                }
            }
        }
        return null
    }
}

data class ProductRow(
    val productId: Long,
    val productName: String,
    val productType: String?,
    val brand: String?,
    val modelName: String?,
    val description: String?,
    val productActive: Boolean,
    val categoryName: String?,
    val isService: Boolean,
    val isBundle: Boolean,
    val isConsignment: Boolean,
    val variantId: Long?,
    val variantName: String?,
    // VARIANT = لون/قياس لنفس الصنف؛ ALTERNATIVE = منتجٌ مختلف (ماركة/منشأ) تحت اسمٍ واحد — يُوسَم بشارة.
    val variantKind: String? = null,
    val color: String?,
    val size: String?,
    val sku: String?,
    val variantActive: Boolean?,
    val productUnitId: Long?,
    val unitName: String?,
    val conversionFactor: String?,
    val barcode: String?,
    val barcodeAliases: List<String>,
    val unitActive: Boolean?,
    val retailPrice: String?,
    val wholesalePrice: String?,
    val governmentPrice: String?,
    val costPrice: String?,
    val stockBase: Int,
) {
    val label get() = listOfNotNull(productName, variantName, unitName).joinToString(" • ")
    /** بديلٌ حقيقيّ (ماركة/منشأ مختلف) يُباع تحت اسمٍ واحد — تُعرَض له شارة تمييز في القائمة. */
    val isAlternative get() = variantKind == "ALTERNATIVE"
    fun price(tier: ProductTier) = when (tier) {
        ProductTier.RETAIL -> retailPrice
        ProductTier.WHOLESALE -> wholesalePrice
        ProductTier.GOVERNMENT -> governmentPrice
    }
}

data class ProductPage(val rows: List<ProductRow>, val total: Int)

data class ProductDetails(
    val productId: Long,
    val name: String,
    val description: String?,
    val brand: String?,
    val modelName: String?,
    val categoryName: String?,
    val active: Boolean,
    val isBundle: Boolean,
    val isService: Boolean,
    val rows: List<ProductRow>,
    val bundle: BundleDetails? = null,
)

data class BarcodeResult(
    val productId: Long,
    val variantId: Long,
    val productUnitId: Long,
    val label: String,
    val sku: String,
    val barcode: String?,
    val price: String?,
    val availableBase: Int,
)

data class BundleComponent(
    val variantId: Long,
    val quantityBase: Int,
    val unitId: Long?,
    val productName: String,
    val sku: String,
    val active: Boolean,
    val costPrice: String?,
)

data class BundleDetails(
    val name: String?,
    val components: List<BundleComponent>,
    val affectedInvoiceLines: Int,
    val totalInvoiceLines: Int,
)

enum class PriceChangeType { INCREASE_PERCENT, DECREASE_PERCENT, INCREASE_AMOUNT, DECREASE_AMOUNT, SET_MARGIN }

data class PriceWaveDraft(
    val name: String = "",
    val description: String = "",
    val reason: String = "",
    val productSearch: String = "",
    val tier: ProductTier? = null,
    val changeType: PriceChangeType = PriceChangeType.INCREASE_PERCENT,
    val changeValue: String = "",
    val allowBelowCost: Boolean = false,
)

data class PriceWavePreviewRow(
    val productUnitId: Long,
    val productName: String,
    val sku: String,
    val unitName: String,
    val tier: ProductTier,
    val oldPrice: String,
    val newPrice: String,
    val costPrice: String,
    val belowCost: Boolean,
)

data class PriceWavePreview(val rows: List<PriceWavePreviewRow>, val belowCostCount: Int)
data class AppliedPriceWave(val waveId: Long, val totalRows: Int)
data class PriceWaveSummary(
    val id: Long,
    val name: String,
    val changeType: PriceChangeType,
    val changeValue: String,
    val totalRows: Int,
    val appliedAt: String?,
)

data class PrintPricingSettings(
    val pricingMode: String,
    val defaultMarginPercent: String,
    val setupFee: String,
    val facePrices: List<FacePrice>,
    val paperUpcharges: List<PrintOption>,
    val wideMedia: List<WideMedia>,
    val finishings: List<PrintOption>,
)
data class FacePrice(val id: Long, val paperSize: String, val colorMode: String, val pricePerFace: String)
data class PrintOption(val id: Long, val name: String, val unit: String, val amount: String, val active: Boolean)
data class WideMedia(val id: Long, val name: String, val pricePerSqm: String, val active: Boolean)

enum class PrintCategory { SMALL, WIDE }
data class PrintEstimateDraft(
    val category: PrintCategory = PrintCategory.SMALL,
    val paperSize: String = "A4",
    val colorMode: String = "COLOR",
    val sides: Int = 1,
    val copies: String = "1",
    val pagesPerCopy: String = "1",
    val paperUpchargeId: Long? = null,
    val mediaId: Long? = null,
    val width: String = "",
    val height: String = "",
    val quantity: String = "1",
    val finishingIds: Set<Long> = emptySet(),
    val applySetupFee: Boolean = true,
    val marginOverride: String = "",
)
data class PrintCostLine(val key: String, val label: String, val amount: String, val detail: String?)
data class PrintEstimate(
    val category: PrintCategory,
    val faces: Int?,
    val sheets: Int?,
    val areaSqm: String?,
    val units: Int,
    val lines: List<PrintCostLine>,
    val totalCost: String,
    val pricingMode: String,
    val marginPercent: String,
    val suggestedPrice: String,
    val unitPrice: String,
)

object ProductsValidation {
    private val decimal = Regex("^\\d+(\\.\\d{1,3})?$")
    fun wave(draft: PriceWaveDraft, apply: Boolean): String? {
        if (apply && draft.name.trim().isEmpty()) return "اسم موجة الأسعار مطلوب"
        if (!decimal.matches(draft.changeValue) || draft.changeValue.toDoubleOrNull()?.let { it <= 0 } != false) return "قيمة التغيير غير صالحة"
        if (draft.changeType.name.contains("PERCENT") || draft.changeType == PriceChangeType.SET_MARGIN) {
            if (draft.changeValue.toDouble() > 1000) return "النسبة تتجاوز الحد المسموح"
        }
        return null
    }

    fun estimate(draft: PrintEstimateDraft): String? {
        if (draft.marginOverride.isNotBlank() &&
            (!decimal.matches(draft.marginOverride) || (draft.marginOverride.toDoubleOrNull() ?: 1000.0) > 999.999)
        ) return "نسبة الهامش غير صالحة"
        return when (draft.category) {
            PrintCategory.SMALL -> if ((draft.copies.toIntOrNull() ?: 0) < 1 || (draft.pagesPerCopy.toIntOrNull() ?: 0) < 1) "أدخل نسخاً وصفحات صحيحة" else null
            PrintCategory.WIDE -> if (
                draft.mediaId == null || !decimal.matches(draft.width) || !decimal.matches(draft.height) ||
                (draft.width.toDoubleOrNull() ?: 0.0) <= 0 || (draft.height.toDoubleOrNull() ?: 0.0) <= 0 ||
                (draft.quantity.toIntOrNull() ?: 0) < 1
            ) "أكمل الوسيط والأبعاد والكمية" else null
        }
    }
}

object NativeProductsContractGaps {
    const val READ_DETAIL = "catalog has no productsRead detail endpoint; readers can only assemble details from paginated adminList rows."
    const val WAVE_IDEMPOTENCY = "priceWaves.applyWave has no clientRequestId/idempotency contract; a timed-out apply must be reconciled from priceWaves.list before retry."
    const val PRINT_PERMISSION = "printPricing uses role-only managerProcedure and is not represented as an operation capability in superApp bootstrap."
    const val BUNDLE_VERSIONING = "bundle component updates mutate the current recipe and can affect returns for prior invoices; the API exposes impact counts but no immutable recipe version."
}

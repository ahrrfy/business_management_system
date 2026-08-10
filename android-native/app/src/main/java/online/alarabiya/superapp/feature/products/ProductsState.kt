package online.alarabiya.superapp.feature.products

import online.alarabiya.superapp.model.products.BarcodeResult
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PriceWavePreview
import online.alarabiya.superapp.model.products.PriceWaveSummary
import online.alarabiya.superapp.model.products.PrintEstimate
import online.alarabiya.superapp.model.products.PrintEstimateDraft
import online.alarabiya.superapp.model.products.PrintPricingSettings
import online.alarabiya.superapp.model.products.ProductDetails
import online.alarabiya.superapp.model.products.ProductPage
import online.alarabiya.superapp.model.products.ProductTier
import online.alarabiya.superapp.model.products.ProductsSection
import online.alarabiya.superapp.model.products.ProductCategory
import online.alarabiya.superapp.model.products.ProductEditorDraft
import online.alarabiya.superapp.model.products.BarcodeAlias

enum class ProductsBusy { INITIAL, SEARCH, DETAIL, BARCODE, ACTIVE, EDITOR_LOAD, EDITOR_SAVE, CATEGORIES, BARCODE_ALIASES, WAVE_PREVIEW, WAVE_APPLY, WAVE_RECONCILE, PRINT_ESTIMATE }

data class ProductsUiState(
    val section: ProductsSection = ProductsSection.CATALOG,
    val busy: ProductsBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val query: String = "",
    val includeInactive: Boolean = false,
    val tier: ProductTier = ProductTier.RETAIL,
    val page: ProductPage = ProductPage(emptyList(), 0),
    val catalogLoaded: Boolean = false,
    val selected: ProductDetails? = null,
    val barcodeInput: String = "",
    val barcodeResult: BarcodeResult? = null,
    val categories: List<ProductCategory> = emptyList(),
    val editor: ProductEditorDraft? = null,
    val barcodeUnitId: Long? = null,
    val barcodeAliases: List<BarcodeAlias> = emptyList(),
    val barcodeAliasesFresh: Boolean = false,
    val waveDraft: PriceWaveDraft = PriceWaveDraft(),
    val wavePreview: PriceWavePreview? = null,
    val previewedDraft: PriceWaveDraft? = null,
    val waves: List<PriceWaveSummary> = emptyList(),
    val waveOutcomeUnknown: Boolean = false,
    val printSettings: PrintPricingSettings? = null,
    val printDraft: PrintEstimateDraft = PrintEstimateDraft(),
    val printEstimate: PrintEstimate? = null,
) {
    val locked get() = busy != null
    val canMutateCatalog get() = catalogLoaded && !locked
    val canApplyWave get() = canMutateCatalog && !waveOutcomeUnknown && wavePreview != null && previewedDraft == waveDraft
    val canMutateBarcodeAliases get() = canMutateCatalog && barcodeUnitId != null && barcodeAliasesFresh
    fun start(operation: ProductsBusy): ProductsUiState? = if (locked) null else copy(busy = operation, error = null, notice = null)
    fun failed(message: String) = copy(busy = null, error = message, notice = null)
    fun committedRefreshFailed(message: String) = copy(
        busy = null,
        catalogLoaded = false,
        editor = null,
        selected = null,
        barcodeResult = null,
        barcodeUnitId = null,
        barcodeAliases = emptyList(),
        barcodeAliasesFresh = false,
        error = message,
    )

    fun catalogRefreshed(value: ProductPage) = copy(
        busy = null,
        page = value,
        catalogLoaded = true,
        error = null,
    )

    fun productSaved() = copy(editor = null, selected = null, notice = "تم حفظ المنتج", error = null)
    fun productActiveCommitted(productId: Long, active: Boolean) = copy(
        page = page.copy(rows = page.rows.map { if (it.productId == productId) it.copy(productActive = active) else it }),
        selected = selected?.let { detail ->
            if (detail.productId == productId) detail.copy(
                active = active,
                rows = detail.rows.map { it.copy(productActive = active) },
            ) else detail
        },
        notice = if (active) "تم تفعيل المنتج" else "تم تعطيل المنتج",
        error = null,
    )
    fun categoryCreated(category: ProductCategory) = copy(
        categories = (categories.filterNot { it.id == category.id } + category).sortedBy(ProductCategory::name),
        notice = "تمت إضافة الفئة",
        error = null,
    )
    fun categoryUpdated(category: ProductCategory) = copy(
        categories = categories.map { if (it.id == category.id) category else it }.sortedBy(ProductCategory::name),
        notice = "تم تحديث الفئة",
        error = null,
    )
    fun barcodeAliasesLoaded(productUnitId: Long, aliases: List<BarcodeAlias>) = copy(
        busy = null,
        barcodeUnitId = productUnitId,
        barcodeAliases = aliases,
        barcodeAliasesFresh = true,
        error = null,
    )
    fun barcodeAliasCommitted(removedId: Long? = null) = copy(
        barcodeAliases = if (removedId == null) barcodeAliases else barcodeAliases.filterNot { it.id == removedId },
        barcodeAliasesFresh = false,
        notice = if (removedId == null) "تمت إضافة الباركود" else "تم حذف الباركود",
        error = null,
    )
    fun waveChanged(value: PriceWaveDraft) = copy(waveDraft = value, wavePreview = null, previewedDraft = null, error = null, notice = null)
    fun startWavePreview(): ProductsUiState? = if (!canMutateCatalog || waveOutcomeUnknown) null else copy(
        busy = ProductsBusy.WAVE_PREVIEW,
        wavePreview = null,
        previewedDraft = null,
        error = null,
        notice = null,
    )
    fun wavePreviewed(value: PriceWavePreview) = copy(busy = null, wavePreview = value, previewedDraft = waveDraft, error = null)
    fun startWaveApply(): ProductsUiState? = if (!canApplyWave) null else copy(
        busy = ProductsBusy.WAVE_APPLY,
        wavePreview = null,
        previewedDraft = null,
        error = null,
        notice = null,
    )
    fun waveReconfirmationRequired(value: PriceWavePreview) = copy(
        busy = null,
        wavePreview = value,
        previewedDraft = waveDraft,
        error = "تغيّرت الأسعار منذ المعاينة. راجع المعاينة المحدّثة ثم أكّد التطبيق من جديد.",
        notice = null,
    )
    fun uncertainWave(message: String) = copy(busy = null, waveOutcomeUnknown = true, error = message, notice = null)
    fun reconciled(history: List<PriceWaveSummary>) = copy(
        busy = null, waves = history, waveOutcomeUnknown = false, wavePreview = null, previewedDraft = null,
        error = null, notice = "تمت مطابقة سجل موجات الأسعار؛ أعد المعاينة قبل أي تطبيق جديد",
    )
}

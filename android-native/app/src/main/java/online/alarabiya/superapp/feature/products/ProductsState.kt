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

enum class ProductsBusy { INITIAL, SEARCH, DETAIL, BARCODE, ACTIVE, WAVE_PREVIEW, WAVE_APPLY, WAVE_RECONCILE, PRINT_ESTIMATE }

data class ProductsUiState(
    val section: ProductsSection = ProductsSection.CATALOG,
    val busy: ProductsBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val query: String = "",
    val includeInactive: Boolean = false,
    val tier: ProductTier = ProductTier.RETAIL,
    val page: ProductPage = ProductPage(emptyList(), 0),
    val selected: ProductDetails? = null,
    val barcodeInput: String = "",
    val barcodeResult: BarcodeResult? = null,
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
    val canApplyWave get() = !locked && !waveOutcomeUnknown && wavePreview != null && previewedDraft == waveDraft
    fun start(operation: ProductsBusy): ProductsUiState? = if (locked) null else copy(busy = operation, error = null, notice = null)
    fun failed(message: String) = copy(busy = null, error = message, notice = null)
    fun waveChanged(value: PriceWaveDraft) = copy(waveDraft = value, wavePreview = null, previewedDraft = null, error = null, notice = null)
    fun wavePreviewed(value: PriceWavePreview) = copy(busy = null, wavePreview = value, previewedDraft = waveDraft, error = null)
    fun uncertainWave(message: String) = copy(busy = null, waveOutcomeUnknown = true, error = message, notice = null)
    fun reconciled(history: List<PriceWaveSummary>) = copy(
        busy = null, waves = history, waveOutcomeUnknown = false, wavePreview = null, previewedDraft = null,
        error = null, notice = "تمت مطابقة سجل موجات الأسعار؛ أعد المعاينة قبل أي تطبيق جديد",
    )
}

package online.alarabiya.superapp.feature.products

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.ProductsDataSource
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PrintEstimateDraft
import online.alarabiya.superapp.model.products.ProductDetails
import online.alarabiya.superapp.model.products.ProductRow
import online.alarabiya.superapp.model.products.ProductTier
import online.alarabiya.superapp.model.products.ProductsCapabilities
import online.alarabiya.superapp.model.products.ProductsSection

class ProductsViewModel(private val source: ProductsDataSource, private val capabilities: ProductsCapabilities) : ViewModel() {
    var state by mutableStateOf(ProductsUiState())
        private set

    fun initialize() {
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال لكتالوج المنتجات")
        val started = state.start(ProductsBusy.INITIAL) ?: return
        state = started
        viewModelScope.launch {
            val results = coroutineScope {
                val products = async { if (capabilities.canBrowse) runCatching { source.products(branchId, "", false) } else null }
                val waves = async { if (capabilities.canManage) runCatching { source.waves() } else null }
                val print = async { if (capabilities.canUsePrintPricing) runCatching { source.printSettings() } else null }
                Triple(products.await(), waves.await(), print.await())
            }
            state = state.copy(
                busy = null,
                page = results.first?.getOrNull() ?: state.page,
                waves = results.second?.getOrNull() ?: state.waves,
                printSettings = results.third?.getOrNull() ?: state.printSettings,
                error = listOf(results.first, results.second, results.third).firstNotNullOfOrNull { it?.exceptionOrNull() }?.let(::message),
            )
        }
    }

    fun section(value: ProductsSection) {
        if (value == ProductsSection.PRICE_WAVES && !capabilities.canManage) return
        if (value == ProductsSection.PRINT_PRICING && !capabilities.canUsePrintPricing) return
        state = state.copy(section = value, selected = null, error = null, notice = null)
    }
    fun query(value: String) { state = state.copy(query = value.take(120)) }
    fun barcode(value: String) { state = state.copy(barcodeInput = value.take(64)) }
    fun tier(value: ProductTier) { state = state.copy(tier = value) }
    fun includeInactive(value: Boolean) { state = state.copy(includeInactive = value); search() }
    fun closeDetails() { state = state.copy(selected = null, error = null) }
    fun waveDraft(value: PriceWaveDraft) { state = state.waveChanged(value) }
    fun printDraft(value: PrintEstimateDraft) { state = state.copy(printDraft = value, printEstimate = null, error = null) }

    fun search() = launch(ProductsBusy.SEARCH) {
        val branchId = capabilities.branchId ?: error("لا يوجد فرع فعّال")
        state = state.copy(page = source.products(branchId, state.query, state.includeInactive), selected = null)
    }

    fun more() {
        if (state.page.rows.size >= state.page.total) return
        launch(ProductsBusy.SEARCH) {
            val branchId = capabilities.branchId ?: error("لا يوجد فرع فعّال")
            val next = source.products(branchId, state.query, state.includeInactive, state.page.rows.size)
            state = state.copy(page = next.copy(rows = state.page.rows + next.rows))
        }
    }

    fun select(row: ProductRow) = launch(ProductsBusy.DETAIL) {
        val related = state.page.rows.filter { it.productId == row.productId }
        var details = ProductDetails(
            productId = row.productId, name = row.productName, description = row.description, brand = row.brand,
            modelName = row.modelName, categoryName = row.categoryName, active = row.productActive,
            isBundle = row.isBundle, isService = row.isService, rows = related,
        )
        if (row.isBundle && row.variantId != null) details = details.copy(bundle = source.bundle(row.variantId))
        state = state.copy(selected = details)
    }

    fun lookupBarcode() = launch(ProductsBusy.BARCODE) {
        val branchId = capabilities.branchId ?: error("لا يوجد فرع فعّال")
        val found = source.barcode(branchId, state.barcodeInput, state.tier)
        state = state.copy(barcodeResult = found, notice = if (found == null) "لم يُعثر على باركود مطابق" else null)
    }

    fun setActive(active: Boolean) {
        val product = state.selected ?: return
        if (!capabilities.canManage) return
        launch(ProductsBusy.ACTIVE) {
            source.setActive(product.productId, active)
            val branchId = capabilities.branchId ?: error("لا يوجد فرع فعّال")
            val refreshed = source.products(branchId, state.query, state.includeInactive)
            state = state.copy(page = refreshed, selected = product.copy(active = active), notice = if (active) "تم تفعيل المنتج" else "تم تعطيل المنتج")
        }
    }

    fun previewWave() {
        val draft = state.waveDraft
        launch(ProductsBusy.WAVE_PREVIEW) { state = state.wavePreviewed(source.previewWave(draft)) }
    }

    fun applyWave() {
        if (!state.canApplyWave) return
        val draft = state.waveDraft
        val started = state.start(ProductsBusy.WAVE_APPLY) ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.applyWave(draft) }
                .onSuccess { applied ->
                    val history = runCatching { source.waves() }.getOrElse { state.waves }
                    state = state.copy(
                        busy = null, waves = history, wavePreview = null, previewedDraft = null,
                        notice = "طُبقت الموجة على ${applied.totalRows} سعراً", error = null,
                    )
                }
                .onFailure {
                    state = state.uncertainWave("تعذر تأكيد نتيجة التطبيق. لا تُعد المحاولة قبل مطابقة السجل من الخادم.")
                }
        }
    }

    fun reconcileWaves() = launch(ProductsBusy.WAVE_RECONCILE) { state = state.reconciled(source.waves()) }

    fun estimatePrint() = launch(ProductsBusy.PRINT_ESTIMATE) { state = state.copy(printEstimate = source.estimatePrint(state.printDraft)) }

    private fun launch(operation: ProductsBusy, block: suspend () -> Unit) {
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }.onSuccess { if (state.busy == operation) state = state.copy(busy = null) }
                .onFailure { state = state.failed(message(it)) }
        }
    }
    private fun fail(value: String) { state = state.failed(value) }
    private fun message(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class ProductsViewModelFactory(private val source: ProductsDataSource, private val capabilities: ProductsCapabilities) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ProductsViewModel(source, capabilities) as T
}

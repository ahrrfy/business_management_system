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
import online.alarabiya.superapp.model.products.ProductCategory
import online.alarabiya.superapp.model.products.ProductEditorDraft

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
                val categories = async { if (capabilities.canBrowse) runCatching { source.categories(capabilities.canManage) } else null }
                listOf(products.await(), waves.await(), print.await(), categories.await())
            }
            state = state.copy(
                busy = null,
                page = (results[0]?.getOrNull() as? online.alarabiya.superapp.model.products.ProductPage) ?: state.page,
                catalogLoaded = results[0]?.isSuccess == true,
                selected = if (results[0]?.isSuccess == true) null else state.selected,
                waves = (results[1]?.getOrNull() as? List<*>)?.filterIsInstance<online.alarabiya.superapp.model.products.PriceWaveSummary>() ?: state.waves,
                printSettings = (results[2]?.getOrNull() as? online.alarabiya.superapp.model.products.PrintPricingSettings) ?: state.printSettings,
                categories = (results[3]?.getOrNull() as? List<*>)?.filterIsInstance<ProductCategory>() ?: state.categories,
                error = results.firstNotNullOfOrNull { it?.exceptionOrNull() }?.let(::message),
            )
        }
    }

    fun section(value: ProductsSection) {
        if (value == ProductsSection.PRICE_WAVES && !capabilities.canManage) return
        if (value == ProductsSection.PRINT_PRICING && !capabilities.canUsePrintPricing) return
        state = state.copy(section = value, selected = null, error = null, notice = null)
    }
    fun query(value: String) { if (!state.locked) state = state.copy(query = value.take(120)) }
    fun barcode(value: String) { if (!state.locked) state = state.copy(barcodeInput = value.take(64)) }
    fun tier(value: ProductTier) { if (!state.locked) state = state.copy(tier = value) }
    fun includeInactive(value: Boolean) {
        if (state.locked) return
        state = state.copy(includeInactive = value)
        search()
    }
    fun closeDetails() { if (!state.locked) state = state.copy(selected = null, error = null) }
    fun waveDraft(value: PriceWaveDraft) { if (!state.locked) state = state.waveChanged(value) }
    fun printDraft(value: PrintEstimateDraft) {
        if (!state.locked) state = state.copy(printDraft = value, printEstimate = null, error = null)
    }
    fun editorDraft(value: ProductEditorDraft) {
        if (!state.locked) state = state.copy(editor = value, error = null)
    }
    fun closeEditor() {
        if (!state.locked) state = state.copy(editor = null, error = null)
    }

    fun newProduct() {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        state = state.copy(editor = ProductEditorDraft(), selected = null, error = null)
    }

    fun editProduct(productId: Long) = launch(ProductsBusy.EDITOR_LOAD) {
        if (!capabilities.canManage || !state.catalogLoaded) return@launch
        state = state.copy(editor = source.productForEdit(productId), selected = null)
    }

    fun saveProduct() {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val draft = state.editor ?: return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.EDITOR_SAVE,
            mutation = {
                if (draft.productId == null) source.createProduct(draft)
                else {
                    source.updateProduct(draft)
                    draft.productId
                }
            },
            commit = { current, _ -> current.productSaved() },
            refresh = { current, _ ->
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
            },
            refreshFailureMessage = "تم حفظ المنتج، وتعذر تحديث قائمة المنتجات الآن.",
        )
    }

    fun createCategory(name: String, parentId: Long?) {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.CATEGORIES,
            mutation = { source.createCategory(name, parentId) },
            commit = { current, created -> current.categoryCreated(created) },
            refresh = { current, _ ->
                val categories = source.categories(true)
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
                    .copy(categories = categories)
            },
            refreshFailureMessage = "تمت إضافة الفئة، وتعذر تحديث قائمة الفئات الآن.",
        )
    }

    fun updateCategory(category: ProductCategory) {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.CATEGORIES,
            mutation = { source.updateCategory(category) },
            commit = { current, _ -> current.categoryUpdated(category) },
            refresh = { current, _ ->
                val categories = source.categories(true)
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
                    .copy(categories = categories)
            },
            refreshFailureMessage = "تم تحديث الفئة، وتعذر تحديث قائمة الفئات الآن.",
        )
    }

    fun openBarcodes(productUnitId: Long) {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        state = requireNotNull(state.start(ProductsBusy.BARCODE_ALIASES)).copy(
            barcodeUnitId = null,
            barcodeAliases = emptyList(),
            barcodeAliasesFresh = false,
        )
        viewModelScope.launch {
            runCatching { source.barcodeAliases(productUnitId) }
                .onSuccess { state = state.barcodeAliasesLoaded(productUnitId, it) }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    fun closeBarcodes() {
        if (!state.locked) {
            state = state.copy(barcodeUnitId = null, barcodeAliases = emptyList(), barcodeAliasesFresh = false)
        }
    }
    fun addBarcodeAlias(barcode: String, note: String) {
        val unitId = state.barcodeUnitId ?: return
        if (!capabilities.canManage || !state.canMutateBarcodeAliases) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.BARCODE_ALIASES,
            mutation = { source.addBarcodeAlias(unitId, barcode, note) },
            commit = { current, _ -> current.barcodeAliasCommitted() },
            refresh = { current, _ ->
                val aliases = source.barcodeAliases(unitId)
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
                    .copy(barcodeUnitId = unitId, barcodeAliases = aliases, barcodeAliasesFresh = true)
            },
            refreshFailureMessage = "تمت إضافة الباركود، وتعذر تحديث القائمة الآن. أغلق النافذة وأعد فتحها.",
        )
    }
    fun removeBarcodeAlias(id: Long) {
        val unitId = state.barcodeUnitId ?: return
        if (!capabilities.canManage || !state.canMutateBarcodeAliases) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.BARCODE_ALIASES,
            mutation = { source.removeBarcodeAlias(id) },
            commit = { current, _ -> current.barcodeAliasCommitted(id) },
            refresh = { current, _ ->
                val aliases = source.barcodeAliases(unitId)
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
                    .copy(barcodeUnitId = unitId, barcodeAliases = aliases, barcodeAliasesFresh = true)
            },
            refreshFailureMessage = "تم حذف الباركود، وتعذر تحديث القائمة الآن. أغلق النافذة وأعد فتحها.",
        )
    }

    fun search() {
        refreshCatalog(append = false)
    }

    fun more() {
        if (state.page.rows.size >= state.page.total) return
        refreshCatalog(append = true)
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
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        committedMutation(
            operation = ProductsBusy.ACTIVE,
            mutation = { source.setActive(product.productId, active) },
            commit = { current, _ -> current.productActiveCommitted(product.productId, active) },
            refresh = { current, _ ->
                current.catalogRefreshed(source.products(branchId, current.query, current.includeInactive))
            },
            refreshFailureMessage = "تم تحديث حالة المنتج، وتعذر تحديث القائمة الآن.",
        )
    }

    fun previewWave() {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val draft = state.waveDraft
        val started = state.startWavePreview() ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.previewWave(draft) }
                .onSuccess { state = state.wavePreviewed(it) }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    fun applyWave() {
        if (!capabilities.canManage || !state.canMutateCatalog) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        val draft = state.waveDraft
        val expectedPreview = state.wavePreview ?: return
        val started = state.startWaveApply() ?: return
        state = started
        viewModelScope.launch {
            // The server contract has no preview token/version. Recompute immediately before apply
            // and require a second explicit confirmation whenever any row changed.
            val freshPreview = runCatching { source.previewWave(draft) }
                .getOrElse {
                    state = state.failed(message(it))
                    return@launch
                }
            if (freshPreview != expectedPreview) {
                state = state.waveReconfirmationRequired(freshPreview)
                return@launch
            }

            runCatching { source.applyWave(draft) }
                .onSuccess { applied ->
                    val history = runCatching { source.waves() }.getOrElse { state.waves }
                    val catalog = runCatching {
                        source.products(branchId, state.query, state.includeInactive)
                    }
                    state = state.copy(
                        busy = null,
                        waves = history,
                        page = catalog.getOrNull() ?: state.page,
                        catalogLoaded = catalog.isSuccess,
                        wavePreview = null,
                        previewedDraft = null,
                        notice = "طُبقت الموجة على ${applied.totalRows} سعراً",
                        error = catalog.exceptionOrNull()?.let {
                            "تم تطبيق الموجة، وتعذر تحديث الكتالوج الآن. أعد المحاولة قبل أي تعديل جديد."
                        },
                    )
                }
                .onFailure {
                    state = state.uncertainWave("تعذر تأكيد نتيجة التطبيق. لا تُعد المحاولة قبل مطابقة السجل من الخادم.")
                }
        }
    }

    fun reconcileWaves() = launch(ProductsBusy.WAVE_RECONCILE) { state = state.reconciled(source.waves()) }

    fun estimatePrint() = launch(ProductsBusy.PRINT_ESTIMATE) { state = state.copy(printEstimate = source.estimatePrint(state.printDraft)) }

    private fun refreshCatalog(append: Boolean) {
        if (state.locked || !capabilities.canBrowse) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال")
        val previousRows = state.page.rows
        val offset = if (append) previousRows.size else 0
        state = state.copy(catalogLoaded = false, selected = null, barcodeResult = null)
        val started = state.start(ProductsBusy.SEARCH) ?: return
        state = started
        viewModelScope.launch {
            runCatching { source.products(branchId, state.query, state.includeInactive, offset) }
                .onSuccess { next ->
                    val page = if (append) next.copy(rows = previousRows + next.rows) else next
                    state = state.catalogRefreshed(page).copy(selected = null)
                }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    private fun launch(operation: ProductsBusy, block: suspend () -> Unit) {
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }.onSuccess { if (state.busy == operation) state = state.copy(busy = null) }
                .onFailure { state = state.failed(message(it)) }
        }
    }

    private fun <T> committedMutation(
        operation: ProductsBusy,
        mutation: suspend () -> T,
        commit: (ProductsUiState, T) -> ProductsUiState,
        refresh: suspend (ProductsUiState, T) -> ProductsUiState,
        refreshFailureMessage: String,
    ) {
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            val result = runCatching { mutation() }
                .getOrElse {
                    state = state.failed(message(it))
                    return@launch
                }

            // Once the server acknowledges a write, close/update the command surface before its
            // read-after-write refresh. A refresh error must never reopen the same mutation.
            state = commit(state, result)
            state = runCatching { refresh(state, result) }
                .fold(
                    onSuccess = { it.copy(busy = null, error = null) },
                    onFailure = { state.committedRefreshFailed(refreshFailureMessage) },
                )
        }
    }
    private fun fail(value: String) { state = state.failed(value) }
    private fun message(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class ProductsViewModelFactory(private val source: ProductsDataSource, private val capabilities: ProductsCapabilities) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ProductsViewModel(source, capabilities) as T
}

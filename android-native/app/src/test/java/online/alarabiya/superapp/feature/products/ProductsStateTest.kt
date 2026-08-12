package online.alarabiya.superapp.feature.products

import online.alarabiya.superapp.model.products.PriceChangeType
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PriceWavePreview
import online.alarabiya.superapp.model.products.PriceWaveSummary
import online.alarabiya.superapp.model.products.BarcodeAlias
import online.alarabiya.superapp.model.products.ProductCategory
import online.alarabiya.superapp.model.products.ProductDetails
import online.alarabiya.superapp.model.products.ProductPage
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import online.alarabiya.superapp.model.products.ProductEditorDraft
import online.alarabiya.superapp.model.products.ProductEditorValidation
import online.alarabiya.superapp.model.products.ProductVariantDraft
import online.alarabiya.superapp.model.products.ProductUnitDraft

class ProductsStateTest {
    @Test
    fun `product editor requires one base unit and valid prices`() {
        val valid = ProductEditorDraft(
            name = "ورق A4",
            variants = listOf(ProductVariantDraft(sku = "A4", costPrice = "100", units = listOf(ProductUnitDraft(retailPrice = "125")))),
        )
        assertNull(ProductEditorValidation.validate(valid))
        assertTrue(ProductEditorValidation.validate(valid.copy(name = ""))!!.contains("اسم المنتج"))
        assertTrue(ProductEditorValidation.validate(valid.copy(variants = listOf(valid.variants.single().copy(units = listOf(valid.variants.single().units.single().copy(isBase = false))))))!!.contains("وحدة أساس"))
    }
    @Test
    fun `busy state rejects a second operation`() {
        val busy = requireNotNull(ProductsUiState().start(ProductsBusy.WAVE_APPLY))
        assertNull(busy.start(ProductsBusy.WAVE_APPLY))
    }

    @Test
    fun `wave can apply only after an unchanged server preview`() {
        val draft = PriceWaveDraft(name = "Q3", changeType = PriceChangeType.INCREASE_PERCENT, changeValue = "5")
        val previewed = ProductsUiState(catalogLoaded = true, waveDraft = draft).wavePreviewed(PriceWavePreview(emptyList(), 0))
        assertTrue(previewed.canApplyWave)

        val changed = previewed.waveChanged(draft.copy(changeValue = "6"))
        assertFalse(changed.canApplyWave)
        assertNull(changed.wavePreview)
    }

    @Test
    fun `failed preview clears prior preview and fails closed`() {
        val draft = PriceWaveDraft(name = "Q3", changeValue = "5")
        val previewed = ProductsUiState(catalogLoaded = true, waveDraft = draft).wavePreviewed(PriceWavePreview(emptyList(), 0))
        val loading = requireNotNull(previewed.startWavePreview())
        val failed = loading.failed("network")

        assertNull(failed.wavePreview)
        assertNull(failed.previewedDraft)
        assertFalse(failed.canApplyWave)
    }

    @Test
    fun `apply clears preview while server revalidates and changed preview requires reconfirmation`() {
        val draft = PriceWaveDraft(name = "Q3", changeValue = "5")
        val old = PriceWavePreview(emptyList(), 0)
        val previewed = ProductsUiState(catalogLoaded = true, waveDraft = draft).wavePreviewed(old)
        val revalidating = requireNotNull(previewed.startWaveApply())

        assertNull(revalidating.wavePreview)
        assertFalse(revalidating.canApplyWave)

        val changed = revalidating.waveReconfirmationRequired(PriceWavePreview(emptyList(), 1))
        assertTrue(changed.canApplyWave)
        assertTrue(changed.error!!.contains("أكّد التطبيق من جديد"))
    }

    @Test
    fun `saved product stays closed when post commit refresh fails`() {
        val draft = ProductEditorDraft(name = "دفتر")
        val committed = requireNotNull(ProductsUiState(editor = draft).start(ProductsBusy.EDITOR_SAVE))
            .productSaved()
            .committedRefreshFailed("refresh failed")

        assertNull(committed.editor)
        assertFalse(committed.locked)
        assertFalse(committed.catalogLoaded)
        assertTrue(committed.notice!!.contains("حفظ"))
    }

    @Test
    fun `active and category commits update local state before refresh`() {
        val detail = ProductDetails(7, "دفتر", null, null, null, null, true, false, false, emptyList())
        val category = ProductCategory(3, "قرطاسية")
        val acknowledged = requireNotNull(ProductsUiState(selected = detail).start(ProductsBusy.ACTIVE))
            .productActiveCommitted(7, false)
            .categoryCreated(category)

        assertFalse(requireNotNull(acknowledged.selected).active)
        assertTrue(category in acknowledged.categories)

        val stale = acknowledged.committedRefreshFailed("refresh failed")
        assertNull(stale.selected)
        assertFalse(stale.catalogLoaded)
        assertFalse(stale.locked)
    }

    @Test
    fun `barcode mutation becomes stale and cannot repeat after refresh failure`() {
        val loaded = ProductsUiState(catalogLoaded = true).barcodeAliasesLoaded(11, listOf(BarcodeAlias(4, "100", null)))
        assertTrue(loaded.canMutateBarcodeAliases)

        val committed = requireNotNull(loaded.start(ProductsBusy.BARCODE_ALIASES))
            .barcodeAliasCommitted(4)
            .committedRefreshFailed("refresh failed")

        assertFalse(committed.canMutateBarcodeAliases)
        assertFalse(committed.barcodeAliasesFresh)
        assertTrue(committed.barcodeAliases.isEmpty())
    }

    @Test
    fun `unknown apply outcome blocks retry until history reconciliation`() {
        val draft = PriceWaveDraft(name = "Q3", changeValue = "5")
        val state = ProductsUiState(catalogLoaded = true, waveDraft = draft).wavePreviewed(PriceWavePreview(emptyList(), 0))
            .uncertainWave("unknown")
        assertFalse(state.canApplyWave)
        assertTrue(state.waveOutcomeUnknown)

        val reconciled = state.reconciled(
            listOf(PriceWaveSummary(1, "Q3", PriceChangeType.INCREASE_PERCENT, "5", 10, null)),
        )
        assertFalse(reconciled.waveOutcomeUnknown)
        assertFalse(reconciled.canApplyWave)
        assertNull(reconciled.wavePreview)
    }

    @Test
    fun `initial catalog failure blocks every mutation until successful retry`() {
        val initial = ProductsUiState(editor = ProductEditorDraft(name = "دفتر"))
        assertFalse(initial.canMutateCatalog)
        assertNull(initial.startWavePreview())

        val failed = requireNotNull(initial.start(ProductsBusy.INITIAL)).failed("catalog unavailable")
        assertFalse(failed.canMutateCatalog)

        val ready = failed.catalogRefreshed(ProductPage(emptyList(), 0))
        assertTrue(ready.canMutateCatalog)
        assertFalse(ready.locked)
    }
}

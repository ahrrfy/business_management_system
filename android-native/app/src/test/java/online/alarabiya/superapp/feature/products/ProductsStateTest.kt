package online.alarabiya.superapp.feature.products

import online.alarabiya.superapp.model.products.PriceChangeType
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PriceWavePreview
import online.alarabiya.superapp.model.products.PriceWaveSummary
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductsStateTest {
    @Test
    fun `busy state rejects a second operation`() {
        val busy = requireNotNull(ProductsUiState().start(ProductsBusy.WAVE_APPLY))
        assertNull(busy.start(ProductsBusy.WAVE_APPLY))
    }

    @Test
    fun `wave can apply only after an unchanged server preview`() {
        val draft = PriceWaveDraft(name = "Q3", changeType = PriceChangeType.INCREASE_PERCENT, changeValue = "5")
        val previewed = ProductsUiState(waveDraft = draft).wavePreviewed(PriceWavePreview(emptyList(), 0))
        assertTrue(previewed.canApplyWave)

        val changed = previewed.waveChanged(draft.copy(changeValue = "6"))
        assertFalse(changed.canApplyWave)
        assertNull(changed.wavePreview)
    }

    @Test
    fun `unknown apply outcome blocks retry until history reconciliation`() {
        val draft = PriceWaveDraft(name = "Q3", changeValue = "5")
        val state = ProductsUiState(waveDraft = draft).wavePreviewed(PriceWavePreview(emptyList(), 0))
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
}

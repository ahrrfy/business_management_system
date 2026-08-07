package online.alarabiya.superapp.feature.receivables

import online.alarabiya.superapp.model.receivables.ReceivablesSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceivablesStateTest {
    @Test
    fun `loading reducer distinguishes initial refresh and pagination`() {
        val state = ReceivablesUiState(ReceivablesSection.INSTALLMENTS)

        assertTrue(state.startLoading(refresh = false).loading)
        assertTrue(state.startLoading(refresh = true).refreshing)
        assertTrue(state.startLoading(refresh = false, append = true).loadingMore)
    }

    @Test
    fun `finish loading marks only completed section`() {
        val state = ReceivablesUiState(ReceivablesSection.CARD_ACCOUNT, loading = true)
            .finishLoading(ReceivablesSection.CARD_ACCOUNT)

        assertEquals(setOf(ReceivablesSection.CARD_ACCOUNT), state.loadedSections)
        assertFalse(state.loading)
    }

    @Test
    fun `failed action clears every busy flag`() {
        val state = ReceivablesUiState(
            section = ReceivablesSection.INSTALLMENTS,
            loading = true,
            refreshing = true,
            loadingMore = true,
            submitting = true,
            detailLoading = true,
        ).failed("تعذر")

        assertFalse(state.loading)
        assertFalse(state.refreshing)
        assertFalse(state.loadingMore)
        assertFalse(state.submitting)
        assertFalse(state.detailLoading)
        assertEquals("تعذر", state.error)
    }
}

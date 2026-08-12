package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.InsightsSection
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.insights.SearchInsight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class InsightsStateTest {
    @Test
    fun `typed target prevents same numeric id selecting another entity`() {
        val invoice = result(SearchEntityType.INVOICE, 7)
        val product = result(SearchEntityType.PRODUCT, 7)
        val state = InsightsUiState(
            section = InsightsSection.SEARCH,
            searchResults = listOf(invoice),
        )

        assertEquals(invoice.target, state.select(invoice.target).selectedTarget)
        assertSame(state, state.select(product.target))
    }

    @Test
    fun `loaded marks only completed section`() {
        val state = InsightsUiState(section = InsightsSection.REPORTS, loading = true)
            .loaded(InsightsSection.REPORTS)

        assertEquals(setOf(InsightsSection.REPORTS), state.loadedSections)
        assertEquals(false, state.loading)
    }

    private fun result(type: SearchEntityType, id: Long) = SearchInsight(
        target = InsightTarget(type, id),
        title = "نتيجة",
        subtitle = null,
        meta = null,
        rank = 0,
    )
}

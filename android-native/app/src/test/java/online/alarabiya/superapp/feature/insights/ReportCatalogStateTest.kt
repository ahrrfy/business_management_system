package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightMoney
import online.alarabiya.superapp.model.insights.ReportCatalogKind
import online.alarabiya.superapp.model.insights.ReportCatalogQuery
import online.alarabiya.superapp.model.insights.ReportPageInfo
import online.alarabiya.superapp.model.insights.SalesRegisterReportInsight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportCatalogStateTest {
    @Test
    fun `late response from a previously selected report is ignored`() {
        val query = query(ReportCatalogKind.SALES_REGISTER)
        val loading = ReportCatalogUiState(selected = query.kind).loading(query)
        val changed = loading.select(ReportCatalogKind.INVENTORY_VALUATION)

        val afterLateResponse = changed.loaded(query, salesResult())

        assertSame(changed, afterLateResponse)
        assertNull(afterLateResponse.result)
    }

    @Test
    fun `refresh failure retains only the exact same report snapshot`() {
        val query = query(ReportCatalogKind.SALES_REGISTER)
        val loaded = ReportCatalogUiState(selected = query.kind)
            .loading(query)
            .loaded(query, salesResult())

        val failedRefresh = loaded.loading(query).failed(query, "تعذر التحديث")
        val nextPage = query.copy(page = 1)
        val failedNextPage = loaded.loading(nextPage).failed(nextPage, "تعذر التحديث")

        assertEquals("تعذر التحديث", failedRefresh.error)
        assertTrue(failedRefresh.result != null)
        assertNull(failedNextPage.result)
    }

    @Test
    fun `filter invalidation clears result and cancels in flight acceptance`() {
        val query = query(ReportCatalogKind.SALES_REGISTER)
        val invalidated = ReportCatalogUiState(selected = query.kind).loading(query).invalidate()

        assertFalse(invalidated.loading)
        assertNull(invalidated.loadingRequest)
        assertNull(invalidated.result)
        assertSame(invalidated, invalidated.loaded(query, salesResult()))
    }

    private fun query(kind: ReportCatalogKind) = ReportCatalogQuery(
        kind = kind,
        range = InsightDateRange("2026-08-01", "2026-08-10"),
        branchId = 2,
    )

    private fun salesResult() = SalesRegisterReportInsight(
        revenue = InsightMoney.fromServer("10"),
        cost = InsightMoney.fromServer("5"),
        profit = InsightMoney.fromServer("5"),
        quantity = "1",
        rows = emptyList(),
        pageInfo = ReportPageInfo(0, 25, 0, hasPrevious = false, hasNext = false),
    )
}

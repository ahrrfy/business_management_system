package online.alarabiya.superapp.data

import online.alarabiya.superapp.model.insights.CashOrphanCategory
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.ProductionReportInsight
import online.alarabiya.superapp.model.insights.ReportCatalogKind
import online.alarabiya.superapp.model.insights.ReportCatalogQuery
import online.alarabiya.superapp.model.insights.SalesRegisterReportInsight
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeReportCatalogMapperTest {
    @Test
    fun `sales mapper preserves decimal strings and authoritative pagination`() {
        val json = JSONObject()
            .put("total", 53)
            .put("totals", JSONObject()
                .put("revenue", "12345678901234567890.25")
                .put("cost", "20")
                .put("profit", "12345678901234567870.25")
                .put("qty", "4.500"))
            .put("rows", JSONArray()
                .put(JSONObject()
                    .put("id", 10).put("invoiceId", 20).put("invoiceNumber", "INV-20")
                    .put("invoiceDate", "2026-08-10").put("productName", "ورق")
                    .put("quantity", "2.5").put("unitPrice", "10.1")
                    .put("total", "25.25").put("profit", "5.05"))
                .put(JSONObject().put("id", 0).put("invoiceId", 21)))
        val query = query(ReportCatalogKind.SALES_REGISTER, page = 1)

        val result = ReportCatalogMapper.salesRegister(json, query) as SalesRegisterReportInsight

        assertEquals("12345678901234567890.25", result.revenue.value)
        assertEquals("10.10", result.rows.single().unitPrice.value)
        assertEquals(53, result.pageInfo.total)
        assertTrue(result.pageInfo.hasPrevious)
        assertTrue(result.pageInfo.hasNext)
    }

    @Test
    fun `cash mapper never exposes an offset it cannot enforce`() {
        val rows = JSONArray()
        repeat(25) { index ->
            rows.put(JSONObject()
                .put("receiptId", index + 1)
                .put("direction", "IN")
                .put("amount", "1")
                .put("category", if (index == 0) "TRUE_ORPHAN" else "TREASURY")
                .put("createdAt", "2026-08-10T08:00:00.000Z"))
        }
        val json = JSONObject()
            .put("rows", rows).put("count", 25)
            .put("totalIn", "25").put("totalOut", "0").put("net", "25")
            .put("countTreasury", 24).put("countTrueOrphan", 1).put("netTrueOrphan", "1")

        val result = ReportCatalogMapper.cashOrphans(json, query(ReportCatalogKind.CASH_ORPHANS))

        assertEquals(CashOrphanCategory.TRUE_ORPHAN, result.rows.first().category)
        assertTrue(result.pageInfo.serverWindowLimited)
        assertFalse(result.pageInfo.hasNext)
    }

    @Test
    fun `production mapper preserves the bounded server page and authoritative total`() {
        val rows = JSONArray()
        repeat(15) { index ->
            rows.put(JSONObject()
                .put("id", index + 26).put("docNumber", "PR-${index + 26}")
                .put("date", "2026-08-10").put("inputsCost", "1")
                .put("laborCost", "2").put("wasteCost", "0").put("totalCost", "3"))
        }
        val json = JSONObject().put("rows", rows).put("total", 40).put("totals", JSONObject()
            .put("count", 40).put("inputsCost", "40").put("laborCost", "80")
            .put("wasteCost", "0").put("totalCost", "120"))

        val result = ReportCatalogMapper.production(
            json,
            query(ReportCatalogKind.PRODUCTION, page = 1),
        ) as ProductionReportInsight

        assertEquals(15, result.rows.size)
        assertEquals(26L, result.rows.first().id)
        assertFalse(result.pageInfo.hasNext)
        assertEquals("120.00", result.totalCost.value)
    }

    @Test
    fun `report query fails closed for missing item variant and oversized production range`() {
        assertEquals(
            "أدخل معرّف متغيّر الصنف",
            query(ReportCatalogKind.ITEM_LEDGER).validationError(),
        )
        val oversized = ReportCatalogQuery(
            kind = ReportCatalogKind.PRODUCTION,
            range = InsightDateRange("2026-06-01", "2026-08-10"),
            branchId = 1,
        )
        assertEquals("الفترة أطول من الحد المسموح", oversized.validationError())
    }

    private fun query(kind: ReportCatalogKind, page: Int = 0) = ReportCatalogQuery(
        kind = kind,
        range = InsightDateRange("2026-08-01", "2026-08-10"),
        branchId = 2,
        page = page,
    )
}

package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.data.CategoryProfitPayload
import online.alarabiya.superapp.data.InsightsMapper
import online.alarabiya.superapp.data.ManagementAlertPayload
import online.alarabiya.superapp.data.SearchPayload
import online.alarabiya.superapp.data.TopProductPayload
import online.alarabiya.superapp.model.insights.AlertSeverity
import online.alarabiya.superapp.model.insights.PercentText
import online.alarabiya.superapp.model.insights.SearchEntityType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InsightsMapperTest {
    @Test
    fun `maps alert money without floating point`() {
        val alert = InsightsMapper.alert(
            ManagementAlertPayload("stock", "critical", "نفاد", 3, "123456789012345.10", "عرض"),
        )!!

        assertEquals(AlertSeverity.CRITICAL, alert.severity)
        assertEquals("123456789012345.10", alert.amount?.value)
    }

    @Test
    fun `unknown severity is not invented`() {
        assertNull(InsightsMapper.alert(ManagementAlertPayload("x", "urgent", "تنبيه", 1, null, "عرض")))
    }

    @Test
    fun `top product preserves decimal strings`() {
        val product = InsightsMapper.topProduct(
            TopProductPayload(4, "منتج", null, "9.000", "100.10", "25.05", "25.024", 2),
        )!!

        assertEquals("100.10", product.revenue.value)
        // The server-provided margin is authoritative and is normalized to one decimal.
        assertEquals("25.0", product.margin.value)
    }

    @Test
    fun `category supports unclassified null id`() {
        val category = InsightsMapper.category(CategoryProfitPayload(null, "بلا فئة", "10", "7", "3", "30", 1))

        assertNull(category.categoryId)
        assertEquals("3.00", category.profit.value)
    }

    @Test
    fun `search mapper validates type scope and numeric identity`() {
        val payload = SearchPayload("INVOICE", 8, "INV-8", null, null, 0)

        assertEquals(8L, InsightsMapper.search(payload, setOf(SearchEntityType.INVOICE))?.target?.id)
        assertNull(InsightsMapper.search(payload, setOf(SearchEntityType.PRODUCT)))
        assertNull(InsightsMapper.search(payload.copy(type = "UNKNOWN"), SearchEntityType.entries.toSet()))
    }

    @Test
    fun `fraction percent uses decimal arithmetic`() {
        assertEquals("33.3", PercentText.fromFraction("0.333333333").value)
    }
}

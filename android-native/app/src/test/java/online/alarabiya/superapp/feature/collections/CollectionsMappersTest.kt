package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.data.toCreditDecisionOrNull
import online.alarabiya.superapp.model.collections.CreditDecisionPage
import online.alarabiya.superapp.model.collections.CreditDecisionStatus
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectionsMappersTest {
    @Test
    fun `decision preserves server amount and supplied server filter status`() {
        val decision = JSONObject()
            .put("id", 91)
            .put("customerId", 8)
            .put("customerName", "عميل")
            .put("customerPhone", "07700000000")
            .put("maxAmount", "123456.78")
            .put("approvedBy", 4)
            .put("approvedByName", "مدير")
            .put("approvedAt", "2026-08-06T08:00:00.000Z")
            .put("expiresAt", "2026-08-06T09:00:00.000Z")
            .put("consumedAt", JSONObject.NULL)
            .put("consumedByInvoiceId", JSONObject.NULL)
            .toCreditDecisionOrNull(CreditDecisionStatus.EXPIRED)

        assertEquals("123456.78", decision?.maxAmount)
        assertEquals(CreditDecisionStatus.EXPIRED, decision?.status)
        assertNull(decision?.consumedByInvoiceId)
    }

    @Test
    fun `invalid row is rejected instead of fabricating identity`() {
        assertNull(JSONObject().put("id", 0).put("customerId", 8).toCreditDecisionOrNull(CreditDecisionStatus.ACTIVE))
        assertNull(JSONObject().put("id", 1).put("customerId", 0).toCreditDecisionOrNull(CreditDecisionStatus.ACTIVE))
    }

    @Test
    fun `pagination uses authoritative total rather than page size`() {
        val first = CreditDecisionPage(emptyList(), total = 51, offset = 0, limit = 50)
        val last = CreditDecisionPage(emptyList(), total = 50, offset = 50, limit = 50)

        assertTrue(first.hasMore)
        assertFalse(last.hasMore)
    }
}

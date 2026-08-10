package online.alarabiya.superapp.data

import online.alarabiya.superapp.model.crm.CustomerContractPriceDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUpDraft
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmOperationsWireTest {
    @Test
    fun `follow-up creation always carries the selected session branch`() {
        val input = CrmOperationsWire.followUpCreate(
            customerId = 41,
            branchId = 7,
            draft = CustomerFollowUpDraft(note = "  اتصال بشأن العقد  ", followUpDate = "2026-08-10"),
        )

        assertEquals(41L, input.getLong("customerId"))
        assertEquals(7L, input.getLong("branchId"))
        assertEquals("اتصال بشأن العقد", input.getString("note"))
        assertEquals("2026-08-10", input.getString("followUpDate"))
    }

    @Test
    fun `empty optional values are explicit null and list offsets never become negative`() {
        val create = CrmOperationsWire.followUpCreate(41, 7, CustomerFollowUpDraft(note = "اتصال"))
        val page = CrmOperationsWire.followUpList(41, includeResolved = false, offset = -20)
        val due = CrmOperationsWire.dueFollowUps(offset = -9)

        assertTrue(create.isNull("followUpDate"))
        assertEquals(0, page.getInt("offset"))
        assertEquals(100, page.getInt("limit"))
        assertEquals(false, page.getBoolean("includeResolved"))
        assertEquals(0, due.getInt("offset"))
        assertEquals(100, due.getInt("limit"))
    }

    @Test
    fun `contract price payload preserves exact decimal string and product unit`() {
        val input = CrmOperationsWire.contractUpsert(
            customerId = 41,
            draft = CustomerContractPriceDraft(
                productUnitId = 8,
                productLabel = "ورق · A4 · كرتون",
                price = "125000.50",
                note = "  عقد 2026/14  ",
            ),
        )

        assertEquals(41L, input.getLong("customerId"))
        assertEquals(8L, input.getLong("productUnitId"))
        assertEquals("125000.50", input.getString("price"))
        assertEquals("عقد 2026/14", input.getString("note"))
        assertTrue(input.opt("price") !is Number)
        assertTrue(input.opt("note") != JSONObject.NULL)
    }

    @Test
    fun `contract paging keeps the server cursor opaque and customer bound`() {
        val first = CrmOperationsWire.contractPricePage(41, null)
        val next = CrmOperationsWire.contractPricePage(41, "opaque+/=_cursor")

        assertEquals(41L, first.getLong("customerId"))
        assertEquals(100, first.getInt("limit"))
        assertTrue(first.isNull("cursor"))
        assertEquals("opaque+/=_cursor", next.getString("cursor"))
    }
}

package online.alarabiya.superapp.feature.purchasing

import online.alarabiya.superapp.model.purchasing.Currency
import online.alarabiya.superapp.model.purchasing.PurchaseStatus
import online.alarabiya.superapp.model.purchasing.PurchasingMappers
import online.alarabiya.superapp.model.purchasing.SupplierKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PurchasingMappersTest {
    @Test
    fun `purchase mapper preserves money strings and masked nulls`() {
        val rows = PurchasingMappers.orders(listOf(mapOf(
            "id" to "41", "poNumber" to "PO-41", "supplierId" to 7, "branchId" to 3,
            "total" to null, "paidAmount" to null, "usdTotal" to "151.5500",
            "agreedCurrency" to "USD", "status" to "CONFIRMED",
        )))

        val row = rows.single()
        assertNull(row.total)
        assertEquals("151.5500", row.usdTotal)
        assertEquals(Currency.USD, row.agreedCurrency)
        assertEquals(PurchaseStatus.CONFIRMED, row.status)
    }

    @Test
    fun `order detail computes remaining units only from integer server quantities`() {
        val detail = PurchasingMappers.orderDetail(mapOf(
            "id" to 8, "poNumber" to "PO-8", "supplierId" to 2, "branchId" to 1, "status" to "RECEIVED",
            "items" to listOf(mapOf(
                "id" to 9, "variantId" to 10, "productUnitId" to 11, "productName" to "ورق",
                "quantity" to "10.00", "baseQuantity" to 20, "receivedBaseQuantity" to 7,
                "unitPrice" to "4.1250", "total" to "41.2500",
            )),
        ))

        assertEquals(13, detail.lines.single().remainingBaseQuantity)
        assertEquals("4.1250", detail.lines.single().unitPrice)
    }

    @Test
    fun `supplier mapper retains masking and active status`() {
        val page = PurchasingMappers.suppliers(mapOf(
            "rows" to listOf(mapOf("id" to 1, "name" to "المورد", "supplierKind" to "REGULAR", "isActive" to false, "currentBalance" to null)),
            "total" to "1",
        ))

        assertEquals(1, page.total)
        assertEquals(SupplierKind.REGULAR, page.rows.single().kind)
        assertFalse(page.rows.single().active)
        assertNull(page.rows.single().currentBalance)
    }

    @Test
    fun `reminder mapper preserves server promise state`() {
        val queue = PurchasingMappers.reminderQueue(listOf(mapOf(
            "supplierId" to 4, "supplierName" to "المورد", "totalUnpaid" to "900.00",
            "oldestPoDate" to "2026-07-01", "daysOverdue" to "36", "isPromiseDue" to true,
        )))

        assertTrue(queue.single().promiseDue)
        assertEquals(36, queue.single().daysOverdue)
        assertEquals("900.00", queue.single().totalUnpaid)
    }
}

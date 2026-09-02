package online.alarabiya.superapp.feature.sales

import online.alarabiya.superapp.model.sales.CatalogSaleItem
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.ReturnableInvoice
import online.alarabiya.superapp.model.sales.SaleCreation
import online.alarabiya.superapp.model.sales.SaleDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SalesStateTest {
    @Test
    fun `adding same unit increments one cart line`() {
        val item = item()
        val state = SalesUiState().add(item).add(item)

        assertEquals(1, state.cart.size)
        assertEquals("2", state.cart.single().quantity)
    }

    @Test
    fun `busy state rejects a second submit transition`() {
        val sending = requireNotNull(SalesUiState().start(SalesBusy.SALE))

        assertNull(sending.start(SalesBusy.SALE))
        assertTrue(sending.locked)
    }

    @Test
    fun `network failure preserves cart and idempotency key`() {
        val initial = SalesUiState(saleRequestId = "request-fixed").add(item())
        val sending = requireNotNull(initial.start(SalesBusy.SALE))
        val failed = sending.failed("network")

        assertEquals("request-fixed", failed.saleRequestId)
        assertEquals(initial.cart, failed.cart)
        assertFalse(failed.locked)
    }

    @Test
    fun `server acknowledgement clears cart and rotates idempotency key before detail refresh`() {
        val initial = SalesUiState(saleRequestId = "request-fixed").add(item())
        val creation = SaleCreation(9, "INV-9", "10", "PAID", false)
        val confirmed = requireNotNull(initial.start(SalesBusy.SALE)).saleCommitted(creation, "request-next")

        assertTrue(confirmed.cart.isEmpty())
        assertEquals("request-next", confirmed.saleRequestId)
        assertNotEquals(initial.saleRequestId, confirmed.saleRequestId)
        assertSame(creation, confirmed.committedSale)
        assertNull(confirmed.selectedSale)
        assertTrue(confirmed.locked)

        val detail = detail()
        assertSame(detail, confirmed.saleDetailLoaded(detail).selectedSale)
    }

    @Test
    fun `detail refresh failure cannot reopen committed sale`() {
        val initial = SalesUiState(saleRequestId = "request-fixed").add(item())
        val committed = requireNotNull(initial.start(SalesBusy.SALE))
            .saleCommitted(SaleCreation(9, "INV-9", "10", "PAID", false), "request-next")
            .followUpFailed("detail unavailable")

        assertTrue(committed.cart.isEmpty())
        assertEquals("request-next", committed.saleRequestId)
        assertFalse(committed.locked)
        assertEquals("detail unavailable", committed.error)
    }

    @Test
    fun `return acknowledgement closes stale invoice and rotates request before refresh`() {
        val invoice = ReturnableInvoice(9, "INV-9", 1, null, "10", "10", "PAID", "CASH", emptyList())
        val initial = SalesUiState(
            returnInvoice = invoice,
            returnQuantities = mapOf(3L to 1),
            returnRequestId = "return-fixed",
        )
        val committed = requireNotNull(initial.start(SalesBusy.RETURN_SUBMIT))
            .returnCommitted(ReturnCreation.Executed(9, "4", false, false), "return-next")
            .followUpFailed("refresh unavailable")

        assertNull(committed.returnInvoice)
        assertTrue(committed.returnQuantities.isEmpty())
        assertEquals("return-next", committed.returnRequestId)
        assertFalse(committed.locked)
    }

    @Test
    fun `checkout remains closed until required initial dependencies loaded`() {
        val partial = SalesUiState(catalogLoaded = true, shiftsLoaded = false, paymentMethod = PaymentMethod.CASH)
        assertFalse(partial.checkoutDependenciesLoaded)
        assertTrue(partial.copy(shiftsLoaded = true).checkoutDependenciesLoaded)
        assertTrue(partial.copy(paymentMethod = PaymentMethod.CARD).checkoutDependenciesLoaded)
    }

    private fun item() = CatalogSaleItem(
        productId = 1,
        productName = "منتج",
        variantId = 2,
        variantName = null,
        color = null,
        size = null,
        sku = "SKU",
        productUnitId = 3,
        unitName = "قطعة",
        conversionFactor = "1",
        barcode = null,
        serverPrice = "10.00",
        availableBase = 5,
        openedAt = null,
        isService = false,
        isBundle = false,
        isContractPrice = false,
        promotionName = null,
    )

    private fun detail() = SaleDetail(
        id = 9,
        invoiceNumber = "INV-9",
        branchId = 1,
        customerName = null,
        invoiceDate = null,
        subtotal = "10",
        discountAmount = "0",
        taxAmount = "0",
        total = "10",
        paidAmount = "10",
        returnedTotal = "0",
        status = "PAID",
        paymentMethod = "CASH",
        notes = null,
        items = emptyList(),
        payments = emptyList(),
        returns = emptyList(),
    )
}

package online.alarabiya.superapp.feature.sales

import online.alarabiya.superapp.model.sales.CatalogSaleItem
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
    fun `confirmed sale clears cart and rotates idempotency key`() {
        val initial = SalesUiState(saleRequestId = "request-fixed").add(item())
        val detail = detail()
        val confirmed = requireNotNull(initial.start(SalesBusy.SALE)).saleSucceeded(detail, "request-next")

        assertTrue(confirmed.cart.isEmpty())
        assertEquals("request-next", confirmed.saleRequestId)
        assertNotEquals(initial.saleRequestId, confirmed.saleRequestId)
        assertSame(detail, confirmed.selectedSale)
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

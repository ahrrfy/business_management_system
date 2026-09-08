package online.alarabiya.superapp.data

import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.ReturnSubmission
import online.alarabiya.superapp.model.sales.ReturnableInvoice
import online.alarabiya.superapp.model.sales.ReturnableLine
import online.alarabiya.superapp.model.sales.SalesValidation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SalesReturnWireValidationTest {

    private val sampleInvoice = ReturnableInvoice(
        id = 100L,
        invoiceNumber = "INV-100",
        branchId = 1L,
        customerName = "عميل نقدي",
        total = "50.00",
        paidAmount = "50.00",
        status = "COMPLETED",
        paymentMethod = "CASH",
        items = listOf(
            ReturnableLine(
                invoiceItemId = 10L,
                productName = "صنف تجريبي",
                variantLabel = null,
                unitName = "قطعة",
                baseQuantity = 5,
                returnedBaseQuantity = 0,
                remaining = 5,
                unitPrice = "10.00",
                total = "50.00",
            ),
        ),
    )

    @Test
    fun `salesReturn rejects reason shorter than 3 characters`() {
        val submission = ReturnSubmission(
            invoiceId = 100L,
            quantities = mapOf(10L to 1),
            refundAmount = "10.00",
            refundMethod = PaymentMethod.CASH,
            refundShiftId = 1L,
            restock = true,
            clientRequestId = "req-test-12345",
            reason = "لا",
        )

        val err = SalesValidation.salesReturn(submission, sampleInvoice)
        assertNotNull(err)
        assertTrue(err!!.contains("سبب المرتجع مطلوب"))
    }

    @Test
    fun `salesReturn requires reference for non-cash refunds`() {
        val noRefSubmission = ReturnSubmission(
            invoiceId = 100L,
            quantities = mapOf(10L to 1),
            refundAmount = "10.00",
            refundMethod = PaymentMethod.CARD,
            refundShiftId = null,
            restock = true,
            clientRequestId = "req-test-12345",
            reason = "عيب في المنتج",
            refundReference = null,
        )

        val err = SalesValidation.salesReturn(noRefSubmission, sampleInvoice)
        assertEquals("مرجع البطاقة مطلوب", err)

        val withRefSubmission = noRefSubmission.copy(refundReference = "AUTH-9988")
        assertNull(SalesValidation.salesReturn(withRefSubmission, sampleInvoice))
    }

    @Test
    fun `salesReturn rejects non-surfaced direct refund rails`() {
        val transferSubmission = ReturnSubmission(
            invoiceId = 100L,
            quantities = mapOf(10L to 1),
            refundAmount = "10.00",
            refundMethod = PaymentMethod.TRANSFER,
            refundShiftId = null,
            restock = true,
            clientRequestId = "req-test-12345",
            reason = "عيب في المنتج",
            refundReference = "TR-1234",
        )

        val err = SalesValidation.salesReturn(transferSubmission, sampleInvoice)
        assertEquals("طريقة الرد المباشر المتاحة هي النقد أو البطاقة فقط", err)
    }

    @Test
    fun `SalesWire returnInput serializes reason and non-cash refund reference`() {
        val submission = ReturnSubmission(
            invoiceId = 100L,
            quantities = mapOf(10L to 2),
            refundAmount = "20.00",
            refundMethod = PaymentMethod.CARD,
            refundShiftId = null,
            restock = true,
            clientRequestId = "req-return-card-01",
            reason = "تلف أثناء النقل",
            refundReference = "TXN-CARD-5544",
        )

        val json = SalesWire.returnInput(submission)
        assertEquals(100L, json.getLong("invoiceId"))
        assertEquals("تلف أثناء النقل", json.getString("reason"))
        assertTrue(json.getBoolean("directExecution"))

        val refund = json.getJSONObject("refund")
        assertEquals("20.00", refund.getString("amount"))
        assertEquals("CARD", refund.getString("method"))
        assertEquals("TXN-CARD-5544", refund.getString("reference"))
        assertFalse(refund.has("shiftId"))
    }

    @Test
    fun `SalesWire returnInput omits reference for cash refunds`() {
        val submission = ReturnSubmission(
            invoiceId = 100L,
            quantities = mapOf(10L to 1),
            refundAmount = "10.00",
            refundMethod = PaymentMethod.CASH,
            refundShiftId = 7L,
            restock = true,
            clientRequestId = "req-return-cash-01",
            reason = "إرجاع نقد فوري",
            refundReference = null,
        )

        val json = SalesWire.returnInput(submission)
        val refund = json.getJSONObject("refund")
        assertEquals("CASH", refund.getString("method"))
        assertEquals(7L, refund.getLong("shiftId"))
        assertFalse(refund.has("reference"))
    }
}

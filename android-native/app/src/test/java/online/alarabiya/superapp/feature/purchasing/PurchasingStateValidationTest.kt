package online.alarabiya.superapp.feature.purchasing

import online.alarabiya.superapp.model.purchasing.PaymentMethod
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraft
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraftLine
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseReceiveDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnLineDraft
import online.alarabiya.superapp.model.purchasing.PurchaseStatus
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import online.alarabiya.superapp.model.purchasing.PurchasingValidation
import online.alarabiya.superapp.model.purchasing.ReceiveLineDraft
import online.alarabiya.superapp.model.purchasing.ReturnSettlement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PurchasingStateValidationTest {
    @Test
    fun `money is validated without floating point conversion`() {
        assertTrue(PurchasingValidation.money("999999999999999999.1234"))
        assertFalse(PurchasingValidation.money("1e4"))
        assertFalse(PurchasingValidation.money("-1"))
        assertFalse(PurchasingValidation.money("0", positive = true))
        assertTrue(PurchasingValidation.money("0.0001", positive = true))
    }

    @Test
    fun `purchase draft enforces own branch and idempotency`() {
        val valid = PurchaseOrderDraft(
            supplierId = 1, branchId = 2,
            items = listOf(PurchaseOrderDraftLine(3, 4, "2", "10.50")),
        )
        assertNull(PurchasingValidation.order(valid, 2))
        assertNotNull(PurchasingValidation.order(valid.copy(branchId = 9), 2))
        assertNotNull(PurchasingValidation.order(valid.copy(clientRequestId = ""), 2))
    }

    @Test
    fun `receive forbids duplicate lines and quantity beyond server remainder`() {
        val detail = PurchaseOrderDetail(
            PurchaseOrderSummary(1, "PO", null, 1, null, 1, null, null, null, null, online.alarabiya.superapp.model.purchasing.Currency.IQD, null, null, null, null, PurchaseStatus.CONFIRMED),
            null, null, null, null,
            listOf(online.alarabiya.superapp.model.purchasing.PurchaseOrderLine(7, 3, 4, "Item", null, null, null, "5", 5, 2, null, null, null, null)),
        )
        val tooMuch = PurchaseReceiveDraft(1, listOf(ReceiveLineDraft(7, "4")))
        val duplicate = PurchaseReceiveDraft(1, listOf(ReceiveLineDraft(7, "1"), ReceiveLineDraft(7, "1")))
        assertNotNull(PurchasingValidation.receive(tooMuch, detail))
        assertNotNull(PurchasingValidation.receive(duplicate, detail))
    }

    @Test
    fun `cash return requires linked order and cash method`() {
        val base = PurchaseReturnDraft(
            supplierId = 1, branchId = 2,
            items = listOf(PurchaseReturnLineDraft(3, 4, "1", "10")),
            settlement = ReturnSettlement.CASH,
        )
        assertNotNull(PurchasingValidation.purchaseReturn(base, 2))
        assertNotNull(PurchasingValidation.purchaseReturn(base.copy(purchaseOrderRefId = 8, paymentMethod = PaymentMethod.CARD), 2))
        assertNull(PurchasingValidation.purchaseReturn(base.copy(purchaseOrderRefId = 8, paymentMethod = PaymentMethod.CASH), 2))
    }

    @Test
    fun `state serializes operations and resets selection across sections`() {
        val state = PurchasingUiState(PurchasingSection.ORDERS)
        val busy = requireNotNull(state.start("load"))
        assertNull(busy.start("duplicate"))
        assertEquals(PurchasingSection.SUPPLIERS, busy.succeed().switchTo(PurchasingSection.SUPPLIERS).section)
    }
}

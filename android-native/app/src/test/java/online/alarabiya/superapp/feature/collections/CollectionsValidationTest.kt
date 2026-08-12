package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.model.collections.CancelCreditDecisionCommand
import online.alarabiya.superapp.model.collections.CollectionsValidation
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.collections.CreateCreditDecisionDraft
import online.alarabiya.superapp.model.collections.CreditDecision
import online.alarabiya.superapp.model.collections.CreditDecisionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CollectionsValidationTest {
    @Test
    fun `cancellation requires a real decision and an auditable reason`() {
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(0, "سبب كافٍ")))
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "لا")))
        assertNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "أُلغي بعد مراجعة المدير")))
    }

    @Test
    fun `cancellation reason is capped to server contract`() {
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "س".repeat(256))))
    }

    @Test
    fun `successful cancellation becomes locally monotonic before refresh`() {
        val active = CreditDecision(9, 3, "عميل", null, "100", 1, "مدير", null, null, null, null, null, CreditDecisionStatus.ACTIVE)
        val loaded = CollectionsUiState(rows = listOf(active), selectedId = 9, initialized = true, catalogFresh = true)
        val committed = loaded.cancellationCommitted(9)

        assertEquals(CreditDecisionStatus.CANCELLED, committed.rows.single().status)
        assertFalse(committed.catalogFresh)
        assertNull(committed.selectedId)
        val failedRefresh = committed.refreshFailedAfterMutation("شبكة")
        assertEquals("تمت العملية وتعذر تحديث العرض", failedRefresh.notice)
        assertEquals(CreditDecisionStatus.CANCELLED, failedRefresh.rows.single().status)
    }

    @Test
    fun `creation contract requires session branch typed customer money ttl and stable uuid`() {
        val capabilities = CollectionsCapabilities(1, "manager", 3, false, "FULL")
        val valid = CreateCreditDecisionDraft(
            branchId = 3,
            customerId = 9,
            customerName = "عميل",
            maxAmount = "125000.50",
            ttlMinutes = "90",
            notes = "مراجعة مدير الفرع",
            clientRequestId = "e8ca3a66-b8df-4f76-944d-1472693b1092",
        )
        assertNull(CollectionsValidation.create(valid, capabilities))
        assertEquals("125000.50", CollectionsValidation.command(valid, capabilities)?.maxAmount)
        assertNotNull(CollectionsValidation.create(valid.copy(branchId = 4), capabilities))
        assertNotNull(CollectionsValidation.create(valid.copy(maxAmount = "0"), capabilities))
        assertNotNull(CollectionsValidation.create(valid.copy(maxAmount = "10.999"), capabilities))
        assertNotNull(CollectionsValidation.create(valid.copy(ttlMinutes = "1441"), capabilities))
        assertNotNull(CollectionsValidation.create(valid.copy(clientRequestId = "new"), capabilities))
    }

    @Test
    fun `credit decisions require full collections grant even for a manager`() {
        assertFalse(CollectionsCapabilities(1, "manager", 3, false, "READ").canReadCreditDecisions)
        assertFalse(CollectionsCapabilities(1, "manager", 3, false, "NONE").canCreateCreditDecision)
    }

    @Test
    fun `successful creation commits locally before refresh and rotates the request`() {
        val created = CreditDecision(
            id = 44,
            customerId = 9,
            customerName = "عميل",
            customerPhone = null,
            maxAmount = "1000.00",
            approvedBy = 1,
            approvedByName = "مدير",
            approvedAt = null,
            expiresAt = null,
            consumedAt = null,
            consumedByInvoiceId = null,
            notes = null,
            status = CreditDecisionStatus.ACTIVE,
            branchId = 3,
            branchName = "الكرادة",
        )
        val oldRequest = "e8ca3a66-b8df-4f76-944d-1472693b1092"
        val nextRequest = "6b2ce5a9-b173-4daa-8730-49ce8be2f6d3"
        val state = CollectionsUiState(
            initialized = true,
            catalogFresh = true,
            createOpen = true,
            createDraft = CreateCreditDecisionDraft(branchId = 3, clientRequestId = oldRequest),
        )
        val committed = state.creationCommitted(created, CreateCreditDecisionDraft(branchId = 3, clientRequestId = nextRequest))

        assertEquals(44L, committed.rows.single().id)
        assertFalse(committed.catalogFresh)
        assertFalse(committed.createOpen)
        assertEquals(nextRequest, committed.createDraft.clientRequestId)
        assertEquals("صدر قرار الائتمان #44", committed.notice)
    }
}

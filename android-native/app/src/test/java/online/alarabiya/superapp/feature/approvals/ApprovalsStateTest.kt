package online.alarabiya.superapp.feature.approvals

import online.alarabiya.superapp.model.approvals.ApprovalCapabilities
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.approvals.RejectionReasonPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ApprovalsStateTest {
    @Test
    fun `loaded retains valid selection and removes stale selection`() {
        val selected = request(1, ApprovalKind.INVENTORY)
        val original = ApprovalsUiState(selectedKey = selected.key)

        assertEquals(selected.key, original.loaded(listOf(selected)).selectedKey)
        assertNull(original.loaded(listOf(request(2, ApprovalKind.LEAVE))).selectedKey)
    }

    @Test
    fun `filter returns only requested domain`() {
        val state = ApprovalsUiState(
            loading = false,
            requests = listOf(request(1, ApprovalKind.INVENTORY), request(2, ApprovalKind.VOUCHER)),
            filter = ApprovalFilter.VOUCHER,
        )

        assertEquals(listOf(ApprovalKind.VOUCHER), state.visibleRequests.map { it.kind })
    }

    @Test
    fun `second decision cannot start while one is in flight`() {
        val first = PendingApprovalDecision(request(1, ApprovalKind.INVENTORY).key, ApprovalDecision.Approve)
        val inFlight = ApprovalsUiState(loading = false).decisionStarted(first)
        val second = PendingApprovalDecision(request(2, ApprovalKind.LEAVE).key, ApprovalDecision.Approve)

        assertSame(inFlight, inFlight.decisionStarted(second))
        assertEquals(first.requestKey, inFlight.submittingKey)
    }

    @Test
    fun `completed decision removes request and clears selection`() {
        val item = request(9, ApprovalKind.LEAVE)
        val state = ApprovalsUiState(
            loading = false,
            requests = listOf(item),
            selectedKey = item.key,
            submittingKey = item.key,
        ).decisionCompleted(item.key, approved = false)

        assertFalse(state.requests.any { it.id == item.id })
        assertNull(state.selectedKey)
        assertNull(state.submittingKey)
        assertEquals("تم رفض الطلب", state.notice)
    }

    @Test
    fun `same numeric id in another domain remains after decision`() {
        val inventory = request(7, ApprovalKind.INVENTORY)
        val leave = request(7, ApprovalKind.LEAVE)
        val state = ApprovalsUiState(
            requests = listOf(inventory, leave),
            selectedKey = inventory.key,
            submittingKey = inventory.key,
        ).decisionCompleted(inventory.key, approved = true)

        assertEquals(listOf(leave), state.requests)
    }

    private fun request(id: Long, kind: ApprovalKind) = ApprovalRequest(
        id = id,
        kind = kind,
        title = "طلب $id",
        reference = "REF-$id",
        detail = "تفاصيل",
        createdAt = "2026-08-06T10:00:00Z",
        capabilities = ApprovalCapabilities(
            canApprove = true,
            canReject = true,
            rejectionReasonPolicy = RejectionReasonPolicy.NOT_SUPPORTED,
        ),
    )
}

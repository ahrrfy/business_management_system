package online.alarabiya.superapp.feature.approvals

import online.alarabiya.superapp.data.ApprovalInboxPayload
import online.alarabiya.superapp.data.ApprovalMapper
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.approvals.RejectionReasonPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalMapperTest {
    @Test
    fun `maps inventory quantities and requires rejection reason`() {
        val request = ApprovalMapper.fromPayload(
            payload(kind = "inventory", currentQuantity = 8.0, targetQuantity = 11.0),
        )!!

        assertEquals(ApprovalKind.INVENTORY, request.kind)
        assertEquals(8.0, request.currentQuantity!!, 0.0)
        assertEquals(11.0, request.targetQuantity!!, 0.0)
        assertEquals(RejectionReasonPolicy.REQUIRED, request.capabilities.rejectionReasonPolicy)
        assertTrue(request.capabilities.canReject)
        assertFalse(request.capabilities.hasServerIdempotencyKey)
    }

    @Test
    fun `maps voucher amount and requires rejection reason`() {
        val request = ApprovalMapper.fromPayload(payload(kind = "voucher", amount = "54300.00"))!!

        assertEquals(ApprovalKind.VOUCHER, request.kind)
        assertEquals("54300.00", request.amount)
        assertEquals(RejectionReasonPolicy.REQUIRED, request.capabilities.rejectionReasonPolicy)
    }

    @Test
    fun `leave rejection is allowed without unsupported reason field`() {
        val request = ApprovalMapper.fromPayload(payload(kind = "leave"))!!

        assertEquals(ApprovalKind.LEAVE, request.kind)
        assertTrue(request.capabilities.canReject)
        assertEquals(RejectionReasonPolicy.NOT_SUPPORTED, request.capabilities.rejectionReasonPolicy)
    }

    @Test
    fun `gift rejection is hidden by server capability`() {
        val request = ApprovalMapper.fromPayload(payload(kind = "gift", canReject = false))!!

        assertEquals(ApprovalKind.GIFT, request.kind)
        assertFalse(request.capabilities.canReject)
    }

    @Test
    fun `unknown approval kind is not invented`() {
        assertNull(ApprovalMapper.fromPayload(payload(kind = "unknown")))
    }

    private fun payload(
        kind: String,
        amount: String? = null,
        currentQuantity: Double? = null,
        targetQuantity: Double? = null,
        canReject: Boolean = true,
    ) = ApprovalInboxPayload(
        kind = kind,
        id = 42,
        title = "طلب",
        reference = "REQ-42",
        detail = "تفاصيل",
        createdAt = "2026-08-06T10:00:00.000Z",
        amount = amount,
        currentQuantity = currentQuantity,
        targetQuantity = targetQuantity,
        canReject = canReject,
    )
}

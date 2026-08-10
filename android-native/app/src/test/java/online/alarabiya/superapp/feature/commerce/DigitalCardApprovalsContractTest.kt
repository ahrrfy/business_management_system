package online.alarabiya.superapp.feature.commerce

import online.alarabiya.superapp.data.DigitalCardApprovalContract
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.commerce.DigitalCardApproval
import online.alarabiya.superapp.model.commerce.DigitalCardApprovalKind
import online.alarabiya.superapp.model.commerce.NativeCommerceBlockers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DigitalCardApprovalsContractTest {
    @Test
    fun `mutation routing matches authoritative server procedures`() {
        assertEquals(
            "digitalCards.sales.approveReviewResolution",
            DigitalCardApprovalContract.approveProcedure(DigitalCardApprovalKind.REVIEW_RESOLUTION),
        )
        assertEquals(
            "digitalCards.sales.rejectReviewResolution",
            DigitalCardApprovalContract.rejectProcedure(DigitalCardApprovalKind.REVIEW_RESOLUTION),
        )
        assertEquals(
            "digitalCards.sales.approveWriteoff",
            DigitalCardApprovalContract.approveProcedure(DigitalCardApprovalKind.WRITEOFF),
        )
        assertEquals(
            "digitalCards.pricing.approveMismatch",
            DigitalCardApprovalContract.approveProcedure(DigitalCardApprovalKind.PRICE_MISMATCH),
        )
    }

    @Test
    fun `only owner or admin with full module sees approval station`() {
        assertTrue(capabilities("admin", full = true).canReviewDigitalCardApprovals)
        assertTrue(capabilities("user", full = true, owner = true).canReviewDigitalCardApprovals)
        assertFalse(capabilities("manager", full = true).canReviewDigitalCardApprovals)
        assertFalse(capabilities("admin", full = false).canReviewDigitalCardApprovals)
    }

    @Test
    fun `server separation of duties blocks self approval except owner override`() {
        val requestedByActor = approval(requesterId = 41)
        val requestedByOther = approval(requesterId = 99)

        assertFalse(requestedByActor.canDecide(capabilities("admin", full = true, actorId = 41)))
        assertTrue(requestedByOther.canDecide(capabilities("admin", full = true, actorId = 41)))
        assertTrue(requestedByActor.canDecide(capabilities("user", full = true, owner = true, actorId = 41)))
    }

    @Test
    fun `undiscoverable workflows stay explicit instead of fake client scans`() {
        assertTrue(NativeCommerceBlockers.DIGITAL_CARD_APPROVAL_DISCOVERY.contains("no global pending endpoint"))
        assertTrue(NativeCommerceBlockers.WALLET_VARIANCE_APPROVAL.contains("adjustmentTransactionId"))
    }

    private fun capabilities(
        role: String,
        full: Boolean,
        owner: Boolean = false,
        actorId: Long = 41,
    ): CommerceCapabilities = CommerceCapabilities.fromBootstrap(
        AppBootstrap(
            user = UserIdentity(
                id = actorId,
                name = "مختبر",
                username = "tester",
                email = null,
                role = role,
                isOwner = owner,
            ),
            modules = listOf(ModuleAccess("digital_cards", "البطاقات الرقمية", if (full) "FULL" else "READ")),
            branchId = null,
            allBranches = true,
            isOwner = owner,
        ),
    )

    private fun approval(requesterId: Long) = DigitalCardApproval(
        id = 7,
        kind = DigitalCardApprovalKind.WRITEOFF,
        branchId = 1,
        branchName = "الرئيسي",
        title = "شطب",
        description = null,
        amount = "100.00",
        requesterId = requesterId,
        requesterName = null,
        createdAt = null,
    )
}

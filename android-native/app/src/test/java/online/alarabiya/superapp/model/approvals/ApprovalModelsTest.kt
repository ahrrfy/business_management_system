package online.alarabiya.superapp.model.approvals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * تغطية طلبات إلغاء البيع ببطاقة: اكتشاف الحاجة لمرجع جهازٍ من الحقائق (لا حقلٍ خامّ يصل
 * الجوّال)، واشتقاق [CardReferenceInput] الثلاثيّ من حالة حقل إدخالٍ بسيط — نظير حقل الويب
 * (`client/src/pages/SalesControlApprovals.tsx`، تعميم PR #997).
 */
class ApprovalModelsTest {
    @Test
    fun `untouched field stays untouched regardless of stale text`() {
        assertEquals(CardReferenceInput.Untouched, resolveCardReferenceInput(touched = false, text = ""))
        assertEquals(CardReferenceInput.Untouched, resolveCardReferenceInput(touched = false, text = "ignored"))
    }

    @Test
    fun `touched and blank is a deliberate clear`() {
        assertEquals(CardReferenceInput.Cleared, resolveCardReferenceInput(touched = true, text = ""))
        assertEquals(CardReferenceInput.Cleared, resolveCardReferenceInput(touched = true, text = "   "))
    }

    @Test
    fun `touched with text is a trimmed override value`() {
        val result = resolveCardReferenceInput(touched = true, text = "  APR-9911  ")
        assertEquals(CardReferenceInput.Value("APR-9911"), result)
    }

    @Test
    fun `card cancel needs a reference only for SALES_CONTROL with a CARD refund destination fact`() {
        val cardCancel = request(
            kind = ApprovalKind.SALES_CONTROL,
            facts = listOf(ApprovalFact("جهة الاسترداد", "CARD")),
        )
        val cashCancel = request(
            kind = ApprovalKind.SALES_CONTROL,
            facts = listOf(ApprovalFact("جهة الاسترداد", "CASH")),
        )
        val undetailed = request(kind = ApprovalKind.SALES_CONTROL, facts = emptyList())
        val otherKind = request(
            kind = ApprovalKind.INVENTORY,
            facts = listOf(ApprovalFact("جهة الاسترداد", "CARD")),
        )

        assertTrue(cardCancel.needsCardCancelReference)
        assertFalse(cashCancel.needsCardCancelReference)
        // قبل اكتمال `approvalDetail` (الاختيار) تصل الحقائق فارغة — يجب ألّا يُطلَب مرجعٌ زوراً.
        assertFalse(undetailed.needsCardCancelReference)
        assertFalse(otherKind.needsCardCancelReference)
    }

    @Test
    fun `card cancel reference fact is looked up by its shared label`() {
        val withReference = request(
            kind = ApprovalKind.SALES_CONTROL,
            facts = listOf(
                ApprovalFact("جهة الاسترداد", "CARD"),
                ApprovalFact("مرجع جهاز الدفع", "APR-1234"),
            ),
        )
        val withoutReference = request(
            kind = ApprovalKind.SALES_CONTROL,
            facts = listOf(ApprovalFact("جهة الاسترداد", "CASH")),
        )

        assertEquals("APR-1234", withReference.cardCancelReferenceFact?.value)
        assertNull(withoutReference.cardCancelReferenceFact)
    }

    private fun request(kind: ApprovalKind, facts: List<ApprovalFact>) = ApprovalRequest(
        id = 1,
        kind = kind,
        title = "طلب",
        reference = "REF-1",
        detail = "تفاصيل",
        createdAt = "2026-09-04T10:00:00Z",
        facts = facts,
        capabilities = ApprovalCapabilities(
            canApprove = true,
            canReject = true,
            rejectionReasonPolicy = RejectionReasonPolicy.REQUIRED,
        ),
    )
}

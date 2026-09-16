package online.alarabiya.superapp.data

import online.alarabiya.superapp.model.approvals.CardReferenceInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * شكلُ حمولة `salesControl.approve` — مرجع استرداد البطاقة قرارُ لحظة الاعتماد (تعميم PR #997).
 * الفرقُ بين إغفال المفتاح و`null` صريحة جوهريٌّ خادمياً (`applyCancelCashRouting`،
 * `server/services/sale/controlRequests.ts`)، فالتغطية هنا على شكل الحمولة الخام لا على حالة
 * [CardReferenceInput] وحدها — كسرُ الترجمة بينهما يمرّ بصمتٍ في اختبار [CardReferenceInput] وحده.
 */
class ApprovalsRepositoryInputTest {
    @Test
    fun `untouched reference omits the key entirely so the original payload stands`() {
        val input = buildSalesControlApproveInput(42L, CardReferenceInput.Untouched)

        val cashRouting = input.getJSONObject("cashRouting")
        assertEquals(42L, input.getLong("requestId"))
        assertTrue(cashRouting.getBoolean("clearShift"))
        assertFalse("مفتاح reference لا يظهر أصلاً حين لا يُلمَس", cashRouting.has("reference"))
    }

    @Test
    fun `cleared reference sends an explicit JSON null, not a missing key`() {
        val input = buildSalesControlApproveInput(42L, CardReferenceInput.Cleared)

        val cashRouting = input.getJSONObject("cashRouting")
        assertTrue(cashRouting.has("reference"))
        assertTrue(cashRouting.isNull("reference"))
    }

    @Test
    fun `value reference sends the exact string`() {
        val input = buildSalesControlApproveInput(42L, CardReferenceInput.Value("APR-778899"))

        val cashRouting = input.getJSONObject("cashRouting")
        assertEquals("APR-778899", cashRouting.getString("reference"))
    }

    @Test
    fun `explicit null and a missing key are distinguishable in the serialized wire form`() {
        val untouched = buildSalesControlApproveInput(1L, CardReferenceInput.Untouched)
        val cleared = buildSalesControlApproveInput(1L, CardReferenceInput.Cleared)

        assertFalse(untouched.toString().contains("reference"))
        assertTrue(cleared.toString().contains("\"reference\":null"))
    }
}

package online.alarabiya.superapp.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TwoFactorRepositoryContractTest {
    @Test
    fun `status maps server contract and clamps invalid recovery count`() {
        val active = TwoFactorJson.status(
            JSONObject()
                .put("enabled", true)
                .put("pending", false)
                .put("recoveryCodesRemaining", 7)
                .put("cryptoReady", true),
        )
        val invalid = TwoFactorJson.status(JSONObject().put("recoveryCodesRemaining", -4))

        assertTrue(active.enabled)
        assertFalse(active.pending)
        assertTrue(active.cryptoReady)
        assertEquals(7, active.recoveryCodesRemaining)
        assertEquals(0, invalid.recoveryCodesRemaining)
    }

    @Test
    fun `enrollment maps only required one-time values`() {
        val enrollment = TwoFactorJson.enrollment(
            JSONObject()
                .put("secretB32", "ABCD2345")
                .put("otpauthUri", "otpauth://totp/test?secret=ABCD2345"),
        )

        assertEquals("ABCD2345", enrollment.secretBase32)
        assertTrue(enrollment.otpauthUri.startsWith("otpauth://"))
    }

    @Test
    fun `recovery mapper ignores empty values and preserves server order`() {
        val codes = TwoFactorJson.recoveryCodes(
            JSONObject().put("recoveryCodes", JSONArray(listOf("CODE-1", " ", "CODE-2"))),
        )

        assertEquals(listOf("CODE-1", "CODE-2"), codes)
        assertTrue(TwoFactorJson.recoveryCodes(JSONObject()).isEmpty())
    }
}

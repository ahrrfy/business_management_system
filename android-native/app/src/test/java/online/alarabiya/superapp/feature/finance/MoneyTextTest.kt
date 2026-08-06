package online.alarabiya.superapp.feature.finance

import online.alarabiya.superapp.model.finance.MoneyText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MoneyTextTest {
    @Test
    fun `canonicalizes user money without floating point`() {
        assertEquals("1.00", MoneyText.parseUnsigned("1")?.value)
        assertEquals("12345678901234567890.10", MoneyText.parseUnsigned("12345678901234567890.1")?.value)
        assertEquals("0.05", MoneyText.parseUnsigned(" 0.05 ")?.value)
    }

    @Test
    fun `rejects signed malformed and over-precision user values`() {
        assertNull(MoneyText.parseUnsigned("-1"))
        assertNull(MoneyText.parseUnsigned("1.001"))
        assertNull(MoneyText.parseUnsigned("1,000"))
        assertNull(MoneyText.parseUnsigned("NaN"))
    }

    @Test
    fun `server values remain decimal strings and may be signed`() {
        assertEquals("-19.35", MoneyText.fromServer("-19.35").value)
        assertEquals("0.00", MoneyText.fromServer(null).value)
    }
}

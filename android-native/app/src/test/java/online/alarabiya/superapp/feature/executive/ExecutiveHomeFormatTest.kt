package online.alarabiya.superapp.feature.executive

import java.time.ZoneId
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExecutiveHomeFormatTest {
    @Test fun `utc timestamp is converted to Baghdad time and isolated for RTL`() {
        val formatted = requireNotNull(
            formatExecutiveTimestamp("2026-08-09T18:45:00Z", ZoneId.of("Asia/Baghdad")),
        )
        assertTrue(formatted.contains("21:45"))
        assertNotEquals("2026-08-09T18:45", formatted)
    }

    @Test fun `invalid timestamp is omitted rather than shown as raw server text`() {
        assertNull(formatExecutiveTimestamp("not-a-date"))
    }
}

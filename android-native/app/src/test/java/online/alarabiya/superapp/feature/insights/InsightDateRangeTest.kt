package online.alarabiya.superapp.feature.insights

import java.time.LocalDate
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightsFilter
import online.alarabiya.superapp.model.insights.PeriodPreset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class InsightDateRangeTest {
    @Test
    fun `preset range is inclusive and deterministic`() {
        val range = InsightDateRange.forPreset(PeriodPreset.LAST_7, LocalDate.parse("2026-08-06"))

        assertEquals("2026-07-31", range.from)
        assertEquals("2026-08-06", range.to)
        assertNull(range.validationError())
    }

    @Test
    fun `rejects reversed and malformed ranges`() {
        assertNotNull(InsightDateRange("2026-08-07", "2026-08-06").validationError())
        assertNotNull(InsightDateRange("06/08/2026", "2026-08-07").validationError())
    }

    @Test
    fun `store range enforces actual ninety-two day endpoint cap`() {
        val filter = InsightsFilter(
            preset = PeriodPreset.CUSTOM,
            range = InsightDateRange("2026-01-01", "2026-04-03"),
        )

        assertNotNull(filter.validationError(forStore = true))
        assertNull(filter.copy(range = InsightDateRange("2026-01-01", "2026-04-02")).validationError(forStore = true))
    }
}

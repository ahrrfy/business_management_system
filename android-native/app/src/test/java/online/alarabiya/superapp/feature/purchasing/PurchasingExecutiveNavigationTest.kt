package online.alarabiya.superapp.feature.purchasing

import online.alarabiya.superapp.model.purchasing.PurchasingSection
import org.junit.Assert.assertEquals
import org.junit.Test

class PurchasingExecutiveNavigationTest {
    @Test
    fun `payables action selects the operational supplier reminders state`() {
        val next = PurchasingUiState(PurchasingSection.ORDERS).applyExecutiveNavigation(
            arguments = mapOf("view" to "payables"),
            visibleSections = PurchasingSection.entries,
        )

        assertEquals(PurchasingSection.REMINDERS, next.section)
        assertEquals(PurchasingExecutiveView.PAYABLES, next.executiveView)
    }
}

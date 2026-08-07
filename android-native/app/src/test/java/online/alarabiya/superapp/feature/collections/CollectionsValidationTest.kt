package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.model.collections.CancelCreditDecisionCommand
import online.alarabiya.superapp.model.collections.CollectionsValidation
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CollectionsValidationTest {
    @Test
    fun `cancellation requires a real decision and an auditable reason`() {
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(0, "سبب كافٍ")))
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "لا")))
        assertNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "أُلغي بعد مراجعة المدير")))
    }

    @Test
    fun `cancellation reason is capped to server contract`() {
        assertNotNull(CollectionsValidation.cancel(CancelCreditDecisionCommand(9, "س".repeat(256))))
    }
}

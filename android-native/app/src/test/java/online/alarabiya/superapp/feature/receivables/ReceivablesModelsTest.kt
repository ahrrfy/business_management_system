package online.alarabiya.superapp.feature.receivables

import java.time.LocalDate
import online.alarabiya.superapp.model.receivables.CardFilters
import online.alarabiya.superapp.model.receivables.InstallmentFilters
import online.alarabiya.superapp.model.receivables.NewInstallmentLine
import online.alarabiya.superapp.model.receivables.NewInstallmentPlan
import online.alarabiya.superapp.model.receivables.ReceivablesMoney
import online.alarabiya.superapp.model.receivables.ReminderActionDraft
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem
import online.alarabiya.superapp.model.receivables.ReminderSubject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ReceivablesModelsTest {
    @Test
    fun `server money keeps decimal precision without floating point`() {
        assertEquals("123456789012345.10", ReceivablesMoney.fromServer("123456789012345.1").value)
        assertEquals("0.00", ReceivablesMoney.fromServer("not-money").value)
    }

    @Test
    fun `money input accepts signed reconciliation and rejects excess scale`() {
        assertEquals("-120.50", ReceivablesMoney.validatedInput("-120.5")?.value)
        assertNull(ReceivablesMoney.validatedInput("10.001"))
    }

    @Test
    fun `new plan validates structure but does not calculate financial sum locally`() {
        val draft = NewInstallmentPlan(
            customerId = "8",
            branchId = "2",
            totalAmount = "1000",
            downPayment = "0",
            lines = listOf(NewInstallmentLine("2026-09-01", "1")),
        )

        assertNull(draft.validationError())
    }

    @Test
    fun `new plan rejects descending dates`() {
        val draft = NewInstallmentPlan(
            customerId = "8",
            branchId = "2",
            totalAmount = "100",
            lines = listOf(
                NewInstallmentLine("2026-10-01", "50"),
                NewInstallmentLine("2026-09-01", "50"),
            ),
        )

        assertNotNull(draft.validationError())
    }

    @Test
    fun `installment and card filters reject invalid ranges`() {
        assertNotNull(InstallmentFilters(from = "2026-08-10", to = "2026-08-01").validationError())
        assertNotNull(CardFilters(branchId = "abc").validationError())
    }

    @Test
    fun `reminder confirmation rejects a promise in the past`() {
        val item = ReminderQueueItem(
            subject = ReminderSubject(ReminderLedger.RECEIVABLE, 7, "عميل", null),
            totalUnpaid = ReceivablesMoney.fromServer("50"),
            oldestDocumentDate = "2026-07-01",
            daysOverdue = 30,
            lastReminderAt = null,
            lastReminderStatus = null,
            promisedDate = null,
            isPromiseDue = false,
            isOpeningBalance = false,
        )
        val draft = ReminderActionDraft(
            item = item,
            kind = ReminderActionDraft.Kind.SKIP,
            reason = "وعد بالسداد",
            promisedDate = "2026-08-05",
        )

        assertNotNull(draft.validationError(LocalDate.parse("2026-08-06")))
    }
}

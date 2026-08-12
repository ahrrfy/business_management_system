package online.alarabiya.superapp.feature.receivables

import online.alarabiya.superapp.model.receivables.ReceivablesMoney
import online.alarabiya.superapp.model.receivables.ReceivablesSection
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem
import online.alarabiya.superapp.model.receivables.ReminderSubject
import org.junit.Assert.assertEquals
import org.junit.Test

class ReceivablesExecutiveNavigationTest {
    @Test
    fun `aging action opens customer receivables and applies its non-overlapping bucket`() {
        val next = ReceivablesUiState(
            section = ReceivablesSection.INSTALLMENTS,
            reminderQueue = listOf(reminder(1, 30), reminder(2, 31), reminder(3, 60), reminder(4, 61)),
        ).applyExecutiveNavigation(mapOf("bucket" to "ar-30"), canReadCustomerReminders = true)

        assertEquals(ReceivablesSection.CUSTOMER_REMINDERS, next.section)
        assertEquals(ExecutiveReceivablesView.AR_30, next.executiveView)
        assertEquals(listOf(2L, 3L), next.visibleReminderQueue.map { it.subject.id })
    }

    @Test
    fun `credit exposure action sorts operational customer rows by exposure`() {
        val next = ReceivablesUiState(
            section = ReceivablesSection.INSTALLMENTS,
            reminderQueue = listOf(reminder(1, 10, "50"), reminder(2, 10, "400")),
        ).applyExecutiveNavigation(mapOf("view" to "creditExposure"), canReadCustomerReminders = true)

        assertEquals(ExecutiveReceivablesView.CREDIT_EXPOSURE, next.executiveView)
        assertEquals(listOf(2L, 1L), next.visibleReminderQueue.map { it.subject.id })
    }

    private fun reminder(id: Long, days: Int, amount: String = "100") = ReminderQueueItem(
        subject = ReminderSubject(ReminderLedger.RECEIVABLE, id, "customer-$id", null),
        totalUnpaid = ReceivablesMoney.fromServer(amount),
        oldestDocumentDate = "2026-01-01",
        daysOverdue = days,
        lastReminderAt = null,
        lastReminderStatus = null,
        promisedDate = null,
        isPromiseDue = false,
        isOpeningBalance = false,
    )
}

package online.alarabiya.superapp.feature.receivables

import online.alarabiya.superapp.model.receivables.ReceivablesSection
import online.alarabiya.superapp.model.receivables.ReceivablesMoney
import online.alarabiya.superapp.model.receivables.ReminderActionDraft
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem
import online.alarabiya.superapp.model.receivables.ReminderSubject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceivablesStateTest {
    @Test
    fun `loading reducer distinguishes initial refresh and pagination`() {
        val state = ReceivablesUiState(
            ReceivablesSection.INSTALLMENTS,
            freshSections = setOf(ReceivablesSection.INSTALLMENTS),
        )

        assertTrue(state.startLoading(refresh = false).loading)
        assertTrue(state.startLoading(refresh = true).refreshing)
        assertTrue(state.startLoading(refresh = false, append = true).loadingMore)
        assertFalse(state.startLoading(refresh = true).isFresh())
    }

    @Test
    fun `finish loading marks only completed section`() {
        val state = ReceivablesUiState(ReceivablesSection.CARD_ACCOUNT, loading = true)
            .finishLoading(ReceivablesSection.CARD_ACCOUNT)

        assertEquals(setOf(ReceivablesSection.CARD_ACCOUNT), state.loadedSections)
        assertEquals(setOf(ReceivablesSection.CARD_ACCOUNT), state.freshSections)
        assertTrue(state.canInteract(ReceivablesSection.CARD_ACCOUNT))
        assertFalse(state.loading)
    }

    @Test
    fun `failed action clears every busy flag`() {
        val state = ReceivablesUiState(
            section = ReceivablesSection.INSTALLMENTS,
            loading = true,
            refreshing = true,
            loadingMore = true,
            submitting = true,
            detailLoading = true,
        ).failed("تعذر")

        assertFalse(state.loading)
        assertFalse(state.refreshing)
        assertFalse(state.loadingMore)
        assertFalse(state.submitting)
        assertFalse(state.detailLoading)
        assertEquals("تعذر", state.error)
        assertFalse(state.isFresh(ReceivablesSection.INSTALLMENTS))
    }

    @Test
    fun `committed reminder remains removed when reconciliation refresh fails`() {
        val item = reminder(7)
        val section = ReceivablesSection.CUSTOMER_REMINDERS
        val initial = ReceivablesUiState(
            section = section,
            loadedSections = setOf(section),
            freshSections = setOf(section),
            reminderQueue = listOf(item),
            selectedReminderId = item.subject.id,
            pendingAction = ReceivablesPendingAction.Reminder(
                ReminderActionDraft(item, ReminderActionDraft.Kind.SEND_API),
            ),
        )

        val committed = initial.commit(section) { it.afterReminderCommit(item) }
        val refreshFailed = committed.failed("تعذر التحديث", section)

        assertTrue(refreshFailed.reminderQueue.isEmpty())
        assertEquals(null, refreshFailed.selectedReminderId)
        assertEquals(null, refreshFailed.pendingAction)
        assertTrue(section in refreshFailed.loadedSections)
        assertFalse(refreshFailed.canInteract(section))
    }

    private fun reminder(id: Long) = ReminderQueueItem(
        subject = ReminderSubject(ReminderLedger.RECEIVABLE, id, "عميل", null),
        totalUnpaid = ReceivablesMoney.fromServer("100"),
        oldestDocumentDate = "2026-08-01",
        daysOverdue = 10,
        lastReminderAt = null,
        lastReminderStatus = null,
        promisedDate = null,
        isPromiseDue = false,
        isOpeningBalance = false,
    )
}

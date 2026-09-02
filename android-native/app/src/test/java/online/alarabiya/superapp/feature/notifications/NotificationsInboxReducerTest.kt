package online.alarabiya.superapp.feature.notifications

import online.alarabiya.superapp.data.NotificationFilter
import online.alarabiya.superapp.model.selfservice.PersonalNotification
import online.alarabiya.superapp.model.selfservice.NotificationFamily
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationsInboxReducerTest {
    private val sampleRow = PersonalNotification(
        id = 7L,
        kind = "TASK_ASSIGNED",
        family = NotificationFamily.OPERATIONS,
        title = "مهمّة جديدة",
        body = "أُسندت لك مهمّة عاجلة",
        createdAt = "2026-08-24T10:00:00Z",
        readAt = null,
        requiresAction = true,
        entityType = "task",
        entityId = 7L,
        route = "/mobile#tasks/7",
    )

    @Test
    fun initialLoadClearsBannersAndMarksLoading() {
        val next = NotificationsInboxReducer.startInitialLoad(
            NotificationsInboxUiState(error = "قديم", message = "قديم"),
        )
        assertTrue(next.loading)
        assertNull(next.error)
        assertNull(next.message)
    }

    @Test
    fun refreshDoesNotClearRowsWhileWorking() {
        val prior = NotificationsInboxUiState(rows = listOf(sampleRow), unreadCount = 1)
        val next = NotificationsInboxReducer.startRefresh(prior)
        assertTrue(next.refreshing)
        assertEquals(prior.rows, next.rows)
        assertEquals(prior.unreadCount, next.unreadCount)
    }

    @Test
    fun loadedResetsBothLoadingFlagsAndPublishesCount() {
        val next = NotificationsInboxReducer.loaded(
            NotificationsInboxUiState(loading = true, refreshing = true),
            rows = listOf(sampleRow),
            unreadCount = 3,
        )
        assertEquals(listOf(sampleRow), next.rows)
        assertEquals(3, next.unreadCount)
        assertFalse(next.loading)
        assertFalse(next.refreshing)
    }

    @Test
    fun filterSwitchQueuesLoadWithoutTouchingRowsUntilServerRespondsAgain() {
        val prior = NotificationsInboxUiState(
            rows = listOf(sampleRow),
            unreadCount = 1,
            filter = NotificationFilter.All,
        )
        val next = NotificationsInboxReducer.applyFilter(prior, NotificationFilter.UnreadOnly)
        assertEquals(NotificationFilter.UnreadOnly, next.filter)
        assertTrue(next.loading)
        // Rows survive so the UI does not blink while the new list is being fetched.
        assertEquals(prior.rows, next.rows)
        assertEquals(prior.unreadCount, next.unreadCount)
    }

    @Test
    fun operationLifecycleTracksBusyKeyAndClearsOnCompletion() {
        val started = NotificationsInboxReducer.operationStarted(NotificationsInboxUiState(), "read:7")
        assertEquals("read:7", started.busyKey)
        val completed = NotificationsInboxReducer.operationCompleted(
            state = started,
            rows = listOf(sampleRow.copy(readAt = "2026-08-24T10:01:00Z")),
            unreadCount = 0,
            message = "تم",
        )
        assertNull(completed.busyKey)
        assertEquals("تم", completed.message)
        assertEquals(0, completed.unreadCount)
    }

    @Test
    fun failureClearsBusyAndSurfacesMessage() {
        val busy = NotificationsInboxReducer.operationStarted(NotificationsInboxUiState(), "readAll")
        val failed = NotificationsInboxReducer.operationFailed(busy, "شبكة")
        assertNull(failed.busyKey)
        assertEquals("شبكة", failed.error)
    }
}

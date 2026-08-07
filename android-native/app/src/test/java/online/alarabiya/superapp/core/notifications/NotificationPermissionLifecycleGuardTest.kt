package online.alarabiya.superapp.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPermissionLifecycleGuardTest {
    @Test
    fun systemPermissionDialogDoesNotLockSessionOrRelockOnReturn() {
        val guard = NotificationPermissionLifecycleGuard()

        guard.requestStarting()

        assertTrue(guard.onActivityStopping())
        guard.permissionResultReceived()
        assertFalse(guard.onActivityStopping())
        assertTrue(guard.consumeResumeBypass())
        assertFalse(guard.consumeResumeBypass())
    }

    @Test
    fun resumeBeforePermissionCallbackStillConsumesOnlyOneBypass() {
        val guard = NotificationPermissionLifecycleGuard()

        guard.requestStarting()

        assertTrue(guard.onActivityStopping())
        assertTrue(guard.consumeResumeBypass())
        assertFalse(guard.consumeResumeBypass())
        assertTrue(guard.onActivityStopping())
        guard.permissionResultReceived()
        assertFalse(guard.onActivityStopping())
    }

    @Test
    fun callbackWithoutActivityStopDoesNotBypassFutureResumeLock() {
        val guard = NotificationPermissionLifecycleGuard()

        guard.requestStarting()
        guard.permissionResultReceived()

        assertFalse(guard.onActivityStopping())
        assertFalse(guard.consumeResumeBypass())
    }

    @Test
    fun skippedRequestRestoresNormalSecurityLifecycle() {
        val guard = NotificationPermissionLifecycleGuard()

        guard.requestStarting()
        guard.requestDidNotStart()

        assertFalse(guard.onActivityStopping())
        assertFalse(guard.consumeResumeBypass())
    }
}

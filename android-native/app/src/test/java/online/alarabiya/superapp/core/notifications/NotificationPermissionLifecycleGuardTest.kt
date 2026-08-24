package online.alarabiya.superapp.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

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
    fun resumeConsumingBypassClearsInFlightSoNextStopLocks() {
        // Safety semantic: after the Activity resumes (dialog dismissed or user answered), any
        // subsequent onStop is a real user departure — the session MUST re-lock even if the
        // system never fired onRequestPermissionsResult. Prevents the H1 defect where a stalled
        // OEM callback left requestInFlight = true forever and every stop bypassed the lock.
        val guard = NotificationPermissionLifecycleGuard()

        guard.requestStarting()

        assertTrue(guard.onActivityStopping())
        assertTrue(guard.consumeResumeBypass())
        assertFalse(guard.consumeResumeBypass())
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

    @Test
    fun requestExpiresAfterMaxAgeSoStaleFlagCannotBypassLockForever() {
        // OEM quirk on Xiaomi/Vivo/Huawei: onRequestPermissionsResult may never fire. Without a
        // cap, requestInFlight stays true indefinitely and every activity-stop skips the lock.
        var clock = 0L
        val guard = NotificationPermissionLifecycleGuard(
            maxRequestAgeNanos = TimeUnit.SECONDS.toNanos(30),
            nowNanos = { clock },
        )

        guard.requestStarting()

        clock = TimeUnit.SECONDS.toNanos(29)
        assertTrue("within window still bypasses", guard.onActivityStopping())

        // Reset bypass state before crossing the boundary.
        assertTrue(guard.consumeResumeBypass())

        guard.requestStarting()
        clock += TimeUnit.SECONDS.toNanos(31)

        assertFalse("expired request must not bypass lock", guard.onActivityStopping())
        assertFalse("no pending bypass remains after expiry", guard.consumeResumeBypass())
    }

    @Test
    fun expiredRequestClearsPendingBypassOnNextStop() {
        var clock = 0L
        val guard = NotificationPermissionLifecycleGuard(
            maxRequestAgeNanos = TimeUnit.SECONDS.toNanos(30),
            nowNanos = { clock },
        )

        guard.requestStarting()
        assertTrue(guard.onActivityStopping())

        // Clock advances past the deadline; a stale resumeBypassPending must not linger.
        clock += TimeUnit.SECONDS.toNanos(60)
        assertFalse(guard.onActivityStopping())
        assertFalse(guard.consumeResumeBypass())
    }
}

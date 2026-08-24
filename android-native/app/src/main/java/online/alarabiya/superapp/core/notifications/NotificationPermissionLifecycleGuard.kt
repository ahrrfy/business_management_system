package online.alarabiya.superapp.core.notifications

import java.util.concurrent.TimeUnit

/**
 * Distinguishes the Android notification-permission surface from a real trip to the background.
 * Some OEMs stop the Activity while the system dialog is visible; treating that transition as a
 * user departure immediately locks the authenticated session and can strand the user at launch.
 *
 * A max age caps how long the guard trusts an in-flight request: on Xiaomi/Vivo/Huawei OEMs the
 * system may never fire onRequestPermissionsResult, which would otherwise leave requestInFlight
 * = true forever and permanently bypass session locking.
 *
 * MainActivity owns this guard and calls it only from the main thread.
 */
internal class NotificationPermissionLifecycleGuard(
    private val maxRequestAgeNanos: Long = DEFAULT_MAX_REQUEST_AGE_NANOS,
    private val nowNanos: () -> Long = System::nanoTime,
) {
    private var requestInFlight = false
    private var requestStartedAtNanos = 0L
    private var resumeBypassPending = false

    fun requestStarting() {
        requestInFlight = true
        requestStartedAtNanos = nowNanos()
        resumeBypassPending = false
    }

    fun requestDidNotStart() {
        requestInFlight = false
        requestStartedAtNanos = 0L
        resumeBypassPending = false
    }

    fun permissionResultReceived() {
        requestInFlight = false
        requestStartedAtNanos = 0L
    }

    fun onActivityStopping(): Boolean {
        if (!isRequestActive()) {
            // Clear the pending bypass so a stale request does not later grant a resume-bypass
            // on the next stop/resume cycle (the request has already timed out).
            resumeBypassPending = false
            return false
        }
        resumeBypassPending = true
        return true
    }

    fun consumeResumeBypass(): Boolean {
        if (!resumeBypassPending) return false
        resumeBypassPending = false
        // Any resume clears an in-flight request the OS never resolved — the next stop must lock.
        requestInFlight = false
        requestStartedAtNanos = 0L
        return true
    }

    private fun isRequestActive(): Boolean {
        if (!requestInFlight) return false
        if (nowNanos() - requestStartedAtNanos > maxRequestAgeNanos) {
            requestInFlight = false
            requestStartedAtNanos = 0L
            return false
        }
        return true
    }

    companion object {
        val DEFAULT_MAX_REQUEST_AGE_NANOS: Long = TimeUnit.SECONDS.toNanos(30)
    }
}

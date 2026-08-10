package online.alarabiya.superapp.core.notifications

/**
 * Distinguishes the Android notification-permission surface from a real trip to the background.
 * Some OEMs stop the Activity while the system dialog is visible; treating that transition as a
 * user departure immediately locks the authenticated session and can strand the user at launch.
 *
 * MainActivity owns this guard and calls it only from the main thread.
 */
internal class NotificationPermissionLifecycleGuard {
    private var requestInFlight = false
    private var resumeBypassPending = false

    fun requestStarting() {
        requestInFlight = true
        resumeBypassPending = false
    }

    fun requestDidNotStart() {
        requestInFlight = false
        resumeBypassPending = false
    }

    fun permissionResultReceived() {
        requestInFlight = false
    }

    fun onActivityStopping(): Boolean {
        if (!requestInFlight) return false
        resumeBypassPending = true
        return true
    }

    fun consumeResumeBypass(): Boolean {
        if (!resumeBypassPending) return false
        resumeBypassPending = false
        return true
    }
}

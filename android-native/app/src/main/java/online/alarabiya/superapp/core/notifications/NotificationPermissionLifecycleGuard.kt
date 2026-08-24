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
        return when (evaluateRequestState()) {
            RequestState.Active -> {
                resumeBypassPending = true
                true
            }
            // Inactive covers both "never started" and "resolved via callback" — pending stays valid
            // for the imminent resume the OEM dialog may still trigger. Expired paths already
            // cleared pending inside evaluateRequestState() so a stale bypass never leaks.
            RequestState.Inactive, RequestState.Expired -> false
        }
    }

    fun consumeResumeBypass(): Boolean {
        if (!resumeBypassPending) return false
        resumeBypassPending = false
        // Deliberately do NOT clear requestInFlight here: some OEMs fire multiple stop/resume
        // pairs before finally delivering the permission callback. Clearing here would lock the
        // session on the second stop while the dialog is still up. The age cap in
        // evaluateRequestState() is what caps runaway state.
        return true
    }

    private fun evaluateRequestState(): RequestState {
        if (!requestInFlight) return RequestState.Inactive
        if (nowNanos() - requestStartedAtNanos > maxRequestAgeNanos) {
            requestInFlight = false
            requestStartedAtNanos = 0L
            // The OEM never fired the callback and the user never came back to consume the bypass.
            // Any resume that happens now is a real user return, not a dialog transition.
            resumeBypassPending = false
            return RequestState.Expired
        }
        return RequestState.Active
    }

    private enum class RequestState { Inactive, Active, Expired }

    companion object {
        val DEFAULT_MAX_REQUEST_AGE_NANOS: Long = TimeUnit.SECONDS.toNanos(30)
    }
}

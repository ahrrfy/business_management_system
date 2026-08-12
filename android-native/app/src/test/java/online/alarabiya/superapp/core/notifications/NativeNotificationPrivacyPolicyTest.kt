package online.alarabiya.superapp.core.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeNotificationPrivacyPolicyTest {
    @Test
    fun sanitizedPayloadMayExposeItsSafeTextOnLockScreen() {
        assertEquals(
            LockScreenExposure.PUBLIC,
            NativeNotificationPrivacyPolicy.lockScreenExposure(sensitive = false),
        )
    }

    @Test
    fun sensitivePayloadAlwaysUsesPrivateLockScreenContent() {
        assertEquals(
            LockScreenExposure.PRIVATE,
            NativeNotificationPrivacyPolicy.lockScreenExposure(sensitive = true),
        )
    }

    @Test
    fun informationalAttendanceUsesItsOwnHeadsUpDeliveryLane() {
        assertEquals(
            NotificationDeliveryLane.ATTENDANCE,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "ATTENDANCE",
                urgency = NotificationUrgency.INFORMATION,
            ),
        )
    }
}

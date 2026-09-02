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
    fun routesEveryNotificationFamilyToItsOwnStableDeliveryLane() {
        assertEquals(
            NotificationDeliveryLane.EMPLOYEE,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "ATTENDANCE",
                urgency = NotificationUrgency.INFORMATION,
            ),
        )
        assertEquals(
            NotificationDeliveryLane.ADMIN,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "SESSION_EVENT",
                urgency = NotificationUrgency.INFORMATION,
            ),
        )
        assertEquals(
            NotificationDeliveryLane.APPROVAL,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "APPROVAL_REQUIRED",
                urgency = NotificationUrgency.ACTION,
            ),
        )
        assertEquals(
            NotificationDeliveryLane.SYSTEM,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "SYSTEM",
                urgency = NotificationUrgency.INFORMATION,
            ),
        )
        assertEquals(
            NotificationDeliveryLane.OPERATIONS,
            NativeNotificationPrivacyPolicy.deliveryLane(
                kind = "TASK_ASSIGNED",
                urgency = NotificationUrgency.ACTION,
            ),
        )
    }
}

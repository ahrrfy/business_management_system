package online.alarabiya.superapp.core.notifications

internal enum class LockScreenExposure {
    PUBLIC,
    PRIVATE,
}

internal enum class NotificationDeliveryLane {
    ATTENDANCE,
    ACTIONS,
    INFORMATION,
}

/** Only server-sanitized, explicitly non-sensitive payloads may show their text while locked. */
internal object NativeNotificationPrivacyPolicy {
    fun lockScreenExposure(sensitive: Boolean): LockScreenExposure =
        if (sensitive) LockScreenExposure.PRIVATE else LockScreenExposure.PUBLIC

    fun deliveryLane(kind: String, urgency: NotificationUrgency): NotificationDeliveryLane = when {
        kind == "ATTENDANCE" -> NotificationDeliveryLane.ATTENDANCE
        urgency == NotificationUrgency.ACTION -> NotificationDeliveryLane.ACTIONS
        else -> NotificationDeliveryLane.INFORMATION
    }
}

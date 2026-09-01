package online.alarabiya.superapp.core.notifications

internal enum class LockScreenExposure {
    PUBLIC,
    PRIVATE,
}

internal enum class NotificationDeliveryLane {
    OPERATIONS,
    ADMIN,
    EMPLOYEE,
    SYSTEM,
    APPROVAL,
}

/** Only server-sanitized, explicitly non-sensitive payloads may show their text while locked. */
internal object NativeNotificationPrivacyPolicy {
    fun lockScreenExposure(sensitive: Boolean): LockScreenExposure =
        if (sensitive) LockScreenExposure.PRIVATE else LockScreenExposure.PUBLIC

    fun deliveryLane(kind: String, urgency: NotificationUrgency): NotificationDeliveryLane = when (kind) {
        "SESSION_EVENT" -> NotificationDeliveryLane.ADMIN
        "APPROVAL_REQUIRED" -> NotificationDeliveryLane.APPROVAL
        "PAYROLL_READY", "LEAVE_STATUS", "ATTENDANCE", "ATTENDANCE_CHECK_IN", "ATTENDANCE_CHECK_OUT" ->
            NotificationDeliveryLane.EMPLOYEE
        "SYSTEM", "ANNOUNCEMENT" -> NotificationDeliveryLane.SYSTEM
        "TASK_ASSIGNED" -> NotificationDeliveryLane.OPERATIONS
        else -> if (urgency == NotificationUrgency.ACTION) NotificationDeliveryLane.OPERATIONS
        else NotificationDeliveryLane.SYSTEM
    }
}

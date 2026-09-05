package online.alarabiya.superapp.core.notifications

import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule

enum class NotificationUrgency {
    INFORMATION,
    ACTION,
}

data class NativeNotificationPayload(
    val notificationId: String,
    val kind: String,
    val title: String,
    val body: String,
    val urgency: NotificationUrgency,
    val sensitive: Boolean,
    val family: NotificationDeliveryLane,
    val destination: NativeDestination,
)

sealed interface NativeNotificationParseResult {
    data class Accepted(val payload: NativeNotificationPayload) : NativeNotificationParseResult
    data class Rejected(val reason: String) : NativeNotificationParseResult
}

/**
 * Treat FCM data as untrusted input. Only an allowlisted, typed in-app destination is accepted;
 * remote URLs and arbitrary Android intents never enter notification navigation.
 */
object NativeNotificationPayloadParser {
    private val notificationIdPattern = Regex("[A-Za-z0-9_-]{1,96}")
    private val kindPattern = Regex("[A-Z][A-Z0-9_]{1,39}")

    fun parse(data: Map<String, String>): NativeNotificationParseResult {
        if (data["version"] != "1") return rejected("unsupported_version")

        val notificationId = data["notificationId"]
            ?.takeIf(notificationIdPattern::matches)
            ?: return rejected("invalid_notification_id")
        val kind = data["kind"]
            ?.takeIf(kindPattern::matches)
            ?: return rejected("invalid_kind")
        val title = data["title"]
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= 80 }
            ?: return rejected("invalid_title")
        val body = data["body"]
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= 180 }
            ?: return rejected("invalid_body")
        val urgency = when (data["urgency"]) {
            "information" -> NotificationUrgency.INFORMATION
            "action" -> NotificationUrgency.ACTION
            else -> return rejected("invalid_urgency")
        }
        val sensitive = when (data["sensitive"]) {
            "true" -> true
            "false" -> false
            else -> return rejected("invalid_sensitivity")
        }
        val family = when (data["family"]) {
            "OPERATIONS" -> NotificationDeliveryLane.OPERATIONS
            "ADMIN" -> NotificationDeliveryLane.ADMIN
            "EMPLOYEE" -> NotificationDeliveryLane.EMPLOYEE
            "SYSTEM" -> NotificationDeliveryLane.SYSTEM
            "APPROVAL" -> NotificationDeliveryLane.APPROVAL
            null -> NativeNotificationPrivacyPolicy.deliveryLane(kind, urgency)
            else -> return rejected("invalid_family")
        }
        val destination = when (val parsed = data["destination"]?.let(NativeDeepLinkCodec::parse)) {
            is DeepLinkResult.Accepted -> parsed.destination
            else -> return rejected("invalid_destination")
        }
        if (!allowsDestination(kind, destination)) return rejected("destination_not_allowed_for_kind")

        return NativeNotificationParseResult.Accepted(
            NativeNotificationPayload(
                notificationId = notificationId,
                kind = kind,
                title = if (sensitive) "تحديث آمن" else title,
                body = if (sensitive) "افتح سوبر العربية لعرض التفاصيل." else body,
                urgency = urgency,
                sensitive = sensitive,
                family = family,
                destination = destination,
            ),
        )
    }

    /**
     * The URI codec is the syntax boundary; this matrix is the narrower push contract.
     * It prevents a valid but unrelated native destination from being paired with a forged kind.
     */
    fun allowsDestination(kind: String, destination: NativeDestination): Boolean = when (kind) {
        "TASK_ASSIGNED" -> destination == NativeDestination.Tasks || destination.matchesFeature(
            module = NativeModule.TASKS,
            intent = NativeFeatureIntent.VIEW,
            requiresEntity = true,
        )
        "APPROVAL_REQUIRED" -> destination == NativeDestination.Approvals
        "ATTENDANCE", "ATTENDANCE_CHECK_IN", "ATTENDANCE_CHECK_OUT" -> destination.matchesFeature(
            module = NativeModule.HR,
            intent = NativeFeatureIntent.BROWSE,
            requiresEntity = false,
        )
        "PAYROLL_READY", "LEAVE_STATUS" -> destination == NativeDestination.Profile || destination.matchesFeature(
            module = NativeModule.HR,
            intent = NativeFeatureIntent.VIEW,
            requiresEntity = true,
        )
        "ANNOUNCEMENT" -> destination.matchesFeature(
            module = NativeModule.ANNOUNCEMENTS,
            intent = NativeFeatureIntent.VIEW,
            requiresEntity = true,
        )
        "SESSION_EVENT", "SYSTEM" -> destination == NativeDestination.Alerts
        else -> false
    }

    private fun rejected(reason: String) = NativeNotificationParseResult.Rejected(reason)

    private fun NativeDestination.matchesFeature(
        module: NativeModule,
        intent: NativeFeatureIntent,
        requiresEntity: Boolean,
    ): Boolean = this is NativeDestination.Feature &&
        this.module == module &&
        this.intent == intent &&
        if (requiresEntity) entityId?.toLongOrNull()?.let { it > 0 } == true else entityId == null
}

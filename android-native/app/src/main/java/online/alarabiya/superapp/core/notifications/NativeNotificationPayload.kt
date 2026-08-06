package online.alarabiya.superapp.core.notifications

import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination

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
        val destination = when (val parsed = data["destination"]?.let(NativeDeepLinkCodec::parse)) {
            is DeepLinkResult.Accepted -> parsed.destination
            else -> return rejected("invalid_destination")
        }

        return NativeNotificationParseResult.Accepted(
            NativeNotificationPayload(
                notificationId = notificationId,
                kind = kind,
                title = if (sensitive) "تحديث آمن" else title,
                body = if (sensitive) "افتح سوبر العربية لعرض التفاصيل." else body,
                urgency = urgency,
                sensitive = sensitive,
                destination = destination,
            ),
        )
    }

    private fun rejected(reason: String) = NativeNotificationParseResult.Rejected(reason)
}

package online.alarabiya.superapp.core.notifications

import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNotificationPayloadParserTest {
    @Test
    fun acceptsTypedInternalDestination() {
        val result = NativeNotificationPayloadParser.parse(validPayload())

        assertTrue(result is NativeNotificationParseResult.Accepted)
        val payload = (result as NativeNotificationParseResult.Accepted).payload
        assertEquals(NotificationUrgency.ACTION, payload.urgency)
        assertEquals("موافقة جديدة", payload.title)
    }

    @Test
    fun rejectsWebAndIntentUrls() {
        listOf(
            "https://example.com/payroll",
            "http://127.0.0.1/admin",
            "intent://app/#Intent;scheme=alrueya;end",
            "alrueya://evil/home",
            "alrueya://app/home?redirect=https://evil.example",
        ).forEach { destination ->
            val result = NativeNotificationPayloadParser.parse(
                validPayload().toMutableMap().apply { put("destination", destination) },
            )
            assertTrue("Expected rejection for $destination", result is NativeNotificationParseResult.Rejected)
        }
    }

    @Test
    fun redactsSensitiveContentEvenWhenServerSendsDetails() {
        val result = NativeNotificationPayloadParser.parse(
            validPayload().toMutableMap().apply {
                put("sensitive", "true")
                put("title", "راتب شهر آب")
                put("body", "تم إيداع 5000")
            },
        ) as NativeNotificationParseResult.Accepted

        assertEquals("تحديث آمن", result.payload.title)
        assertEquals("افتح سوبر العربية لعرض التفاصيل.", result.payload.body)
    }

    @Test
    fun rejectsOversizedOrMalformedFields() {
        val cases = listOf(
            "notificationId" to "x".repeat(97),
            "kind" to "lowercase",
            "title" to "x".repeat(81),
            "body" to "x".repeat(181),
            "sensitive" to "yes",
            "urgency" to "critical",
        )

        cases.forEach { (key, value) ->
            val result = NativeNotificationPayloadParser.parse(
                validPayload().toMutableMap().apply { put(key, value) },
            )
            assertTrue("Expected rejection for $key", result is NativeNotificationParseResult.Rejected)
        }
    }

    @Test
    fun acceptsOnlyTheRootOrDetailShapeDefinedForEachOperationalKind() {
        val accepted = listOf(
            "TASK_ASSIGNED" to "alrueya://app/tasks",
            "TASK_ASSIGNED" to "alrueya://app/module/tasks/view/42",
            "APPROVAL_REQUIRED" to "alrueya://app/approvals",
            "ATTENDANCE" to "alrueya://app/module/hr/browse",
            "ATTENDANCE_CHECK_IN" to "alrueya://app/module/hr/browse",
            "ATTENDANCE_CHECK_OUT" to "alrueya://app/module/hr/browse",
            "PAYROLL_READY" to "alrueya://app/profile",
            "PAYROLL_READY" to "alrueya://app/module/hr/view/9",
            "LEAVE_STATUS" to "alrueya://app/profile",
            "LEAVE_STATUS" to "alrueya://app/module/hr/view/11",
            "ANNOUNCEMENT" to "alrueya://app/module/announcements/view/5",
        )

        accepted.forEach { (kind, destination) ->
            val result = NativeNotificationPayloadParser.parse(
                validPayload().toMutableMap().apply {
                    put("kind", kind)
                    put("destination", destination)
                },
            )
            assertTrue("Expected $kind to accept $destination", result is NativeNotificationParseResult.Accepted)
        }
    }

    @Test
    fun rejectsKindDestinationConfusionEvenWhenTheUriItselfIsSafe() {
        val rejected = listOf(
            "TASK_ASSIGNED" to "alrueya://app/module/sales/view/42",
            "TASK_ASSIGNED" to "alrueya://app/module/tasks/view/not-a-number",
            "APPROVAL_REQUIRED" to "alrueya://app/home",
            "ATTENDANCE" to "alrueya://app/module/hr/view/9",
            "ATTENDANCE_CHECK_OUT" to "alrueya://app/profile",
            "PAYROLL_READY" to "alrueya://app/module/tasks/view/42",
            "SYSTEM" to "alrueya://app/home",
            "ANNOUNCEMENT" to "alrueya://app/module/announcements/browse",
        )

        rejected.forEach { (kind, destination) ->
            val result = NativeNotificationPayloadParser.parse(
                validPayload().toMutableMap().apply {
                    put("kind", kind)
                    put("destination", destination)
                },
            )
            assertEquals(
                "Expected $kind to reject $destination",
                "destination_not_allowed_for_kind",
                (result as NativeNotificationParseResult.Rejected).reason,
            )
        }
    }

    @Test
    fun allowlistRetainsTheTypedTaskEntity() {
        val destination = NativeDestination.Feature(
            NativeModule.TASKS,
            NativeFeatureIntent.VIEW,
            "42",
        )

        assertTrue(NativeNotificationPayloadParser.allowsDestination("TASK_ASSIGNED", destination))
        assertEquals("42", destination.entityId)
        assertEquals(NativeFeatureIntent.VIEW, destination.intent)
    }

    private fun validPayload(): Map<String, String> = mapOf(
        "version" to "1",
        "notificationId" to "notif_2026_08_06_1",
        "kind" to "APPROVAL_REQUIRED",
        "title" to "موافقة جديدة",
        "body" to "يوجد طلب بانتظار الإجراء",
        "urgency" to "action",
        "sensitive" to "false",
        "destination" to "alrueya://app/approvals",
    )
}

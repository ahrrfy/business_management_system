package online.alarabiya.superapp.core.notifications

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

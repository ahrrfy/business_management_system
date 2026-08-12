package online.alarabiya.superapp.model.conversations

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ConversationModelsTest {
    @Test
    fun phoneSanitizerNormalizesIraqiAndInternationalNumbersWithoutAcceptingExtensions() {
        assertEquals("9647701234567", ConversationPhoneSanitizer.normalize("٠٧٧٠ ١٢٣ ٤٥٦٧"))
        assertEquals("9647701234567", ConversationPhoneSanitizer.normalize("+964 (770) 123-4567"))
        assertEquals("447911123456", ConversationPhoneSanitizer.normalize("0044 7911 123456"))
        assertNull(ConversationPhoneSanitizer.normalize("07701234567 ext 9"))
        assertNull(ConversationPhoneSanitizer.normalize("123"))
    }

    @Test
    fun textSanitizerRemovesControlsAndBidiOverridesButKeepsUsefulLines() {
        val input = "  مرحبا\u202Eabc\u0000\r\nالسطر الثاني\t  "
        assertEquals("مرحباabc\nالسطر الثاني", ConversationTextSanitizer.clean(input, 100))
        assertEquals(4, ConversationTextSanitizer.clean("123456", 4).length)
    }

    @Test
    fun whatsappHandoffNeedsManagePermissionValidNumberAndExplicitNonBlankText() {
        val conversation = summary(apiActive = false)
        val full = ConversationCapabilities(ConversationAccess.FULL, 1, false, false)
        val read = full.copy(access = ConversationAccess.READ)

        val target = WhatsappHandoff.build(conversation, full, "مرحباً عميلنا")
        assertEquals("9647701234567", target?.normalizedPhone)
        assertTrue(target?.uri?.startsWith("whatsapp://send?phone=9647701234567&text=") == true)
        assertNull(WhatsappHandoff.build(conversation, read, "مرحباً"))
        assertNull(WhatsappHandoff.build(conversation, full, "   "))
    }

    @Test
    fun sendPolicyDoesNotTurnManualLoggingContractIntoApiDelivery() {
        val full = ConversationCapabilities(ConversationAccess.FULL, 1, false, true)
        val now = Instant.parse("2026-08-06T10:00:00Z")
        assertFalse(ConversationSendPolicy.canSendFreeText(summary(apiActive = false), full, now))
        assertFalse(
            ConversationSendPolicy.canSendFreeText(
                summary(apiActive = true, windowExpiresAt = "2026-08-06T09:59:59Z"),
                full,
                now,
            ),
        )
        assertTrue(
            ConversationSendPolicy.canSendFreeText(
                summary(apiActive = true, windowExpiresAt = "2026-08-06T10:01:00Z"),
                full,
                now,
            ),
        )
    }

    @Test
    fun mapsActualListAndMessageShapesIncludingPendingOutboxRows() {
        val page = ConversationMappers.page(
            JSONObject().put(
                "rows",
                JSONArray().put(
                    JSONObject()
                        .put("id", 9)
                        .put("branchId", 2)
                        .put("channel", "WHATSAPP")
                        .put("channelHandle", "9647701234567")
                        .put("customerName", "عميل بغداد")
                        .put("unreadCount", 3)
                        .put("status", "OPEN")
                        .put("windowExpiresAt", "2026-08-06T12:00:00.000Z")
                        .put("apiActive", true),
                ),
            ).put("nextCursor", JSONObject().put("lastMessageAt", JSONObject.NULL).put("id", 9)),
        )
        assertEquals("عميل بغداد", page.rows.single().title)
        assertEquals(ConversationChannel.WHATSAPP, page.rows.single().channel)
        assertEquals(9L, page.nextCursor?.id)

        val messages = ConversationMappers.messages(
            JSONArray().put(
                JSONObject()
                    .put("id", -18)
                    .put("direction", "OUT")
                    .put("body", "قيد الإرسال")
                    .put("pending", JSONObject().put("outboxId", 18).put("status", "FAILED").put("lastError", "timeout")),
            ),
        )
        assertEquals(MessageDirection.OUT, messages.single().direction)
        assertEquals(18L, messages.single().pending?.outboxId)
        assertEquals("FAILED", messages.single().pending?.status)
    }

    private fun summary(
        apiActive: Boolean,
        windowExpiresAt: String? = "2026-08-07T00:00:00Z",
    ) = ConversationSummary(
        id = 1,
        branchId = 1,
        channel = ConversationChannel.WHATSAPP,
        channelHandle = "07701234567",
        customerId = null,
        customerName = "عميل",
        displayName = null,
        linkedWorkOrderId = null,
        unreadCount = 0,
        lastMessageAt = null,
        lastMessagePreview = null,
        status = ConversationStatus.OPEN,
        createdAt = null,
        lastInboundAt = null,
        assignedTo = null,
        windowExpiresAt = windowExpiresAt,
        apiActive = apiActive,
    )
}

package online.alarabiya.superapp.data

import kotlinx.coroutines.runBlocking
import online.alarabiya.superapp.model.conversations.ApprovedWhatsappTemplate
import online.alarabiya.superapp.model.conversations.ConversationAccess
import online.alarabiya.superapp.model.conversations.ConversationCapabilities
import online.alarabiya.superapp.model.conversations.ConversationFilter
import online.alarabiya.superapp.model.conversations.ConversationListRequest
import online.alarabiya.superapp.model.conversations.ConversationChannel
import online.alarabiya.superapp.model.conversations.ConversationStatus
import online.alarabiya.superapp.model.conversations.ConversationSummary
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ConversationsRepositoryTest {
    @Test
    fun listUsesOnlyMountedConversationContractAndPreservesBranchScope() = runBlocking {
        val api = FakeConversationsApi().apply {
            objectResponses["conversations.list"] = JSONObject().put("rows", JSONArray()).put("nextCursor", JSONObject.NULL)
        }
        val repository = ConversationsRepository(api)

        repository.list(
            ConversationListRequest(
                filter = ConversationFilter.UNREAD,
                channel = ConversationChannel.WHATSAPP,
                query = "  أحمد  ",
                branchId = 7,
                limit = 40,
            ),
        )

        assertEquals("conversations.list", api.calls.single().procedure)
        with(requireNotNull(api.calls.single().input)) {
            assertEquals("unread", getString("filter"))
            assertEquals("WHATSAPP", getString("channel"))
            assertEquals("أحمد", getString("q"))
            assertEquals(7L, getLong("branchId"))
            assertEquals(40, getInt("limit"))
        }
    }

    @Test
    fun sendTextCallsRealCloudApiPathOnlyWhenServerCapabilityAndWindowAreOpen() = runBlocking {
        val api = FakeConversationsApi().apply {
            objectResponses["conversations.sendMessage"] = JSONObject().put("queued", true).put("outboxId", 81)
        }
        val repository = ConversationsRepository(api)
        val capabilities = ConversationCapabilities(ConversationAccess.FULL, 1, false, true)
        val now = Instant.parse("2026-08-06T10:00:00Z")

        val receipt = repository.sendText(conversation(apiActive = true), capabilities, "  مرحباً  ", now)
        assertTrue(receipt.queued)
        assertEquals(81L, receipt.outboxId)
        val call = api.calls.single()
        assertEquals("conversations.sendMessage", call.procedure)
        assertEquals("OUT", call.input?.getString("direction"))
        assertEquals("مرحباً", call.input?.getString("body"))
        val clientRequestId = requireNotNull(call.input?.getString("clientRequestId"))
        assertTrue(clientRequestId.length in 8..64)

        val inactiveApi = FakeConversationsApi()
        val inactiveRepository = ConversationsRepository(inactiveApi)
        val failure = runCatching {
            inactiveRepository.sendText(conversation(apiActive = false), capabilities, "مرحبا", now)
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertTrue(inactiveApi.calls.isEmpty())
    }

    @Test
    fun templatesUseApprovedManagerListAndExactSendTemplateContract() = runBlocking {
        val api = FakeConversationsApi().apply {
            arrayResponses["integrations.templates.list"] = JSONArray().put(
                JSONObject()
                    .put("name", "order_ready")
                    .put("language", "ar")
                    .put("category", "UTILITY")
                    .put("templateStatus", "APPROVED")
                    .put("bodyText", "طلبك {{1}} جاهز")
                    .put("variableCount", 1),
            )
            objectResponses["conversations.sendTemplate"] = JSONObject().put("queued", true).put("outboxId", 91)
        }
        val repository = ConversationsRepository(api)
        val template = repository.approvedTemplates().single()
        assertEquals("integrations.templates.list", api.calls.first().procedure)
        assertEquals("APPROVED", api.calls.first().input?.getString("statusFilter"))

        repository.sendTemplate(
            conversation(apiActive = true),
            ConversationCapabilities(ConversationAccess.FULL, 1, false, true),
            template,
            listOf("A-42"),
        )
        val send = api.calls.last()
        assertEquals("conversations.sendTemplate", send.procedure)
        assertEquals("order_ready", send.input?.getString("templateName"))
        assertEquals("A-42", send.input?.getJSONArray("bodyParams")?.getString(0))
    }

    @Test
    fun messageReadAndRetryUseActualProcedureNames() = runBlocking {
        val api = FakeConversationsApi().apply {
            arrayResponses["conversations.messages"] = JSONArray()
            objectResponses["conversations.markRead"] = JSONObject().put("ok", true)
            objectResponses["conversations.retrySend"] = JSONObject().put("ok", true)
        }
        val repository = ConversationsRepository(api)
        repository.messages(5)
        repository.markRead(5)
        repository.retry(22)
        assertEquals(
            listOf("conversations.messages", "conversations.markRead", "conversations.retrySend"),
            api.calls.map { it.procedure },
        )
    }

    private fun conversation(apiActive: Boolean) = ConversationSummary(
        id = 5,
        branchId = 1,
        channel = ConversationChannel.WHATSAPP,
        channelHandle = "9647701234567",
        customerId = null,
        customerName = "عميل",
        displayName = null,
        linkedWorkOrderId = null,
        unreadCount = 0,
        lastMessageAt = null,
        lastMessagePreview = null,
        status = ConversationStatus.OPEN,
        createdAt = null,
        lastInboundAt = "2026-08-06T09:00:00Z",
        assignedTo = null,
        windowExpiresAt = "2026-08-06T11:00:00Z",
        apiActive = apiActive,
    )
}

private data class ApiCall(val procedure: String, val input: JSONObject?)

private class FakeConversationsApi : ConversationsApi {
    val calls = mutableListOf<ApiCall>()
    val objectResponses = mutableMapOf<String, JSONObject>()
    val arrayResponses = mutableMapOf<String, JSONArray>()

    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ApiCall(procedure, input)
        return objectResponses[procedure] ?: error("No object response for $procedure")
    }

    override suspend fun queryArray(procedure: String, input: JSONObject?): JSONArray {
        calls += ApiCall(procedure, input)
        return arrayResponses[procedure] ?: error("No array response for $procedure")
    }

    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ApiCall(procedure, input)
        return objectResponses[procedure] ?: error("No mutation response for $procedure")
    }
}

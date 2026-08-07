package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.conversations.ApprovedWhatsappTemplate
import online.alarabiya.superapp.model.conversations.ConversationCapabilities
import online.alarabiya.superapp.model.conversations.ConversationListRequest
import online.alarabiya.superapp.model.conversations.ConversationMappers
import online.alarabiya.superapp.model.conversations.ConversationMessage
import online.alarabiya.superapp.model.conversations.ConversationPage
import online.alarabiya.superapp.model.conversations.ConversationSendPolicy
import online.alarabiya.superapp.model.conversations.ConversationSummary
import online.alarabiya.superapp.model.conversations.ConversationTextSanitizer
import online.alarabiya.superapp.model.conversations.SendReceipt
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

interface ConversationsDataSource {
    suspend fun list(request: ConversationListRequest): ConversationPage
    suspend fun messages(conversationId: Long): List<ConversationMessage>
    suspend fun markRead(conversationId: Long)
    suspend fun sendText(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        rawText: String,
        now: Instant = Instant.now(),
    ): SendReceipt
    suspend fun approvedTemplates(): List<ApprovedWhatsappTemplate>
    suspend fun sendTemplate(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        template: ApprovedWhatsappTemplate,
        rawParameters: List<String>,
    ): SendReceipt
    suspend fun retry(outboxId: Long)
}

internal interface ConversationsApi {
    suspend fun queryObject(procedure: String, input: JSONObject? = null): JSONObject
    suspend fun queryArray(procedure: String, input: JSONObject? = null): JSONArray
    suspend fun mutateObject(procedure: String, input: JSONObject? = null): JSONObject
}

private class TrpcConversationsApi(private val client: TrpcClient) : ConversationsApi {
    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject = client.query(procedure, input)
    override suspend fun queryArray(procedure: String, input: JSONObject?): JSONArray = client.queryArray(procedure, input)
    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject = client.mutate(procedure, input)
}

class ConversationsRepository internal constructor(private val api: ConversationsApi) : ConversationsDataSource {
    constructor(client: TrpcClient) : this(TrpcConversationsApi(client))

    override suspend fun list(request: ConversationListRequest): ConversationPage {
        require(request.limit in 1..500) { "حجم صفحة المحادثات غير صالح" }
        val input = JSONObject()
            .put("filter", request.filter.wire)
            .put("limit", request.limit)
        request.channel?.let { input.put("channel", it.wire) }
        request.query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        request.branchId?.also { require(it > 0) { "معرّف الفرع غير صالح" } }?.let { input.put("branchId", it) }
        request.cursor?.let { cursor ->
            require(cursor.id > 0) { "مؤشر المحادثات غير صالح" }
            input.put(
                "cursor",
                JSONObject()
                    .put("lastMessageAt", cursor.lastMessageAt ?: JSONObject.NULL)
                    .put("id", cursor.id),
            )
        }
        return ConversationMappers.page(api.queryObject("conversations.list", input))
    }

    override suspend fun messages(conversationId: Long): List<ConversationMessage> {
        require(conversationId > 0) { "معرّف المحادثة غير صالح" }
        return ConversationMappers.messages(
            api.queryArray("conversations.messages", JSONObject().put("conversationId", conversationId)),
        )
    }

    override suspend fun markRead(conversationId: Long) {
        require(conversationId > 0) { "معرّف المحادثة غير صالح" }
        api.mutateObject("conversations.markRead", JSONObject().put("conversationId", conversationId))
    }

    override suspend fun sendText(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        rawText: String,
        now: Instant,
    ): SendReceipt {
        require(ConversationSendPolicy.canSendFreeText(conversation, capabilities, now)) {
            "الإرسال الحر غير متاح لهذه المحادثة"
        }
        val text = ConversationTextSanitizer.forApi(rawText)
        require(text.isNotBlank()) { "اكتب الرسالة أولاً" }
        val result = api.mutateObject(
            "conversations.sendMessage",
            JSONObject()
                .put("conversationId", conversation.id)
                .put("direction", "OUT")
                .put("body", text)
                .put("clientRequestId", UUID.randomUUID().toString()),
        )
        return result.sendReceipt().also { receipt ->
            require(receipt.queued) {
                "لم يؤكد الخادم إدراج الرسالة في مسار واتساب؛ لم تُسجل كإرسال ناجح"
            }
        }
    }

    override suspend fun approvedTemplates(): List<ApprovedWhatsappTemplate> =
        ConversationMappers.templates(
            api.queryArray(
                "integrations.templates.list",
                JSONObject().put("statusFilter", "APPROVED"),
            ),
        )

    override suspend fun sendTemplate(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        template: ApprovedWhatsappTemplate,
        rawParameters: List<String>,
    ): SendReceipt {
        require(ConversationSendPolicy.canUseApprovedTemplate(conversation, capabilities)) {
            "إرسال القوالب غير متاح لهذا الحساب أو لهذه المحادثة"
        }
        require(rawParameters.size == template.variableCount) { "عدد متغيرات القالب غير مطابق" }
        val parameters = rawParameters.map {
            ConversationTextSanitizer.clean(it, 1_000).also { value -> require(value.isNotBlank()) { "أكمل متغيرات القالب" } }
        }
        val result = api.mutateObject(
            "conversations.sendTemplate",
            JSONObject()
                .put("conversationId", conversation.id)
                .put("templateName", template.name)
                .put("templateLang", template.language)
                .put("bodyParams", JSONArray(parameters))
                .put("clientRequestId", UUID.randomUUID().toString()),
        )
        return result.sendReceipt().also { receipt ->
            require(receipt.queued) { "لم يؤكد الخادم إدراج القالب في مسار واتساب" }
        }
    }

    override suspend fun retry(outboxId: Long) {
        require(outboxId > 0) { "معرّف محاولة الإرسال غير صالح" }
        api.mutateObject("conversations.retrySend", JSONObject().put("outboxId", outboxId))
    }
}

private fun JSONObject.sendReceipt(): SendReceipt = SendReceipt(
    queued = optBoolean("queued", false),
    outboxId = takeUnless { isNull("outboxId") }?.optLong("outboxId")?.takeIf { it > 0 },
)

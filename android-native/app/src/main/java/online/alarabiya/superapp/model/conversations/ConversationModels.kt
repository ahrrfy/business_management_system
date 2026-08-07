package online.alarabiya.superapp.model.conversations

import online.alarabiya.superapp.model.AppBootstrap
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant

enum class ConversationAccess {
    NONE,
    READ,
    FULL;

    val canRead: Boolean get() = this != NONE
    val canManage: Boolean get() = this == FULL

    companion object {
        fun fromWire(value: String?): ConversationAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class ConversationCapabilities(
    val access: ConversationAccess,
    val branchId: Long?,
    val allBranches: Boolean,
    val canReadApprovedTemplates: Boolean,
) {
    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): ConversationCapabilities {
            val role = bootstrap.user.role.lowercase()
            return ConversationCapabilities(
                access = ConversationAccess.fromWire(
                    bootstrap.modules.firstOrNull { it.key == "channels" }?.access,
                ),
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
                canReadApprovedTemplates = role == "admin" || role == "manager",
            )
        }
    }
}

enum class ConversationChannel(val wire: String, val label: String) {
    WHATSAPP("WHATSAPP", "واتساب"),
    INSTAGRAM("INSTAGRAM", "إنستغرام"),
    TIKTOK("TIKTOK", "تيك توك"),
    STORE("STORE", "المتجر"),
    PHONE("PHONE", "اتصال"),
    WALK_IN("WALK_IN", "حضوري"),
    OTHER("OTHER", "أخرى");

    companion object {
        fun fromWire(value: String?): ConversationChannel = entries.firstOrNull { it.wire == value } ?: OTHER
    }
}

enum class ConversationStatus { OPEN, ARCHIVED, CLOSED }

enum class ConversationFilter(val wire: String, val label: String) {
    ALL("all", "المفتوحة"),
    UNREAD("unread", "غير المقروءة"),
    ARCHIVED("archived", "المؤرشفة"),
    CLOSED("closed", "المغلقة"),
}

enum class MessageDirection { IN, OUT, NOTE }
enum class DeliveryStatus { PENDING, SENT, DELIVERED, READ, FAILED }
enum class MessageOrigin { API, PHONE_APP, SYSTEM }

data class ConversationCursor(val lastMessageAt: String?, val id: Long)

data class ConversationSummary(
    val id: Long,
    val branchId: Long,
    val channel: ConversationChannel,
    val channelHandle: String,
    val customerId: Long?,
    val customerName: String?,
    val displayName: String?,
    val linkedWorkOrderId: Long?,
    val unreadCount: Int,
    val lastMessageAt: String?,
    val lastMessagePreview: String?,
    val status: ConversationStatus,
    val createdAt: String?,
    val lastInboundAt: String?,
    val assignedTo: Long?,
    val windowExpiresAt: String?,
    val apiActive: Boolean,
) {
    val title: String get() = customerName ?: displayName ?: channelHandle

    fun isFreeReplyWindowOpen(now: Instant = Instant.now()): Boolean =
        apiActive && windowExpiresAt?.let { runCatching { Instant.parse(it).isAfter(now) }.getOrDefault(false) } == true
}

data class ConversationPage(
    val rows: List<ConversationSummary>,
    val nextCursor: ConversationCursor?,
)

data class PendingDelivery(
    val outboxId: Long,
    val status: String,
    val lastError: String?,
)

data class ConversationMessage(
    val id: Long,
    val direction: MessageDirection,
    val body: String?,
    val mediaUrl: String?,
    val mediaType: String?,
    val authorUserId: Long?,
    val authorName: String?,
    val deliveryStatus: DeliveryStatus?,
    val statusUpdatedAt: String?,
    val errorCode: String?,
    val origin: MessageOrigin?,
    val templateName: String?,
    val createdAt: String?,
    val pending: PendingDelivery?,
)

data class ApprovedWhatsappTemplate(
    val name: String,
    val language: String,
    val category: String,
    val bodyText: String?,
    val variableCount: Int,
)

data class ConversationListRequest(
    val filter: ConversationFilter = ConversationFilter.ALL,
    val channel: ConversationChannel? = null,
    val query: String = "",
    val branchId: Long? = null,
    val cursor: ConversationCursor? = null,
    val limit: Int = 80,
)

data class SendReceipt(val queued: Boolean, val outboxId: Long?)

data class WhatsappLaunchTarget(
    val uri: String,
    val normalizedPhone: String,
    val messagePreview: String,
)

object ConversationSendPolicy {
    fun canSendFreeText(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        now: Instant = Instant.now(),
    ): Boolean = capabilities.access.canManage &&
        conversation.channel == ConversationChannel.WHATSAPP &&
        conversation.isFreeReplyWindowOpen(now)

    fun canUseApprovedTemplate(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
    ): Boolean = capabilities.access.canManage && capabilities.canReadApprovedTemplates &&
        conversation.channel == ConversationChannel.WHATSAPP && conversation.apiActive

    fun canOpenExternalWhatsapp(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
    ): Boolean = capabilities.access.canManage &&
        conversation.channel == ConversationChannel.WHATSAPP &&
        ConversationPhoneSanitizer.normalize(conversation.channelHandle) != null
}

object ConversationPhoneSanitizer {
    /** Returns E.164 digits without '+' for WhatsApp deep links. */
    fun normalize(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        val ascii = buildString {
            value.forEachIndexed { index, character ->
                when {
                    character == '+' && index == 0 -> append(character)
                    character.isDigit() -> append(character.digitToInt())
                    character in setOf(' ', '-', '(', ')', '.') -> Unit
                    else -> return null
                }
            }
        }
        var digits = ascii.removePrefix("+")
        digits = when {
            digits.startsWith("00964") -> digits.drop(2)
            digits.startsWith("00") -> digits.drop(2)
            digits.startsWith("07") && digits.length == 11 -> "964${digits.drop(1)}"
            digits.startsWith("7") && digits.length == 10 -> "964$digits"
            else -> digits
        }
        return digits.takeIf { it.length in 8..15 && it.firstOrNull() in '1'..'9' }
    }
}

object ConversationTextSanitizer {
    private val forbiddenFormatting = setOf('\u202A', '\u202B', '\u202D', '\u202E', '\u202C', '\u2066', '\u2067', '\u2068', '\u2069')

    fun clean(raw: String, maxLength: Int): String = buildString {
        raw.replace("\r\n", "\n").replace('\r', '\n').forEach { character ->
            when {
                character in forbiddenFormatting -> Unit
                character == '\n' || character == '\t' || !character.isISOControl() -> append(character)
            }
        }
    }.trim().take(maxLength)

    fun forApi(raw: String): String = clean(raw, 65_500)
    fun forExternalWhatsapp(raw: String): String = clean(raw, 4_096)
}

object WhatsappHandoff {
    fun build(
        conversation: ConversationSummary,
        capabilities: ConversationCapabilities,
        rawMessage: String,
    ): WhatsappLaunchTarget? {
        if (!ConversationSendPolicy.canOpenExternalWhatsapp(conversation, capabilities)) return null
        val phone = ConversationPhoneSanitizer.normalize(conversation.channelHandle) ?: return null
        val message = ConversationTextSanitizer.forExternalWhatsapp(rawMessage)
        if (message.isBlank()) return null
        val encoded = URLEncoder.encode(message, Charsets.UTF_8.name()).replace("+", "%20")
        return WhatsappLaunchTarget(
            uri = "whatsapp://send?phone=$phone&text=$encoded",
            normalizedPhone = phone,
            messagePreview = message,
        )
    }
}

object ConversationMappers {
    fun page(json: JSONObject): ConversationPage = ConversationPage(
        rows = json.optJSONArray("rows").orEmpty().mapObjects(::summary),
        nextCursor = json.optJSONObject("nextCursor")?.let {
            ConversationCursor(it.nullableString("lastMessageAt"), it.optLong("id"))
        }?.takeIf { it.id > 0 },
    )

    fun messages(json: JSONArray): List<ConversationMessage> = json.mapObjects { item ->
        ConversationMessage(
            id = item.optLong("id"),
            direction = enumValueOr(item.nullableString("direction"), MessageDirection.IN),
            body = item.nullableString("body"),
            mediaUrl = item.nullableString("mediaUrl"),
            mediaType = item.nullableString("mediaType"),
            authorUserId = item.nullableLong("authorUserId"),
            authorName = item.nullableString("authorName"),
            deliveryStatus = enumValueOrNull<DeliveryStatus>(item.nullableString("deliveryStatus")),
            statusUpdatedAt = item.nullableString("statusUpdatedAt"),
            errorCode = item.nullableString("errorCode"),
            origin = enumValueOrNull<MessageOrigin>(item.nullableString("origin")),
            templateName = item.nullableString("templateName"),
            createdAt = item.nullableString("createdAt"),
            pending = item.optJSONObject("pending")?.let { pending ->
                PendingDelivery(
                    outboxId = pending.optLong("outboxId"),
                    status = pending.optString("status"),
                    lastError = pending.nullableString("lastError"),
                )
            },
        )
    }

    fun templates(json: JSONArray): List<ApprovedWhatsappTemplate> = json.mapObjects { item ->
        ApprovedWhatsappTemplate(
            name = item.optString("name"),
            language = item.optString("language", "ar"),
            category = item.optString("category"),
            bodyText = item.nullableString("bodyText"),
            variableCount = item.optInt("variableCount").coerceAtLeast(0),
        )
    }.filter { it.name.isNotBlank() }

    private fun summary(item: JSONObject): ConversationSummary = ConversationSummary(
        id = item.optLong("id"),
        branchId = item.optLong("branchId"),
        channel = ConversationChannel.fromWire(item.nullableString("channel")),
        channelHandle = item.optString("channelHandle"),
        customerId = item.nullableLong("customerId"),
        customerName = item.nullableString("customerName"),
        displayName = item.nullableString("displayName"),
        linkedWorkOrderId = item.nullableLong("linkedWorkOrderId"),
        unreadCount = item.optInt("unreadCount").coerceAtLeast(0),
        lastMessageAt = item.nullableString("lastMessageAt"),
        lastMessagePreview = item.nullableString("lastMessagePreview"),
        status = enumValueOr(item.nullableString("status"), ConversationStatus.OPEN),
        createdAt = item.nullableString("createdAt"),
        lastInboundAt = item.nullableString("lastInboundAt"),
        assignedTo = item.nullableLong("assignedTo"),
        windowExpiresAt = item.nullableString("windowExpiresAt"),
        apiActive = item.optBoolean("apiActive"),
    )
}

object NativeConversationContractGaps {
    const val DETAIL_ENDPOINT =
        "The server has no conversations.get procedure; native detail is the selected list row plus conversations.messages."
    const val TEMPLATE_VISIBILITY =
        "integrations.templates.list is manager-only while conversations.sendTemplate requires channels FULL; non-manager writers cannot discover approved templates."
    const val EXTERNAL_DELIVERY_RECEIPT =
        "An explicit WhatsApp app handoff cannot prove that the user sent the prepared text; the UI must only claim that WhatsApp was opened."
    const val NON_WHATSAPP_OUTBOUND =
        "No native transport contract exists for Instagram, TikTok, Store, Phone, Walk-in, or Other; they remain read-only in the native client."
    const val SEND_FAIL_CLOSED =
        "conversations.sendMessage can fall back to a manual log if the active integration disappears after list loading; native rejects a non-queued response but the server needs a fail-closed transport flag for atomic assurance."
    const val NOTIFICATION_PRIVACY =
        "Conversation bodies and phone numbers must not be copied into notification payloads; notification routing should carry opaque entity identifiers only."
}

private fun JSONObject.nullableString(key: String): String? =
    takeUnless { isNull(key) }?.optString(key)?.takeIf { it.isNotBlank() }

private fun JSONObject.nullableLong(key: String): Long? =
    takeUnless { isNull(key) }?.optLong(key)?.takeIf { it > 0 }

private fun JSONArray?.orEmpty(): JSONArray = this ?: JSONArray()

private fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> = buildList {
    for (index in 0 until length()) optJSONObject(index)?.let { add(transform(it)) }
}

private inline fun <reified T : Enum<T>> enumValueOrNull(value: String?): T? =
    value?.let { wire -> enumValues<T>().firstOrNull { it.name == wire } }

private inline fun <reified T : Enum<T>> enumValueOr(value: String?, fallback: T): T =
    enumValueOrNull<T>(value) ?: fallback

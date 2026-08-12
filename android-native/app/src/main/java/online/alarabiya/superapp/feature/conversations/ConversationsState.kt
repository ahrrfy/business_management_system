package online.alarabiya.superapp.feature.conversations

import online.alarabiya.superapp.model.conversations.ApprovedWhatsappTemplate
import online.alarabiya.superapp.model.conversations.ConversationChannel
import online.alarabiya.superapp.model.conversations.ConversationCursor
import online.alarabiya.superapp.model.conversations.ConversationFilter
import online.alarabiya.superapp.model.conversations.ConversationMessage
import online.alarabiya.superapp.model.conversations.ConversationSummary
import online.alarabiya.superapp.model.conversations.WhatsappLaunchTarget

data class ConversationsUiState(
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val loadingMessages: Boolean = false,
    val conversations: List<ConversationSummary> = emptyList(),
    val nextCursor: ConversationCursor? = null,
    val selectedId: Long? = null,
    val messages: List<ConversationMessage> = emptyList(),
    val filter: ConversationFilter = ConversationFilter.ALL,
    val channel: ConversationChannel? = null,
    val query: String = "",
    val branchId: Long? = null,
    val draft: String = "",
    val templates: List<ApprovedWhatsappTemplate> = emptyList(),
    val templatesLoading: Boolean = false,
    val selectedTemplateName: String? = null,
    val templateParameters: List<String> = emptyList(),
    val pendingWhatsapp: WhatsappLaunchTarget? = null,
    val busyKey: String? = null,
    val error: String? = null,
    val notice: String? = null,
) {
    val selectedConversation: ConversationSummary?
        get() = conversations.firstOrNull { it.id == selectedId }

    val selectedTemplate: ApprovedWhatsappTemplate?
        get() = templates.firstOrNull { "${it.name}::${it.language}" == selectedTemplateName }

    fun loaded(rows: List<ConversationSummary>, cursor: ConversationCursor?, append: Boolean): ConversationsUiState {
        val merged = if (append) (conversations + rows).distinctBy(ConversationSummary::id) else rows
        val retained = selectedId?.takeIf { id -> merged.any { it.id == id } }
        return copy(
            loading = false,
            refreshing = false,
            loadingMore = false,
            conversations = merged,
            nextCursor = cursor,
            selectedId = retained,
            messages = messages.takeIf { retained != null } ?: emptyList(),
            error = null,
        )
    }

    fun failed(message: String): ConversationsUiState = copy(
        loading = false,
        refreshing = false,
        loadingMore = false,
        loadingMessages = false,
        templatesLoading = false,
        busyKey = null,
        error = message,
    )
}

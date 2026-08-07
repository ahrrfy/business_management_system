package online.alarabiya.superapp.feature.conversations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.ConversationsDataSource
import online.alarabiya.superapp.model.conversations.ApprovedWhatsappTemplate
import online.alarabiya.superapp.model.conversations.ConversationCapabilities
import online.alarabiya.superapp.model.conversations.ConversationChannel
import online.alarabiya.superapp.model.conversations.ConversationFilter
import online.alarabiya.superapp.model.conversations.ConversationListRequest
import online.alarabiya.superapp.model.conversations.ConversationSendPolicy
import online.alarabiya.superapp.model.conversations.WhatsappHandoff

class ConversationsViewModel(
    private val source: ConversationsDataSource,
    val capabilities: ConversationCapabilities,
) : ViewModel() {
    var state by mutableStateOf(ConversationsUiState(branchId = capabilities.branchId))
        private set

    init {
        if (capabilities.access.canRead && (!capabilities.allBranches || capabilities.branchId != null)) refresh()
    }

    fun refresh() = load(append = false, refreshing = state.conversations.isNotEmpty())

    fun loadMore() {
        if (state.nextCursor != null) load(append = true, refreshing = false)
    }

    fun setQuery(value: String) {
        state = state.copy(query = value.take(200), error = null)
    }

    fun applySearch() = load(append = false, refreshing = false)

    fun setFilter(value: ConversationFilter) {
        if (state.filter == value) return
        state = state.copy(filter = value, selectedId = null, messages = emptyList())
        load(append = false, refreshing = false)
    }

    fun setChannel(value: ConversationChannel?) {
        if (state.channel == value) return
        state = state.copy(channel = value, selectedId = null, messages = emptyList())
        load(append = false, refreshing = false)
    }

    fun setBranch(branchId: Long?) {
        if (!capabilities.allBranches || branchId == null || branchId <= 0 || state.branchId == branchId) return
        state = state.copy(branchId = branchId, selectedId = null, messages = emptyList())
        load(append = false, refreshing = false)
    }

    fun select(conversationId: Long?) {
        if (conversationId == null) {
            state = state.copy(selectedId = null, messages = emptyList(), error = null, pendingWhatsapp = null)
            return
        }
        val conversation = state.conversations.firstOrNull { it.id == conversationId } ?: return
        state = state.copy(
            selectedId = conversationId,
            messages = emptyList(),
            loadingMessages = true,
            error = null,
            pendingWhatsapp = null,
            selectedTemplateName = null,
            templateParameters = emptyList(),
        )
        viewModelScope.launch {
            runCatching { source.messages(conversationId) }
                .onSuccess { messages ->
                    state = state.copy(loadingMessages = false, messages = messages)
                    if (conversation.unreadCount > 0 && capabilities.access.canManage) {
                        runCatching { source.markRead(conversationId) }.onSuccess {
                            state = state.copy(
                                conversations = state.conversations.map { row ->
                                    if (row.id == conversationId) row.copy(unreadCount = 0) else row
                                },
                            )
                        }
                    }
                }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    fun updateDraft(value: String) {
        state = state.copy(draft = value.take(65_500), error = null, notice = null)
    }

    fun sendText() {
        val conversation = state.selectedConversation ?: return
        if (!ConversationSendPolicy.canSendFreeText(conversation, capabilities)) {
            state = state.copy(error = "الرد الحر غير متاح لهذه المحادثة")
            return
        }
        if (state.draft.isBlank() || state.busyKey != null) return
        val draft = state.draft
        state = state.copy(busyKey = "send", error = null, notice = null)
        viewModelScope.launch {
            runCatching { source.sendText(conversation, capabilities, draft) }
                .onSuccess {
                    state = state.copy(
                        draft = state.draft.takeUnless { it == draft }.orEmpty(),
                        busyKey = null,
                        notice = "تم تسليم الرسالة لمسار الإرسال",
                    )
                    reloadMessages(conversation.id)
                }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    fun requestWhatsappHandoff() {
        val conversation = state.selectedConversation ?: return
        val target = WhatsappHandoff.build(conversation, capabilities, state.draft)
        state = if (target == null) {
            state.copy(error = "أدخل نصاً وتأكد من رقم واتساب قبل المتابعة")
        } else {
            state.copy(pendingWhatsapp = target, error = null, notice = null)
        }
    }

    fun dismissWhatsappHandoff() {
        state = state.copy(pendingWhatsapp = null)
    }

    fun whatsappOpened() {
        state = state.copy(pendingWhatsapp = null, notice = "تم فتح واتساب؛ الإرسال يتم من داخل واتساب")
    }

    fun loadTemplates() {
        val conversation = state.selectedConversation ?: return
        if (!ConversationSendPolicy.canUseApprovedTemplate(conversation, capabilities) || state.templatesLoading) return
        state = state.copy(templatesLoading = true, error = null)
        viewModelScope.launch {
            runCatching { source.approvedTemplates() }
                .onSuccess { state = state.copy(templatesLoading = false, templates = it) }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    fun selectTemplate(template: ApprovedWhatsappTemplate?) {
        state = state.copy(
            selectedTemplateName = template?.let { "${it.name}::${it.language}" },
            templateParameters = List(template?.variableCount ?: 0) { "" },
            error = null,
        )
    }

    fun updateTemplateParameter(index: Int, value: String) {
        if (index !in state.templateParameters.indices) return
        state = state.copy(
            templateParameters = state.templateParameters.mapIndexed { position, current ->
                if (position == index) value.take(1_000) else current
            },
            error = null,
        )
    }

    fun sendTemplate() {
        val conversation = state.selectedConversation ?: return
        val template = state.selectedTemplate ?: return
        if (state.busyKey != null) return
        state = state.copy(busyKey = "template", error = null, notice = null)
        viewModelScope.launch {
            runCatching {
                source.sendTemplate(conversation, capabilities, template, state.templateParameters)
            }.onSuccess {
                state = state.copy(
                    busyKey = null,
                    selectedTemplateName = null,
                    templateParameters = emptyList(),
                    notice = "تم تسليم القالب لمسار الإرسال",
                )
                reloadMessages(conversation.id)
            }.onFailure { state = state.failed(userMessage(it)) }
        }
    }

    fun retry(outboxId: Long) {
        if (!capabilities.access.canManage || state.busyKey != null) return
        state = state.copy(busyKey = "retry:$outboxId", error = null)
        val conversationId = state.selectedId ?: return
        viewModelScope.launch {
            runCatching { source.retry(outboxId) }
                .onSuccess {
                    state = state.copy(busyKey = null, notice = "أعيدت محاولة الإرسال")
                    reloadMessages(conversationId)
                }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    fun clearNotice() {
        state = state.copy(notice = null)
    }

    private fun load(append: Boolean, refreshing: Boolean) {
        if (!capabilities.access.canRead || state.loading || state.refreshing || state.loadingMore) return
        if (capabilities.allBranches && state.branchId == null) {
            state = state.failed("اختر الفرع لعرض محادثاته")
            return
        }
        state = state.copy(
            loading = !append && !refreshing,
            refreshing = refreshing,
            loadingMore = append,
            error = null,
            notice = null,
        )
        val request = ConversationListRequest(
            filter = state.filter,
            channel = state.channel,
            query = state.query,
            branchId = state.branchId,
            cursor = state.nextCursor.takeIf { append },
        )
        viewModelScope.launch {
            runCatching { source.list(request) }
                .onSuccess { state = state.loaded(it.rows, it.nextCursor, append) }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    private fun reloadMessages(conversationId: Long) {
        viewModelScope.launch {
            runCatching { source.messages(conversationId) }
                .onSuccess { if (state.selectedId == conversationId) state = state.copy(messages = it, loadingMessages = false) }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class ConversationsViewModelFactory(
    private val source: ConversationsDataSource,
    private val capabilities: ConversationCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        ConversationsViewModel(source, capabilities) as T
}

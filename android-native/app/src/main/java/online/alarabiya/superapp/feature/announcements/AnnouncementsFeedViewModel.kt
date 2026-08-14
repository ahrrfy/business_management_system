package online.alarabiya.superapp.feature.announcements

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.AnnouncementsDataSource

class AnnouncementsFeedViewModel(private val source: AnnouncementsDataSource) : ViewModel() {
    var state by mutableStateOf(AnnouncementsFeedUiState())
        private set

    fun refresh() {
        if (state.loading) return
        state = AnnouncementsFeedStateReducer.refreshing(state)
        viewModelScope.launch {
            runCatching { source.myFeed() }
                .onSuccess { state = AnnouncementsFeedStateReducer.refreshed(state, it) }
                .onFailure { error -> state = AnnouncementsFeedStateReducer.refreshFailed(state, userMessage(error)) }
        }
    }

    /** يفتح التفاصيل، ويعلّم الإعلان مقروءاً في الخلفية إن كان غير مقروء (بحارس تشغيلة واحدة). */
    fun openDetail(id: Long) {
        if (id <= 0) return
        state = AnnouncementsFeedStateReducer.selectDetail(state, id)
        val target = state.feed?.rows?.firstOrNull { it.id == id } ?: return
        if (!target.isRead) markRead(id)
    }

    fun closeDetail() {
        state = AnnouncementsFeedStateReducer.clearDetail(state)
    }

    fun acknowledge(id: Long) = mutate("ack:$id", "تم تسجيل إقرارك بالقراءة") {
        source.acknowledge(id)
    }

    fun markRead(id: Long) = mutate("read:$id", null) {
        source.markRead(id)
    }

    private fun mutate(key: String, successMessage: String?, operation: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = AnnouncementsFeedStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            runCatching {
                operation()
                source.myFeed()
            }.onSuccess { feed ->
                state = AnnouncementsFeedStateReducer.operationCompleted(state, feed, successMessage)
            }.onFailure { error ->
                state = AnnouncementsFeedStateReducer.operationFailed(state, userMessage(error))
            }
        }
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "تعذر إكمال العملية"
}

class AnnouncementsFeedViewModelFactory(private val source: AnnouncementsDataSource) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = AnnouncementsFeedViewModel(source) as T
}

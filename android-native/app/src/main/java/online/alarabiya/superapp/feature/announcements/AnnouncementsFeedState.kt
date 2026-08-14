package online.alarabiya.superapp.feature.announcements

import online.alarabiya.superapp.model.announcements.Announcement
import online.alarabiya.superapp.model.announcements.AnnouncementFeed

data class AnnouncementsFeedUiState(
    val feed: AnnouncementFeed? = null,
    val selectedId: Long? = null,
    val loading: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
) {
    /** الإعلان المفتوح حالياً في عرض التفاصيل (إن وُجد ضمن التغذية). */
    val selected: Announcement? get() = feed?.rows?.firstOrNull { it.id == selectedId }
}

internal object AnnouncementsFeedStateReducer {
    fun refreshing(state: AnnouncementsFeedUiState): AnnouncementsFeedUiState =
        state.copy(loading = true, message = null, error = null)

    fun refreshed(state: AnnouncementsFeedUiState, feed: AnnouncementFeed): AnnouncementsFeedUiState =
        state.copy(feed = feed, loading = false, error = null)

    fun refreshFailed(state: AnnouncementsFeedUiState, message: String): AnnouncementsFeedUiState =
        state.copy(loading = false, error = message)

    fun operationStarted(state: AnnouncementsFeedUiState, key: String): AnnouncementsFeedUiState =
        state.copy(busyKey = key, message = null, error = null)

    fun operationCompleted(
        state: AnnouncementsFeedUiState,
        feed: AnnouncementFeed,
        message: String?,
    ): AnnouncementsFeedUiState = state.copy(
        busyKey = null,
        feed = feed,
        message = message,
        error = null,
    )

    fun operationFailed(state: AnnouncementsFeedUiState, message: String): AnnouncementsFeedUiState =
        state.copy(busyKey = null, error = message)

    fun selectDetail(state: AnnouncementsFeedUiState, id: Long): AnnouncementsFeedUiState =
        state.copy(selectedId = id, message = null, error = null)

    fun clearDetail(state: AnnouncementsFeedUiState): AnnouncementsFeedUiState =
        state.copy(selectedId = null, error = null)
}

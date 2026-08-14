package online.alarabiya.superapp.feature.announcements

import online.alarabiya.superapp.model.announcements.AnnouncementDetail
import online.alarabiya.superapp.model.announcements.AnnouncementSummary

/**
 * حالة شاشة إدارة الإعلانات (قائمة ← تفصيل ← محرّر إنشاء).
 * [busyKey] قفل «طلقة واحدة» للعمليات الكاتبة (إنشاء/تفعيل) — يعكس نمط submittingKey في الاعتمادات.
 */
data class AnnouncementsAdminUiState(
    val items: List<AnnouncementSummary> = emptyList(),
    val selectedId: Long? = null,
    val detail: AnnouncementDetail? = null,
    val includeInactive: Boolean = false,
    val editorOpen: Boolean = false,
    val loading: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
) {
    val locked: Boolean get() = busyKey != null

    val selected: AnnouncementSummary?
        get() = items.firstOrNull { it.id == selectedId }
}

/** مُخفِّضات نقيّة تُحوّل الحالة — تُستدعى من [AnnouncementsAdminViewModel] فقط. */
object AnnouncementsAdminReducer {

    fun loaded(state: AnnouncementsAdminUiState, items: List<AnnouncementSummary>): AnnouncementsAdminUiState {
        val retainedId = state.selectedId?.takeIf { id -> items.any { it.id == id } }
        return state.copy(
            loading = false,
            items = items,
            selectedId = retainedId,
            detail = state.detail?.takeIf { it.summary.id == retainedId },
            error = null,
        )
    }

    fun failed(state: AnnouncementsAdminUiState, message: String): AnnouncementsAdminUiState = state.copy(
        loading = false,
        busyKey = null,
        error = message,
    )

    fun detailLoaded(state: AnnouncementsAdminUiState, detail: AnnouncementDetail): AnnouncementsAdminUiState =
        if (state.selectedId == detail.summary.id) state.copy(detail = detail, error = null) else state

    /** يبدأ عمليةً كاتبةً — يعيد null إذا كانت الحالة مقفلةً (طلقة واحدة). */
    fun operationStarted(state: AnnouncementsAdminUiState, key: String): AnnouncementsAdminUiState? =
        if (state.locked) null else state.copy(busyKey = key, error = null, message = null)

    fun operationDone(state: AnnouncementsAdminUiState, message: String): AnnouncementsAdminUiState = state.copy(
        busyKey = null,
        message = message,
        error = null,
    )

    fun operationFailed(state: AnnouncementsAdminUiState, message: String): AnnouncementsAdminUiState = state.copy(
        busyKey = null,
        error = message,
    )

    fun openEditor(state: AnnouncementsAdminUiState): AnnouncementsAdminUiState = state.copy(
        editorOpen = true,
        error = null,
        message = null,
    )

    fun closeEditor(state: AnnouncementsAdminUiState): AnnouncementsAdminUiState = state.copy(editorOpen = false)

    fun select(state: AnnouncementsAdminUiState, id: Long?): AnnouncementsAdminUiState = state.copy(
        selectedId = id,
        detail = state.detail?.takeIf { it.summary.id == id },
        error = null,
    )
}

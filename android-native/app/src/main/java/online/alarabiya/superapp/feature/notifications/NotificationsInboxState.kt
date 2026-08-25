package online.alarabiya.superapp.feature.notifications

import online.alarabiya.superapp.data.NotificationFilter
import online.alarabiya.superapp.model.selfservice.PersonalNotification

/**
 * ن-١ (٢٤/٨) — حالة صندوق الإشعارات الأصيل.
 *
 * لا تُخلط بحقّ التبويب داخل SelfService (السلوك القائم يعرض قائمةً بلا مرشّح ولا تنقّل تلقائيّ).
 * هذه الشاشة تُخصَّص كوجهةٍ من الدرجة الأولى:
 *   - مرشّحاتٌ تعبر خادمياً (اقتطاعُ limit لا يُخفي غير المقروء)،
 *   - نقرةٌ على صفٍّ تُعلّمه مقروءاً وتفتح route الآمن الذي صنعه الخادم،
 *   - عدّاد unreadCount يعكس المصدر الحيّ لا الشاشة.
 */
data class NotificationsInboxUiState(
    val rows: List<PersonalNotification> = emptyList(),
    val unreadCount: Int = 0,
    val filter: NotificationFilter = NotificationFilter.All,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
) {
    val isEmpty: Boolean get() = rows.isEmpty() && !loading
}

internal object NotificationsInboxReducer {
    fun startInitialLoad(state: NotificationsInboxUiState): NotificationsInboxUiState =
        state.copy(loading = true, error = null, message = null)

    fun startRefresh(state: NotificationsInboxUiState): NotificationsInboxUiState =
        state.copy(refreshing = true, error = null, message = null)

    fun loaded(state: NotificationsInboxUiState, rows: List<PersonalNotification>, unreadCount: Int): NotificationsInboxUiState =
        state.copy(rows = rows, unreadCount = unreadCount, loading = false, refreshing = false, error = null)

    fun failed(state: NotificationsInboxUiState, message: String): NotificationsInboxUiState =
        state.copy(loading = false, refreshing = false, error = message)

    fun applyFilter(state: NotificationsInboxUiState, filter: NotificationFilter): NotificationsInboxUiState =
        state.copy(filter = filter, loading = true, error = null, message = null)

    fun operationStarted(state: NotificationsInboxUiState, key: String): NotificationsInboxUiState =
        state.copy(busyKey = key, error = null, message = null)

    fun operationCompleted(
        state: NotificationsInboxUiState,
        rows: List<PersonalNotification>,
        unreadCount: Int,
        message: String? = null,
    ): NotificationsInboxUiState = state.copy(
        rows = rows,
        unreadCount = unreadCount,
        busyKey = null,
        message = message,
        error = null,
    )

    fun operationFailed(state: NotificationsInboxUiState, message: String): NotificationsInboxUiState =
        state.copy(busyKey = null, error = message)

    fun dismissMessage(state: NotificationsInboxUiState): NotificationsInboxUiState =
        state.copy(message = null, error = null)
}

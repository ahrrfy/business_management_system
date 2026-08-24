package online.alarabiya.superapp.feature.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.NotificationFilter
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.model.selfservice.NotificationCenter

/**
 * ن-١ (٢٤/٨) — يقود الصندوق الأصيل عبر إعادة استعمال SelfServiceDataSource دون بناء API جديدة.
 * كل تغيير حالةٍ يعيد جلب المصدر ليتوافق العدّاد مع القائمة الظاهرة.
 */
class NotificationsInboxViewModel(private val source: SelfServiceDataSource) : ViewModel() {
    var state by mutableStateOf(NotificationsInboxUiState())
        private set

    /**
     * Codex P2 (٢٥/٨) — نتتبّع Job قراءة الصندوق ونُلغيه قبل بدء آخر جديد. لولا هذا، ضغطاتٌ
     * متلاحقة على مرشّحاتٍ مختلفة تُطلق عدّة تحميلاتٍ متوازية تُخزّن نتائجها بلا فحصٍ للمرشّح
     * الحاليّ ⇒ نتيجةٌ قديمة قد تكتب فوق نتيجةٍ جديدة بينما chip المرشّح ظاهرٌ للأخيرة.
     */
    private var loadJob: Job? = null

    fun refresh(initial: Boolean = false) {
        if (state.refreshing) return
        state = if (initial) NotificationsInboxReducer.startInitialLoad(state)
        else NotificationsInboxReducer.startRefresh(state)
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load(state.filter) }
    }

    fun setFilter(filter: NotificationFilter) {
        if (filter == state.filter) return
        state = NotificationsInboxReducer.applyFilter(state, filter)
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load(filter) }
    }

    /**
     * تُعلَّم مقروءةً محلياً وخادمياً بمعرِّفٍ واحد؛ الاستدعاء المضاعف يُعتَذَر عنه محلياً
     * بحارس busyKey فلا نُرسل mutations مكرَّرة لنفس السجلّ.
     */
    fun markRead(id: Long) {
        if (id <= 0 || state.busyKey == "read:$id") return
        state = NotificationsInboxReducer.operationStarted(state, "read:$id")
        viewModelScope.launch {
            runCatching {
                source.markNotificationRead(id)
                source.loadNotifications(filter = state.filter)
            }.onSuccess { center ->
                state = NotificationsInboxReducer.operationCompleted(state, center.rows, center.unreadCount)
            }.onFailure { error ->
                state = NotificationsInboxReducer.operationFailed(state, humanMessage(error))
            }
        }
    }

    fun markAllRead() {
        if (state.busyKey != null || state.unreadCount == 0) return
        state = NotificationsInboxReducer.operationStarted(state, "readAll")
        viewModelScope.launch {
            runCatching {
                source.markAllNotificationsRead()
                source.loadNotifications(filter = state.filter)
            }.onSuccess { center ->
                state = NotificationsInboxReducer.operationCompleted(
                    state = state,
                    rows = center.rows,
                    unreadCount = center.unreadCount,
                    message = "عُلِّمت كلّ الإشعارات مقروءةً",
                )
            }.onFailure { error ->
                state = NotificationsInboxReducer.operationFailed(state, humanMessage(error))
            }
        }
    }

    fun dismissBanner() {
        state = NotificationsInboxReducer.dismissMessage(state)
    }

    private suspend fun load(filter: NotificationFilter) {
        try {
            val center: NotificationCenter = source.loadNotifications(filter = filter)
            // فحصٌ مضاعف: قد يكون Job نجا من cancel + ردٌّ متأخّرٌ عن مرشّح سابق. نُقارن مع
            // state.filter الحاليّ فلا نكتب فوق نتيجةٍ لمرشّحٍ أحدث. (يحدث نظرياً إن جاء الردّ
            // بين cancel و launch التاليَين — نتفادى السباق نهائياً.)
            if (state.filter != filter) return
            state = NotificationsInboxReducer.loaded(state, center.rows, center.unreadCount)
        } catch (e: CancellationException) {
            throw e
        } catch (error: Throwable) {
            if (state.filter != filter) return
            state = NotificationsInboxReducer.failed(state, humanMessage(error))
        }
    }

    private fun humanMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "تعذّر تحديث الإشعارات"
}

class NotificationsInboxViewModelFactory(
    private val source: SelfServiceDataSource,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = NotificationsInboxViewModel(source) as T
}

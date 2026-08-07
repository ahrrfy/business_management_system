package online.alarabiya.superapp.feature.selfservice

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.PersonalPayslip
import online.alarabiya.superapp.model.selfservice.SelfServiceSnapshot

enum class SelfServiceSection {
    Profile,
    Attendance,
    Payroll,
    Tasks,
    Leaves,
    Notifications,
}

data class SelfServiceUiState(
    val section: SelfServiceSection = SelfServiceSection.Profile,
    val snapshot: SelfServiceSnapshot? = null,
    val loading: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
    val selectedPayslipItemId: Long? = null,
    val selectedPayslip: PersonalPayslip? = null,
)

internal object SelfServiceStateReducer {
    fun selected(state: SelfServiceUiState, section: SelfServiceSection): SelfServiceUiState =
        state.copy(section = section, message = null, error = null)

    fun refreshing(state: SelfServiceUiState): SelfServiceUiState =
        state.copy(loading = true, message = null, error = null)

    fun refreshed(state: SelfServiceUiState, snapshot: SelfServiceSnapshot): SelfServiceUiState =
        state.copy(snapshot = snapshot, loading = false, error = null)

    fun operationStarted(state: SelfServiceUiState, key: String): SelfServiceUiState =
        state.copy(busyKey = key, message = null, error = null)

    fun operationCompleted(
        state: SelfServiceUiState,
        snapshot: SelfServiceSnapshot,
        message: String?,
    ): SelfServiceUiState = state.copy(
        busyKey = null,
        snapshot = snapshot,
        message = message,
        error = null,
    )

    fun notificationPreferencesSaved(
        state: SelfServiceUiState,
        preferences: NotificationPreferences,
    ): SelfServiceUiState = state.copy(
        busyKey = null,
        message = "تم حفظ تفضيلات التنبيهات",
        error = null,
        snapshot = state.snapshot?.copy(notificationPreferences = preferences),
    )

    fun refreshFailed(state: SelfServiceUiState, message: String): SelfServiceUiState =
        state.copy(loading = false, error = message)

    fun operationFailed(state: SelfServiceUiState, message: String): SelfServiceUiState =
        state.copy(busyKey = null, error = message)
}

class SelfServiceViewModel(private val source: SelfServiceDataSource) : ViewModel() {
    var state by mutableStateOf(SelfServiceUiState())
        private set

    fun select(section: SelfServiceSection) {
        state = SelfServiceStateReducer.selected(state, section)
    }

    fun refresh() {
        if (state.loading) return
        state = SelfServiceStateReducer.refreshing(state)
        viewModelScope.launch {
            runCatching { loadSnapshot() }
                .onSuccess { state = SelfServiceStateReducer.refreshed(state, it) }
                .onFailure { error -> state = SelfServiceStateReducer.refreshFailed(state, userMessage(error)) }
        }
    }

    fun performTaskAction(taskId: Long, action: PersonalTaskAction, note: String? = null) =
        mutate("task:$taskId:${action.name}", "تم تحديث المهمة") {
            source.performTaskAction(taskId, action, note)
        }

    fun requestLeave(leaveType: String, fromDate: String, toDate: String, reason: String?) =
        mutate("leave:new", "تم إرسال طلب الإجازة للمراجعة") {
            source.requestLeave(leaveType, fromDate, toDate, reason)
        }

    fun withdrawLeave(id: Long) = mutate("leave:$id", "تم سحب طلب الإجازة") {
        source.withdrawLeave(id)
    }

    fun markNotificationRead(id: Long) = mutate("notification:$id", null) {
        source.markNotificationRead(id)
    }

    fun markAllNotificationsRead() = mutate("notifications:all", "تم تعليم التنبيهات كمقروءة") {
        source.markAllNotificationsRead()
    }

    fun saveNotificationPreferences(preferences: NotificationPreferences) {
        if (state.busyKey != null) return
        state = SelfServiceStateReducer.operationStarted(state, "notifications:preferences")
        viewModelScope.launch {
            runCatching { source.updateNotificationPreferences(preferences) }
                .onSuccess { saved ->
                    state = SelfServiceStateReducer.notificationPreferencesSaved(state, saved)
                }
                .onFailure { error -> state = SelfServiceStateReducer.operationFailed(state, userMessage(error)) }
        }
    }

    fun openPayslip(payrollItemId: Long) {
        if (state.busyKey != null || payrollItemId <= 0) return
        state = SelfServiceStateReducer.operationStarted(state, "payslip:$payrollItemId")
            .copy(selectedPayslipItemId = payrollItemId, selectedPayslip = null)
        viewModelScope.launch {
            runCatching { source.loadPayslip(payrollItemId) }
                .onSuccess { detail ->
                    state = state.copy(busyKey = null, selectedPayslip = detail, error = null)
                }
                .onFailure { error ->
                    state = SelfServiceStateReducer.operationFailed(state, userMessage(error))
                        .copy(selectedPayslipItemId = null, selectedPayslip = null)
                }
        }
    }

    fun closePayslip() {
        if (state.busyKey != null) return
        state = state.copy(selectedPayslipItemId = null, selectedPayslip = null, error = null)
    }

    private fun mutate(key: String, successMessage: String?, operation: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = SelfServiceStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            runCatching {
                operation()
                loadSnapshot()
            }.onSuccess { snapshot ->
                state = SelfServiceStateReducer.operationCompleted(state, snapshot, successMessage)
            }.onFailure { error ->
                state = SelfServiceStateReducer.operationFailed(state, userMessage(error))
            }
        }
    }

    private suspend fun loadSnapshot(): SelfServiceSnapshot = coroutineScope {
        val workspace = async { source.loadWorkspace() }
        val notifications = async { source.loadNotifications() }
        val preferences = async { source.loadNotificationPreferences() }
        val payrollHistory = async { source.loadPayrollHistory() }
        SelfServiceSnapshot(
            workspace = workspace.await(),
            notifications = notifications.await(),
            notificationPreferences = preferences.await(),
            payrollHistory = payrollHistory.await(),
        )
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "تعذر إكمال العملية"
}

class SelfServiceViewModelFactory(private val source: SelfServiceDataSource) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = SelfServiceViewModel(source) as T
}

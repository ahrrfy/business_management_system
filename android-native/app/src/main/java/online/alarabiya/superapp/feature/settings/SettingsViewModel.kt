package online.alarabiya.superapp.feature.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.LegalDataSource
import online.alarabiya.superapp.data.SelfServiceDataSource

class SettingsViewModel(
    initialState: SettingsUiState,
    private val legalSource: LegalDataSource,
    private val selfServiceSource: SelfServiceDataSource,
) : ViewModel() {
    var state by mutableStateOf(initialState)
        private set

    init {
        refreshLegal()
    }

    fun refreshLegal() {
        state = state.copy(legal = LegalUiState.Loading)
        viewModelScope.launch {
            runCatching { legalSource.loadPrivacyPolicy() }
                .onSuccess { document -> state = state.copy(legal = LegalUiState.Content(document)) }
                .onFailure {
                    state = state.copy(
                        legal = LegalUiState.Error("تعذر تحميل سياسة الخصوصية"),
                    )
                }
        }
    }

    fun setNotification(key: NotificationSettingKey, enabled: Boolean) {
        if (state.notificationsSaving) return
        val previous = state.notifications
        val updated = SettingsStateMapper.updateNotification(previous, key, enabled)
        state = state.copy(
            notifications = updated,
            notificationsSaving = true,
            notificationsError = null,
        )
        viewModelScope.launch {
            runCatching { selfServiceSource.updateNotificationPreferences(updated) }
                .onSuccess { saved ->
                    state = state.copy(notifications = saved, notificationsSaving = false)
                }
                .onFailure {
                    state = state.copy(
                        notifications = previous,
                        notificationsSaving = false,
                        notificationsError = "تعذر حفظ الإشعارات",
                    )
                }
        }
    }

    fun setBiometricEnabled(enabled: Boolean) {
        state = state.copy(biometricEnabled = enabled)
    }
}

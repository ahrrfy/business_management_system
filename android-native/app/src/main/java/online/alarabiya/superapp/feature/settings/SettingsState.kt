package online.alarabiya.superapp.feature.settings

import online.alarabiya.superapp.data.LegalDocument
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.selfservice.NotificationPreferences

data class SettingsAccount(
    val name: String,
    val identifier: String,
    val role: String,
    val branch: String,
)

enum class NotificationSettingKey {
    Tasks,
    Payroll,
    Attendance,
    Leave,
    Approvals,
}

sealed interface LegalUiState {
    data object Loading : LegalUiState
    data class Content(val document: LegalDocument) : LegalUiState
    data class Error(val message: String) : LegalUiState
}

data class SettingsUiState(
    val account: SettingsAccount,
    val notifications: NotificationPreferences,
    val notificationsSaving: Boolean = false,
    val notificationsError: String? = null,
    val biometricAvailable: Boolean,
    val biometricEnabled: Boolean,
    val legal: LegalUiState = LegalUiState.Loading,
    val appVersion: String,
)

object SettingsStateMapper {
    fun account(bootstrap: AppBootstrap): SettingsAccount = SettingsAccount(
        name = bootstrap.user.name,
        identifier = bootstrap.user.email
            ?: bootstrap.user.username
            ?: "—",
        role = bootstrap.user.roleLabel,
        branch = when {
            bootstrap.allBranches -> "كل الفروع"
            bootstrap.branchId != null -> "الفرع ${bootstrap.branchId}"
            else -> "غير محدد"
        },
    )

    fun notificationValue(
        preferences: NotificationPreferences,
        key: NotificationSettingKey,
    ): Boolean = when (key) {
        NotificationSettingKey.Tasks -> preferences.taskAssigned
        NotificationSettingKey.Payroll -> preferences.payrollReady
        NotificationSettingKey.Attendance -> preferences.attendance
        NotificationSettingKey.Leave -> preferences.leaveStatus
        NotificationSettingKey.Approvals -> preferences.approvals
    }

    fun updateNotification(
        preferences: NotificationPreferences,
        key: NotificationSettingKey,
        enabled: Boolean,
    ): NotificationPreferences = when (key) {
        NotificationSettingKey.Tasks -> preferences.copy(taskAssigned = enabled)
        NotificationSettingKey.Payroll -> preferences.copy(payrollReady = enabled)
        NotificationSettingKey.Attendance -> preferences.copy(attendance = enabled)
        NotificationSettingKey.Leave -> preferences.copy(leaveStatus = enabled)
        NotificationSettingKey.Approvals -> preferences.copy(approvals = enabled)
    }
}

package online.alarabiya.superapp.feature.security

import online.alarabiya.superapp.data.TwoFactorAccountStatus
import online.alarabiya.superapp.data.TwoFactorEnrollment

sealed interface TwoFactorContent {
    data object Loading : TwoFactorContent
    data class Ready(val status: TwoFactorAccountStatus) : TwoFactorContent
    data class Failed(val message: String) : TwoFactorContent
}

data class TwoFactorUiState(
    val content: TwoFactorContent = TwoFactorContent.Loading,
    val busy: Boolean = false,
    val enrollment: TwoFactorEnrollment? = null,
    val recoveryCodes: List<String> = emptyList(),
    val message: String? = null,
)

object TwoFactorValidation {
    fun password(value: String): Boolean = value.isNotBlank() && value.length <= 128
    fun authenticatorCode(value: String): Boolean = value.trim().matches(Regex("^[0-9]{6}$"))
    fun recoveryCode(value: String): Boolean = value.trim().length in 6..64
}

object TwoFactorEntryPolicy {
    /** إدارة العامل الثاني خدمة ذاتية؛ يحدد الخادم الأفعال المسموحة للمستخدم المصادق عليه. */
    fun visible(authenticated: Boolean, role: String): Boolean = authenticated && role.isNotBlank()
}

object AuthenticatorUriPolicy {
    fun canOpen(value: String): Boolean = value.length <= 2_048 && value.startsWith("otpauth://totp/")
}

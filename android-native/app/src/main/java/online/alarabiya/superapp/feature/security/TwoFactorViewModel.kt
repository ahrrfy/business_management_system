package online.alarabiya.superapp.feature.security

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.TwoFactorDataSource
import online.alarabiya.superapp.data.TwoFactorVerification

class TwoFactorViewModel(private val source: TwoFactorDataSource) : ViewModel() {
    var state by mutableStateOf(TwoFactorUiState())
        private set

    init { refresh() }

    fun refresh() {
        if (state.busy) return
        state = state.copy(content = TwoFactorContent.Loading, message = null)
        viewModelScope.launch {
            runCatching { source.status() }
                .onSuccess { state = state.copy(content = TwoFactorContent.Ready(it)) }
                .onFailure { state = state.copy(content = TwoFactorContent.Failed(it.safeMessage())) }
        }
    }

    fun startEnrollment(password: String) {
        if (!TwoFactorValidation.password(password)) {
            state = state.copy(message = "أدخل كلمة المرور الحالية")
            return
        }
        mutate {
            val enrollment = source.startEnrollment(password)
            state = state.copy(enrollment = enrollment, recoveryCodes = emptyList())
        }
    }

    fun confirmEnrollment(code: String) {
        if (!TwoFactorValidation.authenticatorCode(code)) {
            state = state.copy(message = "أدخل رمزاً صحيحاً من 6 أرقام")
            return
        }
        mutate(refreshAfter = true) {
            val codes = source.confirmEnrollment(code)
            state = state.copy(enrollment = null, recoveryCodes = codes)
        }
    }

    fun regenerateRecoveryCodes(password: String, code: String) {
        if (!TwoFactorValidation.password(password) || !TwoFactorValidation.authenticatorCode(code)) {
            state = state.copy(message = "تحقق من كلمة المرور ورمز المصادقة")
            return
        }
        mutate(refreshAfter = true) {
            state = state.copy(recoveryCodes = source.regenerateRecoveryCodes(password, code))
        }
    }

    fun disable(password: String, verification: TwoFactorVerification) {
        val validVerification = when (verification) {
            is TwoFactorVerification.AuthenticatorCode -> TwoFactorValidation.authenticatorCode(verification.value)
            is TwoFactorVerification.RecoveryCode -> TwoFactorValidation.recoveryCode(verification.value)
        }
        if (!TwoFactorValidation.password(password) || !validVerification) {
            state = state.copy(message = "تحقق من كلمة المرور ورمز التحقق")
            return
        }
        mutate(refreshAfter = true) {
            source.disable(password, verification)
            state = state.copy(enrollment = null, recoveryCodes = emptyList(), message = "تم تعطيل المصادقة الثنائية")
        }
    }

    /** رموز الاسترداد أسرار تُعرض مرة واحدة؛ تُزال فور إقرار المستخدم بحفظها. */
    fun acknowledgeRecoveryCodes() {
        state = state.copy(recoveryCodes = emptyList(), message = null)
    }

    fun clearMessage() { state = state.copy(message = null) }

    private fun mutate(refreshAfter: Boolean = false, operation: suspend () -> Unit) {
        if (state.busy) return
        state = state.copy(busy = true, message = null)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess {
                    state = state.copy(busy = false)
                    if (refreshAfter) refresh()
                }
                .onFailure { state = state.copy(busy = false, message = it.safeMessage()) }
        }
    }

    companion object {
        fun factory(source: TwoFactorDataSource): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = TwoFactorViewModel(source) as T
        }
    }
}

private fun Throwable.safeMessage(): String =
    message?.takeIf { it.isNotBlank() && it.length <= 240 } ?: "تعذر إكمال العملية"

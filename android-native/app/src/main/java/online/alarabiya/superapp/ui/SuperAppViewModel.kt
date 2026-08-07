package online.alarabiya.superapp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.data.SuperAppRepository
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.AuthPolicyCode
import online.alarabiya.superapp.model.LoginOutcome
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.ModuleMetric
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.TwoFactorEnrollmentStep
import online.alarabiya.superapp.model.TwoFactorSetup
import online.alarabiya.superapp.model.UserIdentity

sealed interface AppSessionState {
    data object Starting : AppSessionState
    data class Locked(val userName: String?) : AppSessionState
    data class SignedOut(
        val submitting: Boolean = false,
        val error: String? = null,
        val twoFactorTicket: String? = null,
    ) : AppSessionState
    data class PasswordChangeRequired(
        val user: UserIdentity,
        val submitting: Boolean = false,
        val error: String? = null,
    ) : AppSessionState
    data class TwoFactorEnrollmentRequired(
        val status: String,
        val setup: TwoFactorSetup? = null,
        val recoveryCodes: List<String> = emptyList(),
        val submitting: Boolean = false,
        val error: String? = null,
    ) : AppSessionState
    data class SessionUnavailable(
        val error: String,
        val correlationId: String? = null,
    ) : AppSessionState
    data class Loading(val message: String = "جارٍ مزامنة مساحة العمل") : AppSessionState
    data class Ready(
        val bootstrap: AppBootstrap,
        val workspace: PersonalWorkspace,
        val biometricEnabled: Boolean,
    ) : AppSessionState
}

data class ModuleSheetState(
    val module: ModuleAccess,
    val loading: Boolean = true,
    val metrics: List<ModuleMetric> = emptyList(),
    val error: String? = null,
)

class SuperAppViewModel(private val repository: SuperAppRepository) : ViewModel() {
    var sessionState: AppSessionState by mutableStateOf(AppSessionState.Starting)
        private set
    var selectedModule: ModuleSheetState? by mutableStateOf(null)
        private set
    private var pendingUser: UserIdentity? = repository.cachedUser()

    init {
        if (!repository.hasSession()) sessionState = AppSessionState.SignedOut()
        else if (repository.isBiometricEnabled()) {
            sessionState = AppSessionState.Locked(repository.cachedUserName())
        } else refresh()
    }

    fun login(identifier: String, password: String, remember: Boolean) {
        if (identifier.isBlank() || password.isBlank()) {
            sessionState = AppSessionState.SignedOut(error = "أدخل اسم المستخدم أو البريد وكلمة المرور")
            return
        }
        sessionState = AppSessionState.SignedOut(submitting = true)
        viewModelScope.launch {
            runCatching { repository.login(identifier, password, remember) }
                .onSuccess { outcome ->
                    when (outcome) {
                        is LoginOutcome.Success -> continueAuthenticated(outcome.user)
                        is LoginOutcome.TwoFactorRequired -> sessionState =
                            AppSessionState.SignedOut(twoFactorTicket = outcome.ticket)
                    }
                }
                .onFailure { error -> sessionState = AppSessionState.SignedOut(error = userMessage(error)) }
        }
    }

    fun verifyTwoFactor(code: String) {
        val ticket = (sessionState as? AppSessionState.SignedOut)?.twoFactorTicket ?: return
        if (code.isBlank()) {
            sessionState = AppSessionState.SignedOut(twoFactorTicket = ticket, error = "أدخل رمز التحقق")
            return
        }
        sessionState = AppSessionState.SignedOut(submitting = true, twoFactorTicket = ticket)
        viewModelScope.launch {
            runCatching { repository.verifyTwoFactor(ticket, code) }
                .onSuccess { continueAuthenticated(it.user) }
                .onFailure { error ->
                    sessionState = AppSessionState.SignedOut(twoFactorTicket = ticket, error = userMessage(error))
                }
        }
    }

    fun biometricUnlocked() = refresh()

    fun biometricCancelled() {
        sessionState = AppSessionState.Locked(repository.cachedUserName())
    }

    fun usePasswordInstead() {
        sessionState = AppSessionState.Loading("جارٍ تأمين الجلسة")
        viewModelScope.launch {
            repository.logout()
            pendingUser = null
            selectedModule = null
            sessionState = AppSessionState.SignedOut()
        }
    }

    fun enableBiometric() {
        repository.setBiometricEnabled(true)
        val ready = sessionState as? AppSessionState.Ready ?: return
        sessionState = ready.copy(biometricEnabled = true)
    }

    fun disableBiometric() {
        repository.setBiometricEnabled(false)
        val ready = sessionState as? AppSessionState.Ready ?: return
        sessionState = ready.copy(biometricEnabled = false)
    }

    fun changeRequiredPassword(oldPassword: String, newPassword: String) {
        val current = sessionState as? AppSessionState.PasswordChangeRequired ?: return
        if (oldPassword.isBlank() || newPassword.isBlank()) {
            sessionState = current.copy(error = "أدخل كلمة المرور الحالية والجديدة")
            return
        }
        sessionState = current.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.changePassword(oldPassword, newPassword) }
                .onSuccess {
                    continueAuthenticated(current.user.copy(mustChangePassword = false))
                }
                .onFailure { error ->
                    sessionState = current.copy(submitting = false, error = userMessage(error))
                }
        }
    }

    fun startTwoFactorEnrollment(password: String) {
        val current = sessionState as? AppSessionState.TwoFactorEnrollmentRequired ?: return
        if (password.isBlank()) {
            sessionState = current.copy(error = "أدخل كلمة المرور الحالية")
            return
        }
        sessionState = current.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.startTwoFactorEnrollment(password) }
                .onSuccess { setup ->
                    sessionState = AppSessionState.TwoFactorEnrollmentRequired(
                        status = TwoFactorEnrollmentStep.SETUP,
                        setup = setup,
                    )
                }
                .onFailure { error ->
                    sessionState = current.copy(submitting = false, error = userMessage(error))
                }
        }
    }

    fun confirmTwoFactorEnrollment(code: String) {
        val current = sessionState as? AppSessionState.TwoFactorEnrollmentRequired ?: return
        if (current.status != TwoFactorEnrollmentStep.SETUP || current.setup == null) return
        if (code.isBlank()) {
            sessionState = current.copy(error = "أدخل رمز التحقق من تطبيق المصادقة")
            return
        }
        sessionState = current.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.confirmTwoFactorEnrollment(code) }
                .onSuccess { recoveryCodes ->
                    sessionState = AppSessionState.TwoFactorEnrollmentRequired(
                        status = TwoFactorEnrollmentStep.RECOVERY,
                        recoveryCodes = recoveryCodes,
                    )
                }
                .onFailure { error ->
                    sessionState = current.copy(submitting = false, error = userMessage(error))
                }
        }
    }

    fun dismissRecoveryCodes() {
        val current = sessionState as? AppSessionState.TwoFactorEnrollmentRequired ?: return
        if (current.status != TwoFactorEnrollmentStep.RECOVERY) return
        pendingUser = pendingUser?.copy(mustEnrollTwoFactor = false)
        refresh()
    }

    fun retrySession() = refresh()

    fun refresh() {
        sessionState = AppSessionState.Loading()
        viewModelScope.launch {
            runCatching {
                repository.verifyRuntimeContract()
                val bootstrap = async { repository.loadBootstrap() }
                val workspace = async { repository.loadWorkspace() }
                bootstrap.await() to workspace.await()
            }.onSuccess { (bootstrap, workspace) ->
                pendingUser = bootstrap.user
                sessionState = AppSessionState.Ready(
                    bootstrap = bootstrap,
                    workspace = workspace,
                    biometricEnabled = repository.isBiometricEnabled(),
                )
            }.onFailure { error ->
                handleRefreshFailure(error)
            }
        }
    }

    fun openModule(module: ModuleAccess) {
        selectedModule = ModuleSheetState(module = module)
        viewModelScope.launch {
            runCatching { repository.loadModuleMetrics(module.key) }
                .onSuccess { selectedModule = ModuleSheetState(module = module, loading = false, metrics = it) }
                .onFailure { selectedModule = ModuleSheetState(module = module, loading = false, error = userMessage(it)) }
        }
    }

    fun closeModule() {
        selectedModule = null
    }

    fun logout() {
        viewModelScope.launch {
            repository.logout()
            pendingUser = null
            selectedModule = null
            sessionState = AppSessionState.SignedOut()
        }
    }

    private fun continueAuthenticated(user: UserIdentity) {
        pendingUser = user
        sessionState = when {
            user.mustChangePassword -> AppSessionState.PasswordChangeRequired(user)
            user.mustEnrollTwoFactor -> AppSessionState.TwoFactorEnrollmentRequired(
                status = TwoFactorEnrollmentStep.PASSWORD,
            )
            else -> {
                refresh()
                return
            }
        }
    }

    private suspend fun handleRefreshFailure(error: Throwable) {
        val apiError = error as? ApiException
        if (apiError?.status == 401 || apiError?.code == "UNAUTHORIZED") {
            repository.clearLocalSession()
            pendingUser = null
            sessionState = AppSessionState.SignedOut(error = userMessage(error))
            return
        }

        when (apiError?.appCode) {
            AuthPolicyCode.PASSWORD_CHANGE_REQUIRED -> {
                val user = resolveAuthenticatedUser()
                if (user != null) sessionState = AppSessionState.PasswordChangeRequired(user)
                else sessionState = unavailable(error, apiError)
            }
            AuthPolicyCode.TWO_FACTOR_ENROLLMENT_REQUIRED -> {
                pendingUser = resolveAuthenticatedUser() ?: pendingUser
                if (pendingUser != null) {
                    sessionState = AppSessionState.TwoFactorEnrollmentRequired(
                        status = TwoFactorEnrollmentStep.PASSWORD,
                    )
                } else sessionState = unavailable(error, apiError)
            }
            else -> sessionState = unavailable(error, apiError)
        }
    }

    private suspend fun resolveAuthenticatedUser(): UserIdentity? {
        val remote = runCatching { repository.currentUser() }.getOrNull()
        if (remote != null) pendingUser = remote
        return remote ?: pendingUser ?: repository.cachedUser()
    }

    private fun unavailable(error: Throwable, apiError: ApiException?) =
        AppSessionState.SessionUnavailable(
            error = userMessage(error),
            correlationId = apiError?.correlationId,
        )

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "تعذر إكمال العملية"
}

class SuperAppViewModelFactory(private val repository: SuperAppRepository) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = SuperAppViewModel(repository) as T
}

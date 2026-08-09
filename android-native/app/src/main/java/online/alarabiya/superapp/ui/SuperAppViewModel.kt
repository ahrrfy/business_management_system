package online.alarabiya.superapp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.data.SuperAppRepository
import online.alarabiya.superapp.data.ExecutiveDataSource
import online.alarabiya.superapp.feature.executive.ExecutiveHomeState
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
        val companyCodeRequired: Boolean = false,
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
        val usingCachedData: Boolean = false,
    ) : AppSessionState
}

data class ModuleSheetState(
    val module: ModuleAccess,
    val loading: Boolean = true,
    val metrics: List<ModuleMetric> = emptyList(),
    val error: String? = null,
)

class SuperAppViewModel(
    private val repository: SuperAppRepository,
    private val executiveSource: ExecutiveDataSource? = null,
) : ViewModel() {
    var sessionState: AppSessionState by mutableStateOf(AppSessionState.Starting)
        private set
    var selectedModule: ModuleSheetState? by mutableStateOf(null)
        private set
    var executiveState: ExecutiveHomeState by mutableStateOf(ExecutiveHomeState.Loading)
        private set
    private var pendingUser: UserIdentity? = repository.cachedUser()
    private val executiveRequests = ExecutiveRequestGate()
    private var executiveJob: Job? = null

    init {
        if (!repository.hasSession()) {
            sessionState = AppSessionState.SignedOut()
            resolveTenancyMode()
        }
        else if (repository.isBiometricEnabled()) {
            sessionState = AppSessionState.Locked(repository.cachedUserName())
        } else refresh()
    }

    fun login(identifier: String, password: String, remember: Boolean, companyCode: String?) {
        val current = sessionState as? AppSessionState.SignedOut ?: return
        if (identifier.isBlank() || password.isBlank() || (current.companyCodeRequired && companyCode.isNullOrBlank())) {
            sessionState = current.copy(
                error = if (current.companyCodeRequired && companyCode.isNullOrBlank()) {
                    "أدخل رمز الشركة"
                } else {
                    "أدخل اسم المستخدم أو البريد وكلمة المرور"
                },
            )
            return
        }
        resetExecutiveState()
        sessionState = current.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.login(identifier, password, remember, companyCode) }
                .onSuccess { outcome ->
                    when (outcome) {
                        is LoginOutcome.Success -> continueAuthenticated(outcome.user)
                        is LoginOutcome.TwoFactorRequired -> sessionState =
                            current.copy(twoFactorTicket = outcome.ticket, error = null)
                    }
                }
                .onFailure { error -> sessionState = current.copy(error = userMessage(error)) }
        }
    }

    private fun resolveTenancyMode() {
        viewModelScope.launch {
            runCatching { repository.verifyRuntimeContract() }
                .onSuccess { mode ->
                    val current = sessionState as? AppSessionState.SignedOut ?: return@onSuccess
                    sessionState = current.copy(companyCodeRequired = mode.companyCodeRequired)
                }
                // A transient discovery failure must not permanently disable the login form.
                // login() performs the same bounded discovery request and surfaces its error.
                .onFailure { }
        }
    }

    fun verifyTwoFactor(code: String) {
        val current = sessionState as? AppSessionState.SignedOut ?: return
        val ticket = current.twoFactorTicket ?: return
        if (code.isBlank()) {
            sessionState = current.copy(error = "أدخل رمز التحقق")
            return
        }
        sessionState = current.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.verifyTwoFactor(ticket, code) }
                .onSuccess { continueAuthenticated(it.user) }
                .onFailure { error ->
                    sessionState = current.copy(error = userMessage(error))
                }
        }
    }

    fun biometricUnlocked() = refresh()

    fun biometricCancelled() {
        resetExecutiveState()
        sessionState = AppSessionState.Locked(repository.cachedUserName())
    }

    fun usePasswordInstead() {
        resetExecutiveState()
        sessionState = AppSessionState.Loading("جارٍ تأمين الجلسة")
        viewModelScope.launch {
            repository.logout()
            pendingUser = null
            selectedModule = null
            sessionState = AppSessionState.SignedOut()
            resolveTenancyMode()
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
        val executiveLifecycle = resetExecutiveState()
        sessionState = AppSessionState.Loading()
        viewModelScope.launch {
            runCatching {
                repository.verifyRuntimeContract()
                val bootstrap = repository.loadBootstrap()
                val workspace = if (bootstrap.hasPersonalWorkspace) {
                    repository.loadWorkspace()
                } else {
                    PersonalWorkspace(
                        date = java.time.LocalDate.now().toString(),
                        employee = null,
                        attendance = null,
                        tasks = emptyList(),
                        notifications = emptyList(),
                        payroll = null,
                    )
                }
                bootstrap to workspace
            }.onSuccess { (bootstrap, workspace) ->
                if (!executiveRequests.isLifecycleCurrent(executiveLifecycle)) return@onSuccess
                pendingUser = bootstrap.user
                sessionState = AppSessionState.Ready(
                    bootstrap = bootstrap,
                    workspace = workspace,
                    biometricEnabled = repository.isBiometricEnabled(),
                )
                if (bootstrap.hasExecutiveHome()) {
                    startExecutiveLoad(bootstrap, executiveLifecycle)
                }
            }.onFailure { error ->
                if (!executiveRequests.isLifecycleCurrent(executiveLifecycle)) return@onFailure
                val apiError = error as? ApiException
                val cached = if (apiError?.retryableTransportFailure == true) {
                    repository.loadCachedHome()
                } else {
                    null
                }
                if (cached != null) {
                    pendingUser = cached.first.user
                    sessionState = AppSessionState.Ready(
                        bootstrap = cached.first,
                        workspace = cached.second,
                        biometricEnabled = repository.isBiometricEnabled(),
                        usingCachedData = true,
                    )
                    settleCachedExecutive(cached.first, executiveLifecycle)
                } else {
                    val bootstrap = if (apiError?.retryableTransportFailure == true) repository.loadCachedBootstrap() else null
                    if (bootstrap?.hasExecutiveHome() == true && !bootstrap.hasPersonalWorkspace) {
                        pendingUser = bootstrap.user
                        sessionState = AppSessionState.Ready(
                            bootstrap = bootstrap,
                            workspace = PersonalWorkspace(
                                date = java.time.LocalDate.now().toString(), employee = null, attendance = null,
                                tasks = emptyList(), notifications = emptyList(), payroll = null,
                            ),
                            biometricEnabled = repository.isBiometricEnabled(),
                            usingCachedData = true,
                        )
                        settleCachedExecutive(bootstrap, executiveLifecycle)
                    } else handleRefreshFailure(error)
                }
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

    fun retryExecutive() {
        val ready = sessionState as? AppSessionState.Ready ?: return
        if (!ready.bootstrap.hasExecutiveHome()) return
        startExecutiveLoad(ready.bootstrap, executiveRequests.currentLifecycle())
    }

    private fun startExecutiveLoad(bootstrap: AppBootstrap, lifecycle: Long) {
        val request = executiveRequests.begin(bootstrap, lifecycle) ?: return
        val previousJob = executiveJob
        executiveJob = null
        previousJob?.cancel()
        executiveState = ExecutiveHomeState.Loading

        val source = executiveSource
        if (source == null) {
            if (executiveRequests.accepts(request, currentExecutiveBootstrap())) {
                executiveState = ExecutiveHomeState.Error("مركز القيادة غير مهيأ")
            }
            return
        }
        // An administrator/owner with a home branch still has company-wide scope.
        // Passing that branch id would silently narrow the command center and hide
        // the rest of the company despite bootstrap.allBranches being authoritative.
        val requestedBranchId = bootstrap.executiveRequestBranchId()
        executiveJob = viewModelScope.launch {
            val result = try {
                Result.success(source.commandCenter(requestedBranchId))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Result.failure(error)
            }
            if (!executiveRequests.accepts(request, currentExecutiveBootstrap())) return@launch
            result.onSuccess { executiveState = ExecutiveHomeState.Content(it) }
                .onFailure { error ->
                    if (error.isUnauthorized()) handleUnauthorized(error)
                    else executiveState = ExecutiveHomeState.Error(userMessage(error))
                }
        }
    }

    private fun settleCachedExecutive(bootstrap: AppBootstrap, lifecycle: Long) {
        if (!executiveRequests.acceptsSnapshot(lifecycle, bootstrap, currentExecutiveBootstrap())) return
        executiveState = offlineExecutiveState(bootstrap)
    }

    private fun currentExecutiveBootstrap(): AppBootstrap? =
        (sessionState as? AppSessionState.Ready)?.bootstrap

    private fun resetExecutiveState(): Long {
        val lifecycle = executiveRequests.invalidate()
        val previousJob = executiveJob
        executiveJob = null
        previousJob?.cancel()
        executiveState = ExecutiveHomeState.Loading
        return lifecycle
    }

    fun closeModule() {
        selectedModule = null
    }

    fun logout() {
        resetExecutiveState()
        viewModelScope.launch {
            repository.logout()
            pendingUser = null
            selectedModule = null
            sessionState = AppSessionState.SignedOut()
            resolveTenancyMode()
        }
    }

    private fun continueAuthenticated(user: UserIdentity) {
        pendingUser = user
        if (user.mustChangePassword || user.mustEnrollTwoFactor) resetExecutiveState()
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
        if (error.isUnauthorized()) {
            handleUnauthorized(error)
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

    private fun handleUnauthorized(error: Throwable) {
        resetExecutiveState()
        repository.clearLocalSession()
        pendingUser = null
        selectedModule = null
        sessionState = AppSessionState.SignedOut(error = userMessage(error))
        resolveTenancyMode()
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

private fun AppBootstrap.hasExecutiveHome(): Boolean = (isExecutive && !roleDegraded) || isOwner || user.isOwner

internal fun AppBootstrap.executiveRequestBranchId(): Long? = branchId.takeUnless { allBranches }

internal data class ExecutiveScopeIdentity(
    val userId: Long,
    val requestedBranchId: Long?,
    val allBranches: Boolean,
    val authorized: Boolean,
)

internal data class ExecutiveRequestToken(
    val lifecycle: Long,
    val sequence: Long,
    val scope: ExecutiveScopeIdentity,
)

/**
 * Rejects asynchronous command-center writes after an authentication or scope transition.
 * Sequence protects retries within the same session; lifecycle protects logout/401/refresh.
 */
internal class ExecutiveRequestGate {
    private var lifecycle: Long = 0
    private var sequence: Long = 0
    private var active: ExecutiveRequestToken? = null

    fun invalidate(): Long {
        lifecycle += 1
        active = null
        return lifecycle
    }

    fun currentLifecycle(): Long = lifecycle

    fun isLifecycleCurrent(candidate: Long): Boolean = candidate == lifecycle

    fun begin(bootstrap: AppBootstrap, expectedLifecycle: Long): ExecutiveRequestToken? {
        if (!isLifecycleCurrent(expectedLifecycle) || !bootstrap.hasExecutiveHome()) return null
        return ExecutiveRequestToken(
            lifecycle = lifecycle,
            sequence = ++sequence,
            scope = bootstrap.executiveScopeIdentity(),
        ).also { active = it }
    }

    fun accepts(token: ExecutiveRequestToken, currentBootstrap: AppBootstrap?): Boolean =
        active == token &&
            isLifecycleCurrent(token.lifecycle) &&
            currentBootstrap?.executiveScopeIdentity() == token.scope

    fun acceptsSnapshot(
        expectedLifecycle: Long,
        expectedBootstrap: AppBootstrap,
        currentBootstrap: AppBootstrap?,
    ): Boolean =
        isLifecycleCurrent(expectedLifecycle) &&
            currentBootstrap?.executiveScopeIdentity() == expectedBootstrap.executiveScopeIdentity()
}

internal fun AppBootstrap.executiveScopeIdentity() = ExecutiveScopeIdentity(
    userId = user.id,
    requestedBranchId = executiveRequestBranchId(),
    allBranches = allBranches,
    authorized = hasExecutiveHome(),
)

internal fun offlineExecutiveState(bootstrap: AppBootstrap): ExecutiveHomeState =
    if (bootstrap.hasExecutiveHome()) {
        ExecutiveHomeState.Error("تعذر تحديث مركز القيادة دون اتصال")
    } else {
        ExecutiveHomeState.Loading
    }

internal fun Throwable.isUnauthorized(): Boolean =
    (this as? ApiException)?.let { it.status == 401 || it.code == "UNAUTHORIZED" } == true

class SuperAppViewModelFactory(
    private val repository: SuperAppRepository,
    private val executiveSource: ExecutiveDataSource? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = SuperAppViewModel(repository, executiveSource) as T
}

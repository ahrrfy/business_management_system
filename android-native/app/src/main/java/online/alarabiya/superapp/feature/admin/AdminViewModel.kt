package online.alarabiya.superapp.feature.admin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.AdminDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.admin.AdminAccessPolicy
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminSection
import online.alarabiya.superapp.model.admin.AdminUser
import online.alarabiya.superapp.model.admin.AdminUserSession
import online.alarabiya.superapp.model.admin.CreateAdminRoleCommand
import online.alarabiya.superapp.model.admin.CreateAdminUserCommand
import online.alarabiya.superapp.model.admin.RoleAssignment
import online.alarabiya.superapp.model.admin.UpdateAdminRoleCommand
import online.alarabiya.superapp.model.admin.UpdateAdminUserCommand
import online.alarabiya.superapp.model.admin.AccessLevel

class AdminViewModel(
    private val repository: AdminDataSource,
    val policy: AdminAccessPolicy,
) : ViewModel() {
    var state by mutableStateOf(AdminUiState())
        private set

    init {
        if (policy.canOpen) refresh() else state = state.failed("هذه المساحة لمدير النظام فقط")
    }

    fun setSection(section: AdminSection) {
        state = state.copy(section = section, error = null, notice = null)
        if (section == AdminSection.AUDIT && state.auditEvents.isEmpty()) loadAudit(reset = true)
    }

    fun setQuery(value: String) {
        state = state.copy(query = value.take(120))
    }

    fun setIncludeInactive(value: Boolean) {
        state = state.copy(includeInactive = value)
        refresh()
    }

    fun applySearch() = refresh()

    fun selectUser(id: Long?) {
        state = state.copy(selectedUserId = id, error = null, notice = null)
    }

    fun selectRole(key: String?) {
        state = state.copy(selectedRoleKey = key, error = null, notice = null)
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    fun requestTemporaryPassword() {
        if (!policy.canOpen || state.passwordLoading) return
        state = state.copy(passwordLoading = true, temporaryPassword = null, error = null)
        viewModelScope.launch {
            runCatching { repository.generateTemporaryPassword() }
                .onSuccess { state = state.copy(passwordLoading = false, temporaryPassword = it) }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun consumeTemporaryPassword() {
        state = state.copy(temporaryPassword = null)
    }

    fun loadUserPermissions(target: AdminUser) {
        if (!state.overviewLoaded) return deny("حدّث بيانات الحسابات قبل فتح الصلاحيات")
        val decision = policy.canManageIndividualPermissions(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        if (state.permissionLoading) return
        state = state.copy(permissionLoading = true, permissionProfile = null, error = null)
        viewModelScope.launch {
            runCatching { repository.loadUserPermissions(target.id) }
                .onSuccess { state = state.copy(permissionLoading = false, permissionProfile = it) }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun clearUserPermissions() {
        state = state.copy(permissionProfile = null, permissionLoading = false)
    }

    fun updateUserPermissions(target: AdminUser, overrides: Map<String, AccessLevel>) {
        val decision = policy.canManageIndividualPermissions(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("permissions:${target.id}", "تم تحديث الصلاحيات الفردية وإبطال الجلسات القديمة") {
            repository.updateUserPermissions(target.id, overrides)
        }
        clearUserPermissions()
    }

    fun resetPassword(target: AdminUser, temporaryPassword: String) {
        val decision = policy.canResetPassword(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("password:${target.id}", "تمت إعادة كلمة المرور وإبطال الجلسات القديمة") {
            repository.resetUserPassword(target.id, temporaryPassword)
        }
    }

    fun loadAccountSecurity(target: AdminUser) {
        if (!state.overviewLoaded) return deny("حدّث بيانات الحسابات قبل فتح إجراءات الأمان")
        val decision = accountSecurityDecision(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        if (state.incidentLoading || state.busyKey != null) return
        state = state.copy(
            incidentUserId = target.id,
            incidentSessions = emptyList(),
            incidentLoading = true,
            incidentFresh = false,
            error = null,
        )
        viewModelScope.launch {
            runCatching { repository.loadUserSessions(target.id) }
                .onSuccess { sessions -> state = state.incidentLoaded(target.id, sessions) }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun clearAccountSecurity() {
        state = state.copy(
            incidentUserId = null,
            incidentSessions = emptyList(),
            incidentLoading = false,
            incidentFresh = false,
        )
    }

    fun revokeSession(target: AdminUser, sessionId: Long) {
        val decision = accountSecurityDecision(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        incidentMutation(
            "session:$sessionId",
            "تم إنهاء الجلسة المحددة",
            target,
            localSessions = { sessions -> sessions.filterNot { it.id == sessionId } },
        ) {
            repository.revokeUserSession(target.id, sessionId)
        }
    }

    fun revokeAllSessions(target: AdminUser) {
        val decision = accountSecurityDecision(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        incidentMutation("sessions:${target.id}", "تم إنهاء جميع جلسات الحساب", target, clearSessions = true) {
            repository.revokeAllUserSessions(target.id)
        }
    }

    fun resetTwoFactor(target: AdminUser) {
        val decision = accountSecurityDecision(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        incidentMutation("2fa:${target.id}", "تمت إعادة تهيئة المصادقة الثنائية وإنهاء الجلسات", target, clearSessions = true) {
            repository.resetUserTwoFactor(target.id)
        }
    }

    fun refresh() {
        if (!policy.canOpen || state.loading || state.refreshing) return
        state = state.overviewLoadStarted()
        viewModelScope.launch {
            runCatching { repository.loadOverview(state.query, state.includeInactive) }
                .onSuccess { state = state.overviewLoaded(it) }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun loadMoreAudit() = loadAudit(reset = false)

    fun createUser(command: CreateAdminUserCommand) {
        if (!policy.canOpen) return deny("هذه المساحة لمدير النظام فقط")
        if (!isKnownActiveAssignment(command.assignment)) return deny("اختر دوراً نشطاً من النظام")
        mutate("user:new", "تم إنشاء الحساب وإلزام تغيير كلمة المرور") {
            repository.createUser(command)
        }
    }

    fun updateUser(command: UpdateAdminUserCommand) {
        val target = state.users.firstOrNull { it.id == command.userId } ?: return
        val decision = policy.canEditProfile(target)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("user:${target.id}", "تم تحديث بيانات الحساب") { repository.updateUser(command) }
    }

    fun assignRole(target: AdminUser, assignment: RoleAssignment) {
        if (!isKnownActiveAssignment(assignment)) return deny("اختر دوراً نشطاً من النظام")
        val decision = policy.canAssignRole(target, assignment, state.overview?.activeAdminCount ?: 0)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("user:${target.id}", "تم تحديث الدور وإبطال الجلسات القديمة") {
            repository.assignRole(target.id, assignment)
        }
    }

    fun setUserActive(target: AdminUser, active: Boolean) {
        val decision = policy.canSetActive(target, active, state.overview?.activeAdminCount ?: 0)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("user:${target.id}", if (active) "تم تفعيل الحساب" else "تم تعطيل الحساب") {
            repository.setUserActive(target.id, active)
        }
    }

    fun createRole(command: CreateAdminRoleCommand) {
        val decision = policy.canCreateRole(command.baseRole)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("role:new", "تم إنشاء الدور المخصّص") { repository.createRole(command) }
    }

    fun updateRole(role: AdminRole, command: UpdateAdminRoleCommand) {
        val decision = policy.canEditRole(role)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        mutate("role:${role.id}", "تم تحديث الدور وإبطال جلسات أصحابه") {
            repository.updateRole(command)
        }
    }

    fun setRoleActive(role: AdminRole, active: Boolean) {
        val decision = policy.canEditRole(role)
        if (!decision.allowed) return deny(decision.reason.orEmpty())
        if (!active && role.userCount > 0) return deny("غيّر أدوار المستخدمين النشطين أولاً")
        mutate("role:${role.id}", if (active) "تم تفعيل الدور" else "تم تعطيل الدور") {
            repository.setRoleActive(requireNotNull(role.id), active)
        }
    }

    private fun loadAudit(reset: Boolean) {
        if (!policy.canOpen || state.auditLoading) return
        if (!reset && (!state.auditHasMore || state.auditNextCursor == null)) return
        state = state.copy(auditLoading = true, error = null)
        viewModelScope.launch {
            runCatching { repository.loadAudit(if (reset) null else state.auditNextCursor) }
                .onSuccess { page ->
                    state = state.auditLoaded(page.rows, page.hasMore, page.nextCursor, append = !reset)
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    private fun mutate(key: String, success: String, action: suspend () -> Unit) {
        if (!state.overviewLoaded || state.busyKey != null) {
            return deny("حدّث البيانات قبل تنفيذ الإجراء")
        }
        state = state.mutationStarted(key)
        viewModelScope.launch {
            val mutation = runCatching { action() }
            if (mutation.isFailure) {
                state = state.mutationRefreshFailed(requireNotNull(mutation.exceptionOrNull()).userMessage())
                return@launch
            }

            state = state.mutationCommitted(success)
            val refreshed = runCatching { repository.loadOverview(state.query, state.includeInactive) }
            state = if (refreshed.isSuccess) {
                state.overviewLoaded(refreshed.getOrThrow()).copy(busyKey = null, notice = success)
            } else {
                state.mutationRefreshFailed(
                    "تم تنفيذ الإجراء، لكن تعذر تحديث البيانات. ${requireNotNull(refreshed.exceptionOrNull()).userMessage()}",
                )
            }
            if (state.overviewLoaded && state.section == AdminSection.AUDIT) loadAudit(reset = true)
        }
    }

    private fun incidentMutation(
        key: String,
        success: String,
        target: AdminUser,
        clearSessions: Boolean = false,
        localSessions: (List<AdminUserSession>) -> List<AdminUserSession> = { it },
        action: suspend () -> Unit,
    ) {
        if (!state.incidentFresh || state.incidentUserId != target.id || state.busyKey != null) {
            return deny("حدّث جلسات الحساب قبل تنفيذ الإجراء")
        }
        state = state.incidentMutationStarted(key)
        viewModelScope.launch {
            val mutation = runCatching { action() }
            if (mutation.isFailure) {
                state = state.incidentRefreshFailed(requireNotNull(mutation.exceptionOrNull()).userMessage())
                return@launch
            }

            state = state.copy(
                incidentSessions = if (clearSessions) emptyList() else localSessions(state.incidentSessions),
                notice = success,
            )
            val refreshed = runCatching { repository.loadUserSessions(target.id) }
            state = if (refreshed.isSuccess) {
                state.incidentLoaded(target.id, refreshed.getOrThrow()).copy(notice = success)
            } else {
                state.incidentRefreshFailed(
                    "تم تنفيذ الإجراء، لكن تعذر تحديث الجلسات. ${requireNotNull(refreshed.exceptionOrNull()).userMessage()}",
                )
            }
        }
    }

    private fun accountSecurityDecision(target: AdminUser) = policy.canManageAccountSecurity(
        target,
        state.overview?.activeOwnerCount ?: 0,
    )

    private fun deny(message: String) {
        state = state.copy(error = message.ifBlank { "الإجراء غير مسموح" }, notice = null)
    }

    private fun isKnownActiveAssignment(assignment: RoleAssignment): Boolean = when (assignment) {
        is RoleAssignment.BuiltIn -> state.roles.any {
            it.id == null && it.isActive && it.baseRole == assignment.role
        }
        is RoleAssignment.Custom -> state.roles.any {
            it.id == assignment.roleId && it.isActive && it.baseRole == assignment.baseRole && it.baseRole != "admin"
        }
    }
}

private fun Throwable.userMessage(): String =
    message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

class AdminViewModelFactory(
    private val repository: AdminDataSource,
    bootstrap: AppBootstrap,
) : ViewModelProvider.Factory {
    private val policy = AdminAccessPolicy.fromBootstrap(bootstrap)

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = AdminViewModel(repository, policy) as T
}

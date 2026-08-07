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
import online.alarabiya.superapp.model.admin.CreateAdminRoleCommand
import online.alarabiya.superapp.model.admin.CreateAdminUserCommand
import online.alarabiya.superapp.model.admin.RoleAssignment
import online.alarabiya.superapp.model.admin.UpdateAdminRoleCommand
import online.alarabiya.superapp.model.admin.UpdateAdminUserCommand

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

    fun refresh() {
        if (!policy.canOpen || state.loading || state.refreshing) return
        val hasContent = state.overview != null
        state = state.copy(loading = !hasContent, refreshing = hasContent, error = null, notice = null)
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
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, notice = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    state = state.copy(busyKey = null, notice = success)
                    refresh()
                    if (state.section == AdminSection.AUDIT) loadAudit(reset = true)
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

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

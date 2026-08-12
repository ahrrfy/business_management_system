package online.alarabiya.superapp.feature.admin

import online.alarabiya.superapp.model.admin.AdminAuditEvent
import online.alarabiya.superapp.model.admin.AdminOverview
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminSection
import online.alarabiya.superapp.model.admin.AdminUser
import online.alarabiya.superapp.model.admin.AdminUserSession
import online.alarabiya.superapp.model.admin.UserPermissionProfile

data class AdminUiState(
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val section: AdminSection = AdminSection.USERS,
    val overview: AdminOverview? = null,
    val overviewFresh: Boolean = false,
    val auditEvents: List<AdminAuditEvent> = emptyList(),
    val auditLoading: Boolean = false,
    val auditHasMore: Boolean = false,
    val auditNextCursor: Long? = null,
    val query: String = "",
    val includeInactive: Boolean = false,
    val selectedUserId: Long? = null,
    val selectedRoleKey: String? = null,
    val busyKey: String? = null,
    val temporaryPassword: String? = null,
    val passwordLoading: Boolean = false,
    val permissionProfile: UserPermissionProfile? = null,
    val permissionLoading: Boolean = false,
    val incidentUserId: Long? = null,
    val incidentSessions: List<AdminUserSession> = emptyList(),
    val incidentLoading: Boolean = false,
    val incidentFresh: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
) {
    val overviewLoaded: Boolean get() = overview != null && overviewFresh
    val users: List<AdminUser> get() = overview?.users.orEmpty()
    val roles: List<AdminRole> get() = overview?.roles.orEmpty()
    val selectedUser: AdminUser? get() = users.firstOrNull { it.id == selectedUserId }
    val selectedRole: AdminRole? get() = roles.firstOrNull { it.key == selectedRoleKey }

    fun overviewLoaded(value: AdminOverview): AdminUiState = copy(
        loading = false,
        refreshing = false,
        overview = value,
        overviewFresh = true,
        selectedUserId = selectedUserId?.takeIf { id -> value.users.any { it.id == id } },
        selectedRoleKey = selectedRoleKey?.takeIf { key -> value.roles.any { it.key == key } },
        error = null,
    )

    fun overviewLoadStarted(): AdminUiState = copy(
        loading = overview == null,
        refreshing = overview != null,
        overviewFresh = false,
        error = null,
    )

    fun mutationStarted(key: String): AdminUiState = copy(
        overviewFresh = false,
        busyKey = key,
        error = null,
        notice = null,
    )

    fun mutationCommitted(message: String): AdminUiState = copy(notice = message)

    fun mutationRefreshFailed(message: String): AdminUiState = copy(
        loading = false,
        refreshing = false,
        overviewFresh = false,
        busyKey = null,
        error = message,
    )

    fun incidentLoaded(userId: Long, sessions: List<AdminUserSession>): AdminUiState = copy(
        incidentUserId = userId,
        incidentSessions = sessions,
        incidentLoading = false,
        incidentFresh = true,
        busyKey = null,
        error = null,
    )

    fun incidentMutationStarted(key: String): AdminUiState = copy(
        incidentFresh = false,
        incidentLoading = true,
        busyKey = key,
        error = null,
        notice = null,
    )

    fun incidentRefreshFailed(message: String): AdminUiState = copy(
        incidentLoading = false,
        incidentFresh = false,
        busyKey = null,
        error = message,
    )

    fun auditLoaded(
        rows: List<AdminAuditEvent>,
        hasMore: Boolean,
        nextCursor: Long?,
        append: Boolean,
    ): AdminUiState = copy(
        auditLoading = false,
        auditEvents = if (append) (auditEvents + rows).distinctBy { it.id } else rows,
        auditHasMore = hasMore,
        auditNextCursor = nextCursor,
        error = null,
    )

    fun failed(message: String): AdminUiState = copy(
        loading = false,
        refreshing = false,
        auditLoading = false,
        busyKey = null,
        passwordLoading = false,
        permissionLoading = false,
        incidentLoading = false,
        error = message,
    )
}

internal fun canOpenAdminWorkspace(state: AdminUiState, policyCanOpen: Boolean): Boolean =
    policyCanOpen && state.overviewLoaded

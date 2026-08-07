package online.alarabiya.superapp.feature.admin

import online.alarabiya.superapp.model.admin.AdminAuditEvent
import online.alarabiya.superapp.model.admin.AdminOverview
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminSection
import online.alarabiya.superapp.model.admin.AdminUser

data class AdminUiState(
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val section: AdminSection = AdminSection.USERS,
    val overview: AdminOverview? = null,
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
    val error: String? = null,
    val notice: String? = null,
) {
    val users: List<AdminUser> get() = overview?.users.orEmpty()
    val roles: List<AdminRole> get() = overview?.roles.orEmpty()
    val selectedUser: AdminUser? get() = users.firstOrNull { it.id == selectedUserId }
    val selectedRole: AdminRole? get() = roles.firstOrNull { it.key == selectedRoleKey }

    fun overviewLoaded(value: AdminOverview): AdminUiState = copy(
        loading = false,
        refreshing = false,
        overview = value,
        selectedUserId = selectedUserId?.takeIf { id -> value.users.any { it.id == id } },
        selectedRoleKey = selectedRoleKey?.takeIf { key -> value.roles.any { it.key == key } },
        error = null,
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
        error = message,
    )
}

package online.alarabiya.superapp.model.admin

import online.alarabiya.superapp.model.AppBootstrap

enum class AdminSection(val label: String) {
    USERS("المستخدمون"),
    ROLES("الأدوار والصلاحيات"),
    AUDIT("سجل التدقيق"),
}

enum class AccessLevel(val apiValue: String, val label: String) {
    FULL("FULL", "إدارة"),
    READ("READ", "قراءة"),
    NONE("NONE", "محجوب");

    companion object {
        fun fromApi(value: String?): AccessLevel =
            entries.firstOrNull { it.apiValue.equals(value, ignoreCase = true) } ?: NONE
    }
}

data class AdminUser(
    val id: Long,
    val name: String,
    val email: String?,
    val username: String?,
    val phone: String?,
    val role: String,
    val customRoleId: Long?,
    val customRoleLabel: String?,
    val branchId: Long?,
    val isActive: Boolean,
    val isOwner: Boolean,
    val jobTitle: String?,
    val hiredAt: String?,
    val mustChangePassword: Boolean,
    val lastSignedIn: String?,
    val createdAt: String?,
    val effectiveStation: String?,
) {
    val identifier: String get() = username ?: email ?: "#${id}"
    val displayRole: String get() = customRoleLabel ?: role
}

data class AdminBranch(
    val id: Long,
    val name: String,
    val code: String,
    val isActive: Boolean,
)

data class AdminRole(
    val id: Long?,
    val key: String,
    val label: String,
    val description: String?,
    val baseRole: String,
    val permissions: Map<String, AccessLevel>,
    val isSystem: Boolean,
    val isActive: Boolean,
    val userCount: Int,
    val canSeeCost: Boolean,
) {
    val isCustom: Boolean get() = id != null
}

data class AdminAuditEvent(
    val id: Long,
    val actorId: Long?,
    val actorName: String,
    val branchId: Long?,
    val action: String,
    val entityType: String,
    val entityId: Long?,
    val changedFields: List<String>,
    val maskedIpAddress: String?,
    val createdAt: String,
)

data class AdminAuditPage(
    val rows: List<AdminAuditEvent>,
    val hasMore: Boolean,
    val nextCursor: Long?,
)

data class AdminOverview(
    val users: List<AdminUser>,
    val totalUsers: Int,
    val activeAdminCount: Int,
    val roles: List<AdminRole>,
    val branches: List<AdminBranch>,
)

sealed interface RoleAssignment {
    data class BuiltIn(val role: String) : RoleAssignment
    data class Custom(val roleId: Long, val baseRole: String) : RoleAssignment
}

data class CreateAdminUserCommand(
    val name: String,
    val email: String?,
    val username: String?,
    val temporaryPassword: String,
    val assignment: RoleAssignment,
    val branchId: Long?,
    val phone: String?,
    val jobTitle: String?,
    val hiredAt: String?,
)

data class UpdateAdminUserCommand(
    val userId: Long,
    val name: String,
    val email: String?,
    val username: String?,
    val branchId: Long?,
    val phone: String?,
    val jobTitle: String?,
    val hiredAt: String?,
)

data class CreateAdminRoleCommand(
    val label: String,
    val description: String?,
    val baseRole: String,
    val permissions: Map<String, AccessLevel>,
)

data class UpdateAdminRoleCommand(
    val id: Long,
    val label: String,
    val description: String?,
    val baseRole: String,
    val permissions: Map<String, AccessLevel>,
)

data class AdminActionDecision(val allowed: Boolean, val reason: String? = null)

/**
 * Client-side guardrails mirror the server contract. They improve UX but never replace the
 * authoritative adminProcedure, transaction locks, last-admin guard, and owner checks.
 */
data class AdminAccessPolicy(
    val actorId: Long,
    val actorRole: String,
) {
    val canOpen: Boolean get() = actorRole.equals("admin", ignoreCase = true)

    fun canEditProfile(target: AdminUser): AdminActionDecision = adminOnly()

    fun canAssignRole(target: AdminUser, assignment: RoleAssignment, activeAdminCount: Int): AdminActionDecision {
        adminOnly().takeUnless { it.allowed }?.let { return it }
        if (target.id == actorId) return denied("لا يمكن تغيير دور حسابك من هذه الشاشة")
        val demotesAdmin = target.role == "admin" && when (assignment) {
            is RoleAssignment.BuiltIn -> assignment.role != "admin"
            is RoleAssignment.Custom -> true // custom roles cannot use admin as a base role server-side
        }
        if (demotesAdmin && activeAdminCount <= 1) return denied("عيّن مديراً نشطاً آخر أولاً")
        return allowed()
    }

    fun canSetActive(target: AdminUser, active: Boolean, activeAdminCount: Int): AdminActionDecision {
        adminOnly().takeUnless { it.allowed }?.let { return it }
        if (!active && target.id == actorId) return denied("لا يمكن تعطيل حسابك الحالي")
        if (!active && target.role == "admin" && target.isActive && activeAdminCount <= 1) {
            return denied("لا يمكن تعطيل آخر مدير نشط")
        }
        return allowed()
    }

    fun canCreateRole(baseRole: String): AdminActionDecision {
        adminOnly().takeUnless { it.allowed }?.let { return it }
        if (baseRole == "admin") return denied("لا يُسمح بدور مخصّص يتجاوز صلاحيات المدير")
        return allowed()
    }

    fun canEditRole(role: AdminRole): AdminActionDecision {
        adminOnly().takeUnless { it.allowed }?.let { return it }
        return if (role.isCustom) allowed() else denied("القالب المدمج للعرض فقط")
    }

    private fun adminOnly(): AdminActionDecision =
        if (canOpen) allowed() else denied("هذه المساحة لمدير النظام فقط")

    private fun allowed() = AdminActionDecision(true)
    private fun denied(reason: String) = AdminActionDecision(false, reason)

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap) = AdminAccessPolicy(
            actorId = bootstrap.user.id,
            actorRole = bootstrap.user.role,
        )
    }
}

package online.alarabiya.superapp.feature.admin

import online.alarabiya.superapp.model.admin.AccessLevel
import online.alarabiya.superapp.model.admin.AdminAccessPolicy
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminUser
import online.alarabiya.superapp.model.admin.RoleAssignment
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminPolicyTest {
    @Test
    fun `non admin cannot open or mutate governance`() {
        val policy = AdminAccessPolicy(actorId = 7, actorRole = "manager")

        assertFalse(policy.canOpen)
        assertFalse(policy.canEditProfile(user(8, "cashier")).allowed)
        assertFalse(policy.canCreateRole("cashier").allowed)
    }

    @Test
    fun `admin cannot change own role or disable own account`() {
        val policy = AdminAccessPolicy(actorId = 7, actorRole = "admin")
        val self = user(7, "admin")

        assertFalse(policy.canAssignRole(self, RoleAssignment.BuiltIn("manager"), activeAdminCount = 3).allowed)
        assertFalse(policy.canSetActive(self, active = false, activeAdminCount = 3).allowed)
        assertTrue(policy.canEditProfile(self).allowed)
    }

    @Test
    fun `last active admin cannot be demoted or disabled`() {
        val policy = AdminAccessPolicy(actorId = 1, actorRole = "admin")
        val lastAdmin = user(9, "admin")

        assertFalse(policy.canAssignRole(lastAdmin, RoleAssignment.BuiltIn("manager"), activeAdminCount = 1).allowed)
        assertFalse(policy.canAssignRole(lastAdmin, RoleAssignment.Custom(4, "manager"), activeAdminCount = 1).allowed)
        assertFalse(policy.canSetActive(lastAdmin, active = false, activeAdminCount = 1).allowed)
        assertTrue(policy.canSetActive(lastAdmin, active = false, activeAdminCount = 2).allowed)
    }

    @Test
    fun `custom roles cannot inherit admin bypass and builtin templates are read only`() {
        val policy = AdminAccessPolicy(actorId = 1, actorRole = "admin")

        assertFalse(policy.canCreateRole("admin").allowed)
        assertTrue(policy.canCreateRole("manager").allowed)
        assertFalse(policy.canEditRole(role(id = null, system = true)).allowed)
        assertTrue(policy.canEditRole(role(id = 12, system = false)).allowed)
    }

    private fun user(id: Long, role: String) = AdminUser(
        id = id,
        name = "مستخدم $id",
        email = null,
        username = "user$id",
        phone = null,
        role = role,
        customRoleId = null,
        customRoleLabel = null,
        branchId = 1,
        isActive = true,
        isOwner = false,
        jobTitle = null,
        hiredAt = null,
        mustChangePassword = false,
        lastSignedIn = null,
        createdAt = null,
        effectiveStation = null,
    )

    private fun role(id: Long?, system: Boolean) = AdminRole(
        id = id,
        key = "role_key",
        label = "دور",
        description = null,
        baseRole = "manager",
        permissions = mapOf("users" to AccessLevel.READ),
        isSystem = system,
        isActive = true,
        userCount = 0,
        canSeeCost = true,
    )
}

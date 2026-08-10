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

    @Test
    fun `admin who is not owner cannot manage individual overrides or reset passwords`() {
        val policy = AdminAccessPolicy(actorId = 1, actorRole = "admin", actorIsOwner = false)
        val target = user(2, "manager")

        assertFalse(policy.canManageIndividualPermissions(target).allowed)
        assertFalse(policy.canResetPassword(target).allowed)
    }

    @Test
    fun `owner can manage another account but not own credential through admin flow`() {
        val policy = AdminAccessPolicy(actorId = 1, actorRole = "admin", actorIsOwner = true)

        assertTrue(policy.canManageIndividualPermissions(user(2, "manager")).allowed)
        assertTrue(policy.canResetPassword(user(2, "manager")).allowed)
        assertFalse(policy.canManageIndividualPermissions(user(1, "admin")).allowed)
        assertFalse(policy.canResetPassword(user(1, "admin")).allowed)
    }

    @Test
    fun `account incident response is owner only and never targets self`() {
        val owner = AdminAccessPolicy(actorId = 1, actorRole = "admin", actorIsOwner = true)
        val admin = AdminAccessPolicy(actorId = 1, actorRole = "admin", actorIsOwner = false)

        assertTrue(owner.canManageAccountSecurity(user(2, "manager"), activeOwnerCount = 1).allowed)
        assertFalse(owner.canManageAccountSecurity(user(1, "admin"), activeOwnerCount = 1).allowed)
        assertFalse(admin.canManageAccountSecurity(user(2, "manager"), activeOwnerCount = 1).allowed)
    }

    @Test
    fun `account incident response protects last active owner`() {
        val policy = AdminAccessPolicy(actorId = 1, actorRole = "admin", actorIsOwner = true)
        val target = user(2, "admin").copy(isOwner = true)

        assertFalse(policy.canManageAccountSecurity(target, activeOwnerCount = 1).allowed)
        assertTrue(policy.canManageAccountSecurity(target, activeOwnerCount = 2).allowed)
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

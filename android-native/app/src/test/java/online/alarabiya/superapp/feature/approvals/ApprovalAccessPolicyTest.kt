package online.alarabiya.superapp.feature.approvals

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.approvals.ApprovalAccessPolicy
import online.alarabiya.superapp.model.approvals.ApprovalKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalAccessPolicyTest {
    @Test
    fun `manager sees only full approval modules`() {
        val policy = ApprovalAccessPolicy.fromBootstrap(
            bootstrap(
                role = "manager",
                ModuleAccess("inventory", "المخزون", "FULL"),
                ModuleAccess("hr", "الموارد البشرية", "READ"),
                ModuleAccess("gifts", "الهدايا", "FULL"),
            ),
        )

        assertTrue(policy.canManage(ApprovalKind.INVENTORY))
        assertTrue(policy.canManage(ApprovalKind.GIFT))
        assertFalse(policy.canManage(ApprovalKind.LEAVE))
    }

    @Test
    fun `accountant can approve treasury but not manager-only inventory`() {
        val policy = ApprovalAccessPolicy.fromBootstrap(
            bootstrap(
                role = "accountant",
                ModuleAccess("treasury", "الخزينة", "FULL"),
                ModuleAccess("inventory", "المخزون", "FULL"),
            ),
        )

        assertTrue(policy.canManage(ApprovalKind.VOUCHER))
        assertFalse(policy.canManage(ApprovalKind.INVENTORY))
    }

    @Test
    fun `full HR permission follows server contract regardless of manager role`() {
        val policy = ApprovalAccessPolicy.fromBootstrap(
            bootstrap(role = "hr", ModuleAccess("hr", "الموارد البشرية", "FULL")),
        )

        assertTrue(policy.canManage(ApprovalKind.LEAVE))
    }

    @Test
    fun `branchless admin does not see vouchers that decision API cannot process`() {
        val policy = ApprovalAccessPolicy.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(id = 1, name = "مدير", username = null, email = null, role = "admin"),
                modules = listOf(ModuleAccess("treasury", "الخزينة", "FULL")),
                branchId = null,
                allBranches = true,
            ),
        )

        assertFalse(policy.canManage(ApprovalKind.VOUCHER))
    }

    private fun bootstrap(role: String, vararg modules: ModuleAccess) = AppBootstrap(
        user = UserIdentity(id = 1, name = "مختبر", username = null, email = null, role = role),
        modules = modules.toList(),
        branchId = 1,
        allBranches = role == "admin" || role == "manager",
    )
}

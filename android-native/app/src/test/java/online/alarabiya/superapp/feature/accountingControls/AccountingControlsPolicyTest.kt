package online.alarabiya.superapp.feature.accountingControls

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountingControlsPolicyTest {
    @Test
    fun `accountant may read account tree but cannot enter company wide exchange`() {
        val policy = capabilities(role = "accountant", reports = "READ", treasury = "FULL", branchId = 7)

        assertTrue(policy.canReadAccounts)
        assertFalse(policy.canReadExchange)
        assertFalse(policy.canWriteExchange)
        assertFalse(policy.canGovernPeriods)
    }

    @Test
    fun `manager with treasury grant may read and write only with active branch`() {
        val assigned = capabilities(role = "manager", reports = "NONE", treasury = "FULL", branchId = 7)
        val unassigned = capabilities(role = "manager", reports = "NONE", treasury = "FULL", branchId = null)

        assertTrue(assigned.canReadExchange)
        assertTrue(assigned.canWriteExchange)
        assertTrue(unassigned.canReadExchange)
        assertFalse(unassigned.canWriteExchange)
    }

    @Test
    fun `treasury read access never enables money mutations`() {
        val policy = capabilities(role = "admin", reports = "NONE", treasury = "READ", branchId = 7)

        assertTrue(policy.canReadExchange)
        assertFalse(policy.canWriteExchange)
    }

    @Test
    fun `only administrator receives period and year governance`() {
        assertTrue(capabilities("admin", "NONE", "NONE", null).canGovernPeriods)
        assertFalse(capabilities("manager", "FULL", "FULL", 7).canGovernPeriods)
    }

    @Test
    fun `module grants are still required for built in roles`() {
        val admin = capabilities("admin", "NONE", "NONE", 7)

        assertFalse(admin.canReadAccounts)
        assertFalse(admin.canReadExchange)
        assertFalse(admin.canWriteExchange)
    }

    @Test
    fun `comprehensive financial reconciliation follows admin procedure not report grant`() {
        val admin = capabilities("admin", "NONE", "NONE", null)
        val manager = capabilities("manager", "FULL", "FULL", 7)

        assertTrue(admin.canReadFinancialReconciliation)
        assertFalse(manager.canReadFinancialReconciliation)
    }

    @Test
    fun `owner with stale non admin role receives administrator controls`() {
        val owner = capabilities("manager", "NONE", "NONE", null, isOwner = true)

        assertTrue(owner.isAdministrator)
        assertTrue(owner.canReadFinancialReconciliation)
        assertTrue(owner.canGovernPeriods)
    }

    private fun capabilities(
        role: String,
        reports: String,
        treasury: String,
        branchId: Long?,
        isOwner: Boolean = false,
    ) = AccountingControlsCapabilities.fromBootstrap(
        AppBootstrap(
            user = UserIdentity(1, "Test", "test", null, role, isOwner = isOwner),
            modules = listOf(
                ModuleAccess("reports", "التقارير", reports),
                ModuleAccess("treasury", "الخزينة", treasury),
            ),
            branchId = branchId,
            allBranches = role == "admin" || isOwner,
            isOwner = isOwner,
        ),
    )
}

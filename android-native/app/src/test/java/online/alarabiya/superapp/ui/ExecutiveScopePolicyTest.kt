package online.alarabiya.superapp.ui

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.UserIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExecutiveScopePolicyTest {
    @Test
    fun `company-wide administrator does not inherit a home branch filter`() {
        assertNull(bootstrap(branchId = 7, allBranches = true).executiveRequestBranchId())
    }

    @Test
    fun `branch manager keeps the server-authorized branch filter`() {
        assertEquals(7L, bootstrap(branchId = 7, allBranches = false).executiveRequestBranchId())
    }

    private fun bootstrap(branchId: Long?, allBranches: Boolean) = AppBootstrap(
        user = UserIdentity(
            id = 1,
            name = "مدير الاختبار",
            username = "manager",
            email = null,
            role = if (allBranches) "admin" else "manager",
            roleLabel = "مدير",
        ),
        modules = emptyList(),
        branchId = branchId,
        allBranches = allBranches,
        isExecutive = true,
    )
}

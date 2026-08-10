package online.alarabiya.superapp.feature.hradmin

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.hradmin.HrEmployee
import online.alarabiya.superapp.model.hradmin.EmploymentStatus
import online.alarabiya.superapp.model.hradmin.EmployeeTerminationIssue
import online.alarabiya.superapp.model.hradmin.HrAdminPolicies
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HrAdminPolicyTest {
    @Test
    fun `failed initial load stays retryable and payroll writes require fresh section`() {
        val initial = HrAdminUiState(section = online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL)
        val failed = initial.failed("شبكة", online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL)
        assertFalse(failed.initialized)
        assertFalse(failed.isFresh(online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL))
        val loaded = failed.sectionLoaded(online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL)
        assertTrue(loaded.initialized)
        assertTrue(loaded.isFresh(online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL))
        assertFalse(loaded.copy(staleSections = setOf(online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL)).isFresh(online.alarabiya.superapp.model.hradmin.HrAdminSection.PAYROLL))
    }
    @Test
    fun `manager keeps the established global hr scope`() {
        val policy = HrAdminCapabilities.fromBootstrap(bootstrap("manager", "FULL", 7))

        assertTrue(policy.canReadEmployees)
        assertTrue(policy.canManageEmployees)
        assertTrue(policy.canReadCompanyHr)
        assertTrue(policy.canManageCompanyHr)
        assertTrue(policy.acceptsEmployee(employee(7)))
        assertTrue(policy.acceptsEmployee(employee(8)))
    }

    @Test
    fun `administrator still needs hr grant for company hr`() {
        assertFalse(HrAdminCapabilities.fromBootstrap(bootstrap("admin", "NONE", 7)).canReadCompanyHr)
        assertTrue(HrAdminCapabilities.fromBootstrap(bootstrap("admin", "READ", 7)).canReadCompanyHr)
        assertFalse(HrAdminCapabilities.fromBootstrap(bootstrap("admin", "READ", 7)).canManageCompanyHr)
        assertTrue(HrAdminCapabilities.fromBootstrap(bootstrap("admin", "FULL", 7)).canManageCompanyHr)
    }

    @Test
    fun `branch-local custom role fails closed without a session branch`() {
        val policy = HrAdminCapabilities.fromBootstrap(bootstrap("hr_specialist", "FULL", null))

        assertFalse(policy.canReadEmployees)
        assertFalse(policy.canManageEmployees)
    }

    @Test
    fun `branch-local custom role stays inside its assigned branch`() {
        val policy = HrAdminCapabilities.fromBootstrap(bootstrap("hr_specialist", "FULL", 7))

        assertTrue(policy.canReadEmployees)
        assertFalse(policy.canReadCompanyHr)
        assertTrue(policy.acceptsEmployee(employee(7)))
        assertFalse(policy.acceptsEmployee(employee(8)))
    }

    @Test
    fun `administrator with explicit all branches capability may use company employee scope`() {
        val policy = HrAdminCapabilities.fromBootstrap(bootstrap("admin", "FULL", null))

        assertTrue(policy.canReadEmployees)
        assertTrue(policy.acceptsEmployee(employee(99)))
    }

    @Test
    fun `termination blocks self and requires a real date and reason`() {
        val policy = HrAdminCapabilities.fromBootstrap(bootstrap("admin", "FULL", null))
        val self = employee(7, userId = 1)
        val other = employee(7, userId = 2)

        assertFalse(policy.canTerminate(self))
        assertTrue(policy.canTerminate(other))
        assertEquals(
            EmployeeTerminationIssue.InvalidDate,
            HrAdminPolicies.terminationIssue("2026-02-30", "انتهاء العقد"),
        )
        assertEquals(
            EmployeeTerminationIssue.MissingReason,
            HrAdminPolicies.terminationIssue("2026-08-31", ""),
        )
        assertNull(HrAdminPolicies.terminationIssue("2026-08-31", "انتهاء العقد"))
    }

    private fun bootstrap(role: String, access: String, branchId: Long?) = AppBootstrap(
        user = UserIdentity(1, "Test", "test", null, role),
        modules = listOf(ModuleAccess("hr", "الموارد البشرية", access)),
        branchId = branchId,
        allBranches = role == "admin",
    )

    private fun employee(branchId: Long, userId: Long? = null) = HrEmployee(
        id = 10,
        userId = userId,
        branchId = branchId,
        branchName = "فرع",
        fullName = "موظف اختبار",
        position = null,
        department = null,
        phone = null,
        email = null,
        payType = "monthly",
        salary = "1000.00",
        allowances = "0.00",
        employmentStatus = EmploymentStatus.ACTIVE,
        isActive = true,
        attendanceExempt = false,
        deviceLinked = true,
        hireDate = null,
        annualLeaveBalance = 10,
        sickLeaveBalance = 5,
    )
}

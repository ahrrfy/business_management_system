package online.alarabiya.superapp.ui

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.approvals.ApprovalAccessPolicy
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.finance.FinanceAccessPolicy
import online.alarabiya.superapp.model.finance.FinanceSection
import online.alarabiya.superapp.model.receivables.ReceivablesAccessPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionBranchCapabilityWiringTest {
    private val bootstrap = AppBootstrap(
        user = UserIdentity(17, "المدير", "admin", null, "admin"),
        modules = listOf(
            ModuleAccess("treasury", "الخزينة", "FULL"),
            ModuleAccess("collections", "التحصيل", "FULL"),
            ModuleAccess("suppliers", "الموردون", "FULL"),
            ModuleAccess("reports", "التقارير", "READ"),
        ),
        branchId = null,
        allBranches = true,
    )

    @Test
    fun selectedSessionBranchUnlocksOnlyTheBranchBoundFinancialActions() {
        val unscopedFinance = FinanceAccessPolicy.fromBootstrap(bootstrap, effectiveBranchId = null)
        val scopedFinance = FinanceAccessPolicy.fromBootstrap(bootstrap, effectiveBranchId = 7)
        assertFalse(unscopedFinance.canWrite(FinanceSection.VOUCHERS))
        assertTrue(scopedFinance.canWrite(FinanceSection.VOUCHERS))
        assertEquals(7L, scopedFinance.branchId)

        val unscopedApprovals = ApprovalAccessPolicy.fromBootstrap(bootstrap, effectiveBranchId = null)
        val scopedApprovals = ApprovalAccessPolicy.fromBootstrap(bootstrap, effectiveBranchId = 7)
        assertFalse(unscopedApprovals.canManage(ApprovalKind.VOUCHER))
        assertTrue(scopedApprovals.canManage(ApprovalKind.VOUCHER))

        val scopedReceivables = ReceivablesAccessPolicy.fromBootstrap(bootstrap, effectiveBranchId = 7)
        assertEquals(7L, scopedReceivables.assignedBranchId)
    }
}

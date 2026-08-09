package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.insights.InsightsAccessPolicy
import online.alarabiya.superapp.model.insights.InsightsSection
import online.alarabiya.superapp.model.insights.SearchEntityType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InsightsPolicyTest {
    @Test
    fun `manager with assigned branch sees report and permitted search scopes`() {
        val policy = policy(
            "manager", 2,
            module("reports", "READ"), module("sales", "READ"), module("expenses", "READ"),
        )

        assertTrue(policy.canRead(InsightsSection.REPORTS))
        assertTrue(policy.canRead(InsightsSection.REPORT_CATALOG))
        assertTrue(policy.canRead(InsightsSection.FINANCIAL))
        assertTrue(SearchEntityType.INVOICE in policy.searchScopes)
        assertTrue(SearchEntityType.EXPENSE in policy.searchScopes)
        assertFalse(SearchEntityType.USER in policy.searchScopes)
    }

    @Test
    fun `nonstandard role report access stays conservative without grant provenance`() {
        val policy = policy("warehouse", 1, module("reports", "READ"), module("products", "READ"))

        assertFalse(policy.canRead(InsightsSection.REPORTS))
        assertTrue(policy.canRead(InsightsSection.SEARCH))
        assertTrue(SearchEntityType.PRODUCT in policy.searchScopes)
    }

    @Test
    fun `cashier store analytics requires branch and store read`() {
        assertTrue(policy("cashier", 3, module("store", "READ")).canRead(InsightsSection.STORE))
        assertFalse(policy("cashier", null, module("store", "READ")).canRead(InsightsSection.STORE))
    }

    @Test
    fun `lower roles never see managerial search entities`() {
        val policy = policy(
            "cashier", 3,
            module("suppliers", "READ"), module("purchases", "READ"), module("expenses", "READ"),
        )

        assertFalse(SearchEntityType.SUPPLIER in policy.searchScopes)
        assertFalse(SearchEntityType.PURCHASE_ORDER in policy.searchScopes)
        assertFalse(SearchEntityType.EXPENSE in policy.searchScopes)
    }

    @Test
    fun `admin may filter reports and search users`() {
        val policy = policy("admin", null, module("reports", "FULL"))

        assertTrue(policy.canFilterBranch)
        assertTrue(policy.canRead(InsightsSection.REPORTS))
        assertTrue(policy.canRead(InsightsSection.REPORT_CATALOG))
        assertTrue(SearchEntityType.USER in policy.searchScopes)
    }

    @Test
    fun `accountant and auditor keep financial reports but not owner manager catalog`() {
        assertTrue(policy("accountant", 2, module("reports", "READ")).canRead(InsightsSection.FINANCIAL))
        assertFalse(policy("accountant", 2, module("reports", "READ")).canRead(InsightsSection.REPORT_CATALOG))
        assertFalse(policy("auditor", 2, module("reports", "READ")).canRead(InsightsSection.REPORT_CATALOG))
    }

    @Test
    fun `hr reports require hr read and an authorised reporting role`() {
        assertTrue(policy("manager", 2, module("hr", "READ")).canRead(InsightsSection.HR_REPORTS))
        assertFalse(policy("cashier", 2, module("hr", "READ")).canRead(InsightsSection.HR_REPORTS))
        assertFalse(policy("manager", 2, module("hr", "NONE")).canRead(InsightsSection.HR_REPORTS))
    }

    private fun module(key: String, access: String) = ModuleAccess(key, key, access)

    private fun policy(role: String, branchId: Long?, vararg modules: ModuleAccess) =
        InsightsAccessPolicy.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(1, "مختبر", null, null, role),
                modules = modules.toList(),
                branchId = branchId,
                allBranches = role == "admin" || role == "manager",
            ),
        )
}

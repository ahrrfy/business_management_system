package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectionsPolicyTest {
    @Test
    fun `administrator and manager mirror managerProcedure access`() {
        assertTrue(policy("admin").canReadCreditDecisions)
        assertTrue(policy("manager").canReadCreditDecisions)
        assertTrue(policy("manager").canCancelActiveDecision)
    }

    @Test
    fun `collections grant does not bypass role only credit route`() {
        assertFalse(policy("accountant").canReadCreditDecisions)
        assertFalse(policy("cashier").canReadCreditDecisions)
        assertFalse(policy("custom_collector").canCancelActiveDecision)
    }

    private fun policy(role: String) = CollectionsCapabilities.fromBootstrap(
        AppBootstrap(
            user = UserIdentity(7, "Test", "test", null, role),
            modules = listOf(ModuleAccess("collections", "التحصيل", "FULL")),
            branchId = 3,
            allBranches = role == "admin",
        ),
    )
}

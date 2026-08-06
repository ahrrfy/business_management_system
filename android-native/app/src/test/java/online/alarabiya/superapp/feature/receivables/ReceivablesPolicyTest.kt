package online.alarabiya.superapp.feature.receivables

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.receivables.ReceivablesAccessPolicy
import online.alarabiya.superapp.model.receivables.ReceivablesSection
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceivablesPolicyTest {
    @Test
    fun `accountant with branch can operate installments and customer reminders`() {
        val policy = policy(
            role = "accountant",
            branchId = 3,
            module("treasury", "FULL"),
            module("collections", "FULL"),
        )

        assertTrue(policy.canWrite(ReceivablesSection.INSTALLMENTS))
        assertTrue(policy.canWrite(ReceivablesSection.CUSTOMER_REMINDERS))
        assertFalse(policy.canRead(ReceivablesSection.SUPPLIER_REMINDERS))
    }

    @Test
    fun `manager without branch may read installments but cannot mutate or open reminder queue`() {
        val policy = policy(
            role = "manager",
            branchId = null,
            module("treasury", "FULL"),
            module("collections", "FULL"),
        )

        assertTrue(policy.canRead(ReceivablesSection.INSTALLMENTS))
        assertFalse(policy.canWrite(ReceivablesSection.INSTALLMENTS))
        assertFalse(policy.canRead(ReceivablesSection.CUSTOMER_REMINDERS))
    }

    @Test
    fun `warehouse role can use supplier reminders only with full module and branch`() {
        assertTrue(
            policy("warehouse", 2, module("suppliers", "FULL"))
                .canWrite(ReceivablesSection.SUPPLIER_REMINDERS),
        )
        assertFalse(
            policy("warehouse", null, module("suppliers", "FULL"))
                .canRead(ReceivablesSection.SUPPLIER_REMINDERS),
        )
    }

    @Test
    fun `auditor receives read-only card and account views`() {
        val policy = policy("auditor", 1, module("reports", "READ"))

        assertTrue(policy.canRead(ReceivablesSection.CARD_ACCOUNT))
        assertTrue(policy.canRead(ReceivablesSection.ACCOUNTS))
        assertFalse(policy.canCreateReconciliation)
    }

    @Test
    fun `nonstandard role remains blocked without grant provenance`() {
        val policy = policy(
            "custom_finance", 1,
            module("treasury", "FULL"), module("reports", "FULL"), module("collections", "FULL"),
        )

        assertTrue(policy.readableSections.isEmpty())
    }

    @Test
    fun `admin gets explicit aggregate scopes but only for present modules`() {
        val policy = policy(
            "admin", null,
            module("collections", "FULL"), module("suppliers", "FULL"), module("reports", "READ"),
        )

        assertTrue(policy.canReadOpeningReceivables)
        assertTrue(policy.canReadAllPayables)
        assertTrue(policy.canFilterBranch)
        assertTrue(policy.canCreateReconciliation)
    }

    private fun module(key: String, access: String) = ModuleAccess(key, key, access)

    private fun policy(role: String, branchId: Long?, vararg modules: ModuleAccess) =
        ReceivablesAccessPolicy.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(1, "مختبر", null, null, role),
                modules = modules.toList(),
                branchId = branchId,
                allBranches = role == "admin" || role == "manager",
            ),
        )
}

package online.alarabiya.superapp.feature.purchasing

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseStatus
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PurchasingPolicyTest {
    @Test
    fun `read access never exposes mutations`() {
        val policy = policy("purchasing", 2, "READ", "READ")

        assertTrue(policy.canReadOrders)
        assertTrue(policy.canReadSuppliers)
        assertFalse(policy.canWriteOrders)
        assertFalse(policy.canWriteSuppliers)
        assertFalse(policy.canReadReturns)
        assertFalse(policy.canReadReminders)
        assertEquals(listOf(PurchasingSection.ORDERS, PurchasingSection.SUPPLIERS), policy.visibleSections)
    }

    @Test
    fun `warehouse full access may receive and manage suppliers but not create order`() {
        val policy = policy("warehouse", 4, "FULL", "FULL")

        assertFalse(policy.canWriteOrders)
        assertTrue(policy.canReceiveOrders)
        assertTrue(policy.canWriteSuppliers)
        assertTrue(policy.canReadReminders)
        assertFalse(policy.canReadReturns)
    }

    @Test
    fun `purchasing user without branch fails closed for stock and debt writes`() {
        val policy = policy("purchasing", null, "FULL", "FULL")

        assertFalse(policy.canWriteOrders)
        assertFalse(policy.canReceiveOrders)
        assertFalse(policy.canWriteReturns)
        assertFalse(policy.canWriteReminders)
    }

    @Test
    fun `order transitions depend on server state`() {
        val policy = policy("manager", 1, "FULL", "FULL")
        val draft = order(PurchaseStatus.DRAFT)
        val confirmed = order(PurchaseStatus.CONFIRMED)

        assertTrue(policy.canConfirm(draft))
        assertFalse(policy.canReceive(draft))
        assertTrue(policy.canReceive(confirmed))
        assertTrue(policy.canCancel(confirmed))
    }

    private fun policy(role: String, branch: Long?, purchases: String, suppliers: String) = PurchasingCapabilities.fromBootstrap(
        AppBootstrap(
            user = UserIdentity(1, "User", "user", null, role),
            modules = listOf(ModuleAccess("purchases", "Purchases", purchases), ModuleAccess("suppliers", "Suppliers", suppliers)),
            branchId = branch, allBranches = role == "admin",
        ),
    )

    private fun order(status: PurchaseStatus) = PurchaseOrderDetail(
        PurchaseOrderSummary(1, "PO-1", null, 1, "Supplier", 1, "1", "0", "0", "0", online.alarabiya.superapp.model.purchasing.Currency.IQD, null, null, null, null, status),
        "1", "0", "0", null, emptyList(),
    )
}

package online.alarabiya.superapp.feature.inventory

import online.alarabiya.superapp.model.inventory.InventorySection
import online.alarabiya.superapp.model.inventory.StockBalance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InventoryExecutiveNavigationTest {
    @Test
    fun `low stock action selects balances and applies the server low filter`() {
        val next = InventoryUiState(section = InventorySection.MOVEMENTS)
            .applyExecutiveNavigation(mapOf("stockState" to "low"))

        assertEquals(InventorySection.BALANCES, next.section)
        assertTrue(next.lowOnly)
        assertEquals(ExecutiveStockState.LOW, next.executiveStockState)
    }

    @Test
    fun `out of stock action removes positive low-stock rows from visible results`() {
        val next = InventoryUiState(
            section = InventorySection.BALANCES,
            balances = listOf(stock(1, 0), stock(2, 2)),
        ).applyExecutiveNavigation(mapOf("stockState" to "out"))

        assertEquals(listOf(1L), next.visibleBalances.map(StockBalance::variantId))
    }

    private fun stock(id: Long, quantity: Int) = StockBalance(
        variantId = id,
        branchId = 1,
        productName = "item-$id",
        variantName = null,
        sku = "sku-$id",
        quantity = quantity,
        minimum = 3,
        reorderPoint = 3,
        isLow = true,
        lastCountedAt = null,
    )
}

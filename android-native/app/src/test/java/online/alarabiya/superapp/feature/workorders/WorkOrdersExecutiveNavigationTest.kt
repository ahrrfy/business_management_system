package online.alarabiya.superapp.feature.workorders

import java.time.LocalDate
import online.alarabiya.superapp.model.workorders.WorkOrderPriority
import online.alarabiya.superapp.model.workorders.WorkOrderStatus
import online.alarabiya.superapp.model.workorders.WorkOrderSummary
import online.alarabiya.superapp.model.workorders.WorkOrdersSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkOrdersExecutiveNavigationTest {
    @Test
    fun `overdue action selects orders and filters out current completed and invalid rows`() {
        val next = WorkOrdersUiState(
            section = WorkOrdersSection.PRICING,
            orders = listOf(
                order(1, "2026-08-01", WorkOrderStatus.RECEIVED),
                order(2, "2026-08-10", WorkOrderStatus.IN_PROGRESS),
                order(3, "2026-08-01", WorkOrderStatus.DELIVERED),
                order(4, null, WorkOrderStatus.RECEIVED),
            ),
        ).applyExecutiveNavigation(mapOf("overdue" to "true"))

        assertEquals(WorkOrdersSection.ORDERS, next.section)
        assertTrue(next.overdueOnly)
        assertEquals(listOf(1L), next.filteredOrders(LocalDate.parse("2026-08-09")).map { it.id })
    }

    private fun order(id: Long, dueDate: String?, status: WorkOrderStatus) = WorkOrderSummary(
        id = id,
        number = "WO-$id",
        title = "work-$id",
        quantity = 1,
        status = status,
        priority = WorkOrderPriority.NORMAL,
        channel = null,
        salePrice = "0",
        deposit = "0",
        dueDate = dueDate,
        createdAt = null,
        assignedTo = null,
        assigneeName = null,
        customerName = null,
        hasDelivery = false,
        deliveryAddress = null,
        consignmentStatus = null,
        deliveryPartyName = null,
    )
}

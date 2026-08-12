package online.alarabiya.superapp.feature.workorders

import online.alarabiya.superapp.model.workorders.DeliveryDraft
import online.alarabiya.superapp.model.workorders.ProductionDetail
import online.alarabiya.superapp.model.workorders.ProductionStatus
import online.alarabiya.superapp.model.workorders.RecipeRunDraft
import online.alarabiya.superapp.model.workorders.WorkOrderCounts
import online.alarabiya.superapp.model.workorders.WorkOrderDetail
import online.alarabiya.superapp.model.workorders.WorkOrderDraft
import online.alarabiya.superapp.model.workorders.WorkOrderPriority
import online.alarabiya.superapp.model.workorders.WorkOrderStatus
import online.alarabiya.superapp.model.workorders.WorkOrdersSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkOrdersMutationSafetyTest {
    @Test
    fun `initial state blocks creation until a successful fresh load`() {
        val initial = WorkOrdersUiState(section = WorkOrdersSection.ORDERS)

        assertFalse(initial.canBeginOrder)
        assertFalse(initial.canBeginRun)

        val ordersReady = initial.orderRefreshed(null, emptyList(), counts)
        val productionsReady = ordersReady.productionRefreshed(null, emptyList(), false)

        assertTrue(ordersReady.canBeginOrder)
        assertTrue(productionsReady.canBeginRun)
    }

    @Test
    fun `created order closes idempotent draft before refresh and stays blocked on stale data`() {
        val originalRequest = "order-request-1"
        val committed = WorkOrdersUiState(
            section = WorkOrdersSection.ORDERS,
            ordersLoaded = true,
            orderDraft = WorkOrderDraft(title = "دفتر", salePrice = "100", clientRequestId = originalRequest),
            deliveryDraft = DeliveryDraft(clientRequestId = "delivery-request-1"),
        ).orderCreatedCommitted(41, "تم الإنشاء")

        assertNull(committed.orderDraft)
        assertNull(committed.deliveryDraft)
        assertEquals(41L, committed.pendingOrderRefreshId)
        assertFalse(committed.canBeginOrder)

        val fresh = committed.orderRefreshed(order(id = 41), emptyList(), counts)
        assertTrue(fresh.canBeginOrder)
        assertTrue(fresh.canMutateSelectedOrder)
        assertNull(fresh.pendingOrderRefreshId)
    }

    @Test
    fun `order transition is monotonic locally and cannot repeat before retry is fresh`() {
        val cancelled = WorkOrdersUiState(
            section = WorkOrdersSection.ORDERS,
            ordersLoaded = true,
            selectedOrder = order(status = WorkOrderStatus.READY),
            selectedOrderFresh = true,
        ).orderTransitionCommitted(order(status = WorkOrderStatus.CANCELLED), "تم الإلغاء")

        assertEquals(WorkOrderStatus.CANCELLED, cancelled.selectedOrder?.status)
        assertFalse(cancelled.selectedOrderFresh)
        assertFalse(cancelled.canMutateSelectedOrder)
        assertEquals(7L, cancelled.pendingOrderRefreshId)

        val fresh = cancelled.orderRefreshed(order(status = WorkOrderStatus.CANCELLED), emptyList(), counts)
        assertTrue(fresh.selectedOrderFresh)
        assertTrue(fresh.canMutateSelectedOrder)
    }

    @Test
    fun `created production closes idempotent run before refresh and stale cancel cannot repeat`() {
        val created = WorkOrdersUiState(
            section = WorkOrdersSection.PRODUCTION,
            productionsLoaded = true,
            runDraft = RecipeRunDraft(recipeId = 3, clientRequestId = "run-request-1"),
        ).productionCreatedCommitted(22, "تم الترحيل")

        assertNull(created.runDraft)
        assertNull(created.runPreview)
        assertFalse(created.canBeginRun)
        assertEquals(22L, created.pendingProductionRefreshId)

        val cancelled = created.productionTransitionCommitted(
            production(id = 22, status = ProductionStatus.CANCELLED),
            "تم العكس",
        )
        assertEquals(ProductionStatus.CANCELLED, cancelled.selectedProduction?.status)
        assertFalse(cancelled.canMutateSelectedProduction)

        val fresh = cancelled.productionRefreshed(
            production(id = 22, status = ProductionStatus.CANCELLED),
            emptyList(),
            false,
        )
        assertTrue(fresh.canMutateSelectedProduction)
        assertNull(fresh.pendingProductionRefreshId)
    }

    private fun order(
        id: Long = 7,
        status: WorkOrderStatus = WorkOrderStatus.READY,
    ) = WorkOrderDetail(
        id = id,
        number = "WO-$id",
        title = "أمر",
        customizationText = null,
        quantity = 1,
        status = status,
        priority = WorkOrderPriority.NORMAL,
        branchId = 2,
        customerId = null,
        customerName = null,
        customerPhone = null,
        materialsCost = null,
        laborCost = null,
        salePrice = "100",
        deposit = "0",
        dueDate = null,
        hasDelivery = false,
        deliveryAddress = null,
        deliveryPhone = null,
        deliveryCost = null,
        assignedTo = null,
        assigneeName = null,
        workStartedAt = null,
        workSeconds = null,
        deliveredAt = null,
        materials = emptyList(),
        timeline = emptyList(),
    )

    private fun production(
        id: Long,
        status: ProductionStatus,
    ) = ProductionDetail(
        id = id,
        number = "PR-$id",
        branchId = 2,
        status = status,
        branchName = "الرئيسي",
        batchQty = 10,
        goodQty = 9,
        scrapQty = 1,
        totalCost = "500",
        recipeName = "وصفة",
        linkedWorkOrderId = null,
        inputs = emptyList(),
        outputs = emptyList(),
    )

    private companion object {
        val counts = WorkOrderCounts(0, 0, 0, 0, 0, 0)
    }
}

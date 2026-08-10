package online.alarabiya.superapp.feature.workorders

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.workorders.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkOrdersContractTest {
    @Test
    fun mapsWorkOrderListAndCostRedactedDetail() {
        val list = WorkOrderMappers.orderList(listOf(mapOf(
            "id" to 8, "orderNumber" to "WO-26-8", "title" to "طباعة كتيب", "quantity" to 20,
            "status" to "IN_PROGRESS", "priority" to "URGENT", "salePrice" to "75000.00", "deposit" to "20000.00",
            "assignedTo" to 5, "assigneeName" to "علي", "customerName" to "شركة النور", "hasDelivery" to true,
        )))
        assertEquals(WorkOrderStatus.IN_PROGRESS, list.single().status)
        assertEquals(WorkOrderPriority.URGENT, list.single().priority)

        val detail = WorkOrderMappers.order(mapOf(
            "id" to 8, "orderNumber" to "WO-26-8", "title" to "طباعة كتيب", "quantity" to 20,
            "status" to "READY", "branchId" to 2, "salePrice" to "75000.00", "deposit" to "20000.00",
            "materialsCost" to null, "laborCost" to null,
            "materials" to listOf(mapOf("id" to 1, "variantId" to 9, "productName" to "ورق", "variantName" to "A4", "sku" to "P-A4", "baseQuantity" to 40, "unitCost" to null)),
        ))
        assertNull(detail.materialsCost)
        assertNull(detail.materials.single().unitCost)
        assertEquals("ورق · A4", detail.materials.single().label)
    }

    @Test
    fun permissionsAndTransitionsPreserveSeparationOfDuties() {
        val operator = capabilities("print_operator", workorders = "FULL", branchId = 2)
        assertTrue(operator.canExecuteOrders)
        assertFalse(operator.canCreateOrders)
        assertFalse(operator.canDeliverOrders)
        val mine = order(status = WorkOrderStatus.IN_PROGRESS, assignedTo = 5)
        assertTrue(WorkOrderAction.MARK_READY in operator.actionsFor(mine))
        assertFalse(WorkOrderAction.DELIVER in operator.actionsFor(mine))
        assertFalse(WorkOrderAction.CANCEL in operator.actionsFor(mine))
        assertFalse(WorkOrderAction.MARK_READY in operator.actionsFor(mine.copy(assignedTo = 99)))

        val manager = capabilities("manager", workorders = "FULL", inventory = "FULL", branchId = 2)
        assertTrue(WorkOrderAction.START in manager.actionsFor(order(status = WorkOrderStatus.RECEIVED, assignedTo = null)))
        val ready = order(status = WorkOrderStatus.READY, assignedTo = 5)
        assertTrue(WorkOrderAction.DELIVER in manager.actionsFor(ready))
        assertTrue(WorkOrderAction.CANCEL in manager.actionsFor(ready))
        assertTrue(manager.canManageProduction)

        val branchless = capabilities("admin", workorders = "FULL", inventory = "FULL", branchId = null)
        assertFalse(branchless.canReadOrders)
        assertFalse(branchless.canManageProduction)
    }

    @Test
    fun validatesCreationDeliveryAndRecipeRun() {
        assertEquals("عنوان أمر الشغل مطلوب", WorkOrderValidation.create(WorkOrderDraft(salePrice = "100", clientRequestId = "x"), 2))
        assertEquals("عنوان التوصيل مطلوب", WorkOrderValidation.create(WorkOrderDraft(title = "عمل", salePrice = "100", hasDelivery = true, clientRequestId = "x"), 2))
        assertNull(WorkOrderValidation.create(WorkOrderDraft(title = "عمل", salePrice = "100", clientRequestId = "x"), 2))
        assertEquals("تاريخ الاستحقاق بصيغة YYYY-MM-DD", WorkOrderValidation.create(WorkOrderDraft(title = "عمل", salePrice = "100", dueDate = "05/08/2026", clientRequestId = "x"), 2))
        assertEquals("أدخل المبلغ الكامل لطلب بلا عميل", WorkOrderValidation.delivery(DeliveryDraft(clientRequestId = "x"), null))
        assertEquals("مرجع الدفع مطلوب", WorkOrderValidation.delivery(DeliveryDraft("100", PaymentMethod.CARD, clientRequestId = "x"), 4))
        assertNull(WorkOrderValidation.delivery(DeliveryDraft("100", PaymentMethod.CARD, "REF", "x"), 4))
        assertEquals("اختر وصفة إنتاج", WorkOrderValidation.production(RecipeRunDraft(clientRequestId = "x"), 2))
        assertEquals("الهدر يجب أن يكون أقل من الدفعة", WorkOrderValidation.production(RecipeRunDraft(3, "10", "10", clientRequestId = "x"), 2))
        assertEquals("العرض غير صالح", WorkOrderValidation.pricing(PricingDraft(category = "WIDE", mediaId = 2, width = "0", height = "1")))
    }

    @Test
    fun mapsServerCalculatedPricingAndProductionPreview() {
        val pricing = WorkOrderMappers.pricing(mapOf(
            "settings" to mapOf("pricingMode" to "COST_PLUS", "defaultMarginPercent" to "30", "setupFee" to "1000"),
            "wideMedia" to listOf(
                mapOf("id" to 1, "name" to "فينيل", "pricePerSqm" to "5000", "isActive" to true),
                mapOf("id" to 2, "name" to "قديم", "pricePerSqm" to "100", "isActive" to false),
            ),
        ))
        assertEquals(listOf("فينيل"), pricing.wideMedia.map { it.name })

        val estimate = WorkOrderMappers.estimate(mapOf(
            "category" to "SMALL", "units" to 10, "faces" to 20, "sheets" to 10,
            "totalCost" to "20000.00", "suggestedPrice" to "26000.00", "unitPrice" to "2600.00",
            "lines" to listOf(mapOf("label" to "كلفة الطباعة", "amount" to "20000.00")),
        ))
        assertEquals("26000.00", estimate.suggestedPrice)
        assertEquals(20, estimate.faces)

        val preview = WorkOrderMappers.recipePreview(mapOf(
            "recipeId" to 3, "outputName" to "كتيب", "good" to 9, "materialsCost" to "5000.00",
            "laborCost" to "1000.00", "totalCost" to "6000.00", "anyShort" to true,
            "inputs" to listOf(mapOf("productName" to "ورق", "sku" to "P", "consumed" to 30, "available" to 20, "lineCost" to "5000.00")),
        ))
        assertTrue(preview.anyShort)
        assertEquals(30, preview.inputs.single().required)
        assertEquals(9, preview.outputBase)

        val production = WorkOrderMappers.production(mapOf(
            "id" to 12, "docNumber" to "PRD-12", "branchId" to 2, "status" to "CONFIRMED", "branchName" to "الرئيسي", "totalCost" to "6000",
        ))
        assertEquals(2, production.branchId)
    }

    private fun capabilities(role: String, workorders: String, inventory: String = "NONE", pos: String = "NONE", branchId: Long?): WorkOrdersCapabilities =
        WorkOrdersCapabilities.fromBootstrap(AppBootstrap(
            UserIdentity(5, "موظف", null, null, role),
            listOf(ModuleAccess("workorders", "أوامر", workorders), ModuleAccess("inventory", "المخزون", inventory), ModuleAccess("pos", "النقطة", pos)),
            branchId, role == "admin",
        ))

    private fun order(status: WorkOrderStatus, assignedTo: Long?) = WorkOrderDetail(
        id = 1, number = "WO-1", title = "عمل", customizationText = null, quantity = 1, status = status,
        priority = WorkOrderPriority.NORMAL, branchId = 2, customerId = 4, customerName = "عميل", customerPhone = null,
        materialsCost = null, laborCost = null, salePrice = "100", deposit = "0", dueDate = null,
        hasDelivery = false, deliveryAddress = null, deliveryPhone = null, deliveryCost = null,
        assignedTo = assignedTo, assigneeName = null, workStartedAt = null, workSeconds = null, deliveredAt = null,
        materials = emptyList(), timeline = emptyList(),
    )
}

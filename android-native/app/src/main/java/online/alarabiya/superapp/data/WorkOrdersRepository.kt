package online.alarabiya.superapp.data

import java.util.UUID
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.workorders.DeliveryDraft
import online.alarabiya.superapp.model.workorders.PriceTier
import online.alarabiya.superapp.model.workorders.PricingBundle
import online.alarabiya.superapp.model.workorders.PricingDraft
import online.alarabiya.superapp.model.workorders.PrintEstimate
import online.alarabiya.superapp.model.workorders.PrintService
import online.alarabiya.superapp.model.workorders.ProductionDetail
import online.alarabiya.superapp.model.workorders.ProductionStatus
import online.alarabiya.superapp.model.workorders.ProductionSummary
import online.alarabiya.superapp.model.workorders.RecipePreview
import online.alarabiya.superapp.model.workorders.RecipeRunDraft
import online.alarabiya.superapp.model.workorders.RecipeSummary
import online.alarabiya.superapp.model.workorders.StaffOption
import online.alarabiya.superapp.model.workorders.WorkOrderCounts
import online.alarabiya.superapp.model.workorders.WorkOrderDetail
import online.alarabiya.superapp.model.workorders.WorkOrderDraft
import online.alarabiya.superapp.model.workorders.WorkOrderMappers
import online.alarabiya.superapp.model.workorders.WorkOrderStatus
import online.alarabiya.superapp.model.workorders.WorkOrderSummary
import online.alarabiya.superapp.model.workorders.WorkOrderValidation
import online.alarabiya.superapp.model.workorders.WorkOrdersCapabilities
import online.alarabiya.superapp.model.workorders.WorkQueue
import org.json.JSONArray
import org.json.JSONObject

interface WorkOrdersDataSource {
    suspend fun orders(query: String = "", status: WorkOrderStatus? = null, queue: WorkQueue = WorkQueue.ALL, cursor: Long? = null): List<WorkOrderSummary>
    suspend fun counts(): WorkOrderCounts
    suspend fun order(id: Long): WorkOrderDetail
    suspend fun staff(): List<StaffOption>
    suspend fun createOrder(draft: WorkOrderDraft): Long
    suspend fun assign(id: Long, staffId: Long?)
    suspend fun claim(id: Long)
    suspend fun start(id: Long)
    suspend fun markReady(id: Long)
    suspend fun deliver(detail: WorkOrderDetail, draft: DeliveryDraft)
    suspend fun cancelOrder(id: Long)
    suspend fun printServices(tier: PriceTier): List<PrintService>
    suspend fun pricing(): PricingBundle
    suspend fun estimate(draft: PricingDraft): PrintEstimate
    suspend fun productions(query: String = "", status: ProductionStatus? = null, offset: Int = 0): Pair<List<ProductionSummary>, Boolean>
    suspend fun production(id: Long): ProductionDetail
    suspend fun recipes(): List<RecipeSummary>
    suspend fun previewRun(draft: RecipeRunDraft): RecipePreview
    suspend fun createRun(draft: RecipeRunDraft): Long
    suspend fun cancelProduction(id: Long)
}

class WorkOrdersRepository(
    private val api: TrpcClient,
    private val capabilities: WorkOrdersCapabilities,
) : WorkOrdersDataSource {
    private fun branchId() = requireNotNull(capabilities.branchId) { "لا يوجد فرع مرتبط بالجلسة" }
    private fun allow(condition: Boolean) = check(condition) { "لا تملك صلاحية تنفيذ هذه العملية" }

    override suspend fun orders(query: String, status: WorkOrderStatus?, queue: WorkQueue, cursor: Long?): List<WorkOrderSummary> {
        allow(capabilities.canReadOrders)
        val input = JSONObject().put("branchId", branchId()).put("limit", 100).put("q", query.trim().take(120))
        status?.takeIf { it != WorkOrderStatus.UNKNOWN }?.let { input.put("statuses", JSONArray().put(it.name)) }
        if (queue == WorkQueue.MINE) input.put("assignedToMe", true)
        if (queue == WorkQueue.UNASSIGNED) input.put("unassignedOnly", true)
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        return WorkOrderMappers.orderList(api.queryArray("workOrders.list", input))
    }

    override suspend fun counts(): WorkOrderCounts {
        allow(capabilities.canReadOrders)
        return WorkOrderMappers.counts(api.query("workOrders.counts", JSONObject().put("branchId", branchId())))
    }

    override suspend fun order(id: Long): WorkOrderDetail {
        allow(capabilities.canReadOrders)
        require(id > 0)
        val input = JSONObject().put("workOrderId", id)
        val detail = WorkOrderMappers.order(api.query("workOrders.get", input), api.queryArray("workOrders.timeline", input))
        require(detail.branchId == branchId()) { "أمر الشغل خارج نطاق الفرع" }
        return detail
    }

    override suspend fun staff(): List<StaffOption> {
        allow(capabilities.canCreateOrders)
        return WorkOrderMappers.staff(api.queryArray("workOrders.assignableStaff", JSONObject().put("branchId", branchId())))
    }

    override suspend fun createOrder(draft: WorkOrderDraft): Long {
        allow(capabilities.canCreateOrders)
        WorkOrderValidation.create(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("branchId", branchId())
            .put("customerId", JSONObject.NULL)
            .put("baseVariantId", JSONObject.NULL)
            .put("title", draft.title.trim())
            .put("customizationText", draft.customizationText.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("quantity", requireNotNull(draft.quantity.toIntOrNull()))
            .put("materials", JSONArray())
            .put("laborCost", "0")
            .put("salePrice", draft.salePrice)
            .put("dueDate", draft.dueDate.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("assignedTo", draft.assignedTo ?: JSONObject.NULL)
            .put("receptionChannel", draft.channel.name)
            .put("priority", draft.priority.name)
            .put("deposit", "0")
            .put("hasDelivery", draft.hasDelivery)
            .put("deliveryAddress", draft.deliveryAddress.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("deliveryPhone", draft.deliveryPhone.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("deliveryCost", if (draft.hasDelivery) draft.deliveryCost else "0")
            .put("designImages", JSONArray())
            .put("clientRequestId", draft.clientRequestId)
        return api.mutate("workOrders.create", input).getLong("workOrderId")
    }

    override suspend fun assign(id: Long, staffId: Long?) { allow(capabilities.canManageOrders); api.mutate("workOrders.assign", JSONObject().put("workOrderId", id).put("assignedTo", staffId ?: JSONObject.NULL)) }
    override suspend fun claim(id: Long) { allow(capabilities.canExecuteOrders); api.mutate("workOrders.claim", JSONObject().put("workOrderId", id)) }
    override suspend fun start(id: Long) { allow(capabilities.canExecuteOrders); api.mutate("workOrders.start", JSONObject().put("workOrderId", id)) }
    override suspend fun markReady(id: Long) { allow(capabilities.canExecuteOrders); api.mutate("workOrders.markReady", JSONObject().put("workOrderId", id)) }

    override suspend fun deliver(detail: WorkOrderDetail, draft: DeliveryDraft) {
        allow(capabilities.canDeliverOrders)
        require(detail.branchId == branchId()) { "أمر الشغل خارج نطاق الفرع" }
        WorkOrderValidation.delivery(draft, detail.customerId)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("workOrderId", detail.id).put("clientRequestId", draft.clientRequestId)
        if (draft.amount.isNotBlank()) input.put("payment", JSONObject()
            .put("amount", draft.amount)
            .put("method", draft.method.name)
            .put("reference", draft.reference.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL))
        api.mutate("workOrders.deliver", input)
    }

    override suspend fun cancelOrder(id: Long) { allow(capabilities.canManageOrders); api.mutate("workOrders.cancel", JSONObject().put("workOrderId", id)) }

    override suspend fun printServices(tier: PriceTier): List<PrintService> {
        allow(capabilities.canReadPrintServices)
        return WorkOrderMappers.printServices(api.queryArray("printPos.services", JSONObject().put("tier", tier.name)))
    }

    override suspend fun pricing(): PricingBundle {
        allow(capabilities.canUsePricing)
        return WorkOrderMappers.pricing(api.query("printPricing.settings"))
    }

    override suspend fun estimate(draft: PricingDraft): PrintEstimate {
        allow(capabilities.canUsePricing)
        WorkOrderValidation.pricing(draft)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("category", draft.category).put("applySetupFee", draft.applySetupFee)
            .put("finishingIds", JSONArray(draft.finishingIds.toList()))
        if (draft.category == "SMALL") {
            input.put("paperSize", draft.paperSize).put("colorMode", draft.colorMode).put("sides", draft.sides)
                .put("copies", draft.copies.toIntOrNull() ?: 0).put("pagesPerCopy", draft.pagesPerCopy.toIntOrNull() ?: 0)
                .put("paperUpchargeId", draft.paperUpchargeId ?: JSONObject.NULL)
        } else {
            input.put("mediaId", requireNotNull(draft.mediaId) { "اختر وسيط الطباعة" })
                .put("width", draft.width).put("height", draft.height).put("quantity", draft.quantity.toIntOrNull() ?: 0)
        }
        return WorkOrderMappers.estimate(api.query("printPricing.estimate", input))
    }

    override suspend fun productions(query: String, status: ProductionStatus?, offset: Int): Pair<List<ProductionSummary>, Boolean> {
        allow(capabilities.canManageProduction)
        val input = JSONObject().put("branchId", branchId()).put("limit", 100).put("offset", offset.coerceAtLeast(0)).put("q", query.trim().take(100))
        status?.takeIf { it != ProductionStatus.UNKNOWN }?.let { input.put("status", it.name) }
        return WorkOrderMappers.productions(api.query("production.list", input)).also { page ->
            require(page.first.all { it.branchId == branchId() }) { "قائمة الإنتاج خارج نطاق الفرع" }
        }
    }

    override suspend fun production(id: Long): ProductionDetail {
        allow(capabilities.canManageProduction)
        return WorkOrderMappers.production(api.query("production.get", JSONObject().put("productionOrderId", id)))
            .also { require(it.id == id && it.branchId == branchId()) { "مستند الإنتاج خارج نطاق الفرع" } }
    }

    override suspend fun recipes(): List<RecipeSummary> {
        allow(capabilities.canManageProduction)
        return WorkOrderMappers.recipes(api.queryArray("production.recipes.list", JSONObject().put("activeOnly", true)))
    }

    override suspend fun previewRun(draft: RecipeRunDraft): RecipePreview {
        allow(capabilities.canManageProduction)
        WorkOrderValidation.production(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        return WorkOrderMappers.recipePreview(api.query("production.runPreview", JSONObject()
            .put("recipeId", requireNotNull(draft.recipeId)).put("batchQty", requireNotNull(draft.batchQty.toIntOrNull()))
            .put("scrapQty", requireNotNull(draft.scrapQty.toIntOrNull())).put("laborPerUnit", draft.laborPerUnit.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("branchId", branchId())))
    }

    override suspend fun createRun(draft: RecipeRunDraft): Long {
        allow(capabilities.canManageProduction)
        WorkOrderValidation.production(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        val run = JSONObject().put("recipeId", requireNotNull(draft.recipeId)).put("batchQty", requireNotNull(draft.batchQty.toIntOrNull()))
            .put("scrapQty", requireNotNull(draft.scrapQty.toIntOrNull())).put("laborPerUnit", draft.laborPerUnit.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
        return api.mutate("production.create", JSONObject().put("branchId", branchId()).put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("clientRequestId", draft.clientRequestId).put("run", run)).getLong("productionOrderId")
    }

    override suspend fun cancelProduction(id: Long) { allow(capabilities.canManageProduction); api.mutate("production.cancel", JSONObject().put("productionOrderId", id)) }
}

fun newWorkOrderDraft() = WorkOrderDraft(clientRequestId = UUID.randomUUID().toString())
fun newDeliveryDraft() = DeliveryDraft(clientRequestId = UUID.randomUUID().toString())
fun newRecipeRunDraft() = RecipeRunDraft(clientRequestId = UUID.randomUUID().toString())

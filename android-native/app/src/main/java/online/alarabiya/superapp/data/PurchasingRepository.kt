package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.purchasing.PaymentMethod
import online.alarabiya.superapp.model.purchasing.PurchaseCatalogItem
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraft
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseReceiveDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnPage
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.purchasing.PurchasingMappers
import online.alarabiya.superapp.model.purchasing.PurchasingValidation
import online.alarabiya.superapp.model.purchasing.ReminderHistoryItem
import online.alarabiya.superapp.model.purchasing.ReminderQueueItem
import online.alarabiya.superapp.model.purchasing.SupplierDetail
import online.alarabiya.superapp.model.purchasing.SupplierDraft
import online.alarabiya.superapp.model.purchasing.SupplierKind
import online.alarabiya.superapp.model.purchasing.SupplierPage
import org.json.JSONArray
import org.json.JSONObject

data class PurchaseCreateResult(val purchaseOrderId: Long, val idempotent: Boolean)
data class PurchaseReturnResult(val purchaseReturnEntryId: Long, val returnedTotal: String, val idempotent: Boolean)
data class ReminderSendResult(val sent: Boolean, val reminderId: Long?, val reason: String?)

interface PurchasingDataSource {
    suspend fun catalog(branchId: Long, query: String = ""): List<PurchaseCatalogItem>
    suspend fun suppliers(query: String = "", includeInactive: Boolean = false, kind: SupplierKind? = null): SupplierPage
    suspend fun supplier(id: Long): SupplierDetail
    suspend fun createSupplier(draft: SupplierDraft): Long
    suspend fun updateSupplier(draft: SupplierDraft)
    suspend fun setSupplierActive(id: Long, active: Boolean)
    suspend fun orders(query: String = ""): List<PurchaseOrderSummary>
    suspend fun order(id: Long): PurchaseOrderDetail
    suspend fun createOrder(draft: PurchaseOrderDraft): PurchaseCreateResult
    suspend fun confirmOrder(id: Long)
    suspend fun receiveOrder(draft: PurchaseReceiveDraft)
    suspend fun cancelOrder(id: Long)
    suspend fun returns(query: String = ""): PurchaseReturnPage
    suspend fun createReturn(draft: PurchaseReturnDraft): PurchaseReturnResult
    suspend fun reminderQueue(allBranches: Boolean = false): List<ReminderQueueItem>
    suspend fun reminderHistory(allBranches: Boolean = false): List<ReminderHistoryItem>
    suspend fun sendReminder(item: ReminderQueueItem): ReminderSendResult
    suspend fun skipReminder(item: ReminderQueueItem, reason: String, promisedDate: String? = null)
}

class PurchasingRepository(
    private val api: TrpcClient,
    private val capabilities: PurchasingCapabilities,
) : PurchasingDataSource {
    override suspend fun catalog(branchId: Long, query: String): List<PurchaseCatalogItem> {
        require(capabilities.canWriteOrders) { "لا تملك صلاحية قراءة كلفة أصناف الشراء" }
        require(branchId > 0) { "حدد فرعاً لعرض أصناف الشراء" }
        val input = JSONObject().put("branchId", branchId).put("limit", 100)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("query", it.take(200)) }
        return PurchasingMappers.catalog(api.queryArray("catalog.forPurchase", input))
    }

    override suspend fun suppliers(query: String, includeInactive: Boolean, kind: SupplierKind?): SupplierPage {
        require(capabilities.canReadSuppliers) { "لا تملك صلاحية قراءة الموردين" }
        val input = JSONObject().put("includeInactive", includeInactive).put("limit", 200).put("offset", 0)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        kind?.takeIf { it != SupplierKind.UNKNOWN }?.let { input.put("kind", it.name) }
        return PurchasingMappers.suppliers(api.query("suppliers.search", input))
    }

    override suspend fun supplier(id: Long): SupplierDetail {
        require(id > 0) { "معرّف المورد غير صالح" }
        return PurchasingMappers.supplier(api.query("suppliers.get", JSONObject().put("supplierId", id)))
    }

    override suspend fun createSupplier(draft: SupplierDraft): Long {
        require(capabilities.canWriteSuppliers) { "لا تملك صلاحية إضافة المورد" }
        require(capabilities.branchId != null) { "لا يوجد فرع مرتبط بالجلسة؛ إنشاء المورد متوقف لحماية نطاق البيانات" }
        PurchasingValidation.supplier(draft, capabilities.canSetOpeningBalanceOnCreate)?.let { throw IllegalArgumentException(it) }
        val result = api.mutate("suppliers.create", supplierJson(draft, create = true))
        return result.getLong("supplierId")
    }

    override suspend fun updateSupplier(draft: SupplierDraft) {
        require(capabilities.canWriteSuppliers) { "لا تملك صلاحية تعديل المورد" }
        requireNotNull(draft.id) { "معرّف المورد مطلوب" }
        PurchasingValidation.supplier(draft, capabilities.canEditOpeningBalance)?.let { throw IllegalArgumentException(it) }
        api.mutate("suppliers.update", supplierJson(draft, create = false))
    }

    override suspend fun setSupplierActive(id: Long, active: Boolean) {
        require(capabilities.canWriteSuppliers) { "لا تملك صلاحية إدارة المورد" }
        api.mutate(if (active) "suppliers.activate" else "suppliers.deactivate", JSONObject().put("supplierId", id))
    }

    override suspend fun orders(query: String): List<PurchaseOrderSummary> {
        require(capabilities.canReadOrders) { "لا تملك صلاحية قراءة المشتريات" }
        val input = JSONObject().put("limit", 100).put("offset", 0)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        if (!capabilities.allBranches) capabilities.branchId?.let { input.put("branchId", it) }
        return PurchasingMappers.orders(api.queryArray("purchases.list", input))
    }

    override suspend fun order(id: Long): PurchaseOrderDetail {
        require(id > 0) { "معرّف أمر الشراء غير صالح" }
        return PurchasingMappers.order(api.query("purchases.get", JSONObject().put("purchaseOrderId", id)))
    }

    override suspend fun createOrder(draft: PurchaseOrderDraft): PurchaseCreateResult {
        require(capabilities.canWriteOrders) { "لا تملك صلاحية إنشاء أمر شراء" }
        PurchasingValidation.order(draft, capabilities.branchId.takeUnless { capabilities.role in setOf("admin", "manager") })
            ?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("supplierId", draft.supplierId).put("branchId", requireNotNull(draft.branchId))
            .put("taxRatePercent", draft.taxRatePercent).put("status", draft.status.name)
            .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("clientRequestId", draft.clientRequestId).put("agreedCurrency", draft.currency.name)
            .put("shippingCost", draft.shippingCost).put("customsCost", draft.customsCost)
            .put("items", JSONArray().apply { draft.items.forEach { line -> put(JSONObject().put("variantId", line.variantId).put("productUnitId", line.productUnitId).put("quantity", line.quantity.trim()).put("unitPrice", line.unitPrice.trim())) } })
        if (draft.currency.name == "USD") input.put("usdTotal", draft.usdTotal.trim()).put("agreedRate", draft.agreedRate.trim())
        val result = api.mutate("purchases.createOrder", input)
        return PurchaseCreateResult(result.getLong("purchaseOrderId"), result.optBoolean("idempotent", false))
    }

    override suspend fun confirmOrder(id: Long) {
        require(capabilities.canWriteOrders) { "لا تملك صلاحية اعتماد أمر الشراء" }
        api.mutate("purchases.confirmOrder", JSONObject().put("purchaseOrderId", id))
    }

    override suspend fun receiveOrder(draft: PurchaseReceiveDraft) {
        require(capabilities.canReceiveOrders) { "لا تملك صلاحية استلام أمر الشراء أو لا يوجد فرع مرتبط" }
        val detail = order(draft.purchaseOrderId)
        PurchasingValidation.receive(draft, detail)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("purchaseOrderId", draft.purchaseOrderId).put("clientRequestId", draft.clientRequestId)
            .put("lines", JSONArray().apply { draft.lines.forEach { put(JSONObject().put("purchaseOrderItemId", it.purchaseOrderItemId).put("receivedBaseQuantity", it.receivedBaseQuantity.toInt())) } })
        draft.paymentAmount.trim().takeIf(String::isNotEmpty)?.let {
            input.put("payment", JSONObject().put("amount", it).put("method", draft.paymentMethod.name))
        }
        api.mutate("purchases.receive", input)
    }

    override suspend fun cancelOrder(id: Long) {
        require(capabilities.canWriteOrders && capabilities.branchId != null) { "لا يمكن إلغاء الأمر دون صلاحية وفرع مرتبط" }
        api.mutate("purchases.cancel", JSONObject().put("purchaseOrderId", id))
    }

    override suspend fun returns(query: String): PurchaseReturnPage {
        require(capabilities.canReadReturns) { "لا تملك صلاحية قراءة مرتجعات الشراء" }
        val input = JSONObject().put("limit", 100).put("offset", 0)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        if (capabilities.role != "admin") input.put("branchId", requireNotNull(capabilities.branchId))
        return PurchasingMappers.returns(api.query("purchaseReturns.list", input))
    }

    override suspend fun createReturn(draft: PurchaseReturnDraft): PurchaseReturnResult {
        require(capabilities.canWriteReturns) { "لا تملك صلاحية إنشاء مرتجع شراء" }
        PurchasingValidation.purchaseReturn(draft, capabilities.branchId.takeUnless { capabilities.role == "admin" })
            ?.let { throw IllegalArgumentException(it) }
        val input = JSONObject().put("clientRequestId", draft.clientRequestId).put("supplierId", draft.supplierId)
            .put("branchId", requireNotNull(draft.branchId)).put("settlement", draft.settlement.name)
            .put("reason", draft.reason.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("items", JSONArray().apply { draft.items.forEach { put(JSONObject().put("variantId", it.variantId).put("productUnitId", it.productUnitId).put("quantity", it.quantity.trim()).put("unitPrice", it.unitPrice.trim())) } })
        draft.purchaseOrderRefId?.let { input.put("purchaseOrderRefId", it) }
        draft.paymentMethod?.let { input.put("paymentMethod", it.name) }
        val result = api.mutate("purchaseReturns.create", input)
        return PurchaseReturnResult(result.getLong("purchaseReturnEntryId"), result.optString("returnedTotal", "0"), result.optBoolean("idempotent", false))
    }

    override suspend fun reminderQueue(allBranches: Boolean): List<ReminderQueueItem> {
        require(capabilities.canReadReminders) { "لا تملك صلاحية قراءة التذكيرات" }
        return PurchasingMappers.reminderQueue(api.queryArray("apReminders.queue", reminderScope(allBranches)))
    }

    override suspend fun reminderHistory(allBranches: Boolean): List<ReminderHistoryItem> {
        require(capabilities.canReadReminders) { "لا تملك صلاحية قراءة سجل التذكيرات" }
        return PurchasingMappers.reminderHistory(api.queryArray("apReminders.history", reminderScope(allBranches).put("limit", 100)))
    }

    override suspend fun sendReminder(item: ReminderQueueItem): ReminderSendResult {
        require(capabilities.canWriteReminders) { "لا يمكن إرسال التذكير دون صلاحية وفرع مرتبط" }
        val result = api.mutate("apReminders.sendViaApi", reminderPayload(item))
        return ReminderSendResult(result.optBoolean("sent", false), result.optLong("reminderId").takeIf { it > 0 }, result.optString("reason").takeIf(String::isNotBlank))
    }

    override suspend fun skipReminder(item: ReminderQueueItem, reason: String, promisedDate: String?) {
        require(capabilities.canWriteReminders) { "لا يمكن تخطي التذكير دون صلاحية وفرع مرتبط" }
        require(reason.trim().isNotEmpty()) { "سبب التخطي مطلوب" }
        if (promisedDate != null) require(PurchasingValidation.reminderDate(promisedDate)) { "صيغة تاريخ الوعد غير صالحة" }
        api.mutate("apReminders.logSkipped", reminderPayload(item).put("skipReason", reason.trim().take(255)).put("promisedDate", promisedDate ?: JSONObject.NULL))
    }

    private fun reminderScope(allBranches: Boolean): JSONObject = JSONObject().also { input ->
        if (allBranches) {
            require(capabilities.role == "admin") { "عرض جميع الفروع متاح للأدمن فقط" }
            input.put("allBranches", true)
        } else input.put("branchId", requireNotNull(capabilities.branchId) { "حدد فرعاً لعرض التذكيرات" })
    }

    private fun reminderPayload(item: ReminderQueueItem) = JSONObject()
        .put("supplierId", item.supplierId).put("totalUnpaidSnapshot", item.totalUnpaid)
        .put("oldestPoDate", item.oldestPoDate).put("daysOverdue", item.daysOverdue)
        .put("branchId", requireNotNull(capabilities.branchId))

    private fun supplierJson(draft: SupplierDraft, create: Boolean): JSONObject = JSONObject().apply {
        if (!create) put("supplierId", requireNotNull(draft.id))
        put("name", draft.name.trim()).putNullable("phone", draft.phone).putNullable("email", draft.email)
            .putNullable("whatsapp", draft.whatsapp).putNullable("address", draft.address).putNullable("city", draft.city)
            .putNullable("paymentTerms", draft.paymentTerms).putNullable("supplierCategory", draft.category)
            .putNullable("notes", draft.notes).put("supplierKind", draft.kind.name)
        if (create) put("clientRequestId", draft.clientRequestId)
        if ((if (create) capabilities.canSetOpeningBalanceOnCreate else capabilities.canEditOpeningBalance) && draft.openingBalance.isNotBlank()) {
            put("openingBalance", draft.openingBalance.trim()).put("openingBalanceDirection", draft.openingDirection)
        }
    }
}

private fun JSONObject.putNullable(key: String, raw: String): JSONObject = put(key, raw.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)

package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.inventory.AdjustmentDraft
import online.alarabiya.superapp.model.inventory.AdjustmentRequest
import online.alarabiya.superapp.model.inventory.AdjustmentStatus
import online.alarabiya.superapp.model.inventory.CountAssignment
import online.alarabiya.superapp.model.inventory.CountSession
import online.alarabiya.superapp.model.inventory.InventoryBranch
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.inventory.InventoryMappers
import online.alarabiya.superapp.model.inventory.InventoryValidation
import online.alarabiya.superapp.model.inventory.MovementPage
import online.alarabiya.superapp.model.inventory.MovementType
import online.alarabiya.superapp.model.inventory.ReceiveDraft
import online.alarabiya.superapp.model.inventory.StockBalance
import online.alarabiya.superapp.model.inventory.StocktakeDetail
import online.alarabiya.superapp.model.inventory.StocktakeDraft
import online.alarabiya.superapp.model.inventory.StocktakeStatus
import online.alarabiya.superapp.model.inventory.StocktakeSummary
import online.alarabiya.superapp.model.inventory.TransferDetail
import online.alarabiya.superapp.model.inventory.TransferDraft
import online.alarabiya.superapp.model.inventory.TransferPage
import online.alarabiya.superapp.model.inventory.TransferStatus
import org.json.JSONArray
import org.json.JSONObject

interface InventoryDataSource {
    suspend fun branches(): List<InventoryBranch>
    suspend fun balances(query: String = "", lowOnly: Boolean = false, offset: Int = 0): List<StockBalance>
    suspend fun movements(query: String = "", type: MovementType? = null, cursor: Long? = null): MovementPage
    suspend fun transfers(query: String = "", status: TransferStatus? = null, cursor: Long? = null): TransferPage
    suspend fun transfer(id: Long): TransferDetail
    suspend fun createTransfer(draft: TransferDraft): Long
    suspend fun receiveTransfer(detail: TransferDetail, draft: ReceiveDraft)
    suspend fun cancelTransfer(id: Long)
    suspend fun adjustments(status: AdjustmentStatus = AdjustmentStatus.PENDING_APPROVAL): List<AdjustmentRequest>
    suspend fun requestAdjustment(draft: AdjustmentDraft): Long
    suspend fun approveAdjustment(id: Long)
    suspend fun rejectAdjustment(id: Long, reason: String)
    suspend fun stocktakes(status: StocktakeStatus? = null): List<StocktakeSummary>
    suspend fun stocktake(id: Long): StocktakeDetail
    suspend fun createStocktake(draft: StocktakeDraft): Long
    suspend fun requestRecount(sessionId: Long, variantId: Long, reason: String)
    suspend fun forceStocktakeReview(sessionId: Long)
    suspend fun firstSignStocktake(sessionId: Long)
    /** @return عدد الأصناف التي ثُبّتت برصيدٍ سالب حقيقي (بيعٌ استمرّ بعد العدّ وتجاوزه). */
    suspend fun approveStocktake(sessionId: Long): Int
    suspend fun cancelStocktake(sessionId: Long, reason: String)
    suspend fun countAssignments(): List<CountAssignment>
    suspend fun countSession(sessionCode: String): CountSession
    suspend fun submitCount(sessionCode: String, variantId: Long, quantity: Int, clientRequestId: String)
    suspend fun finishCount(sessionCode: String)
}

class InventoryRepository(
    private val api: TrpcClient,
    private val capabilities: InventoryCapabilities,
) : InventoryDataSource {
    private fun branchId(): Long = requireNotNull(capabilities.branchId) {
        "لا يوجد فرع مرتبط بالجلسة — راجع مسؤول النظام"
    }

    override suspend fun branches(): List<InventoryBranch> =
        InventoryMappers.branches(api.queryArray("branches.list"))

    override suspend fun balances(query: String, lowOnly: Boolean, offset: Int): List<StockBalance> {
        val input = JSONObject()
            .put("branchId", branchId())
            .put("q", query.trim().take(120))
            .put("lowOnly", lowOnly)
            .put("limit", 100)
            .put("offset", offset.coerceAtLeast(0))
        return InventoryMappers.balances(api.queryArray("inventory.onHand", input))
    }

    override suspend fun movements(query: String, type: MovementType?, cursor: Long?): MovementPage {
        val input = JSONObject()
            .put("branchId", branchId())
            .put("q", query.trim().take(120))
            .put("limit", 100)
        type?.takeIf { it != MovementType.UNKNOWN }?.let { input.put("movementType", it.name) }
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        return InventoryMappers.movements(api.query("inventory.movementsRich", input))
    }

    override suspend fun transfers(query: String, status: TransferStatus?, cursor: Long?): TransferPage {
        val input = JSONObject()
            .put("branchId", branchId())
            .put("dir", "all")
            .put("limit", 60)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(60)) }
        status?.takeIf { it != TransferStatus.UNKNOWN }?.let { input.put("status", it.name) }
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        return InventoryMappers.transfers(api.query("inventory.transfersList", input))
    }

    override suspend fun transfer(id: Long): TransferDetail {
        require(id > 0) { "معرّف سند التحويل غير صالح" }
        return InventoryMappers.transfer(api.query("inventory.transferGet", JSONObject().put("id", id)))
    }

    override suspend fun createTransfer(draft: TransferDraft): Long {
        InventoryValidation.transfer(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("fromBranchId", branchId())
            .put("toBranchId", requireNotNull(draft.toBranchId))
            .put("reason", draft.reason)
            .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("clientRequestId", draft.clientRequestId)
            .put("items", JSONArray().put(
                JSONObject()
                    .put("variantId", draft.variantId)
                    .put("baseQuantity", requireNotNull(draft.quantity.toIntOrNull())),
            ))
        return api.mutate("inventory.transferBatch", input).getLong("transferId")
    }

    override suspend fun receiveTransfer(detail: TransferDetail, draft: ReceiveDraft) {
        InventoryValidation.receive(detail, draft)?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "inventory.transferReceive",
            JSONObject()
                .put("transferId", detail.id)
                .put("receiveNotes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
                .put("clientRequestId", draft.clientRequestId)
                .put("lines", JSONArray().apply {
                    draft.lines.forEach { line ->
                        put(
                            JSONObject()
                                .put("lineId", line.lineId)
                                .put("quantityReceived", requireNotNull(line.quantity.toIntOrNull()))
                                .put("note", line.note.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL),
                        )
                    }
                }),
        )
    }

    override suspend fun cancelTransfer(id: Long) {
        api.mutate("inventory.transferCancel", JSONObject().put("transferId", id))
    }

    override suspend fun adjustments(status: AdjustmentStatus): List<AdjustmentRequest> {
        val input = JSONObject()
        status.takeIf { it != AdjustmentStatus.UNKNOWN }?.let { input.put("status", it.name) }
        // The server intentionally gives administrators an all-branch approval inbox. This native
        // workspace remains bound to the branch selected in the authenticated bootstrap session.
        return InventoryMappers.adjustments(api.queryArray("inventory.pendingAdjustments", input))
            .filter { it.branchId == branchId() }
    }

    override suspend fun requestAdjustment(draft: AdjustmentDraft): Long {
        InventoryValidation.adjustment(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        return api.mutate(
            "inventory.adjust",
            JSONObject()
                .put("variantId", draft.variantId)
                .put("branchId", branchId())
                .put("targetQuantity", requireNotNull(draft.targetQuantity.toIntOrNull()))
                .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL),
        ).getLong("requestId")
    }

    override suspend fun approveAdjustment(id: Long) {
        api.mutate("inventory.approveAdjustment", JSONObject().put("id", id))
    }

    override suspend fun rejectAdjustment(id: Long, reason: String) {
        require(reason.trim().isNotEmpty()) { "سبب الرفض مطلوب" }
        api.mutate(
            "inventory.rejectAdjustment",
            JSONObject().put("id", id).put("reason", reason.trim().take(500)),
        )
    }

    override suspend fun stocktakes(status: StocktakeStatus?): List<StocktakeSummary> {
        val input = JSONObject().put("branchId", branchId()).put("limit", 100).put("offset", 0)
        status?.takeIf { it != StocktakeStatus.UNKNOWN }?.let { input.put("status", it.name) }
        return InventoryMappers.stocktakes(api.queryArray("stocktakes.list", input))
    }

    override suspend fun stocktake(id: Long): StocktakeDetail {
        require(id > 0) { "معرّف جلسة الجرد غير صالح" }
        val input = JSONObject().put("sessionId", id)
        val detail = api.query("stocktakes.get", input)
        val monitor = api.query("stocktakes.monitor", input)
        return InventoryMappers.stocktake(detail, monitor)
    }

    override suspend fun createStocktake(draft: StocktakeDraft): Long {
        InventoryValidation.stocktake(draft, capabilities.branchId)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("name", draft.name.trim())
            .put("branchId", branchId())
            .put("sessionType", "NORMAL")
            .put("scopeType", draft.scopeType)
            .put("blind", true)
            .put("dupPolicy", "VERIFY")
            .put("notes", draft.notes.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("assignments", JSONArray().put(
                JSONObject()
                    .put("name", capabilities.userName)
                    .put("method", "USER")
                    .put("userId", capabilities.userId),
            ))
        if (draft.scopeType == "MOVING") input.put("movingDays", requireNotNull(draft.movingDays.toIntOrNull()))
        return api.mutate("stocktakes.create", input).getLong("sessionId")
    }

    override suspend fun requestRecount(sessionId: Long, variantId: Long, reason: String) {
        require(reason.trim().length >= 3) { "سبب إعادة العد يجب أن يكون ثلاثة أحرف على الأقل" }
        api.mutate(
            "stocktakes.requestRecount",
            JSONObject()
                .put("sessionId", sessionId)
                .put("variantId", variantId)
                .put("reason", reason.trim().take(255)),
        )
    }

    override suspend fun forceStocktakeReview(sessionId: Long) {
        api.mutate("stocktakes.forceReview", JSONObject().put("sessionId", sessionId))
    }

    override suspend fun firstSignStocktake(sessionId: Long) {
        api.mutate("stocktakes.firstSign", JSONObject().put("sessionId", sessionId))
    }

    override suspend fun approveStocktake(sessionId: Long): Int =
        api.mutate("stocktakes.approve", JSONObject().put("sessionId", sessionId))
            .optInt("negativeSettlements", 0)

    override suspend fun cancelStocktake(sessionId: Long, reason: String) {
        api.mutate(
            "stocktakes.cancel",
            JSONObject().put("sessionId", sessionId).put("reason", reason.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL),
        )
    }

    override suspend fun countAssignments(): List<CountAssignment> =
        InventoryMappers.countAssignments(api.queryArray("count.mine"))

    override suspend fun countSession(sessionCode: String): CountSession = InventoryMappers.countSession(
        api.query("count.state", JSONObject().put("sessionCode", sessionCode)),
    )

    override suspend fun submitCount(sessionCode: String, variantId: Long, quantity: Int, clientRequestId: String) {
        api.mutate(
            "count.submit",
            JSONObject()
                .put("sessionCode", sessionCode)
                .put("variantId", variantId)
                .put("qty", quantity)
                .put("clientRequestId", clientRequestId),
        )
    }

    override suspend fun finishCount(sessionCode: String) {
        api.mutate("count.finish", JSONObject().put("sessionCode", sessionCode))
    }
}

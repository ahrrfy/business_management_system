package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteDetail
import online.alarabiya.superapp.model.operations.ConsignmentNoteType
import online.alarabiya.superapp.model.operations.ConsignmentPage
import online.alarabiya.superapp.model.operations.ConsignorProduct
import online.alarabiya.superapp.model.operations.MyCommissionStatus
import online.alarabiya.superapp.model.operations.OperationsMappers
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.operations.OperationsValidation
import online.alarabiya.superapp.model.operations.QuickConsignmentInput
import org.json.JSONArray
import org.json.JSONObject

data class AssetQuery(
    val status: AssetStatus? = null,
    val includeDisposed: Boolean = false,
    val branchId: Long? = null,
)

data class ConsignmentQuery(
    val query: String = "",
    val type: ConsignmentNoteType? = null,
    val branchId: Long? = null,
    val offset: Int = 0,
    val limit: Int = 50,
)

interface OperationsDataSource {
    suspend fun listAssets(query: AssetQuery): List<AssetSummary>
    suspend fun assetDetail(summary: AssetSummary): AssetDetail
    suspend fun startWarrantyMaintenance(asset: AssetSummary, type: String, vendor: String?, note: String?, date: String?)
    suspend fun returnFromMaintenance(asset: AssetSummary)
    suspend fun myCommission(period: String? = null): MyCommissionStatus?
    suspend fun listConsignments(query: ConsignmentQuery): ConsignmentPage
    suspend fun consignmentDetail(summary: online.alarabiya.superapp.model.operations.ConsignmentNoteSummary): ConsignmentNoteDetail
    suspend fun consignorProducts(consignorId: Long, branchId: Long): List<ConsignorProduct>
    suspend fun createQuickConsignment(input: QuickConsignmentInput): Long
}

class OperationsRepository(
    private val api: TrpcClient,
    private val scope: OperationsScope,
) : OperationsDataSource {
    override suspend fun listAssets(query: AssetQuery): List<AssetSummary> {
        val input = JSONObject().put("includeDisposed", query.includeDisposed)
        query.status?.takeIf { it != AssetStatus.Unknown }?.let { input.put("status", it.wire) }
        val effectiveBranch = scope.effectiveBranch(query.branchId)
        require(scope.isAdmin || effectiveBranch?.let { it > 0 } == true) { "لا يوجد فرع مرتبط بالحساب" }
        effectiveBranch?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        return OperationsMappers.assets(api.queryArray("assets.list", input))
            .filter { scope.acceptsBranch(it.branchId) }
    }

    override suspend fun assetDetail(summary: AssetSummary): AssetDetail {
        requireAssetInScope(summary)
        if (!scope.isAdmin) return OperationsMappers.scopedAssetDetail(summary)
        val detail = OperationsMappers.assetDetail(
            api.query("assets.get", JSONObject().put("id", summary.id)),
        )
        require(detail.summary.id == summary.id) { "استجابة الأصل لا تطابق الطلب" }
        return detail
    }

    override suspend fun startWarrantyMaintenance(
        asset: AssetSummary,
        type: String,
        vendor: String?,
        note: String?,
        date: String?,
    ) {
        requireAssetInScope(asset)
        require(asset.status == AssetStatus.Active) { "الأصل ليس بالخدمة" }
        val cleanType = type.trim()
        require(cleanType.isNotEmpty()) { "نوع الصيانة مطلوب" }
        require(date == null || DATE.matches(date)) { "تاريخ الصيانة غير صالح" }
        val input = JSONObject()
            .put("assetId", asset.id)
            .put("type", cleanType.take(255))
            // التطبيق المتنقل لا يرحّل دفعة خزينة: الصيانة المدفوعة تحتاج مسار موافقة وفصل واجبات.
            .put("cost", "0")
        vendor?.trim()?.takeIf(String::isNotEmpty)?.let { input.put("vendor", it.take(255)) }
        note?.trim()?.takeIf(String::isNotEmpty)?.let { input.put("note", it.take(500)) }
        date?.let { input.put("maintDate", it) }
        api.mutate("assets.addMaintenance", input)
    }

    override suspend fun returnFromMaintenance(asset: AssetSummary) {
        requireAssetInScope(asset)
        require(asset.status == AssetStatus.Maintenance) { "الأصل ليس في الصيانة" }
        api.mutate("assets.returnFromMaintenance", JSONObject().put("assetId", asset.id))
    }

    override suspend fun myCommission(period: String?): MyCommissionStatus? {
        val input = period?.takeIf(PERIOD::matches)?.let { JSONObject().put("period", it) }
        return try {
            OperationsMappers.myCommission(api.query("commissions.performance.myStatus", input))
        } catch (error: ApiException) {
            // myStatus يعيد null عند عدم وجود خطة، بينما عميل tRPC الحالي لا يدعم JSON null.
            if (error.message == "استجابة الخادم غير مكتملة") null else throw error
        }
    }

    override suspend fun listConsignments(query: ConsignmentQuery): ConsignmentPage {
        val limit = query.limit.coerceIn(1, 500)
        val offset = query.offset.coerceAtLeast(0)
        val input = JSONObject().put("limit", limit).put("offset", offset)
        query.query.trim().take(50).takeIf(String::isNotEmpty)?.let { input.put("q", it) }
        query.type?.takeIf { it != ConsignmentNoteType.Unknown }?.let { input.put("noteType", it.wire) }
        val effectiveBranch = scope.effectiveBranch(query.branchId)
        require(scope.isAdmin || effectiveBranch?.let { it > 0 } == true) { "لا يوجد فرع مرتبط بالحساب" }
        effectiveBranch?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        val page = OperationsMappers.consignmentPage(api.query("consignments.list", input), offset, limit)
        return page.copy(rows = page.rows.filter { scope.acceptsBranch(it.branchId) })
    }

    override suspend fun consignmentDetail(
        summary: online.alarabiya.superapp.model.operations.ConsignmentNoteSummary,
    ): ConsignmentNoteDetail {
        require(scope.acceptsBranch(summary.branchId)) { "السند خارج نطاق الفرع" }
        if (!scope.isAdmin) return OperationsMappers.scopedConsignmentDetail(summary)
        val detail = OperationsMappers.consignmentDetail(
            api.query("consignments.get", JSONObject().put("noteId", summary.id)),
        )
        require(detail.summary.id == summary.id && scope.acceptsBranch(detail.summary.branchId)) {
            "استجابة السند خارج النطاق"
        }
        return detail
    }

    override suspend fun consignorProducts(consignorId: Long, branchId: Long): List<ConsignorProduct> {
        require(consignorId > 0 && branchId > 0 && scope.acceptsBranch(branchId)) { "نطاق المودع غير صالح" }
        return OperationsMappers.consignorProducts(
            api.queryArray(
                "consignments.consignorProducts",
                JSONObject().put("consignorId", consignorId).put("branchId", branchId),
            ),
        )
    }

    override suspend fun createQuickConsignment(input: QuickConsignmentInput): Long {
        require(input.type == ConsignmentNoteType.Deposit || input.type == ConsignmentNoteType.Withdraw) {
            "الاستبدال يحتاج سطري إيداع وسحب على الأقل"
        }
        require(input.consignorId > 0 && input.branchId > 0 && scope.acceptsBranch(input.branchId)) {
            "نطاق السند غير صالح"
        }
        require(input.product.variantId > 0 && input.product.productUnitId > 0) { "الصنف غير صالح" }
        require(OperationsValidation.isPositiveQuantity(input.quantity)) { "الكمية غير صالحة" }
        require(input.clientRequestId.length in 8..64) { "مفتاح الطلب غير صالح" }
        val direction = if (input.type == ConsignmentNoteType.Deposit) "IN" else "OUT"
        val line = JSONObject()
            .put("lineDirection", direction)
            .put("variantId", input.product.variantId)
            .put("productUnitId", input.product.productUnitId)
            .put("quantity", input.quantity.trim())
        val body = JSONObject()
            .put("noteType", input.type.wire)
            .put("consignorId", input.consignorId)
            .put("branchId", input.branchId)
            .put("clientRequestId", input.clientRequestId)
            .put("lines", JSONArray().put(line))
        input.notes?.trim()?.takeIf(String::isNotEmpty)?.let { body.put("notes", it.take(500)) }
        val result = api.mutate("consignments.create", body)
        return result.optLong("noteId", 0L).also { require(it > 0) { "لم يُرجع الخادم معرّف السند" } }
    }

    private fun requireAssetInScope(asset: AssetSummary) {
        require(asset.id > 0 && scope.acceptsBranch(asset.branchId)) { "الأصل خارج نطاق الفرع" }
    }

    private companion object {
        val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
    }
}

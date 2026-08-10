package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.operations.AssetDepreciationResult
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetDisposalInput
import online.alarabiya.superapp.model.operations.AssetDocument
import online.alarabiya.superapp.model.operations.AssetFormOptions
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.AssetUpsertInput
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
    suspend fun assetFormOptions(): AssetFormOptions
    suspend fun createAsset(input: AssetUpsertInput): AssetDetail
    suspend fun updateAsset(asset: AssetSummary, input: AssetUpsertInput): AssetDetail
    suspend fun handoverAsset(asset: AssetSummary, employeeId: Long, note: String?): AssetDetail
    suspend fun releaseAssetCustody(asset: AssetSummary): AssetDetail
    suspend fun disposeAsset(asset: AssetSummary, input: AssetDisposalInput): AssetDetail
    suspend fun addAssetDocument(asset: AssetSummary, title: String, dataUrl: String): AssetDocument
    suspend fun deleteAssetDocument(asset: AssetSummary, documentId: Long): Long
    suspend fun postAssetDepreciation(year: Int, month: Int): AssetDepreciationResult
    suspend fun startWarrantyMaintenance(asset: AssetSummary, type: String, vendor: String?, note: String?, date: String?): AssetDetail
    suspend fun returnFromMaintenance(asset: AssetSummary): AssetDetail
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
        val detail = OperationsMappers.assetDetail(
            api.query("assets.get", JSONObject().put("id", summary.id)),
        )
        require(detail.summary.id == summary.id && scope.acceptsBranch(detail.summary.branchId)) {
            "استجابة الأصل خارج نطاق الفرع"
        }
        return detail
    }

    override suspend fun assetFormOptions(): AssetFormOptions {
        val options = OperationsMappers.assetFormOptions(api.query("assets.formOptions"))
        val effectiveBranch = scope.effectiveBranch()
        return options.copy(
            employees = options.employees.filter { employee ->
                effectiveBranch == null || employee.branchId == effectiveBranch
            },
            branches = options.branches.filter { branch ->
                effectiveBranch == null || branch.id == effectiveBranch
            },
        )
    }

    override suspend fun createAsset(input: AssetUpsertInput): AssetDetail {
        require(input.id == null) { "طلب إنشاء الأصل غير صالح" }
        val scoped = input.copy(branchId = scope.effectiveBranch(input.branchId))
        OperationsValidation.asset(scoped, scope)?.let { error(it) }
        return OperationsMappers.assetDetail(api.mutate("assets.create", scoped.assetJson(includeId = false, includeCustodian = true)))
            .also { requireAssetInScope(it.summary) }
    }

    override suspend fun updateAsset(asset: AssetSummary, input: AssetUpsertInput): AssetDetail {
        requireAssetInScope(asset)
        require(input.id == asset.id) { "طلب تعديل الأصل لا يطابق الأصل المحدد" }
        require(asset.status != AssetStatus.Disposed) { "لا يمكن تعديل أصل مستبعد" }
        val scoped = input.copy(branchId = scope.effectiveBranch(input.branchId))
        OperationsValidation.asset(scoped, scope)?.let { error(it) }
        return OperationsMappers.assetDetail(api.mutate("assets.update", scoped.assetJson(includeId = true, includeCustodian = false)))
            .also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun handoverAsset(asset: AssetSummary, employeeId: Long, note: String?): AssetDetail {
        requireAssetInScope(asset)
        require(employeeId > 0 && employeeId != asset.custodianId) { "اختر موظفاً مستلماً مختلفاً" }
        val body = JSONObject().put("assetId", asset.id).put("employeeId", employeeId)
        note?.trim()?.takeIf(String::isNotEmpty)?.let { body.put("note", it.take(500)) }
        return OperationsMappers.assetDetail(api.mutate("assets.handover", body))
            .also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun releaseAssetCustody(asset: AssetSummary): AssetDetail {
        requireAssetInScope(asset)
        require(asset.custodianId != null) { "الأصل غير مسند بعهدة" }
        return OperationsMappers.assetDetail(
            api.mutate("assets.returnCustody", JSONObject().put("assetId", asset.id)),
        )
            .also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun disposeAsset(asset: AssetSummary, input: AssetDisposalInput): AssetDetail {
        requireAssetInScope(asset)
        require(input.assetId == asset.id) { "طلب الاستبعاد لا يطابق الأصل المحدد" }
        OperationsValidation.disposal(input)?.let { error(it) }
        val body = JSONObject()
            .put("assetId", asset.id)
            .put("kind", input.status.wire)
            .put("date", input.date)
        input.reason?.trim()?.takeIf(String::isNotEmpty)?.let { body.put("reason", it.take(500)) }
        input.value?.let { body.put("value", it) }
        return OperationsMappers.assetDetail(api.mutate("assets.dispose", body))
            .also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun addAssetDocument(
        asset: AssetSummary,
        title: String,
        dataUrl: String,
    ): AssetDocument {
        requireAssetInScope(asset)
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty() && cleanTitle.length <= 255) { "عنوان المستند مطلوب" }
        require(dataUrl.length in 16..3_500_000 && dataUrl.startsWith("data:image/")) { "صورة المستند غير صالحة" }
        return OperationsMappers.assetDocument(
            api.mutate(
                "assets.addDocument",
                JSONObject().put("assetId", asset.id).put("title", cleanTitle).put("dataUrl", dataUrl),
            ),
        ).copy(dataUrl = dataUrl)
    }

    override suspend fun deleteAssetDocument(asset: AssetSummary, documentId: Long): Long {
        requireAssetInScope(asset)
        require(documentId > 0) { "المستند غير صالح" }
        val result = api.mutate("assets.deleteDocument", JSONObject().put("docId", documentId))
        return result.optLong("assetId", 0L).also { require(it == asset.id) { "استجابة حذف المستند لا تطابق الأصل" } }
    }

    override suspend fun postAssetDepreciation(year: Int, month: Int): AssetDepreciationResult {
        require(year in 2000..2200 && month in 1..12) { "فترة الإهلاك غير صالحة" }
        return OperationsMappers.depreciationResult(
            api.mutate("assets.postDepreciation", JSONObject().put("year", year).put("month", month)),
        )
    }

    override suspend fun startWarrantyMaintenance(
        asset: AssetSummary,
        type: String,
        vendor: String?,
        note: String?,
        date: String?,
    ): AssetDetail {
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
        return OperationsMappers.assetDetail(api.mutate("assets.addMaintenance", input))
            .also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun returnFromMaintenance(asset: AssetSummary): AssetDetail {
        requireAssetInScope(asset)
        require(asset.status == AssetStatus.Maintenance) { "الأصل ليس في الصيانة" }
        return OperationsMappers.assetDetail(
            api.mutate("assets.returnFromMaintenance", JSONObject().put("assetId", asset.id)),
        ).also { require(it.summary.id == asset.id); requireAssetInScope(it.summary) }
    }

    override suspend fun myCommission(period: String?): MyCommissionStatus? {
        val input = period?.takeIf(PERIOD::matches)?.let { JSONObject().put("period", it) }
        val root = api.queryNullableObject("commissions.performance.myStatus", input) ?: return null
        return OperationsMappers.myCommission(root)
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

    private fun AssetUpsertInput.assetJson(includeId: Boolean, includeCustodian: Boolean): JSONObject =
        JSONObject().apply {
            if (includeId) put("id", requireNotNull(id))
            put("name", name.trim())
            put("category", category.wire)
            brand?.trim()?.takeIf(String::isNotEmpty)?.let { put("brand", it.take(255)) }
            serial?.trim()?.takeIf(String::isNotEmpty)?.let { put("serial", it.take(255)) }
            branchId?.let { put("branchId", it) }
            location?.trim()?.takeIf(String::isNotEmpty)?.let { put("location", it.take(255)) }
            if (includeCustodian) custodianId?.let { put("custodianId", it) }
            supplierId?.let { put("supplierId", it) }
            put("purchaseDate", purchaseDate)
            put("purchaseValue", purchaseValue)
            put("salvageValue", salvageValue)
            put("usefulLifeYears", usefulLifeYears)
            put("depreciationMethod", depreciationMethod.wire)
            condition?.trim()?.takeIf(String::isNotEmpty)?.let { put("condition", it.take(255)) }
            warrantyEnd?.let { put("warrantyEnd", it) }
        }

    private companion object {
        val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
    }
}

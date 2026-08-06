package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.marketing.AnomalyCode
import online.alarabiya.superapp.model.marketing.AnomalySeverity
import online.alarabiya.superapp.model.marketing.CatalogAnomalyPage
import online.alarabiya.superapp.model.marketing.CouponPreview
import online.alarabiya.superapp.model.marketing.CouponPreviewRequest
import online.alarabiya.superapp.model.marketing.CouponProgram
import online.alarabiya.superapp.model.marketing.CouponProgramDraft
import online.alarabiya.superapp.model.marketing.CouponProgramStatus
import online.alarabiya.superapp.model.marketing.IssuedCouponPage
import online.alarabiya.superapp.model.marketing.MarketingMappers
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.marketing.MarketingValidation
import online.alarabiya.superapp.model.marketing.PromotionDetail
import online.alarabiya.superapp.model.marketing.PromotionDraft
import online.alarabiya.superapp.model.marketing.PromotionMode
import online.alarabiya.superapp.model.marketing.PromotionSummary
import online.alarabiya.superapp.model.marketing.PromotionType
import org.json.JSONArray
import org.json.JSONObject

data class CatalogAnomalyQuery(
    val includeOverridden: Boolean = false,
    val codes: Set<AnomalyCode> = emptySet(),
    val severities: Set<AnomalySeverity> = emptySet(),
    val offset: Int = 0,
    val limit: Int = 100,
)

interface MarketingDataSource {
    suspend fun promotions(includeInactive: Boolean): List<PromotionSummary>
    suspend fun promotion(id: Long): PromotionDetail
    suspend fun createPromotion(draft: PromotionDraft): Long
    suspend fun updatePromotion(id: Long, draft: PromotionDraft)
    suspend fun setPromotionActive(id: Long, active: Boolean)
    suspend fun couponPrograms(): List<CouponProgram>
    suspend fun createCouponProgram(draft: CouponProgramDraft): Long
    suspend fun setCouponProgramStatus(id: Long, status: CouponProgramStatus)
    suspend fun issuedCoupons(programId: Long, offset: Int = 0, limit: Int = 50): IssuedCouponPage
    suspend fun issueCoupons(programId: Long, count: Int, customerId: Long?): List<String>
    suspend fun voidCoupon(couponId: Long)
    suspend fun previewCoupon(request: CouponPreviewRequest): CouponPreview
    suspend fun catalogAnomalies(query: CatalogAnomalyQuery): CatalogAnomalyPage
    suspend fun markAnomalyIntentional(variantId: Long, code: AnomalyCode, justification: String, excludeUntil: String?)
    suspend fun markAnomalyIgnored(variantId: Long, code: AnomalyCode, justification: String)
    suspend fun clearAnomalyOverride(variantId: Long, code: AnomalyCode)
}

class MarketingRepository(
    private val api: TrpcClient,
    private val scope: MarketingScope,
) : MarketingDataSource {
    override suspend fun promotions(includeInactive: Boolean): List<PromotionSummary> =
        MarketingMappers.promotions(
            api.queryArray("salesPromotions.list", JSONObject().put("includeInactive", includeInactive)),
        ).filter { scope.acceptsVisibleBranch(it.branchId) }

    override suspend fun promotion(id: Long): PromotionDetail {
        require(id > 0) { "معرّف العرض غير صالح" }
        val detail = MarketingMappers.promotionDetail(
            api.query("salesPromotions.getById", JSONObject().put("promotionId", id)),
        )
        require(detail.promotion.id == id && scope.acceptsVisibleBranch(detail.promotion.branchId)) {
            "العرض خارج نطاق الفرع"
        }
        return detail
    }

    override suspend fun createPromotion(draft: PromotionDraft): Long {
        MarketingValidation.promotion(draft)?.let { throw IllegalArgumentException(it) }
        val branchId = scope.effectiveBranch(draft.branchId)
        require(scope.isAdmin || branchId != null) { "لا يوجد فرع مسند للحساب" }
        val input = promotionBody(draft, branchId, includeStructuralFields = true)
        val result = api.mutate("salesPromotions.create", input)
        return result.optLong("promotionId").also { require(it > 0) { "لم يرجع الخادم معرّف العرض" } }
    }

    override suspend fun updatePromotion(id: Long, draft: PromotionDraft) {
        require(id > 0) { "معرّف العرض غير صالح" }
        MarketingValidation.promotion(draft, editing = true)?.let { throw IllegalArgumentException(it) }
        api.mutate(
            "salesPromotions.update",
            promotionBody(draft, branchId = null, includeStructuralFields = false).put("promotionId", id),
        )
    }

    override suspend fun setPromotionActive(id: Long, active: Boolean) {
        require(id > 0) { "معرّف العرض غير صالح" }
        api.mutate(
            if (active) "salesPromotions.reactivate" else "salesPromotions.deactivate",
            JSONObject().put("promotionId", id),
        )
    }

    override suspend fun couponPrograms(): List<CouponProgram> =
        MarketingMappers.couponPrograms(api.queryArray("crm.coupons.programs"))
            .filter { scope.acceptsVisibleBranch(it.branchId) }

    override suspend fun createCouponProgram(draft: CouponProgramDraft): Long {
        MarketingValidation.couponProgram(draft)?.let { throw IllegalArgumentException(it) }
        val branchId = scope.effectiveBranch(draft.branchId)
        require(scope.isAdmin || branchId != null) { "لا يوجد فرع مسند للحساب" }
        val design = JSONObject()
        draft.title.trim().takeIf(String::isNotEmpty)?.let { design.put("title", it.take(80)) }
        draft.subtitle.trim().takeIf(String::isNotEmpty)?.let { design.put("subtitle", it.take(140)) }
        draft.terms.trim().takeIf(String::isNotEmpty)?.let { design.put("terms", it.take(500)) }
        design.put("color", draft.color)
        val input = JSONObject()
            .put("promotionId", draft.promotionId)
            .put("name", draft.name.trim())
            .putNullableLong("branchId", branchId)
            .put("validFrom", draft.validFrom)
            .putNullableText("validTo", draft.validTo)
            .put("perCouponLimit", draft.perCouponLimit)
            .put("perCustomerLimit", draft.perCustomerLimit)
            .put("codePrefix", draft.codePrefix.trim())
            .putNullableLong("campaignId", draft.campaignId)
            .put("design", design)
        val result = api.mutate("crm.coupons.createProgram", input)
        return result.optLong("programId").also { require(it > 0) { "لم يرجع الخادم معرّف البرنامج" } }
    }

    override suspend fun setCouponProgramStatus(id: Long, status: CouponProgramStatus) {
        require(id > 0 && status !in setOf(CouponProgramStatus.Unknown, CouponProgramStatus.Draft)) {
            "انتقال حالة البرنامج غير صالح"
        }
        api.mutate(
            "crm.coupons.setProgramStatus",
            JSONObject().put("programId", id).put("status", status.wire),
        )
    }

    override suspend fun issuedCoupons(programId: Long, offset: Int, limit: Int): IssuedCouponPage {
        require(programId > 0) { "معرّف البرنامج غير صالح" }
        val safeOffset = offset.coerceAtLeast(0)
        val safeLimit = limit.coerceIn(1, 500)
        return MarketingMappers.issuedCoupons(
            api.query(
                "crm.coupons.listIssued",
                JSONObject().put("programId", programId).put("offset", safeOffset).put("limit", safeLimit),
            ),
            safeOffset,
            safeLimit,
        )
    }

    override suspend fun issueCoupons(programId: Long, count: Int, customerId: Long?): List<String> {
        require(programId > 0 && count in 1..500) { "طلب إصدار الكوبونات غير صالح" }
        val result = api.mutate(
            "crm.coupons.issue",
            JSONObject().put("programId", programId).put("count", count).putNullableLong("customerId", customerId),
        )
        val codes = result.optJSONArray("codes") ?: JSONArray()
        return buildList {
            for (index in 0 until codes.length()) codes.optString(index).takeIf(String::isNotBlank)?.let(::add)
        }
    }

    override suspend fun voidCoupon(couponId: Long) {
        require(couponId > 0) { "معرّف الكوبون غير صالح" }
        api.mutate("crm.coupons.void", JSONObject().put("couponId", couponId))
    }

    override suspend fun previewCoupon(request: CouponPreviewRequest): CouponPreview {
        MarketingValidation.couponPreview(request)?.let { throw IllegalArgumentException(it) }
        val branchId = scope.effectiveBranch(request.branchId)
        require(branchId != null && branchId > 0) { "فرع المعاينة غير صالح" }
        val input = JSONObject()
            .put("code", request.code.trim())
            .put("branchId", branchId)
            .putNullableLong("customerId", request.customerId)
            .put("customerTier", request.customerTier.wire)
            .put("lines", JSONArray().apply {
                request.lines.forEach { line ->
                    put(
                        JSONObject()
                            .put("productId", line.productId)
                            .put("variantId", line.variantId)
                            .put("productUnitId", line.productUnitId)
                            .put("unitPrice", line.unitPrice)
                            .put("quantity", line.quantity)
                            .put("hasContractPrice", line.hasContractPrice),
                    )
                }
            })
        // This mutation only validates/locks during its transaction; redemption happens in sales.create.
        return MarketingMappers.couponPreview(api.mutate("crm.coupons.preview", input))
    }

    override suspend fun catalogAnomalies(query: CatalogAnomalyQuery): CatalogAnomalyPage {
        val offset = query.offset.coerceAtLeast(0)
        val limit = query.limit.coerceIn(1, 500)
        val input = JSONObject()
            .put("includeOverridden", query.includeOverridden)
            .put("limitPerLens", 200)
            .put("offset", offset)
            .put("limit", limit)
        if (query.codes.isNotEmpty()) input.put("codes", JSONArray(query.codes.map { it.wire }))
        if (query.severities.isNotEmpty()) input.put("severities", JSONArray(query.severities.map { it.wire }))
        return MarketingMappers.anomalyPage(api.query("catalogAnomalies.list", input), offset, limit)
    }

    override suspend fun markAnomalyIntentional(
        variantId: Long,
        code: AnomalyCode,
        justification: String,
        excludeUntil: String?,
    ) {
        requireAnomalyAction(variantId, code, justification)
        require(MarketingValidation.optionalDate(excludeUntil)) { "تاريخ نهاية الاستثناء غير صالح" }
        api.mutate(
            "catalogAnomalies.markIntentional",
            JSONObject()
                .put("variantId", variantId)
                .put("code", code.wire)
                .put("justification", justification.trim())
                .putNullableText("excludeUntil", excludeUntil),
        )
    }

    override suspend fun markAnomalyIgnored(variantId: Long, code: AnomalyCode, justification: String) {
        requireAnomalyAction(variantId, code, justification)
        api.mutate(
            "catalogAnomalies.markIgnored",
            JSONObject().put("variantId", variantId).put("code", code.wire).put("justification", justification.trim()),
        )
    }

    override suspend fun clearAnomalyOverride(variantId: Long, code: AnomalyCode) {
        require(variantId > 0 && code != AnomalyCode.Unknown) { "نتيجة التدقيق غير صالحة" }
        api.mutate("catalogAnomalies.clearOverride", JSONObject().put("variantId", variantId).put("code", code.wire))
    }

    private fun promotionBody(draft: PromotionDraft, branchId: Long?, includeStructuralFields: Boolean): JSONObject {
        val input = JSONObject()
            .put("name", draft.name.trim())
            .putNullableText("description", draft.description)
            .put("effectiveFrom", draft.effectiveFrom)
            .putNullableText("effectiveTo", draft.effectiveTo)
            .putNullableText("customerTier", draft.customerTier?.wire)
            .put("minLineAmount", draft.minLineAmount)
            .put("priority", draft.priority.coerceIn(0, 999))
            .put("applicationMode", draft.mode.wire)
            .put("channel", draft.channel.wire)
        if (draft.type == PromotionType.Percent) input.put("discountPercent", draft.discountValue)
        if (draft.type == PromotionType.Amount) input.put("discountAmount", draft.discountValue)
        if (includeStructuralFields) {
            input.put("type", draft.type.wire)
                .put("scope", draft.scope.wire)
                .putNullableLong("branchId", branchId)
                .putNullableLong("campaignId", draft.campaignId)
            if (draft.scope != online.alarabiya.superapp.model.marketing.PromotionScope.All) {
                input.put("targets", JSONArray().apply {
                    draft.targets.forEach { target ->
                        put(
                            JSONObject()
                                .putNullableLong("categoryId", target.categoryId)
                                .putNullableLong("productId", target.productId)
                                .putNullableLong("variantId", target.variantId),
                        )
                    }
                })
            }
        }
        return input
    }

    private fun requireAnomalyAction(variantId: Long, code: AnomalyCode, justification: String) {
        require(variantId > 0 && code != AnomalyCode.Unknown) { "نتيجة التدقيق غير صالحة" }
        require(justification.trim().length in 10..500) { "التبرير يجب أن يكون بين 10 و500 حرف" }
    }
}

private fun JSONObject.putNullableLong(key: String, value: Long?): JSONObject = put(key, value ?: JSONObject.NULL)

private fun JSONObject.putNullableText(key: String, value: String?): JSONObject =
    put(key, value?.trim()?.takeIf(String::isNotEmpty) ?: JSONObject.NULL)

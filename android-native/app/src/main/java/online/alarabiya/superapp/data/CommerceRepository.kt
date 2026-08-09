package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.commerce.CommerceMappers
import online.alarabiya.superapp.model.commerce.CommerceBranch
import online.alarabiya.superapp.model.commerce.ConfirmedDigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardCategory
import online.alarabiya.superapp.model.commerce.DigitalSubscription
import online.alarabiya.superapp.model.commerce.DigitalCardApproval
import online.alarabiya.superapp.model.commerce.DigitalCardApprovalDecision
import online.alarabiya.superapp.model.commerce.DigitalCardApprovalKind
import online.alarabiya.superapp.model.commerce.GiftDetail
import online.alarabiya.superapp.model.commerce.GiftDirection
import online.alarabiya.superapp.model.commerce.GiftPage
import online.alarabiya.superapp.model.commerce.GiftStatus
import online.alarabiya.superapp.model.commerce.ReservationConversion
import online.alarabiya.superapp.model.commerce.ReservationDetail
import online.alarabiya.superapp.model.commerce.ReservationPage
import online.alarabiya.superapp.model.commerce.ReservationStatus
import org.json.JSONObject

interface CommerceDataSource {
    suspend fun branches(): List<CommerceBranch>
    suspend fun gifts(query: String, direction: GiftDirection?, status: GiftStatus?, branchId: Long?): GiftPage
    suspend fun gift(id: Long): GiftDetail
    suspend fun approveGift(id: Long)
    suspend fun reservations(query: String, status: ReservationStatus?, branchId: Long?): ReservationPage
    suspend fun reservation(id: Long): ReservationDetail
    suspend fun cancelReservation(id: Long, reason: String?)
    suspend fun extendReservation(id: Long, hours: Int)
    suspend fun convertReservationWithoutCollection(id: Long): ReservationConversion
    suspend fun digitalCards(branchId: Long, category: DigitalCardCategory, query: String): List<DigitalCard>
    suspend fun confirmDigitalCard(branchId: Long, offeringId: Long): ConfirmedDigitalCard
    suspend fun subscriptions(branchId: Long?, query: String, status: String?): List<DigitalSubscription>
    suspend fun digitalCardApprovals(branchId: Long?): List<DigitalCardApproval>
    suspend fun approveDigitalCard(item: DigitalCardApproval, decision: DigitalCardApprovalDecision)
    suspend fun rejectDigitalCard(item: DigitalCardApproval, reason: String?)
}

class CommerceRepository(private val api: TrpcClient) : CommerceDataSource {
    override suspend fun branches(): List<CommerceBranch> = CommerceMappers.branches(api.queryArray("branches.list"))

    override suspend fun gifts(
        query: String,
        direction: GiftDirection?,
        status: GiftStatus?,
        branchId: Long?,
    ): GiftPage {
        val input = JSONObject().put("limit", 80).put("offset", 0)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(120)) }
        direction?.let { input.put("direction", it.name) }
        status?.takeIf { it != GiftStatus.UNKNOWN }?.let { input.put("status", it.name) }
        branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        return CommerceMappers.giftPage(api.query("gifts.list", input))
    }

    override suspend fun gift(id: Long): GiftDetail {
        require(id > 0) { "معرّف سند الهدية غير صالح" }
        return CommerceMappers.giftDetail(api.query("gifts.get", JSONObject().put("giftId", id)))
    }

    override suspend fun approveGift(id: Long) {
        require(id > 0) { "معرّف سند الهدية غير صالح" }
        api.mutate("gifts.approveGift", JSONObject().put("giftId", id))
    }

    override suspend fun reservations(
        query: String,
        status: ReservationStatus?,
        branchId: Long?,
    ): ReservationPage {
        val input = JSONObject().put("limit", 80).put("offset", 0).put("sort", "EXPIRY")
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        status?.takeIf { it != ReservationStatus.UNKNOWN }?.let { input.put("status", it.name) }
        branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        return CommerceMappers.reservationPage(api.query("reservations.list", input))
    }

    override suspend fun reservation(id: Long): ReservationDetail {
        require(id > 0) { "معرّف الحجز غير صالح" }
        return CommerceMappers.reservationDetail(api.query("reservations.get", JSONObject().put("id", id)))
    }

    override suspend fun cancelReservation(id: Long, reason: String?) {
        require(id > 0) { "معرّف الحجز غير صالح" }
        val cleanReason = reason?.trim()?.takeIf(String::isNotEmpty)
        require(cleanReason == null || cleanReason.length <= 300) { "سبب الإلغاء يتجاوز 300 حرف" }
        api.mutate(
            "reservations.cancel",
            JSONObject().put("id", id).put("reason", cleanReason ?: JSONObject.NULL),
        )
    }

    override suspend fun extendReservation(id: Long, hours: Int) {
        require(id > 0) { "معرّف الحجز غير صالح" }
        require(hours in 1..72) { "مدة التمديد بين ساعة و72 ساعة" }
        api.mutate("reservations.extend", JSONObject().put("id", id).put("hours", hours))
    }

    /** Server uses RES-{reservationId} as createSale clientRequestId inside one transaction. */
    override suspend fun convertReservationWithoutCollection(id: Long): ReservationConversion {
        require(id > 0) { "معرّف الحجز غير صالح" }
        return CommerceMappers.conversion(
            api.mutate("reservations.convert", JSONObject().put("reservationId", id)),
        )
    }

    override suspend fun digitalCards(
        branchId: Long,
        category: DigitalCardCategory,
        query: String,
    ): List<DigitalCard> {
        require(branchId > 0) { "حدّد الفرع لعرض البطاقات" }
        val input = JSONObject().put("branchId", branchId).put("category", category.name)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(120)) }
        return CommerceMappers.digitalCards(api.queryArray("digitalCards.pos.listCards", input))
    }

    override suspend fun confirmDigitalCard(branchId: Long, offeringId: Long): ConfirmedDigitalCard {
        require(branchId > 0) { "حدّد الفرع لتأكيد السعر" }
        require(offeringId > 0) { "معرّف البطاقة غير صالح" }
        return CommerceMappers.confirmedCard(
            api.query(
                "digitalCards.pos.confirmCard",
                JSONObject().put("branchId", branchId).put("offeringId", offeringId),
            ),
        )
    }

    override suspend fun subscriptions(
        branchId: Long?,
        query: String,
        status: String?,
    ): List<DigitalSubscription> {
        val input = JSONObject()
        branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(120)) }
        status?.takeIf { it in setOf("ACTIVE", "EXPIRED", "CANCELLED") }?.let { input.put("status", it) }
        return CommerceMappers.subscriptions(api.queryArray("digitalCards.subscriptions.list", input))
    }

    override suspend fun digitalCardApprovals(branchId: Long?): List<DigitalCardApproval> {
        val branchInput = JSONObject().also { input -> branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) } }
        val reviews = api.queryArray("digitalCards.sales.needsReview", branchInput).let { values ->
            buildList {
                repeat(values.length()) { index ->
                    val item = values.optJSONObject(index) ?: return@repeat
                    when {
                        item.optString("status") == "WRITEOFF_PENDING" -> add(
                            DigitalCardApproval(
                                id = item.getLong("id"),
                                kind = DigitalCardApprovalKind.WRITEOFF,
                                branchId = item.optLongOrNull("branchId"),
                                branchName = item.optStringOrNull("branchName"),
                                title = "شطب عملية بطاقة رقمية",
                                description = item.optStringOrNull("writeoffReason"),
                                amount = item.optStringOrNull("expectedTotal"),
                                requesterId = item.optLongOrNull("writeoffRequestedBy"),
                                requesterName = item.optStringOrNull("createdByName"),
                                createdAt = item.optStringOrNull("createdAt"),
                            ),
                        )
                        item.optString("resolutionStatus") == "PENDING" -> add(
                            DigitalCardApproval(
                                id = item.getLong("id"),
                                kind = DigitalCardApprovalKind.REVIEW_RESOLUTION,
                                branchId = item.optLongOrNull("branchId"),
                                branchName = item.optStringOrNull("branchName"),
                                title = "معالجة عملية تحتاج مراجعة",
                                description = item.optStringOrNull("resolutionReason"),
                                amount = item.optStringOrNull("expectedTotal"),
                                requesterId = item.optLongOrNull("resolutionRequestedBy"),
                                requesterName = item.optStringOrNull("createdByName"),
                                createdAt = item.optStringOrNull("createdAt"),
                            ),
                        )
                    }
                }
            }
        }
        val mismatches = api.queryArray(
            "digitalCards.pricing.mismatchReports",
            JSONObject().put("status", "OPEN").also { input ->
                branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) }
            },
        ).let { values ->
            buildList {
                repeat(values.length()) { index ->
                    val item = values.optJSONObject(index) ?: return@repeat
                    add(
                        DigitalCardApproval(
                            id = item.getLong("id"),
                            kind = DigitalCardApprovalKind.PRICE_MISMATCH,
                            branchId = item.optLongOrNull("branchId"),
                            branchName = item.optStringOrNull("branchName"),
                            title = item.optString("offeringName", "اختلاف سعر بطاقة"),
                            description = item.optStringOrNull("notes"),
                            amount = item.optStringOrNull("reportedProviderShare"),
                            requesterId = item.optLongOrNull("reportedBy"),
                            requesterName = null,
                            createdAt = item.optStringOrNull("createdAt"),
                            currentSellPrice = item.optStringOrNull("currentSellPrice"),
                        ),
                    )
                }
            }
        }
        val variances = api.queryArray(
            "digitalCards.wallets.reconciliations",
            JSONObject().put("status", "VARIANCE_OPEN"),
        ).let { values ->
            buildList {
                repeat(values.length()) { index ->
                    val item = values.optJSONObject(index) ?: return@repeat
                    add(
                        DigitalCardApproval(
                            id = item.getLong("id"),
                            kind = DigitalCardApprovalKind.WALLET_VARIANCE,
                            branchId = null,
                            branchName = item.optStringOrNull("branchName"),
                            title = item.optString("walletName", "فرق رصيد محفظة"),
                            description = item.optStringOrNull("notes"),
                            amount = item.optStringOrNull("variance"),
                            requesterId = item.optLongOrNull("countedBy"),
                            requesterName = item.optStringOrNull("countedByName"),
                            createdAt = item.optStringOrNull("createdAt"),
                        ),
                    )
                }
            }
        }
        return (reviews + mismatches + variances).sortedByDescending { it.createdAt.orEmpty() }
    }

    override suspend fun approveDigitalCard(item: DigitalCardApproval, decision: DigitalCardApprovalDecision) {
        require(item.id > 0) { "معرّف طلب الاعتماد غير صالح" }
        when (item.kind) {
            DigitalCardApprovalKind.REVIEW_RESOLUTION ->
                api.mutate(DigitalCardApprovalContract.approveProcedure(item.kind), JSONObject().put("intentId", item.id))
            DigitalCardApprovalKind.WRITEOFF ->
                api.mutate(DigitalCardApprovalContract.approveProcedure(item.kind), JSONObject().put("intentId", item.id))
            DigitalCardApprovalKind.PRICE_MISMATCH -> {
                val date = requireNotNull(decision.businessDate?.takeIf { it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) }) {
                    "تاريخ العمل مطلوب"
                }
                val sellPrice = requireNotNull(decision.sellPrice?.trim()?.takeIf { it.matches(Regex("^\\d+(?:\\.\\d{1,2})?$")) }) {
                    "سعر البيع غير صالح"
                }
                api.mutate(
                    DigitalCardApprovalContract.approveProcedure(item.kind),
                    JSONObject().put("reportId", item.id).put("businessDate", date).put("sellPrice", sellPrice)
                        .put("notes", decision.reason?.trim()?.take(500) ?: JSONObject.NULL),
                )
            }
            DigitalCardApprovalKind.WALLET_VARIANCE ->
                error("اعتماد فرق المحفظة يتطلب حركة التسوية المرتبطة من الخادم")
        }
    }

    override suspend fun rejectDigitalCard(item: DigitalCardApproval, reason: String?) {
        require(item.id > 0) { "معرّف طلب الاعتماد غير صالح" }
        val cleanReason = reason?.trim()?.takeIf(String::isNotEmpty)?.take(500)
        when (item.kind) {
            DigitalCardApprovalKind.REVIEW_RESOLUTION -> {
                require(!cleanReason.isNullOrBlank() && cleanReason.length >= 3) { "سبب الرفض مطلوب" }
                api.mutate(DigitalCardApprovalContract.rejectProcedure(item.kind), JSONObject().put("intentId", item.id).put("reason", cleanReason))
            }
            DigitalCardApprovalKind.WRITEOFF ->
                api.mutate(DigitalCardApprovalContract.rejectProcedure(item.kind), JSONObject().put("intentId", item.id).put("reason", cleanReason ?: JSONObject.NULL))
            DigitalCardApprovalKind.PRICE_MISMATCH ->
                api.mutate(DigitalCardApprovalContract.rejectProcedure(item.kind), JSONObject().put("reportId", item.id).put("notes", cleanReason ?: JSONObject.NULL))
            DigitalCardApprovalKind.WALLET_VARIANCE ->
                error("رفض فرق المحفظة يتطلب حركة التسوية المرتبطة من الخادم")
        }
    }
}

private fun JSONObject.optLongOrNull(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).trim().takeIf(String::isNotEmpty)

internal object DigitalCardApprovalContract {
    fun approveProcedure(kind: DigitalCardApprovalKind): String = when (kind) {
        DigitalCardApprovalKind.REVIEW_RESOLUTION -> "digitalCards.sales.approveReviewResolution"
        DigitalCardApprovalKind.WRITEOFF -> "digitalCards.sales.approveWriteoff"
        DigitalCardApprovalKind.PRICE_MISMATCH -> "digitalCards.pricing.approveMismatch"
        DigitalCardApprovalKind.WALLET_VARIANCE -> error("Variance approval needs a linked adjustment transaction")
    }

    fun rejectProcedure(kind: DigitalCardApprovalKind): String = when (kind) {
        DigitalCardApprovalKind.REVIEW_RESOLUTION -> "digitalCards.sales.rejectReviewResolution"
        DigitalCardApprovalKind.WRITEOFF -> "digitalCards.sales.rejectWriteoff"
        DigitalCardApprovalKind.PRICE_MISMATCH -> "digitalCards.pricing.rejectMismatch"
        DigitalCardApprovalKind.WALLET_VARIANCE -> error("Variance rejection has no server contract")
    }
}

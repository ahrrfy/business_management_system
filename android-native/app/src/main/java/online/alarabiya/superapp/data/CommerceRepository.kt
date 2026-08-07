package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.commerce.CommerceMappers
import online.alarabiya.superapp.model.commerce.CommerceBranch
import online.alarabiya.superapp.model.commerce.ConfirmedDigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardCategory
import online.alarabiya.superapp.model.commerce.DigitalSubscription
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
}

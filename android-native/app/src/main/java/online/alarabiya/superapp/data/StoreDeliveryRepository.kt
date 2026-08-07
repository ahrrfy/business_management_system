package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.store.CourierWorkspace
import online.alarabiya.superapp.model.store.DeliveryPartyOption
import online.alarabiya.superapp.model.store.StoreMappers
import online.alarabiya.superapp.model.store.StoreOrderDetail
import online.alarabiya.superapp.model.store.StoreOrderFilter
import online.alarabiya.superapp.model.store.StoreOrderStatus
import online.alarabiya.superapp.model.store.StoreOrderSummary
import org.json.JSONObject

data class StoreOrderPage(
    val rows: List<StoreOrderSummary>,
    val hasMore: Boolean,
    val nextCursor: Long?,
)

interface StoreDeliveryDataSource {
    suspend fun listOrders(filter: StoreOrderFilter, cursor: Long? = null, limit: Int = 100): StoreOrderPage
    suspend fun orderCounts(): Map<StoreOrderStatus, Int>
    suspend fun orderDetail(id: Long): StoreOrderDetail
    suspend fun deliveryParties(): List<DeliveryPartyOption>
    suspend fun setOrderStatus(id: Long, status: StoreOrderStatus, cancelReason: String? = null)
    suspend fun dispatchOrder(id: Long, partyId: Long)
    suspend fun courierWorkspace(): CourierWorkspace
    suspend fun confirmCourierDelivery(orderId: Long)
    suspend fun failCourierDelivery(orderId: Long, reason: String)
}

class StoreDeliveryRepository(
    private val api: TrpcClient,
) : StoreDeliveryDataSource {
    override suspend fun listOrders(
        filter: StoreOrderFilter,
        cursor: Long?,
        limit: Int,
    ): StoreOrderPage {
        val pageSize = limit.coerceIn(1, 300)
        val input = JSONObject().put("limit", pageSize)
        filter.status?.let { input.put("status", it.wire) }
        filter.from?.takeIf(DATE::matches)?.let { input.put("from", it) }
        filter.to?.takeIf(DATE::matches)?.let { input.put("to", it) }
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        val rows = StoreMappers.orders(api.queryArray("storeAdmin.orders.list", input))
        return StoreOrderPage(
            rows = rows,
            hasMore = rows.size == pageSize,
            nextCursor = rows.lastOrNull()?.id,
        )
    }

    override suspend fun orderCounts(): Map<StoreOrderStatus, Int> =
        StoreMappers.counts(api.query("storeAdmin.orders.counts"))

    override suspend fun orderDetail(id: Long): StoreOrderDetail {
        require(id > 0) { "معرّف الطلب غير صالح" }
        return StoreMappers.orderDetail(
            api.query("storeAdmin.orders.detail", JSONObject().put("id", id)),
        )
    }

    override suspend fun deliveryParties(): List<DeliveryPartyOption> =
        StoreMappers.parties(api.queryArray("storeAdmin.orders.parties"))

    override suspend fun setOrderStatus(id: Long, status: StoreOrderStatus, cancelReason: String?) {
        require(id > 0) { "معرّف الطلب غير صالح" }
        require(status != StoreOrderStatus.Unknown) { "حالة الطلب غير صالحة" }
        val input = JSONObject().put("id", id).put("status", status.wire)
        cancelReason?.trim()?.takeIf(String::isNotEmpty)?.let { input.put("cancelReason", it.take(500)) }
        api.mutate("storeAdmin.orders.setStatus", input)
    }

    override suspend fun dispatchOrder(id: Long, partyId: Long) {
        require(id > 0 && partyId > 0) { "بيانات الإسناد غير صالحة" }
        api.mutate(
            "storeAdmin.orders.dispatch",
            JSONObject().put("id", id).put("partyId", partyId),
        )
    }

    override suspend fun courierWorkspace(): CourierWorkspace =
        StoreMappers.courierWorkspace(api.query("courier.myDeliveries"))

    override suspend fun confirmCourierDelivery(orderId: Long) {
        require(orderId > 0) { "معرّف الطلب غير صالح" }
        api.mutate("courier.confirmDelivery", JSONObject().put("onlineOrderId", orderId))
    }

    override suspend fun failCourierDelivery(orderId: Long, reason: String) {
        require(orderId > 0) { "معرّف الطلب غير صالح" }
        val cleanReason = reason.trim()
        require(cleanReason.length in 2..500) { "اذكر سبب تعذّر التسليم" }
        api.mutate(
            "courier.failDelivery",
            JSONObject().put("onlineOrderId", orderId).put("reason", cleanReason),
        )
    }

    private companion object {
        val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    }
}

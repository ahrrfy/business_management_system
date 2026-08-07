package online.alarabiya.superapp.feature.store

import online.alarabiya.superapp.model.store.CourierDelivery
import online.alarabiya.superapp.model.store.CourierWorkspace
import online.alarabiya.superapp.model.store.DeliveryPartyOption
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderDetail
import online.alarabiya.superapp.model.store.StoreOrderFilter
import online.alarabiya.superapp.model.store.StoreOrderStatus
import online.alarabiya.superapp.model.store.StoreOrderSummary

enum class StoreDeliveryMode {
    Orders,
    Courier,
}

sealed interface StoreDetailState {
    data object None : StoreDetailState
    data object Loading : StoreDetailState
    data class Content(val order: StoreOrderDetail) : StoreDetailState
    data class Error(val message: String) : StoreDetailState
}

data class PendingStoreAction(
    val action: StoreOrderAction,
    val orderId: Long,
    val partyId: Long? = null,
) {
    val requiresReason: Boolean
        get() = action == StoreOrderAction.Cancel || action == StoreOrderAction.CourierFailed
}

data class StoreDeliveryUiState(
    val mode: StoreDeliveryMode,
    val capabilities: StoreCapabilities,
    val loading: Boolean = true,
    val loadingMore: Boolean = false,
    val orders: List<StoreOrderSummary> = emptyList(),
    val counts: Map<StoreOrderStatus, Int> = emptyMap(),
    val filter: StoreOrderFilter = StoreOrderFilter(),
    val hasMore: Boolean = false,
    val nextCursor: Long? = null,
    val selectedOrderId: Long? = null,
    val detail: StoreDetailState = StoreDetailState.None,
    val parties: List<DeliveryPartyOption> = emptyList(),
    val courier: CourierWorkspace? = null,
    val courierShowDelivered: Boolean = false,
    val pendingAction: PendingStoreAction? = null,
    val busyAction: StoreOrderAction? = null,
    val error: String? = null,
    val notice: String? = null,
)

object StoreDeliveryStateFilter {
    fun orders(state: StoreDeliveryUiState): List<StoreOrderSummary> {
        val query = state.filter.query.trim()
        if (query.isEmpty()) return state.orders
        return state.orders.filter { order ->
            listOfNotNull(
                order.orderNumber,
                order.customerName,
                order.customerPhone,
                order.governorate,
            ).any { it.contains(query, ignoreCase = true) }
        }
    }

    fun courierDeliveries(state: StoreDeliveryUiState): List<CourierDelivery> {
        val workspace = state.courier ?: return emptyList()
        val source = if (state.courierShowDelivered) workspace.delivered else workspace.toDeliver
        val query = state.filter.query.trim()
        if (query.isEmpty()) return source
        return source.filter { delivery ->
            listOfNotNull(
                delivery.orderNumber,
                delivery.customerName,
                delivery.customerPhone,
                delivery.governorate,
                delivery.address,
            ).any { it.contains(query, ignoreCase = true) }
        }
    }
}

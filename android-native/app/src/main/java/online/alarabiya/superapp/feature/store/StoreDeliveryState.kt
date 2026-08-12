package online.alarabiya.superapp.feature.store

import java.math.BigDecimal
import online.alarabiya.superapp.model.store.CourierDelivery
import online.alarabiya.superapp.model.store.CourierWorkspace
import online.alarabiya.superapp.model.store.CourierAccount
import online.alarabiya.superapp.model.store.DeliveryPartyAccount
import online.alarabiya.superapp.model.store.DeliveryPartyOption
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderDetail
import online.alarabiya.superapp.model.store.StoreOrderFilter
import online.alarabiya.superapp.model.store.StoreOrderPolicy
import online.alarabiya.superapp.model.store.StoreOrderStatus
import online.alarabiya.superapp.model.store.StoreOrderSummary

enum class StoreDeliveryMode {
    Orders,
    Courier,
    Parties,
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
    val managedParties: List<DeliveryPartyAccount> = emptyList(),
    val courierAccounts: List<CourierAccount> = emptyList(),
    val partyCatalogReady: Boolean = false,
    val partyQuery: String = "",
    val busyPartyAction: String? = null,
    val pendingAction: PendingStoreAction? = null,
    val busyAction: StoreOrderAction? = null,
    val error: String? = null,
    val notice: String? = null,
    val freshModes: Set<StoreDeliveryMode> = emptySet(),
)

internal const val STORE_REFRESH_REQUIRED = "تمت العملية وتعذر تحديث العرض. أعد المحاولة قبل تنفيذ عملية أخرى"

internal fun isStoreModeFresh(state: StoreDeliveryUiState, mode: StoreDeliveryMode = state.mode): Boolean =
    mode in state.freshModes && !state.loading

internal fun acceptsStoreResponse(
    state: StoreDeliveryUiState,
    requestedMode: StoreDeliveryMode,
    requestGeneration: Long,
    currentGeneration: Long,
): Boolean = requestGeneration == currentGeneration && state.mode == requestedMode

internal fun acceptsOrderResponse(
    state: StoreDeliveryUiState,
    requestGeneration: Long,
    currentGeneration: Long,
    requestedFilter: StoreOrderFilter,
): Boolean = acceptsStoreResponse(state, StoreDeliveryMode.Orders, requestGeneration, currentGeneration) &&
    state.filter.copy(query = "") == requestedFilter.copy(query = "")

internal fun acceptsOrderDetail(
    state: StoreDeliveryUiState,
    orderId: Long,
    status: StoreOrderStatus?,
    requestGeneration: Long,
    currentGeneration: Long,
    catalogGeneration: Long,
    currentCatalogGeneration: Long,
): Boolean = isCurrentOrderDetailRequest(
    state = state,
    orderId = orderId,
    requestGeneration = requestGeneration,
    currentGeneration = currentGeneration,
    catalogGeneration = catalogGeneration,
    currentCatalogGeneration = currentCatalogGeneration,
) && state.orders.any { it.id == orderId && (status == null || it.status == status) }

internal fun isCurrentOrderDetailRequest(
    state: StoreDeliveryUiState,
    orderId: Long,
    requestGeneration: Long,
    currentGeneration: Long,
    catalogGeneration: Long,
    currentCatalogGeneration: Long,
): Boolean =
    requestGeneration == currentGeneration &&
        catalogGeneration == currentCatalogGeneration &&
        state.mode == StoreDeliveryMode.Orders &&
        isStoreModeFresh(state, StoreDeliveryMode.Orders) &&
        state.selectedOrderId == orderId &&
        state.orders.any { it.id == orderId }

internal fun canMutateDeliveryParties(state: StoreDeliveryUiState): Boolean =
    state.mode == StoreDeliveryMode.Parties &&
        state.capabilities.canManageDeliveryParties &&
        state.partyCatalogReady &&
        isStoreModeFresh(state, StoreDeliveryMode.Parties) &&
        !state.loading &&
        state.busyAction == null &&
        state.busyPartyAction == null

internal fun canSelectStoreOrder(state: StoreDeliveryUiState, orderId: Long): Boolean =
    isStoreModeFresh(state) &&
        state.busyAction == null &&
        state.busyPartyAction == null &&
        when (state.mode) {
            StoreDeliveryMode.Orders -> state.orders.any { it.id == orderId }
            StoreDeliveryMode.Courier -> (state.courier?.toDeliver.orEmpty() + state.courier?.delivered.orEmpty()).any { it.id == orderId }
            StoreDeliveryMode.Parties -> false
        }

internal fun canExecuteStoreAction(state: StoreDeliveryUiState, pending: PendingStoreAction): Boolean {
    if (!isStoreModeFresh(state) || state.busyAction != null || state.busyPartyAction != null) return false
    val status = when (state.mode) {
        StoreDeliveryMode.Orders -> {
            val detail = state.detail as? StoreDetailState.Content ?: return false
            if (state.selectedOrderId != pending.orderId || detail.order.summary.id != pending.orderId) return false
            val summary = state.orders.firstOrNull { it.id == pending.orderId } ?: return false
            if (detail.order.summary.status != summary.status) return false
            summary.status
        }
        StoreDeliveryMode.Courier -> {
            if (state.selectedOrderId != pending.orderId) return false
            (state.courier?.toDeliver.orEmpty() + state.courier?.delivered.orEmpty())
                .firstOrNull { it.id == pending.orderId }
                ?.status ?: return false
        }
        StoreDeliveryMode.Parties -> return false
    }
    if (pending.action !in StoreOrderPolicy.allowedActions(status, state.capabilities)) return false
    return pending.action != StoreOrderAction.Dispatch || pending.partyId != null
}

internal fun canRequestStoreAction(state: StoreDeliveryUiState, pending: PendingStoreAction): Boolean =
    state.pendingAction == null && canExecuteStoreAction(state, pending)

internal fun StoreDeliveryUiState.commitStoreAction(
    pending: PendingStoreAction,
    reason: String?,
): StoreDeliveryUiState {
    val target = pending.action.committedStatus()
    return when (mode) {
        StoreDeliveryMode.Orders -> {
            val previous = orders.firstOrNull { it.id == pending.orderId } ?: return this
            val committed = previous.copy(
                status = target,
                deliveryPartyId = pending.partyId ?: previous.deliveryPartyId,
                cancelReason = reason?.trim()?.takeIf(String::isNotEmpty) ?: previous.cancelReason,
            )
            val nextOrders = if (filter.status != null && filter.status != target) {
                orders.filterNot { it.id == pending.orderId }
            } else {
                orders.map { if (it.id == pending.orderId) committed else it }
            }
            val nextCounts = counts.toMutableMap().apply {
                this[previous.status] = ((this[previous.status] ?: 0) - 1).coerceAtLeast(0)
                this[target] = (this[target] ?: 0) + 1
            }
            val nextDetail = (detail as? StoreDetailState.Content)?.let { content ->
                if (content.order.summary.id == pending.orderId) {
                    StoreDetailState.Content(content.order.copy(summary = committed))
                } else {
                    detail
                }
            } ?: detail
            copy(
                orders = nextOrders,
                counts = nextCounts,
                detail = nextDetail,
                freshModes = freshModes - StoreDeliveryMode.Orders,
            )
        }
        StoreDeliveryMode.Courier -> {
            val workspace = courier ?: return this
            val delivery = (workspace.toDeliver + workspace.delivered).firstOrNull { it.id == pending.orderId } ?: return this
            val committed = delivery.copy(status = target)
            copy(
                courier = workspace.copy(
                    toDeliver = workspace.toDeliver.filterNot { it.id == pending.orderId },
                    delivered = if (target == StoreOrderStatus.Delivered) {
                        (listOf(committed) + workspace.delivered.filterNot { it.id == pending.orderId })
                    } else {
                        workspace.delivered.filterNot { it.id == pending.orderId }
                    },
                ),
                freshModes = freshModes - StoreDeliveryMode.Courier,
            )
        }
        StoreDeliveryMode.Parties -> this
    }
}

internal fun StoreDeliveryUiState.commitPartyDraft(draft: online.alarabiya.superapp.model.store.DeliveryPartyDraft): StoreDeliveryUiState {
    val id = draft.id ?: return copy(freshModes = freshModes - StoreDeliveryMode.Parties)
    return copy(
        managedParties = managedParties.map { party ->
            if (party.id != id) party else party.copy(
                partyType = draft.partyType,
                name = draft.name.trim(),
                phone = draft.phone.trim().takeIf(String::isNotEmpty),
                userId = draft.userId,
                defaultFee = online.alarabiya.superapp.model.store.DeliveryMoney.normalized(draft.defaultFee) ?: party.defaultFee,
                floatLimit = draft.floatLimit.trim().takeIf(String::isNotEmpty)
                    ?.let(online.alarabiya.superapp.model.store.DeliveryMoney::normalized),
            )
        },
        freshModes = freshModes - StoreDeliveryMode.Parties,
    )
}

internal fun StoreDeliveryUiState.commitPartyActive(partyId: Long, active: Boolean): StoreDeliveryUiState = copy(
    managedParties = managedParties.map { if (it.id == partyId) it.copy(isActive = active) else it },
    freshModes = freshModes - StoreDeliveryMode.Parties,
)

internal fun StoreDeliveryUiState.commitPartyWriteOff(partyId: Long, amount: String): StoreDeliveryUiState = copy(
    managedParties = managedParties.map { party ->
        if (party.id != partyId) party else party.copy(
            currentBalance = runCatching {
                BigDecimal(party.currentBalance).subtract(BigDecimal(amount)).max(BigDecimal.ZERO).setScale(2).toPlainString()
            }.getOrDefault(party.currentBalance),
        )
    },
    freshModes = freshModes - StoreDeliveryMode.Parties,
)

private fun StoreOrderAction.committedStatus(): StoreOrderStatus = when (this) {
    StoreOrderAction.Confirm -> StoreOrderStatus.Confirmed
    StoreOrderAction.StartProcessing -> StoreOrderStatus.Processing
    StoreOrderAction.Cancel,
    StoreOrderAction.CourierFailed,
    -> StoreOrderStatus.Cancelled
    StoreOrderAction.Dispatch -> StoreOrderStatus.Shipped
    StoreOrderAction.MarkDelivered,
    StoreOrderAction.CourierDelivered,
    -> StoreOrderStatus.Delivered
}

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

    fun managedParties(state: StoreDeliveryUiState): List<DeliveryPartyAccount> {
        val query = state.partyQuery.trim()
        if (query.isEmpty()) return state.managedParties
        return state.managedParties.filter { party ->
            listOfNotNull(party.name, party.phone).any { it.contains(query, ignoreCase = true) }
        }
    }
}

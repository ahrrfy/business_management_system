package online.alarabiya.superapp.feature.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.StoreDeliveryDataSource
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderPolicy
import online.alarabiya.superapp.model.store.StoreOrderStatus

class StoreDeliveryViewModel(
    private val source: StoreDeliveryDataSource,
    capabilities: StoreCapabilities,
) : ViewModel() {
    var state by mutableStateOf(
        StoreDeliveryUiState(
            mode = if (capabilities.courierSelfService) StoreDeliveryMode.Courier else StoreDeliveryMode.Orders,
            capabilities = capabilities,
        ),
    )
        private set

    init {
        refresh()
    }

    fun refresh() {
        if (state.busyAction != null) return
        state = state.copy(loading = true, error = null, notice = null)
        viewModelScope.launch {
            if (state.mode == StoreDeliveryMode.Courier) loadCourier()
            else loadOrders(reset = true)
        }
    }

    fun setQuery(query: String) {
        state = state.copy(filter = state.filter.copy(query = query.take(120)))
    }

    fun setStatus(status: StoreOrderStatus?) {
        if (state.mode != StoreDeliveryMode.Orders || state.busyAction != null) return
        state = state.copy(filter = state.filter.copy(status = status), loading = true, error = null)
        viewModelScope.launch { loadOrders(reset = true) }
    }

    fun setDateRange(from: String?, to: String?) {
        if (state.mode != StoreDeliveryMode.Orders || state.busyAction != null) return
        state = state.copy(
            filter = state.filter.copy(
                from = from?.takeIf(DATE::matches),
                to = to?.takeIf(DATE::matches),
            ),
            loading = true,
            error = null,
        )
        viewModelScope.launch { loadOrders(reset = true) }
    }

    fun loadMore() {
        if (!state.hasMore || state.loadingMore || state.loading || state.busyAction != null) return
        state = state.copy(loadingMore = true)
        viewModelScope.launch { loadOrders(reset = false) }
    }

    fun selectOrder(id: Long?) {
        state = state.copy(selectedOrderId = id, detail = StoreDetailState.None)
        if (id == null || state.mode == StoreDeliveryMode.Courier) return
        state = state.copy(detail = StoreDetailState.Loading)
        viewModelScope.launch { loadDetail(id) }
    }

    fun showDeliveredCourierOrders(show: Boolean) {
        state = state.copy(courierShowDelivered = show, selectedOrderId = null)
    }

    fun requestAction(action: StoreOrderAction, orderId: Long, partyId: Long? = null) {
        if (state.busyAction != null || state.pendingAction != null) return
        val status = selectedStatus(orderId) ?: return
        if (action !in StoreOrderPolicy.allowedActions(status, state.capabilities)) return
        if (action == StoreOrderAction.Dispatch && partyId == null) return
        state = state.copy(pendingAction = PendingStoreAction(action, orderId, partyId), error = null)
    }

    fun dismissConfirmation() {
        if (state.busyAction == null) state = state.copy(pendingAction = null)
    }

    fun confirmPendingAction(reason: String? = null) {
        val pending = state.pendingAction ?: return
        if (state.busyAction != null) return
        if (pending.requiresReason && reason.orEmpty().trim().length < 2) {
            state = state.copy(error = "اذكر السبب")
            return
        }
        state = state.copy(pendingAction = null, busyAction = pending.action, error = null, notice = null)
        viewModelScope.launch {
            runCatching { execute(pending, reason) }
                .onSuccess {
                    state = state.copy(busyAction = null, notice = successMessage(pending.action))
                    if (state.mode == StoreDeliveryMode.Courier) {
                        state = state.copy(selectedOrderId = null)
                        loadCourier(preserveNotice = true)
                    } else {
                        val selectedId = state.selectedOrderId
                        loadOrders(reset = true, preserveNotice = true)
                        selectedId
                            ?.takeIf { it == state.selectedOrderId }
                            ?.let { loadDetail(it) }
                    }
                }
                .onFailure { error ->
                    state = state.copy(busyAction = null, error = userMessage(error))
                }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private suspend fun loadOrders(reset: Boolean, preserveNotice: Boolean = false) {
        val cursor = if (reset) null else state.nextCursor
        runCatching {
            coroutineScope {
                val page = async { source.listOrders(state.filter, cursor) }
                val counts = async { if (reset) source.orderCounts() else state.counts }
                val parties = async {
                    if (reset && state.capabilities.canDispatchOrders) source.deliveryParties() else state.parties
                }
                Triple(page.await(), counts.await(), parties.await())
            }
        }.onSuccess { (page, counts, parties) ->
            val rows = if (reset) page.rows else (state.orders + page.rows).distinctBy { it.id }
            val selectedStillExists = state.selectedOrderId?.let { selected -> rows.any { it.id == selected } } == true
            state = state.copy(
                loading = false,
                loadingMore = false,
                orders = rows,
                counts = counts,
                parties = parties,
                hasMore = page.hasMore,
                nextCursor = page.nextCursor,
                selectedOrderId = state.selectedOrderId.takeIf { selectedStillExists },
                detail = state.detail.takeIf { selectedStillExists } ?: StoreDetailState.None,
                error = null,
                notice = state.notice.takeIf { preserveNotice },
            )
        }.onFailure { error ->
            state = state.copy(
                loading = false,
                loadingMore = false,
                error = userMessage(error),
                notice = state.notice.takeIf { preserveNotice },
            )
        }
    }

    private suspend fun loadCourier(preserveNotice: Boolean = false) {
        runCatching { source.courierWorkspace() }
            .onSuccess { workspace ->
                val rows = workspace.toDeliver + workspace.delivered
                state = state.copy(
                    loading = false,
                    courier = workspace,
                    selectedOrderId = state.selectedOrderId?.takeIf { id -> rows.any { it.id == id } },
                    error = null,
                    notice = state.notice.takeIf { preserveNotice },
                )
            }
            .onFailure { error ->
                state = state.copy(
                    loading = false,
                    error = userMessage(error),
                    notice = state.notice.takeIf { preserveNotice },
                )
            }
    }

    private suspend fun loadDetail(id: Long) {
        runCatching { source.orderDetail(id) }
            .onSuccess { order ->
                if (state.selectedOrderId == id) {
                    state = state.copy(detail = StoreDetailState.Content(order))
                }
            }
            .onFailure { error ->
                if (state.selectedOrderId == id) {
                    state = state.copy(detail = StoreDetailState.Error(userMessage(error)))
                }
            }
    }

    private suspend fun execute(pending: PendingStoreAction, reason: String?) {
        when (pending.action) {
            StoreOrderAction.Confirm -> source.setOrderStatus(pending.orderId, StoreOrderStatus.Confirmed)
            StoreOrderAction.StartProcessing -> source.setOrderStatus(pending.orderId, StoreOrderStatus.Processing)
            StoreOrderAction.Cancel -> source.setOrderStatus(pending.orderId, StoreOrderStatus.Cancelled, reason)
            StoreOrderAction.Dispatch -> source.dispatchOrder(pending.orderId, requireNotNull(pending.partyId))
            StoreOrderAction.MarkDelivered -> source.setOrderStatus(pending.orderId, StoreOrderStatus.Delivered)
            StoreOrderAction.CourierDelivered -> source.confirmCourierDelivery(pending.orderId)
            StoreOrderAction.CourierFailed -> source.failCourierDelivery(pending.orderId, reason.orEmpty())
        }
    }

    private fun selectedStatus(orderId: Long): StoreOrderStatus? = when (state.mode) {
        StoreDeliveryMode.Orders -> state.orders.firstOrNull { it.id == orderId }?.status
        StoreDeliveryMode.Courier -> (state.courier?.toDeliver.orEmpty() + state.courier?.delivered.orEmpty())
            .firstOrNull { it.id == orderId }
            ?.status
    }

    private fun successMessage(action: StoreOrderAction): String = when (action) {
        StoreOrderAction.Confirm -> "تم تأكيد الطلب"
        StoreOrderAction.StartProcessing -> "بدأ تجهيز الطلب"
        StoreOrderAction.Cancel -> "تم إلغاء الطلب"
        StoreOrderAction.Dispatch -> "تم إسناد الطلب وإرساله"
        StoreOrderAction.MarkDelivered,
        StoreOrderAction.CourierDelivered,
        -> "تم تسجيل التسليم"
        StoreOrderAction.CourierFailed -> "تم تسجيل تعذّر التسليم"
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    private companion object {
        val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    }
}

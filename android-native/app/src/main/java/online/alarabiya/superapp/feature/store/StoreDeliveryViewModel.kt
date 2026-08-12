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
import online.alarabiya.superapp.model.store.DeliveryPartyDraft
import online.alarabiya.superapp.model.store.DeliveryWriteOffDraft
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderStatus

class StoreDeliveryViewModel(
    private val source: StoreDeliveryDataSource,
    capabilities: StoreCapabilities,
) : ViewModel() {
    private var loadGeneration: Long = 0
    private var detailGeneration: Long = 0

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
        if (state.busyAction != null || state.busyPartyAction != null || state.pendingAction != null) return
        val mode = state.mode
        val generation = ++loadGeneration
        detailGeneration++
        state = state.copy(
            loading = true,
            loadingMore = false,
            error = null,
            notice = null,
            selectedOrderId = null,
            detail = StoreDetailState.None,
            freshModes = state.freshModes - mode,
        )
        viewModelScope.launch { loadMode(mode, generation) }
    }

    fun setMode(mode: StoreDeliveryMode) {
        val allowed = when (mode) {
            StoreDeliveryMode.Courier -> state.capabilities.courierSelfService
            StoreDeliveryMode.Orders -> state.capabilities.canReadOrders
            StoreDeliveryMode.Parties -> state.capabilities.canManageDeliveryParties
        }
        if (!allowed || mode == state.mode || state.loading || state.pendingAction != null || state.busyAction != null || state.busyPartyAction != null) return
        val generation = ++loadGeneration
        detailGeneration++
        state = state.copy(
            mode = mode,
            selectedOrderId = null,
            detail = StoreDetailState.None,
            error = null,
            notice = null,
            loading = true,
            loadingMore = false,
            freshModes = state.freshModes - mode,
        )
        viewModelScope.launch { loadMode(mode, generation) }
    }

    fun setQuery(query: String) {
        state = state.copy(filter = state.filter.copy(query = query.take(120)))
    }

    fun setPartyQuery(query: String) {
        state = state.copy(partyQuery = query.take(120))
    }

    fun setStatus(status: StoreOrderStatus?) {
        if (state.mode != StoreDeliveryMode.Orders || state.busyAction != null || state.pendingAction != null) return
        val filter = state.filter.copy(status = status)
        startOrdersReload(filter)
    }

    fun setDateRange(from: String?, to: String?) {
        if (state.mode != StoreDeliveryMode.Orders || state.busyAction != null || state.pendingAction != null) return
        startOrdersReload(
            state.filter.copy(
                from = from?.takeIf(DATE::matches),
                to = to?.takeIf(DATE::matches),
            ),
        )
    }

    fun loadMore() {
        if (!isStoreModeFresh(state, StoreDeliveryMode.Orders) || !state.hasMore || state.loadingMore || state.loading || state.busyAction != null) return
        val generation = loadGeneration
        val filter = state.filter
        state = state.copy(loadingMore = true)
        viewModelScope.launch { loadOrders(reset = false, generation = generation, filter = filter) }
    }

    fun selectOrder(id: Long?) {
        val detailRequest = ++detailGeneration
        if (id == null) {
            state = state.copy(selectedOrderId = null, detail = StoreDetailState.None)
            return
        }
        if (!canSelectStoreOrder(state, id)) {
            state = state.copy(error = "حدّث العرض قبل فتح تفاصيل الطلب")
            return
        }
        state = state.copy(
            selectedOrderId = id,
            detail = if (state.mode == StoreDeliveryMode.Orders) StoreDetailState.Loading else StoreDetailState.None,
            error = null,
        )
        if (state.mode == StoreDeliveryMode.Orders) {
            val catalogGeneration = loadGeneration
            viewModelScope.launch { loadDetail(id, detailRequest, catalogGeneration) }
        }
    }

    fun showDeliveredCourierOrders(show: Boolean) {
        if (!isStoreModeFresh(state, StoreDeliveryMode.Courier)) return
        detailGeneration++
        state = state.copy(courierShowDelivered = show, selectedOrderId = null)
    }

    fun requestAction(action: StoreOrderAction, orderId: Long, partyId: Long? = null) {
        val pending = PendingStoreAction(action, orderId, partyId)
        if (!canRequestStoreAction(state, pending)) return
        state = state.copy(pendingAction = pending, error = null)
    }

    fun dismissConfirmation() {
        if (state.busyAction == null) state = state.copy(pendingAction = null)
    }

    fun confirmPendingAction(reason: String? = null) {
        val pending = state.pendingAction ?: return
        if (!canExecuteStoreAction(state, pending)) {
            state = state.copy(pendingAction = null, error = "حدّث الطلب قبل تنفيذ الإجراء")
            return
        }
        if (pending.requiresReason && reason.orEmpty().trim().length < 2) {
            state = state.copy(error = "اذكر السبب")
            return
        }
        state = state.copy(pendingAction = null, busyAction = pending.action, error = null, notice = null)
        viewModelScope.launch {
            runCatching { execute(pending, reason) }
                .onSuccess {
                    val success = successMessage(pending.action)
                    state = state.commitStoreAction(pending, reason).copy(
                        busyAction = null,
                        loading = true,
                        notice = success,
                        error = null,
                    )
                    val mode = state.mode
                    val generation = ++loadGeneration
                    detailGeneration++
                    loadMode(mode, generation, postMutation = true, successNotice = success)
                }
                .onFailure { error ->
                    state = state.copy(busyAction = null, error = userMessage(error))
                }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    fun saveParty(draft: DeliveryPartyDraft) {
        if (!canMutateDeliveryParties(state)) return
        draft.validate()?.let { state = state.copy(error = it); return }
        mutateParty(
            key = if (draft.id == null) "party:create" else "party:update",
            success = if (draft.id == null) "تمت إضافة جهة التوصيل" else "تم تحديث جهة التوصيل",
            localCommit = { it.commitPartyDraft(draft) },
        ) {
            if (draft.id == null) source.createParty(draft) else source.updateParty(draft)
        }
    }

    fun setPartyActive(partyId: Long, active: Boolean) {
        if (!canMutateDeliveryParties(state) || partyId <= 0) return
        mutateParty(
            key = "party:active:$partyId",
            success = if (active) "تم تفعيل جهة التوصيل" else "تم تعطيل جهة التوصيل",
            localCommit = { it.commitPartyActive(partyId, active) },
        ) {
            source.setPartyActive(partyId, active)
        }
    }

    fun writeOff(draft: DeliveryWriteOffDraft) {
        if (!canMutateDeliveryParties(state) || !state.capabilities.canWriteOffDeliveryDebt) return
        draft.validate()?.let { state = state.copy(error = it); return }
        mutateParty(
            key = "party:write-off:${draft.partyId}",
            success = "تم تسجيل شطب العجز",
            localCommit = { it.commitPartyWriteOff(draft.partyId, draft.amount) },
        ) {
            source.writeOff(draft)
        }
    }

    private fun startOrdersReload(filter: online.alarabiya.superapp.model.store.StoreOrderFilter) {
        val generation = ++loadGeneration
        detailGeneration++
        state = state.copy(
            filter = filter,
            loading = true,
            loadingMore = false,
            error = null,
            notice = null,
            selectedOrderId = null,
            detail = StoreDetailState.None,
            freshModes = state.freshModes - StoreDeliveryMode.Orders,
        )
        viewModelScope.launch { loadOrders(reset = true, generation = generation, filter = filter) }
    }

    private suspend fun loadMode(
        mode: StoreDeliveryMode,
        generation: Long,
        postMutation: Boolean = false,
        successNotice: String? = null,
    ) {
        when (mode) {
            StoreDeliveryMode.Orders -> loadOrders(
                reset = true,
                generation = generation,
                filter = state.filter,
                postMutation = postMutation,
                successNotice = successNotice,
            )
            StoreDeliveryMode.Courier -> loadCourier(generation, postMutation, successNotice)
            StoreDeliveryMode.Parties -> loadPartyManagement(generation, postMutation, successNotice)
        }
    }

    private suspend fun loadOrders(
        reset: Boolean,
        generation: Long,
        filter: online.alarabiya.superapp.model.store.StoreOrderFilter,
        postMutation: Boolean = false,
        successNotice: String? = null,
    ) {
        val cursor = if (reset) null else state.nextCursor
        val existingCounts = state.counts
        val existingParties = state.parties
        runCatching {
            coroutineScope {
                val page = async { source.listOrders(filter, cursor) }
                val counts = async { if (reset) source.orderCounts() else existingCounts }
                val parties = async {
                    if (reset && state.capabilities.canDispatchOrders) source.deliveryParties() else existingParties
                }
                Triple(page.await(), counts.await(), parties.await())
            }
        }.onSuccess { (page, counts, parties) ->
            if (!acceptsOrderResponse(state, generation, loadGeneration, filter)) return@onSuccess
            val rows = if (reset) page.rows else (state.orders + page.rows).distinctBy { it.id }
            val selectedStillExists = state.selectedOrderId?.let { selected -> rows.any { it.id == selected } } == true
            val selectedId = state.selectedOrderId.takeIf { selectedStillExists }
            state = state.copy(
                loading = false,
                loadingMore = false,
                orders = rows,
                counts = counts,
                parties = parties,
                hasMore = page.hasMore,
                nextCursor = page.nextCursor,
                selectedOrderId = selectedId,
                detail = when {
                    selectedId == null -> StoreDetailState.None
                    reset -> StoreDetailState.Loading
                    else -> state.detail
                },
                error = null,
                notice = successNotice.takeIf { postMutation },
                freshModes = state.freshModes + StoreDeliveryMode.Orders,
            )
            if (reset && selectedId != null) {
                val detailRequest = ++detailGeneration
                loadDetail(selectedId, detailRequest, generation)
            }
        }.onFailure { error ->
            if (!acceptsOrderResponse(state, generation, loadGeneration, filter)) return@onFailure
            state = state.copy(
                loading = false,
                loadingMore = false,
                error = userMessage(error),
                notice = if (postMutation) STORE_REFRESH_REQUIRED else null,
                freshModes = if (reset) state.freshModes - StoreDeliveryMode.Orders else state.freshModes,
            )
        }
    }

    private suspend fun loadCourier(generation: Long, postMutation: Boolean = false, successNotice: String? = null) {
        runCatching { source.courierWorkspace() }
            .onSuccess { workspace ->
                if (!acceptsStoreResponse(state, StoreDeliveryMode.Courier, generation, loadGeneration)) return@onSuccess
                val rows = workspace.toDeliver + workspace.delivered
                state = state.copy(
                    loading = false,
                    courier = workspace,
                    selectedOrderId = state.selectedOrderId?.takeIf { id -> rows.any { it.id == id } },
                    error = null,
                    notice = successNotice.takeIf { postMutation },
                    freshModes = state.freshModes + StoreDeliveryMode.Courier,
                )
            }
            .onFailure { error ->
                if (!acceptsStoreResponse(state, StoreDeliveryMode.Courier, generation, loadGeneration)) return@onFailure
                state = state.copy(
                    loading = false,
                    error = userMessage(error),
                    notice = if (postMutation) STORE_REFRESH_REQUIRED else null,
                    freshModes = state.freshModes - StoreDeliveryMode.Courier,
                )
            }
    }

    private suspend fun loadPartyManagement(generation: Long, postMutation: Boolean = false, successNotice: String? = null) {
        runCatching {
            coroutineScope {
                val parties = async { source.managedParties() }
                val accounts = async { source.courierAccounts() }
                parties.await() to accounts.await()
            }
        }.onSuccess { (parties, accounts) ->
            if (!acceptsStoreResponse(state, StoreDeliveryMode.Parties, generation, loadGeneration)) return@onSuccess
            state = state.copy(
                loading = false,
                managedParties = parties,
                courierAccounts = accounts,
                partyCatalogReady = true,
                error = null,
                notice = successNotice.takeIf { postMutation },
                freshModes = state.freshModes + StoreDeliveryMode.Parties,
            )
        }.onFailure { error ->
            if (!acceptsStoreResponse(state, StoreDeliveryMode.Parties, generation, loadGeneration)) return@onFailure
            state = state.copy(
                loading = false,
                error = userMessage(error),
                notice = if (postMutation) STORE_REFRESH_REQUIRED else null,
                freshModes = state.freshModes - StoreDeliveryMode.Parties,
            )
        }
    }

    private fun mutateParty(
        key: String,
        success: String,
        localCommit: (StoreDeliveryUiState) -> StoreDeliveryUiState,
        operation: suspend () -> Unit,
    ) {
        if (!canMutateDeliveryParties(state)) return
        state = state.copy(busyPartyAction = key, error = null, notice = null)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess {
                    state = localCommit(state).copy(
                        busyPartyAction = null,
                        loading = true,
                        notice = success,
                        error = null,
                    )
                    val generation = ++loadGeneration
                    loadPartyManagement(generation, postMutation = true, successNotice = success)
                }
                .onFailure { error ->
                    state = state.copy(busyPartyAction = null, error = userMessage(error))
                }
        }
    }

    private suspend fun loadDetail(id: Long, request: Long, catalogGeneration: Long) {
        runCatching { source.orderDetail(id) }
            .onSuccess { order ->
                when {
                    acceptsOrderDetail(state, id, order.summary.status, request, detailGeneration, catalogGeneration, loadGeneration) -> {
                        state = state.copy(detail = StoreDetailState.Content(order))
                    }
                    isCurrentOrderDetailRequest(state, id, request, detailGeneration, catalogGeneration, loadGeneration) -> {
                        state = state.copy(
                            detail = StoreDetailState.Error("تغيّرت حالة الطلب"),
                            error = "تغيّرت حالة الطلب. حدّث العرض قبل تنفيذ أي إجراء",
                            freshModes = state.freshModes - StoreDeliveryMode.Orders,
                        )
                    }
                }
            }
            .onFailure { error ->
                if (acceptsOrderDetail(state, id, null, request, detailGeneration, catalogGeneration, loadGeneration)) {
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

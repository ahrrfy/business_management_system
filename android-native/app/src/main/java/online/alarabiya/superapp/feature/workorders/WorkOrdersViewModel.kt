package online.alarabiya.superapp.feature.workorders

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.WorkOrdersDataSource
import online.alarabiya.superapp.data.newDeliveryDraft
import online.alarabiya.superapp.data.newRecipeRunDraft
import online.alarabiya.superapp.data.newWorkOrderDraft
import online.alarabiya.superapp.model.workorders.*

private const val WORK_ORDERS_PAGE_SIZE = 100
private const val MAX_EXECUTIVE_WORK_ORDERS = 5_000

data class WorkOrdersUiState(
    val section: WorkOrdersSection,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    val orderQuery: String = "",
    val orderStatus: WorkOrderStatus? = null,
    val queue: WorkQueue = WorkQueue.ALL,
    val overdueOnly: Boolean = false,
    val orders: List<WorkOrderSummary> = emptyList(),
    val ordersHasMore: Boolean = false,
    val ordersLoaded: Boolean = false,
    val counts: WorkOrderCounts = WorkOrderCounts(0, 0, 0, 0, 0, 0),
    val selectedOrder: WorkOrderDetail? = null,
    val selectedOrderFresh: Boolean = false,
    val pendingOrderRefreshId: Long? = null,
    val staff: List<StaffOption> = emptyList(),
    val orderDraft: WorkOrderDraft? = null,
    val deliveryDraft: DeliveryDraft? = null,
    val printTier: PriceTier = PriceTier.RETAIL,
    val printQuery: String = "",
    val printServices: List<PrintService> = emptyList(),
    val pricingBundle: PricingBundle? = null,
    val pricingDraft: PricingDraft = PricingDraft(),
    val estimate: PrintEstimate? = null,
    val productionQuery: String = "",
    val productionStatus: ProductionStatus? = null,
    val productions: List<ProductionSummary> = emptyList(),
    val productionHasMore: Boolean = false,
    val productionsLoaded: Boolean = false,
    val selectedProduction: ProductionDetail? = null,
    val selectedProductionFresh: Boolean = false,
    val pendingProductionRefreshId: Long? = null,
    val recipes: List<RecipeSummary> = emptyList(),
    val runDraft: RecipeRunDraft? = null,
    val runPreview: RecipePreview? = null,
) {
    val canBeginOrder: Boolean get() = ordersLoaded && busyKey == null
    val canMutateSelectedOrder: Boolean get() = ordersLoaded && selectedOrderFresh && busyKey == null
    val canBeginRun: Boolean get() = productionsLoaded && busyKey == null
    val canMutateSelectedProduction: Boolean get() = productionsLoaded && selectedProductionFresh && busyKey == null

    val visibleOrders: List<WorkOrderSummary>
        get() = filteredOrders()

    internal fun filteredOrders(todayUtc: LocalDate = LocalDate.now(ZoneOffset.UTC)): List<WorkOrderSummary> =
        if (!overdueOnly) orders else orders.filter { order ->
            order.status !in setOf(WorkOrderStatus.DELIVERED, WorkOrderStatus.CANCELLED) &&
                order.dueDate?.take(10)?.let { raw ->
                    runCatching { LocalDate.parse(raw) }.getOrNull()?.isBefore(todayUtc)
                } == true
        }
}

internal fun WorkOrdersUiState.orderCreatedCommitted(id: Long, notice: String): WorkOrdersUiState = copy(
    ordersLoaded = false,
    selectedOrder = null,
    selectedOrderFresh = false,
    pendingOrderRefreshId = id,
    orderDraft = null,
    deliveryDraft = null,
    message = notice,
    error = null,
)

internal fun WorkOrdersUiState.orderTransitionCommitted(
    detail: WorkOrderDetail,
    notice: String,
): WorkOrdersUiState = copy(
    ordersLoaded = false,
    selectedOrder = detail,
    selectedOrderFresh = false,
    pendingOrderRefreshId = detail.id,
    deliveryDraft = null,
    message = notice,
    error = null,
)

internal fun WorkOrdersUiState.orderRefreshed(
    detail: WorkOrderDetail?,
    rows: List<WorkOrderSummary>,
    freshCounts: WorkOrderCounts,
): WorkOrdersUiState = copy(
    orders = rows,
    ordersHasMore = !overdueOnly && rows.size == WORK_ORDERS_PAGE_SIZE,
    counts = freshCounts,
    selectedOrder = detail,
    selectedOrderFresh = detail != null,
    pendingOrderRefreshId = null,
    ordersLoaded = true,
    deliveryDraft = deliveryDraft.takeIf { detail?.status == WorkOrderStatus.READY },
    error = null,
)

internal fun WorkOrdersUiState.productionCreatedCommitted(id: Long, notice: String): WorkOrdersUiState = copy(
    productionsLoaded = false,
    selectedProduction = null,
    selectedProductionFresh = false,
    pendingProductionRefreshId = id,
    runDraft = null,
    runPreview = null,
    message = notice,
    error = null,
)

internal fun WorkOrdersUiState.productionTransitionCommitted(
    detail: ProductionDetail,
    notice: String,
): WorkOrdersUiState = copy(
    productionsLoaded = false,
    selectedProduction = detail,
    selectedProductionFresh = false,
    pendingProductionRefreshId = detail.id,
    runDraft = null,
    runPreview = null,
    message = notice,
    error = null,
)

internal fun WorkOrdersUiState.productionRefreshed(
    detail: ProductionDetail?,
    rows: List<ProductionSummary>,
    hasMore: Boolean,
): WorkOrdersUiState = copy(
    productions = rows,
    productionHasMore = hasMore,
    selectedProduction = detail,
    selectedProductionFresh = detail != null,
    pendingProductionRefreshId = null,
    productionsLoaded = true,
    error = null,
)

internal fun WorkOrdersUiState.applyExecutiveNavigation(arguments: Map<String, String>): WorkOrdersUiState {
    val overdue = arguments["overdue"].equals("true", ignoreCase = true) || arguments["overdue"] == "1"
    if (!overdue) return this
    return copy(
        section = WorkOrdersSection.ORDERS,
        orderStatus = null,
        queue = WorkQueue.ALL,
        overdueOnly = true,
        selectedOrder = null,
        error = null,
        message = null,
    )
}

private data class InitialWorkOrders(
    val orders: Result<List<WorkOrderSummary>>?,
    val counts: Result<WorkOrderCounts>?,
    val staff: Result<List<StaffOption>>?,
    val services: Result<List<PrintService>>?,
    val pricing: Result<PricingBundle>?,
    val productions: Result<Pair<List<ProductionSummary>, Boolean>>?,
    val recipes: Result<List<RecipeSummary>>?,
)

class WorkOrdersViewModel(
    private val source: WorkOrdersDataSource,
    val capabilities: WorkOrdersCapabilities,
) : ViewModel() {
    private var pendingExecutiveOrdersRefresh = false

    var state by mutableStateOf(WorkOrdersUiState(capabilities.sections.firstOrNull() ?: WorkOrdersSection.ORDERS))
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(
            initializing = true,
            error = null,
            ordersLoaded = if (capabilities.canReadOrders) false else state.ordersLoaded,
            selectedOrderFresh = false,
            productionsLoaded = if (capabilities.canManageProduction) false else state.productionsLoaded,
            selectedProductionFresh = false,
        )
        viewModelScope.launch {
            val result = coroutineScope {
                val orders = async { if (capabilities.canReadOrders) runCatching { loadOrders() } else null }
                val counts = async { if (capabilities.canReadOrders) runCatching { source.counts() } else null }
                val staff = async { if (capabilities.canCreateOrders) runCatching { source.staff() } else null }
                val services = async { if (capabilities.canReadPrintServices) runCatching { source.printServices(state.printTier) } else null }
                val pricing = async { if (capabilities.canUsePricing) runCatching { source.pricing() } else null }
                val productions = async { if (capabilities.canManageProduction) runCatching { source.productions() } else null }
                val recipes = async { if (capabilities.canManageProduction) runCatching { source.recipes() } else null }
                InitialWorkOrders(orders.await(), counts.await(), staff.await(), services.await(), pricing.await(), productions.await(), recipes.await())
            }
            val error = listOf(result.orders, result.counts, result.staff, result.services, result.pricing, result.productions, result.recipes)
                .firstNotNullOfOrNull { it?.exceptionOrNull() }
            val ordersReady = !capabilities.canReadOrders || (
                result.orders?.isSuccess == true &&
                    result.counts?.isSuccess == true &&
                    (!capabilities.canCreateOrders || result.staff?.isSuccess == true)
                )
            val productionsReady = !capabilities.canManageProduction || (
                result.productions?.isSuccess == true && result.recipes?.isSuccess == true
                )
            state = state.copy(
                initializing = false,
                orders = result.orders?.getOrNull() ?: state.orders,
                ordersHasMore = !state.overdueOnly && result.orders?.getOrNull()?.size == WORK_ORDERS_PAGE_SIZE,
                ordersLoaded = capabilities.canReadOrders && ordersReady,
                selectedOrderFresh = false,
                pendingOrderRefreshId = if (ordersReady) null else state.pendingOrderRefreshId,
                counts = result.counts?.getOrNull() ?: state.counts,
                staff = result.staff?.getOrNull() ?: state.staff,
                printServices = result.services?.getOrNull() ?: state.printServices,
                pricingBundle = result.pricing?.getOrNull() ?: state.pricingBundle,
                productions = result.productions?.getOrNull()?.first ?: state.productions,
                productionHasMore = result.productions?.getOrNull()?.second ?: false,
                productionsLoaded = capabilities.canManageProduction && productionsReady,
                selectedProductionFresh = false,
                pendingProductionRefreshId = if (productionsReady) null else state.pendingProductionRefreshId,
                recipes = result.recipes?.getOrNull() ?: state.recipes,
                error = error?.message,
            )
            if (pendingExecutiveOrdersRefresh) {
                pendingExecutiveOrdersRefresh = false
                refreshOrders()
            }
        }
    }

    fun applyNavigationArguments(arguments: Map<String, String>) {
        if (WorkOrdersSection.ORDERS !in capabilities.sections) return
        val overdue = arguments["overdue"]
        if (!(overdue.equals("true", ignoreCase = true) || overdue == "1")) return
        val next = state.applyExecutiveNavigation(arguments)
        state = next
        if (state.initializing || state.busyKey != null) pendingExecutiveOrdersRefresh = true
        else refreshOrders()
    }

    fun selectSection(value: WorkOrdersSection) { if (value in capabilities.sections) state = state.copy(section = value, error = null, message = null) }
    fun clearFeedback() { state = state.copy(error = null, message = null) }
    fun setOrderQuery(value: String) { state = state.copy(orderQuery = value.take(120)) }
    fun setOrderStatus(value: WorkOrderStatus?) { state = state.copy(orderStatus = value, overdueOnly = false); refreshOrders() }
    fun setQueue(value: WorkQueue) { state = state.copy(queue = value, overdueOnly = false); refreshOrders() }
    fun clearOverdueFilter() {
        state = state.copy(overdueOnly = false)
        refreshOrders()
    }
    fun refreshOrders() {
        if (state.busyKey != null || !capabilities.canReadOrders) return
        state = state.copy(ordersLoaded = false, selectedOrderFresh = false, error = null)
        launch("orders") {
            val refreshed = coroutineScope {
                val orders = async { loadOrders() }
                val counts = async { source.counts() }
                val staff = async { if (capabilities.canCreateOrders) source.staff() else state.staff }
                Triple(orders.await(), counts.await(), staff.await())
            }
            state = state.orderRefreshed(null, refreshed.first, refreshed.second).copy(staff = refreshed.third)
        }
    }

    private suspend fun loadOrders(): List<WorkOrderSummary> {
        val query = state.orderQuery
        val status = state.orderStatus
        val queue = state.queue
        if (!state.overdueOnly) return source.orders(query, status, queue)

        val rows = mutableListOf<WorkOrderSummary>()
        var cursor: Long? = null
        do {
            val page = source.orders(query, status, queue, cursor)
            rows += page
            cursor = page.lastOrNull()?.id
        } while (
            page.size == WORK_ORDERS_PAGE_SIZE &&
            cursor != null &&
            rows.size < MAX_EXECUTIVE_WORK_ORDERS
        )
        return rows
    }
    fun loadMoreOrders() {
        if (!state.ordersLoaded) return
        val cursor = state.orders.lastOrNull()?.id ?: return
        launch("orders:more") { val next = source.orders(state.orderQuery, state.orderStatus, state.queue, cursor); state = state.copy(orders = state.orders + next, ordersHasMore = next.size == 100) }
    }
    fun selectOrder(id: Long) {
        if (!state.ordersLoaded) return
        state = state.copy(selectedOrder = null, selectedOrderFresh = false, orderDraft = null, deliveryDraft = null)
        launch("order:$id") { state = state.copy(selectedOrder = source.order(id), selectedOrderFresh = true) }
    }
    fun closeOrder() { state = state.copy(selectedOrder = null, deliveryDraft = null) }
    fun beginOrder() {
        if (capabilities.canCreateOrders && state.canBeginOrder) {
            state = state.copy(orderDraft = newWorkOrderDraft(), selectedOrder = null, selectedOrderFresh = false, error = null)
        }
    }
    fun updateOrderDraft(value: WorkOrderDraft) { state = state.copy(orderDraft = value, error = null) }
    fun closeOrderDraft() { state = state.copy(orderDraft = null) }
    fun saveOrder() {
        if (!capabilities.canCreateOrders || !state.ordersLoaded || state.busyKey != null) return
        val draft = state.orderDraft ?: return
        WorkOrderValidation.create(draft, capabilities.branchId)?.let { return fail(it) }
        committedMutation(
            key = "order:create",
            success = "تم إنشاء أمر الشغل",
            mutation = { source.createOrder(draft) },
            commit = { value -> state = state.orderCreatedCommitted(value, "تم إنشاء أمر الشغل") },
            refresh = { value -> reloadOrder(value) },
        )
    }
    fun assign(staffId: Long?) {
        if (allowed(WorkOrderAction.ASSIGN)) orderAction("order:assign", "تم تحديث المنفذ", { source.assign(it, staffId) }) { detail ->
            detail.copy(assignedTo = staffId, assigneeName = state.staff.firstOrNull { it.id == staffId }?.name)
        }
    }
    fun claim() {
        if (allowed(WorkOrderAction.CLAIM)) orderAction("order:claim", "تم سحب الأمر", source::claim) { detail ->
            detail.copy(
                assignedTo = capabilities.userId,
                assigneeName = state.staff.firstOrNull { it.id == capabilities.userId }?.name ?: detail.assigneeName,
            )
        }
    }
    fun start() {
        if (allowed(WorkOrderAction.START)) orderAction("order:start", "بدأ التنفيذ", source::start) {
            it.copy(status = WorkOrderStatus.IN_PROGRESS)
        }
    }
    fun markReady() {
        if (allowed(WorkOrderAction.MARK_READY)) orderAction("order:ready", "أصبح الأمر جاهزاً", source::markReady) {
            it.copy(status = WorkOrderStatus.READY)
        }
    }
    fun beginDelivery() { if (allowed(WorkOrderAction.DELIVER)) state = state.copy(deliveryDraft = newDeliveryDraft()) }
    fun updateDeliveryDraft(value: DeliveryDraft) { state = state.copy(deliveryDraft = value, error = null) }
    fun closeDelivery() { state = state.copy(deliveryDraft = null) }
    fun deliver() {
        if (!allowed(WorkOrderAction.DELIVER)) return
        val detail = state.selectedOrder ?: return; val draft = state.deliveryDraft ?: return
        WorkOrderValidation.delivery(draft, detail.customerId)?.let { return fail(it) }
        committedMutation(
            key = "order:deliver",
            success = "تم تسليم الأمر وإصدار الفاتورة",
            failClosedId = detail.id,
            mutation = { source.deliver(detail, draft) },
            commit = {
                state = state.orderTransitionCommitted(
                    detail.copy(status = WorkOrderStatus.DELIVERED),
                    "تم تسليم الأمر وإصدار الفاتورة",
                )
            },
            refresh = { reloadOrder(detail.id) },
        )
    }
    fun cancelOrder() {
        if (allowed(WorkOrderAction.CANCEL)) orderAction("order:cancel", "تم إلغاء الأمر", source::cancelOrder) {
            it.copy(status = WorkOrderStatus.CANCELLED)
        }
    }

    fun setPrintTier(value: PriceTier) { state = state.copy(printTier = value); launch("services") { state = state.copy(printServices = source.printServices(value)) } }
    fun setPrintQuery(value: String) { state = state.copy(printQuery = value.take(100)) }
    fun updatePricingDraft(value: PricingDraft) { state = state.copy(pricingDraft = value, estimate = null, error = null) }
    fun estimate() {
        WorkOrderValidation.pricing(state.pricingDraft)?.let { return fail(it) }
        launch("pricing:estimate") { state = state.copy(estimate = source.estimate(state.pricingDraft)) }
    }

    fun setProductionQuery(value: String) { state = state.copy(productionQuery = value.take(100)) }
    fun setProductionStatus(value: ProductionStatus?) { state = state.copy(productionStatus = value); refreshProductions() }
    fun refreshProductions() {
        if (state.busyKey != null || !capabilities.canManageProduction) return
        state = state.copy(productionsLoaded = false, selectedProductionFresh = false, runPreview = null, error = null)
        launch("productions") {
            val result = coroutineScope {
                val page = async { source.productions(state.productionQuery, state.productionStatus) }
                val recipes = async { source.recipes() }
                page.await() to recipes.await()
            }
            state = state.productionRefreshed(null, result.first.first, result.first.second).copy(recipes = result.second)
        }
    }
    fun loadMoreProductions() {
        if (!state.productionsLoaded) return
        launch("productions:more") {
            val page = source.productions(state.productionQuery, state.productionStatus, state.productions.size)
            state = state.copy(productions = state.productions + page.first, productionHasMore = page.second)
        }
    }
    fun selectProduction(id: Long) {
        if (!state.productionsLoaded) return
        state = state.copy(selectedProduction = null, selectedProductionFresh = false, runDraft = null, runPreview = null)
        launch("production:$id") { state = state.copy(selectedProduction = source.production(id), selectedProductionFresh = true) }
    }
    fun closeProduction() { state = state.copy(selectedProduction = null) }
    fun beginRun() {
        if (capabilities.canManageProduction && state.canBeginRun) {
            state = state.copy(runDraft = newRecipeRunDraft(), selectedProduction = null, selectedProductionFresh = false, runPreview = null)
        }
    }
    fun updateRunDraft(value: RecipeRunDraft) { state = state.copy(runDraft = value, runPreview = null, error = null) }
    fun closeRun() { state = state.copy(runDraft = null, runPreview = null) }
    fun previewRun() {
        if (!state.canBeginRun) return
        val draft = state.runDraft ?: return
        WorkOrderValidation.production(draft, capabilities.branchId)?.let { return fail(it) }
        launch("production:preview") { state = state.copy(runPreview = source.previewRun(draft)) }
    }
    fun createRun() {
        if (!state.canBeginRun) return
        val draft = state.runDraft ?: return
        val preview = state.runPreview ?: return
        if (preview.anyShort || preview.recipeId != draft.recipeId) return
        WorkOrderValidation.production(draft, capabilities.branchId)?.let { return fail(it) }
        committedMutation(
            key = "production:create",
            success = "تم ترحيل مستند الإنتاج",
            mutation = { source.createRun(draft) },
            commit = { value -> state = state.productionCreatedCommitted(value, "تم ترحيل مستند الإنتاج") },
            refresh = { value -> reloadProduction(value) },
        )
    }
    fun cancelProduction() {
        val detail = state.selectedProduction ?: return
        if (!state.canMutateSelectedProduction || detail.status != ProductionStatus.CONFIRMED) return
        committedMutation(
            key = "production:cancel",
            success = "تم عكس مستند الإنتاج",
            failClosedProductionId = detail.id,
            mutation = { source.cancelProduction(detail.id) },
            commit = {
                state = state.productionTransitionCommitted(
                    detail.copy(status = ProductionStatus.CANCELLED),
                    "تم عكس مستند الإنتاج",
                )
            },
            refresh = { reloadProduction(detail.id) },
        )
    }

    fun retryOrders() {
        if (state.busyKey != null || !capabilities.canReadOrders) return
        val id = state.pendingOrderRefreshId ?: state.selectedOrder?.takeIf { !state.selectedOrderFresh }?.id
        if (id == null) refreshOrders() else launch("order:retry") { reloadOrder(id) }
    }

    fun retryProductions() {
        if (state.busyKey != null || !capabilities.canManageProduction) return
        val id = state.pendingProductionRefreshId ?: state.selectedProduction?.takeIf { !state.selectedProductionFresh }?.id
        if (id == null) refreshProductions() else launch("production:retry") { reloadProduction(id) }
    }

    private fun orderAction(
        key: String,
        message: String,
        action: suspend (Long) -> Unit,
        transition: (WorkOrderDetail) -> WorkOrderDetail,
    ) {
        val detail = state.selectedOrder ?: return
        committedMutation(
            key = key,
            success = message,
            failClosedId = detail.id,
            mutation = { action(detail.id) },
            commit = { state = state.orderTransitionCommitted(transition(detail), message) },
            refresh = { reloadOrder(detail.id) },
        )
    }

    private fun allowed(action: WorkOrderAction): Boolean = state.canMutateSelectedOrder &&
        state.selectedOrder?.let { action in capabilities.actionsFor(it) } == true

    private suspend fun reloadOrder(id: Long) {
        val refreshed = coroutineScope {
            val detail = async { source.order(id) }
            val orders = async { loadOrders() }
            val counts = async { source.counts() }
            Triple(detail.await(), orders.await(), counts.await())
        }
        state = state.orderRefreshed(refreshed.first, refreshed.second, refreshed.third)
    }

    private suspend fun reloadProduction(id: Long) {
        val refreshed = coroutineScope {
            val detail = async { source.production(id) }
            val page = async { source.productions(state.productionQuery, state.productionStatus) }
            detail.await() to page.await()
        }
        state = state.productionRefreshed(refreshed.first, refreshed.second.first, refreshed.second.second)
    }

    private fun <T> committedMutation(
        key: String,
        success: String,
        failClosedId: Long? = null,
        failClosedProductionId: Long? = null,
        mutation: suspend () -> T,
        commit: (T) -> Unit,
        refresh: suspend (T) -> Unit,
    ) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            val result = runCatching { mutation() }.getOrElse { error ->
                state = when {
                    failClosedId != null -> state.copy(
                        busyKey = null,
                        ordersLoaded = false,
                        selectedOrderFresh = false,
                        pendingOrderRefreshId = failClosedId,
                        error = "تعذر التحقق من نتيجة العملية. حدّث أمر الشغل قبل تنفيذ أي إجراء آخر.",
                    )
                    failClosedProductionId != null -> state.copy(
                        busyKey = null,
                        productionsLoaded = false,
                        selectedProductionFresh = false,
                        pendingProductionRefreshId = failClosedProductionId,
                        error = "تعذر التحقق من نتيجة العملية. حدّث مستند الإنتاج قبل تنفيذ أي إجراء آخر.",
                    )
                    else -> state.copy(busyKey = null, error = error.message ?: "تعذر إكمال العملية")
                }
                return@launch
            }

            // The mutation is already durable. Close its command surface before any read-after-write
            // request so a failed refresh can never make the same operation submit-able again.
            commit(result)
            runCatching { refresh(result) }
                .onSuccess { state = state.copy(busyKey = null, message = success, error = null) }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        message = success,
                        error = "تمت العملية، وتعذر تحديث البيانات. أعد المحاولة قبل تنفيذ إجراء جديد.",
                    )
                }
            if (pendingExecutiveOrdersRefresh) {
                pendingExecutiveOrdersRefresh = false
                refreshOrders()
            }
        }
    }

    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { state = state.copy(busyKey = null, message = success) }
                .onFailure { state = state.copy(busyKey = null, error = it.message ?: "تعذر إكمال العملية") }
            if (pendingExecutiveOrdersRefresh) {
                pendingExecutiveOrdersRefresh = false
                refreshOrders()
            }
        }
    }
    private fun fail(message: String) { state = state.copy(error = message) }
}

class WorkOrdersViewModelFactory(private val source: WorkOrdersDataSource, private val capabilities: WorkOrdersCapabilities) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = WorkOrdersViewModel(source, capabilities) as T
}

package online.alarabiya.superapp.feature.workorders

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.WorkOrdersDataSource
import online.alarabiya.superapp.data.newDeliveryDraft
import online.alarabiya.superapp.data.newRecipeRunDraft
import online.alarabiya.superapp.data.newWorkOrderDraft
import online.alarabiya.superapp.model.workorders.*

data class WorkOrdersUiState(
    val section: WorkOrdersSection,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    val orderQuery: String = "",
    val orderStatus: WorkOrderStatus? = null,
    val queue: WorkQueue = WorkQueue.ALL,
    val orders: List<WorkOrderSummary> = emptyList(),
    val ordersHasMore: Boolean = false,
    val counts: WorkOrderCounts = WorkOrderCounts(0, 0, 0, 0, 0, 0),
    val selectedOrder: WorkOrderDetail? = null,
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
    val selectedProduction: ProductionDetail? = null,
    val recipes: List<RecipeSummary> = emptyList(),
    val runDraft: RecipeRunDraft? = null,
    val runPreview: RecipePreview? = null,
)

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
    var state by mutableStateOf(WorkOrdersUiState(capabilities.sections.firstOrNull() ?: WorkOrdersSection.ORDERS))
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, error = null)
        viewModelScope.launch {
            val result = coroutineScope {
                val orders = async { if (capabilities.canReadOrders) runCatching { source.orders() } else null }
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
            state = state.copy(
                initializing = false,
                orders = result.orders?.getOrNull() ?: state.orders,
                ordersHasMore = result.orders?.getOrNull()?.size == 100,
                counts = result.counts?.getOrNull() ?: state.counts,
                staff = result.staff?.getOrNull() ?: state.staff,
                printServices = result.services?.getOrNull() ?: state.printServices,
                pricingBundle = result.pricing?.getOrNull() ?: state.pricingBundle,
                productions = result.productions?.getOrNull()?.first ?: state.productions,
                productionHasMore = result.productions?.getOrNull()?.second ?: false,
                recipes = result.recipes?.getOrNull() ?: state.recipes,
                error = error?.message,
            )
        }
    }

    fun selectSection(value: WorkOrdersSection) { if (value in capabilities.sections) state = state.copy(section = value, error = null, message = null) }
    fun clearFeedback() { state = state.copy(error = null, message = null) }
    fun setOrderQuery(value: String) { state = state.copy(orderQuery = value.take(120)) }
    fun setOrderStatus(value: WorkOrderStatus?) { state = state.copy(orderStatus = value); refreshOrders() }
    fun setQueue(value: WorkQueue) { state = state.copy(queue = value); refreshOrders() }
    fun refreshOrders() = launch("orders") { state = state.copy(orders = source.orders(state.orderQuery, state.orderStatus, state.queue), selectedOrder = null, ordersHasMore = false, counts = source.counts()) }
    fun loadMoreOrders() {
        val cursor = state.orders.lastOrNull()?.id ?: return
        launch("orders:more") { val next = source.orders(state.orderQuery, state.orderStatus, state.queue, cursor); state = state.copy(orders = state.orders + next, ordersHasMore = next.size == 100) }
    }
    fun selectOrder(id: Long) = launch("order:$id") { state = state.copy(selectedOrder = source.order(id), orderDraft = null, deliveryDraft = null) }
    fun closeOrder() { state = state.copy(selectedOrder = null, deliveryDraft = null) }
    fun beginOrder() { if (capabilities.canCreateOrders) state = state.copy(orderDraft = newWorkOrderDraft(), selectedOrder = null, error = null) }
    fun updateOrderDraft(value: WorkOrderDraft) { state = state.copy(orderDraft = value, error = null) }
    fun closeOrderDraft() { state = state.copy(orderDraft = null) }
    fun saveOrder() {
        val draft = state.orderDraft ?: return
        WorkOrderValidation.create(draft, capabilities.branchId)?.let { return fail(it) }
        launch("order:create", "تم إنشاء أمر الشغل") { val id = source.createOrder(draft); state = state.copy(orderDraft = null, orders = source.orders(state.orderQuery, state.orderStatus, state.queue), counts = source.counts(), selectedOrder = source.order(id)) }
    }
    fun assign(staffId: Long?) { if (allowed(WorkOrderAction.ASSIGN)) orderAction("order:assign", "تم تحديث المنفذ") { source.assign(it, staffId) } }
    fun claim() { if (allowed(WorkOrderAction.CLAIM)) orderAction("order:claim", "تم سحب الأمر") { source.claim(it) } }
    fun start() { if (allowed(WorkOrderAction.START)) orderAction("order:start", "بدأ التنفيذ") { source.start(it) } }
    fun markReady() { if (allowed(WorkOrderAction.MARK_READY)) orderAction("order:ready", "أصبح الأمر جاهزاً") { source.markReady(it) } }
    fun beginDelivery() { if (allowed(WorkOrderAction.DELIVER)) state = state.copy(deliveryDraft = newDeliveryDraft()) }
    fun updateDeliveryDraft(value: DeliveryDraft) { state = state.copy(deliveryDraft = value, error = null) }
    fun closeDelivery() { state = state.copy(deliveryDraft = null) }
    fun deliver() {
        if (!allowed(WorkOrderAction.DELIVER)) return
        val detail = state.selectedOrder ?: return; val draft = state.deliveryDraft ?: return
        WorkOrderValidation.delivery(draft, detail.customerId)?.let { return fail(it) }
        launch("order:deliver", "تم تسليم الأمر وإصدار الفاتورة") { source.deliver(detail, draft); reloadOrder(detail.id, clearDelivery = true) }
    }
    fun cancelOrder() { if (allowed(WorkOrderAction.CANCEL)) orderAction("order:cancel", "تم إلغاء الأمر") { source.cancelOrder(it) } }

    fun setPrintTier(value: PriceTier) { state = state.copy(printTier = value); launch("services") { state = state.copy(printServices = source.printServices(value)) } }
    fun setPrintQuery(value: String) { state = state.copy(printQuery = value.take(100)) }
    fun updatePricingDraft(value: PricingDraft) { state = state.copy(pricingDraft = value, estimate = null, error = null) }
    fun estimate() {
        WorkOrderValidation.pricing(state.pricingDraft)?.let { return fail(it) }
        launch("pricing:estimate") { state = state.copy(estimate = source.estimate(state.pricingDraft)) }
    }

    fun setProductionQuery(value: String) { state = state.copy(productionQuery = value.take(100)) }
    fun setProductionStatus(value: ProductionStatus?) { state = state.copy(productionStatus = value); refreshProductions() }
    fun refreshProductions() = launch("productions") { val page = source.productions(state.productionQuery, state.productionStatus); state = state.copy(productions = page.first, productionHasMore = page.second, selectedProduction = null) }
    fun loadMoreProductions() = launch("productions:more") { val page = source.productions(state.productionQuery, state.productionStatus, state.productions.size); state = state.copy(productions = state.productions + page.first, productionHasMore = page.second) }
    fun selectProduction(id: Long) = launch("production:$id") { state = state.copy(selectedProduction = source.production(id), runDraft = null) }
    fun closeProduction() { state = state.copy(selectedProduction = null) }
    fun beginRun() { if (capabilities.canManageProduction) state = state.copy(runDraft = newRecipeRunDraft(), selectedProduction = null, runPreview = null) }
    fun updateRunDraft(value: RecipeRunDraft) { state = state.copy(runDraft = value, runPreview = null, error = null) }
    fun closeRun() { state = state.copy(runDraft = null, runPreview = null) }
    fun previewRun() { val draft = state.runDraft ?: return; WorkOrderValidation.production(draft, capabilities.branchId)?.let { return fail(it) }; launch("production:preview") { state = state.copy(runPreview = source.previewRun(draft)) } }
    fun createRun() { val draft = state.runDraft ?: return; WorkOrderValidation.production(draft, capabilities.branchId)?.let { return fail(it) }; launch("production:create", "تم ترحيل مستند الإنتاج") { val id = source.createRun(draft); val page = source.productions(state.productionQuery, state.productionStatus); state = state.copy(runDraft = null, runPreview = null, productions = page.first, productionHasMore = page.second, selectedProduction = source.production(id)) } }
    fun cancelProduction() { val detail = state.selectedProduction ?: return; if (detail.status != ProductionStatus.CONFIRMED) return; launch("production:cancel", "تم عكس مستند الإنتاج") { source.cancelProduction(detail.id); val page = source.productions(state.productionQuery, state.productionStatus); state = state.copy(selectedProduction = source.production(detail.id), productions = page.first, productionHasMore = page.second) } }

    private fun orderAction(key: String, message: String, action: suspend (Long) -> Unit) { val detail = state.selectedOrder ?: return; launch(key, message) { action(detail.id); reloadOrder(detail.id) } }
    private fun allowed(action: WorkOrderAction): Boolean = state.selectedOrder?.let { action in capabilities.actionsFor(it) } == true
    private suspend fun reloadOrder(id: Long, clearDelivery: Boolean = false) { state = state.copy(selectedOrder = source.order(id), deliveryDraft = if (clearDelivery) null else state.deliveryDraft, orders = source.orders(state.orderQuery, state.orderStatus, state.queue), counts = source.counts()) }
    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch { runCatching { block() }.onSuccess { state = state.copy(busyKey = null, message = success) }.onFailure { state = state.copy(busyKey = null, error = it.message ?: "تعذر إكمال العملية") } }
    }
    private fun fail(message: String) { state = state.copy(error = message) }
}

class WorkOrdersViewModelFactory(private val source: WorkOrdersDataSource, private val capabilities: WorkOrdersCapabilities) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = WorkOrdersViewModel(source, capabilities) as T
}

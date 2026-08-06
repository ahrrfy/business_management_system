package online.alarabiya.superapp.feature.purchasing

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.PurchasingDataSource
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReceiveDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnDraft
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import online.alarabiya.superapp.model.purchasing.ReminderQueueItem
import online.alarabiya.superapp.model.purchasing.SupplierDraft

class PurchasingViewModel(
    private val source: PurchasingDataSource,
    val capabilities: PurchasingCapabilities,
) : ViewModel() {
    var state by mutableStateOf(PurchasingUiState(capabilities.visibleSections.first()))
        private set

    fun initialize() {
        if (state.locked) return
        state = state.start("initial") ?: return
        viewModelScope.launch {
            val result = coroutineScope {
                val orders = async { if (capabilities.canReadOrders) runCatching { source.orders() } else null }
                val catalog = async { if (capabilities.canWriteOrders && capabilities.branchId != null) runCatching { source.catalog(capabilities.branchId) } else null }
                val suppliers = async { if (capabilities.canReadSuppliers) runCatching { source.suppliers() } else null }
                val returns = async { if (capabilities.canReadReturns) runCatching { source.returns() } else null }
                val aggregateReminders = capabilities.role == "admin" && capabilities.branchId == null
                val queue = async { if (capabilities.canReadReminders) runCatching { source.reminderQueue(aggregateReminders) } else null }
                val history = async { if (capabilities.canReadReminders) runCatching { source.reminderHistory(aggregateReminders) } else null }
                listOf(orders.await(), catalog.await(), suppliers.await(), returns.await(), queue.await(), history.await())
            }
            val error = result.firstNotNullOfOrNull { it?.exceptionOrNull() }
            @Suppress("UNCHECKED_CAST")
            state = state.copy(
                busyKey = null,
                orders = (result[0]?.getOrNull() as? List<online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary>) ?: state.orders,
                catalog = (result[1]?.getOrNull() as? List<online.alarabiya.superapp.model.purchasing.PurchaseCatalogItem>) ?: state.catalog,
                suppliers = (result[2]?.getOrNull() as? online.alarabiya.superapp.model.purchasing.SupplierPage) ?: state.suppliers,
                returns = (result[3]?.getOrNull() as? online.alarabiya.superapp.model.purchasing.PurchaseReturnPage) ?: state.returns,
                reminderQueue = (result[4]?.getOrNull() as? List<ReminderQueueItem>) ?: state.reminderQueue,
                reminderHistory = (result[5]?.getOrNull() as? List<online.alarabiya.superapp.model.purchasing.ReminderHistoryItem>) ?: state.reminderHistory,
                error = error?.let(::userMessage),
            )
        }
    }

    fun selectSection(section: PurchasingSection) { if (section in capabilities.visibleSections) state = state.switchTo(section) }
    fun setQuery(value: String) { state = state.copy(query = value.take(200)) }
    fun search() = launch("search") {
        when (state.section) {
            PurchasingSection.ORDERS -> state = state.copy(orders = source.orders(state.query))
            PurchasingSection.SUPPLIERS -> state = state.copy(suppliers = source.suppliers(state.query))
            PurchasingSection.RETURNS -> state = state.copy(returns = source.returns(state.query))
            PurchasingSection.REMINDERS -> {
                val aggregate = capabilities.role == "admin" && capabilities.branchId == null
                state = state.copy(reminderQueue = source.reminderQueue(aggregate), reminderHistory = source.reminderHistory(aggregate))
            }
        }
    }

    fun selectOrder(id: Long) = launch("order:$id") { state = state.copy(selectedOrder = source.order(id), selectedSupplier = null) }
    fun closeOrder() { state = state.copy(selectedOrder = null) }
    fun selectSupplier(id: Long) = launch("supplier:$id") { state = state.copy(selectedSupplier = source.supplier(id), selectedOrder = null) }
    fun closeSupplier() { state = state.copy(selectedSupplier = null) }
    fun loadCatalog(branchId: Long) = launch("catalog:$branchId") { state = state.copy(catalog = source.catalog(branchId)) }

    fun createSupplier(draft: SupplierDraft) = launch("supplier:create", "تم حفظ المورد") {
        val id = source.createSupplier(draft)
        state = state.copy(suppliers = source.suppliers(state.query), selectedSupplier = source.supplier(id))
    }
    fun updateSupplier(draft: SupplierDraft) = launch("supplier:update", "تم تحديث المورد") {
        source.updateSupplier(draft)
        val id = requireNotNull(draft.id)
        state = state.copy(suppliers = source.suppliers(state.query, includeInactive = true), selectedSupplier = source.supplier(id))
    }
    fun requestSupplierActivation(id: Long, name: String, active: Boolean) {
        if (capabilities.canWriteSuppliers) state = state.copy(confirmation = PurchasingConfirmation.SupplierActivation(id, name, active))
    }

    fun createOrder(draft: PurchaseOrderDraft) = launch("order:create", "تم إنشاء أمر الشراء") {
        val result = source.createOrder(draft)
        state = state.copy(orders = source.orders(state.query), selectedOrder = source.order(result.purchaseOrderId))
    }
    fun requestConfirmOrder() {
        val order = state.selectedOrder ?: return
        if (capabilities.canConfirm(order)) state = state.copy(confirmation = PurchasingConfirmation.ConfirmOrder(order.id, order.summary.number))
    }
    fun requestCancelOrder() {
        val order = state.selectedOrder ?: return
        if (capabilities.canCancel(order)) state = state.copy(confirmation = PurchasingConfirmation.CancelOrder(order.id, order.summary.number))
    }
    fun receiveOrder(draft: PurchaseReceiveDraft) = launch("order:receive", "تم تسجيل الاستلام") {
        val order = state.selectedOrder ?: error("اختر أمر الشراء")
        require(capabilities.canReceive(order)) { "الأمر غير قابل للاستلام" }
        source.receiveOrder(draft)
        state = state.copy(selectedOrder = source.order(order.id), orders = source.orders(state.query))
    }
    fun createReturn(draft: PurchaseReturnDraft) = launch("return:create", "تم تسجيل مرتجع الشراء") {
        source.createReturn(draft)
        state = state.copy(returns = source.returns(state.query))
    }

    fun requestSendReminder(item: ReminderQueueItem) {
        if (capabilities.canWriteReminders) state = state.copy(confirmation = PurchasingConfirmation.SendReminder(item))
    }
    fun skipReminder(item: ReminderQueueItem, reason: String, promisedDate: String?) = launch("reminder:skip", "تم تسجيل قرار التذكير") {
        source.skipReminder(item, reason, promisedDate)
        reloadReminders()
    }

    fun dismissConfirmation() { state = state.copy(confirmation = null) }
    fun confirmPending() {
        val pending = state.confirmation ?: return
        when (pending) {
            is PurchasingConfirmation.ConfirmOrder -> launch("order:confirm", "تم اعتماد أمر الشراء") {
                source.confirmOrder(pending.id); reloadOrder(pending.id)
            }
            is PurchasingConfirmation.CancelOrder -> launch("order:cancel", "تم إلغاء أمر الشراء") {
                source.cancelOrder(pending.id); reloadOrder(pending.id)
            }
            is PurchasingConfirmation.SupplierActivation -> launch("supplier:active", if (pending.active) "تم تفعيل المورد" else "تم تعطيل المورد") {
                source.setSupplierActive(pending.id, pending.active)
                state = state.copy(suppliers = source.suppliers(state.query, includeInactive = true), selectedSupplier = source.supplier(pending.id))
            }
            is PurchasingConfirmation.SendReminder -> launch("reminder:send", "تم تنفيذ طلب التذكير") {
                val result = source.sendReminder(pending.item)
                require(result.sent) { result.reason ?: "لم يقبل مزود الرسائل طلب الإرسال" }
                reloadReminders()
            }
        }
    }

    private suspend fun reloadOrder(id: Long) { state = state.copy(orders = source.orders(state.query), selectedOrder = source.order(id)) }
    private suspend fun reloadReminders() {
        val aggregate = capabilities.role == "admin" && capabilities.branchId == null
        state = state.copy(reminderQueue = source.reminderQueue(aggregate), reminderHistory = source.reminderHistory(aggregate))
    }
    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        state = state.start(key) ?: return
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { state = state.succeed(success) }
                .onFailure { state = state.fail(userMessage(it)) }
        }
    }
    private fun userMessage(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class PurchasingViewModelFactory(
    private val source: PurchasingDataSource,
    private val capabilities: PurchasingCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = PurchasingViewModel(source, capabilities) as T
}

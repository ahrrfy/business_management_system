package online.alarabiya.superapp.feature.sales

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.SalesDataSource
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.ReturnSubmission
import online.alarabiya.superapp.model.sales.SaleSubmission
import online.alarabiya.superapp.model.sales.SalesCapabilities
import online.alarabiya.superapp.model.sales.SalesSection
import online.alarabiya.superapp.model.sales.SalesValidation

class SalesViewModel(
    private val source: SalesDataSource,
    private val capabilities: SalesCapabilities,
) : ViewModel() {
    var state by mutableStateOf(SalesUiState(section = firstSection(capabilities)))
        private set

    fun initialize() {
        if (state.locked) return
        state = state.start(SalesBusy.INITIAL) ?: return
        viewModelScope.launch {
            val branchId = capabilities.branchId
            val results = coroutineScope {
                val catalog = async {
                    if (capabilities.canCreateSale && branchId != null) runCatching { source.catalog(branchId, state.priceTier, "", null) } else null
                }
                val sales = async {
                    if (capabilities.canReadSales) runCatching { source.sales(branchId, "") } else null
                }
                val customers = async {
                    if (capabilities.canSearchCustomers) runCatching { source.customers("") } else null
                }
                val shifts = async {
                    if (capabilities.canReadShifts && branchId != null) runCatching { source.openRetailShifts(branchId) } else null
                }
                listOf(catalog.await(), sales.await(), customers.await(), shifts.await())
            }
            @Suppress("UNCHECKED_CAST")
            val catalog = results[0] as Result<List<online.alarabiya.superapp.model.sales.CatalogSaleItem>>?
            @Suppress("UNCHECKED_CAST")
            val sales = results[1] as Result<online.alarabiya.superapp.model.sales.SalesPage>?
            @Suppress("UNCHECKED_CAST")
            val customers = results[2] as Result<List<online.alarabiya.superapp.model.sales.SalesCustomer>>?
            @Suppress("UNCHECKED_CAST")
            val shifts = results[3] as Result<List<online.alarabiya.superapp.model.sales.RetailShift>>?
            val openShifts = shifts?.getOrNull() ?: state.openShifts
            state = state.copy(
                busy = null,
                catalog = catalog?.getOrNull() ?: state.catalog,
                catalogLoaded = catalog?.isSuccess == true,
                salesPage = sales?.getOrNull() ?: state.salesPage,
                customers = customers?.getOrNull() ?: state.customers,
                customersLoaded = customers?.isSuccess == true,
                openShifts = openShifts,
                shiftsLoaded = shifts?.isSuccess == true,
                selectedSaleShiftId = openShifts.firstOrNull { it.userId == capabilities.userId }?.id,
                error = results.firstNotNullOfOrNull { it?.exceptionOrNull() }?.let(::userMessage),
            )
        }
    }

    fun section(value: SalesSection) {
        if (value == SalesSection.CHECKOUT && !capabilities.canCreateSale) return
        if (value == SalesSection.HISTORY && !capabilities.canReadSales) return
        if (value == SalesSection.RETURNS && !capabilities.canCreateReturn) return
        state = state.copy(section = value, error = null, notice = null)
    }

    fun catalogQuery(value: String) { if (!state.locked) state = state.copy(catalogQuery = value.take(120)) }
    fun customerQuery(value: String) { if (!state.locked) state = state.copy(customerQuery = value.take(120)) }
    fun salesQuery(value: String) { if (!state.locked) state = state.copy(salesQuery = value.take(200)) }
    fun quantity(productUnitId: Long, value: String) { if (!state.locked) state = state.quantity(productUnitId, value) }
    fun remove(productUnitId: Long) { if (!state.locked) state = state.remove(productUnitId) }
    fun add(item: online.alarabiya.superapp.model.sales.CatalogSaleItem) { state = state.add(item) }
    fun collectedAmount(value: String) { if (!state.locked) state = state.copy(collectedAmount = value.take(20), error = null) }
    fun paymentReference(value: String) { if (!state.locked) state = state.copy(paymentReference = value.take(100), error = null) }
    fun notes(value: String) { if (!state.locked) state = state.copy(notes = value.take(1_000), error = null) }
    fun paymentMethod(value: PaymentMethod) { if (!state.locked) state = state.copy(paymentMethod = value, error = null) }
    fun returnRefundAmount(value: String) { if (!state.locked) state = state.copy(returnRefundAmount = value.take(20), error = null) }
    fun returnMethod(value: PaymentMethod) { if (!state.locked) state = state.copy(returnMethod = value, error = null) }
    fun returnShift(value: Long?) { if (!state.locked) state = state.copy(returnShiftId = value, error = null) }
    fun returnRestock(value: Boolean) { if (!state.locked) state = state.copy(returnRestock = value, error = null) }

    fun searchCatalog() {
        if (state.locked) return
        state = state.copy(catalog = emptyList(), catalogLoaded = false)
        launch(SalesBusy.CATALOG) {
            val branchId = capabilities.branchId ?: error("لا يوجد فرع فعّال")
            state = state.copy(
                catalog = source.catalog(branchId, state.priceTier, state.catalogQuery, state.selectedCustomer?.id),
                catalogLoaded = true,
            )
        }
    }

    fun searchCustomers() = launch(SalesBusy.CUSTOMER) {
        state = state.copy(customers = source.customers(state.customerQuery), customersLoaded = true)
    }

    fun selectCustomer(customer: online.alarabiya.superapp.model.sales.SalesCustomer?) {
        if (state.locked) return
        state = state.copy(
            selectedCustomer = customer,
            priceTier = customer?.priceTier ?: PriceTier.RETAIL,
            catalog = emptyList(),
            catalogLoaded = false,
            error = null,
        )
        searchCatalog()
    }

    fun searchSales() = launch(SalesBusy.HISTORY) {
        state = state.copy(salesPage = source.sales(capabilities.branchId, state.salesQuery), selectedSale = null)
    }

    fun loadMoreSales() {
        val cursor = state.salesPage.nextCursor ?: return
        launch(SalesBusy.HISTORY) {
            val next = source.sales(capabilities.branchId, state.salesQuery, cursor)
            state = state.copy(salesPage = next.copy(rows = state.salesPage.rows + next.rows))
        }
    }

    fun saleDetail(id: Long) = launch(SalesBusy.DETAIL) {
        state = state.copy(selectedSale = source.sale(id))
    }

    fun closeSale() { state = state.copy(selectedSale = null, error = null) }

    fun submitSale() {
        if (state.locked) return
        val branchId = capabilities.branchId ?: return fail("لا يوجد فرع فعّال للبيع")
        if (!state.checkoutDependenciesLoaded) {
            return fail("لم تكتمل بيانات الكتالوج والوردية بعد. أعد المحاولة بعد اكتمال التحديث.")
        }
        val submission = SaleSubmission(
            branchId = branchId,
            shiftId = if (state.paymentMethod == PaymentMethod.CASH) state.selectedSaleShiftId else null,
            customerId = state.selectedCustomer?.id,
            priceTier = state.priceTier,
            lines = state.cart,
            paymentMethod = state.paymentMethod,
            collectedAmount = state.collectedAmount,
            paymentReference = state.paymentReference,
            notes = state.notes,
            clientRequestId = state.saleRequestId,
        )
        SalesValidation.sale(submission)?.let { return fail(it) }
        val started = state.start(SalesBusy.SALE) ?: return
        state = started
        viewModelScope.launch {
            val result = runCatching { source.createSale(submission) }
                .getOrElse {
                    state = state.failed(userMessage(it))
                    return@launch
                }

            // The server has committed. Rotate the idempotency key and empty the cart before any
            // non-authoritative detail/history refresh can fail.
            state = state.saleCommitted(result, UUID.randomUUID().toString())
            runCatching { source.sale(result.invoiceId) }
                .onSuccess { state = state.saleDetailLoaded(it) }
                .onFailure {
                    state = state.followUpFailed(
                        "تم إنشاء الفاتورة ${result.invoiceNumber}، وتعذر تحديث تفاصيلها الآن.",
                    )
                }
            refreshHistorySilently()
        }
    }

    fun beginReturn(invoiceId: Long) {
        if (!capabilities.canCreateReturn) return
        launch(SalesBusy.RETURN_LOAD) {
            state = state.copy(
                section = SalesSection.RETURNS,
                returnInvoice = source.returnableInvoice(invoiceId),
                returnQuantities = emptyMap(),
                returnRefundAmount = "",
                returnShiftId = null,
            )
        }
    }

    fun returnQuantity(itemId: Long, value: Int) {
        if (state.locked) return
        val invoice = state.returnInvoice ?: return
        val max = invoice.items.firstOrNull { it.invoiceItemId == itemId }?.remaining ?: return
        state = state.copy(returnQuantities = state.returnQuantities + (itemId to value.coerceIn(0, max)), error = null)
    }

    fun submitReturn() {
        if (state.locked) return
        val invoice = state.returnInvoice ?: return fail("اختر فاتورة للمرتجع")
        val submission = ReturnSubmission(
            invoiceId = invoice.id,
            quantities = state.returnQuantities,
            refundAmount = state.returnRefundAmount,
            refundMethod = state.returnMethod,
            refundShiftId = state.returnShiftId,
            restock = state.returnRestock,
            clientRequestId = state.returnRequestId,
        )
        SalesValidation.salesReturn(submission, invoice)?.let { return fail(it) }
        val started = state.start(SalesBusy.RETURN_SUBMIT) ?: return
        state = started
        viewModelScope.launch {
            val result = runCatching { source.createReturn(submission, invoice) }
                .getOrElse {
                    state = state.failed(userMessage(it))
                    return@launch
                }

            // The old remaining-quantity snapshot is no longer valid after this acknowledgement.
            state = state.returnCommitted(result, UUID.randomUUID().toString())
            // إعادةُ التحميل تخصّ **المنفَّذ الجزئيّ** وحده: الطلبُ المعلَّق لم يُغيّر كمّيةً،
            // وإعادةُ تحميله كانت تُظهر نفس المتبقّي فيُعيد الموظّف الإدخال وترتدّ المحاولة.
            if (result is ReturnCreation.Executed && !result.fullyReturned) {
                runCatching { source.returnableInvoice(invoice.id) }
                    .onSuccess { state = state.returnInvoiceReloaded(it) }
                    .onFailure {
                        state = state.followUpFailed(
                            "تم تسجيل المرتجع، وتعذر تحديث الكميات المتبقية الآن.",
                        )
                    }
            }
            refreshHistorySilently()
        }
    }

    private fun launch(work: SalesBusy, operation: suspend () -> Unit) {
        val started = state.start(work) ?: return
        state = started
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = state.copy(busy = null) }
                .onFailure { state = state.failed(userMessage(it)) }
        }
    }

    private suspend fun refreshHistorySilently() {
        if (!capabilities.canReadSales) return
        runCatching { source.sales(capabilities.branchId, state.salesQuery) }
            .onSuccess { state = state.copy(salesPage = it) }
    }

    private fun fail(message: String) { state = state.failed(message) }
    private fun userMessage(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    companion object {
        private fun firstSection(capabilities: SalesCapabilities) = when {
            capabilities.canCreateSale -> SalesSection.CHECKOUT
            capabilities.canReadSales -> SalesSection.HISTORY
            else -> SalesSection.CHECKOUT
        }
    }
}

class SalesViewModelFactory(
    private val source: SalesDataSource,
    private val capabilities: SalesCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = SalesViewModel(source, capabilities) as T
}

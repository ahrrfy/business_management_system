package online.alarabiya.superapp.feature.sales

import java.util.UUID
import online.alarabiya.superapp.model.sales.CartLine
import online.alarabiya.superapp.model.sales.CatalogSaleItem
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.RetailShift
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.ReturnableInvoice
import online.alarabiya.superapp.model.sales.SaleCreation
import online.alarabiya.superapp.model.sales.SaleDetail
import online.alarabiya.superapp.model.sales.SalesCustomer
import online.alarabiya.superapp.model.sales.SalesPage
import online.alarabiya.superapp.model.sales.SalesSection

enum class SalesBusy { INITIAL, CATALOG, CUSTOMER, SALE, HISTORY, DETAIL, RETURN_LOAD, RETURN_SUBMIT }

data class SalesUiState(
    val section: SalesSection = SalesSection.CHECKOUT,
    val busy: SalesBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val catalogQuery: String = "",
    val catalog: List<CatalogSaleItem> = emptyList(),
    val customerQuery: String = "",
    val customers: List<SalesCustomer> = emptyList(),
    val customersLoaded: Boolean = false,
    val selectedCustomer: SalesCustomer? = null,
    val priceTier: PriceTier = PriceTier.RETAIL,
    val openShifts: List<RetailShift> = emptyList(),
    val catalogLoaded: Boolean = false,
    val shiftsLoaded: Boolean = false,
    val selectedSaleShiftId: Long? = null,
    val cart: List<CartLine> = emptyList(),
    val collectedAmount: String = "",
    val paymentMethod: PaymentMethod = PaymentMethod.CASH,
    val paymentReference: String = "",
    val notes: String = "",
    val saleRequestId: String = UUID.randomUUID().toString(),
    val committedSale: SaleCreation? = null,
    val salesQuery: String = "",
    val salesPage: SalesPage = SalesPage(emptyList(), null, false),
    val selectedSale: SaleDetail? = null,
    val returnInvoice: ReturnableInvoice? = null,
    val returnQuantities: Map<Long, Int> = emptyMap(),
    val returnRefundAmount: String = "",
    val returnMethod: PaymentMethod = PaymentMethod.CASH,
    val returnShiftId: Long? = null,
    val returnRestock: Boolean = true,
    val returnRequestId: String = UUID.randomUUID().toString(),
) {
    val locked: Boolean get() = busy != null
    val checkoutDependenciesLoaded: Boolean
        get() = catalogLoaded && (selectedCustomer == null || customersLoaded) &&
            (paymentMethod != PaymentMethod.CASH || shiftsLoaded)

    fun add(item: CatalogSaleItem): SalesUiState {
        if (!item.sellable || locked) return this
        val index = cart.indexOfFirst { it.item.productUnitId == item.productUnitId }
        val next = if (index < 0) cart + CartLine(item) else cart.mapIndexed { position, line ->
            if (position != index) line else line.copy(quantity = increment(line.quantity))
        }
        return copy(cart = next, error = null, notice = null)
    }

    fun quantity(productUnitId: Long, value: String): SalesUiState = copy(
        cart = cart.map { if (it.item.productUnitId == productUnitId) it.copy(quantity = value.take(16)) else it },
        error = null,
        notice = null,
    )

    fun remove(productUnitId: Long): SalesUiState = copy(
        cart = cart.filterNot { it.item.productUnitId == productUnitId },
        error = null,
        notice = null,
    )

    fun start(work: SalesBusy): SalesUiState? = if (locked) null else copy(busy = work, error = null, notice = null)

    fun failed(message: String): SalesUiState = copy(busy = null, error = message, notice = null)

    /** Records the irreversible server acknowledgement before any follow-up query. */
    fun saleCommitted(result: SaleCreation, nextRequestId: String): SalesUiState = copy(
        busy = SalesBusy.DETAIL,
        cart = emptyList(),
        collectedAmount = "",
        paymentReference = "",
        notes = "",
        saleRequestId = nextRequestId,
        committedSale = result,
        selectedSale = null,
        section = SalesSection.HISTORY,
        error = null,
        notice = "تم إنشاء الفاتورة ${result.invoiceNumber}",
    )

    fun saleDetailLoaded(detail: SaleDetail): SalesUiState = copy(
        busy = null,
        selectedSale = detail,
        error = null,
    )

    /** A committed mutation remains committed even when its read-after-write refresh fails. */
    fun followUpFailed(message: String): SalesUiState = copy(busy = null, error = message)

    fun returnCommitted(result: ReturnCreation, nextRequestId: String): SalesUiState = copy(
        busy = if (result.fullyReturned) null else SalesBusy.RETURN_LOAD,
        returnInvoice = null,
        returnQuantities = emptyMap(),
        returnRefundAmount = "",
        returnShiftId = null,
        returnRequestId = nextRequestId,
        error = null,
        notice = "تم تسجيل المرتجع بقيمة ${result.returnedTotal}",
    )

    fun returnInvoiceReloaded(invoice: ReturnableInvoice): SalesUiState = copy(
        busy = null,
        returnInvoice = invoice,
        error = null,
    )

    companion object {
        private fun increment(raw: String): String = ((raw.toDoubleOrNull() ?: 0.0) + 1.0).let {
            if (it % 1.0 == 0.0) it.toLong().toString() else it.toString()
        }
    }
}

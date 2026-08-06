package online.alarabiya.superapp.feature.sales

import java.util.UUID
import online.alarabiya.superapp.model.sales.CartLine
import online.alarabiya.superapp.model.sales.CatalogSaleItem
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.RetailShift
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.ReturnableInvoice
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
    val selectedCustomer: SalesCustomer? = null,
    val priceTier: PriceTier = PriceTier.RETAIL,
    val openShifts: List<RetailShift> = emptyList(),
    val selectedSaleShiftId: Long? = null,
    val cart: List<CartLine> = emptyList(),
    val collectedAmount: String = "",
    val paymentMethod: PaymentMethod = PaymentMethod.CASH,
    val paymentReference: String = "",
    val notes: String = "",
    val saleRequestId: String = UUID.randomUUID().toString(),
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

    fun saleSucceeded(detail: SaleDetail, nextRequestId: String): SalesUiState = copy(
        busy = null,
        cart = emptyList(),
        collectedAmount = "",
        paymentReference = "",
        notes = "",
        saleRequestId = nextRequestId,
        selectedSale = detail,
        section = SalesSection.HISTORY,
        error = null,
        notice = "تم إنشاء الفاتورة ${detail.invoiceNumber}",
    )

    fun returnSucceeded(result: ReturnCreation, nextRequestId: String): SalesUiState = copy(
        busy = null,
        returnQuantities = emptyMap(),
        returnRefundAmount = "",
        returnRequestId = nextRequestId,
        error = null,
        notice = "تم تسجيل المرتجع بقيمة ${result.returnedTotal}",
    )

    companion object {
        private fun increment(raw: String): String = ((raw.toDoubleOrNull() ?: 0.0) + 1.0).let {
            if (it % 1.0 == 0.0) it.toLong().toString() else it.toString()
        }
    }
}

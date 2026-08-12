package online.alarabiya.superapp.model.sales

import online.alarabiya.superapp.model.AppBootstrap

enum class SalesAccess {
    NONE,
    READ,
    FULL,
    ;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL

    companion object {
        fun fromWire(value: String?): SalesAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class SalesCapabilities(
    val sales: SalesAccess,
    val products: SalesAccess,
    val customers: SalesAccess,
    val treasury: SalesAccess,
    val userId: Long,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
) {
    val canCreateSale: Boolean get() = sales.canWrite && products.canRead && branchId != null
    val canReadSales: Boolean get() = sales.canRead
    val canSearchCustomers: Boolean get() = customers.canRead
    val canReadShifts: Boolean get() = treasury.canRead && branchId != null
    val canCreateReturn: Boolean get() = sales.canWrite && (role == "admin" || role == "manager")

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): SalesCapabilities {
            val modules = bootstrap.modules.associate { it.key to SalesAccess.fromWire(it.access) }
            return SalesCapabilities(
                sales = modules["sales"] ?: SalesAccess.NONE,
                products = modules["products"] ?: SalesAccess.NONE,
                customers = modules["customers"] ?: modules["crm"] ?: SalesAccess.NONE,
                treasury = modules["treasury"] ?: SalesAccess.NONE,
                userId = bootstrap.user.id,
                role = bootstrap.user.role,
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
            )
        }
    }
}

enum class SalesSection { CHECKOUT, HISTORY, RETURNS }
enum class PriceTier { RETAIL, WHOLESALE, GOVERNMENT }
enum class PaymentMethod { CASH, CARD, CHECK, TRANSFER, WALLET }

data class CatalogSaleItem(
    val productId: Long,
    val productName: String,
    val variantId: Long,
    val variantName: String?,
    val color: String?,
    val size: String?,
    val sku: String,
    val productUnitId: Long,
    val unitName: String,
    val conversionFactor: String,
    val barcode: String?,
    val serverPrice: String?,
    val availableBase: Int,
    val openedAt: String?,
    val isService: Boolean,
    val isBundle: Boolean,
    val isContractPrice: Boolean,
    val promotionName: String?,
) {
    val label: String get() = listOfNotNull(productName, variantName, unitName).joinToString(" · ")
    val sellable: Boolean get() = serverPrice != null
}

data class SalesCustomer(
    val id: Long,
    val name: String,
    val phone: String?,
    val priceTier: PriceTier,
)

data class RetailShift(
    val id: Long,
    val branchId: Long,
    val userId: Long,
    val userName: String?,
    val status: String,
    val openedAt: String?,
)

data class CartLine(
    val item: CatalogSaleItem,
    val quantity: String = "1",
)

data class SaleSubmission(
    val branchId: Long,
    val shiftId: Long?,
    val customerId: Long?,
    val priceTier: PriceTier,
    val lines: List<CartLine>,
    val paymentMethod: PaymentMethod,
    val collectedAmount: String,
    val paymentReference: String,
    val notes: String,
    val clientRequestId: String,
)

data class SaleCreation(
    val invoiceId: Long,
    val invoiceNumber: String,
    val total: String,
    val status: String,
    val idempotentReplay: Boolean,
)

data class SaleSummary(
    val id: Long,
    val invoiceNumber: String,
    val invoiceDate: String?,
    val total: String,
    val paidAmount: String,
    val returnedTotal: String,
    val status: String,
    val paymentMethod: String?,
    val customerName: String?,
    val salespersonName: String?,
    val branchId: Long,
    val shiftId: Long?,
)

data class SalesPage(
    val rows: List<SaleSummary>,
    val nextCursor: Long?,
    val hasMore: Boolean,
)

data class SaleLine(
    val id: Long,
    val productName: String,
    val variantName: String?,
    val unitName: String?,
    val sku: String?,
    val quantity: String,
    val baseQuantity: Int,
    val returnedBaseQuantity: Int,
    val unitPrice: String,
    val discountAmount: String,
    val total: String,
)

data class SalePayment(
    val id: Long,
    val direction: String,
    val amount: String,
    val paymentMethod: String,
    val status: String,
    val createdAt: String?,
    val referenceNumber: String?,
)

data class SaleReturnEntry(
    val id: Long,
    val amount: String,
    val performedByName: String?,
    val createdAt: String?,
)

data class SaleDetail(
    val id: Long,
    val invoiceNumber: String,
    val branchId: Long,
    val customerName: String?,
    val invoiceDate: String?,
    val subtotal: String,
    val discountAmount: String,
    val taxAmount: String,
    val total: String,
    val paidAmount: String,
    val returnedTotal: String,
    val status: String,
    val paymentMethod: String?,
    val notes: String?,
    val items: List<SaleLine>,
    val payments: List<SalePayment>,
    val returns: List<SaleReturnEntry>,
)

data class ReturnableLine(
    val invoiceItemId: Long,
    val productName: String,
    val variantLabel: String?,
    val unitName: String,
    val baseQuantity: Int,
    val returnedBaseQuantity: Int,
    val remaining: Int,
    val unitPrice: String,
    val total: String,
)

data class ReturnableInvoice(
    val id: Long,
    val invoiceNumber: String,
    val branchId: Long,
    val customerName: String?,
    val total: String,
    val paidAmount: String,
    val status: String,
    val paymentMethod: String?,
    val items: List<ReturnableLine>,
)

data class ReturnSubmission(
    val invoiceId: Long,
    val quantities: Map<Long, Int>,
    val refundAmount: String,
    val refundMethod: PaymentMethod,
    val refundShiftId: Long?,
    val restock: Boolean,
    val clientRequestId: String,
)

data class ReturnCreation(
    val invoiceId: Long,
    val returnedTotal: String,
    val fullyReturned: Boolean,
    val idempotentReplay: Boolean,
)

object SalesValidation {
    private val quantity = Regex("^\\d+(\\.\\d{1,3})?$")
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")

    fun sale(submission: SaleSubmission): String? {
        if (submission.branchId <= 0) return "لا يوجد فرع صالح للبيع"
        if (submission.lines.isEmpty()) return "أضف صنفاً واحداً على الأقل"
        submission.lines.forEach { line ->
            if (!line.item.sellable) return "أحد الأصناف بلا سعر خادمي معتمد"
            if (!quantity.matches(line.quantity) || line.quantity.toDoubleOrNull()?.let { it <= 0 || it > 1_000_000 } != false) {
                return "كمية أحد الأصناف غير صالحة"
            }
        }
        if (!money.matches(submission.collectedAmount) || submission.collectedAmount.toDoubleOrNull()?.let { it <= 0 } != false) {
            return "أدخل مبلغ التحصيل كما ظهر في وسيلة الدفع"
        }
        if (submission.paymentMethod == PaymentMethod.CASH && submission.shiftId == null) return "يلزم فتح وردية نقدية قبل البيع النقدي"
        if (submission.paymentMethod != PaymentMethod.CASH && submission.paymentReference.trim().isEmpty()) {
            return "مرجع البطاقة أو التحويل مطلوب"
        }
        if (submission.clientRequestId.length !in 8..80) return "مفتاح أمان الطلب غير صالح"
        return null
    }

    fun salesReturn(submission: ReturnSubmission, invoice: ReturnableInvoice): String? {
        if (submission.invoiceId != invoice.id) return "الفاتورة المختارة لا تطابق طلب المرتجع"
        val selected = submission.quantities.filterValues { it > 0 }
        if (selected.isEmpty()) return "حدد كمية مرتجعة لصنف واحد على الأقل"
        selected.forEach { (itemId, qty) ->
            val line = invoice.items.firstOrNull { it.invoiceItemId == itemId } ?: return "بند المرتجع لا يتبع الفاتورة"
            if (qty > line.remaining) return "كمية المرتجع تتجاوز المتبقي القابل للإرجاع"
        }
        if (submission.refundAmount.isNotBlank()) {
            if (!money.matches(submission.refundAmount)) return "مبلغ الاسترداد غير صالح"
            if (submission.refundAmount.toDoubleOrNull()?.let { it < 0 } != false) return "مبلغ الاسترداد غير صالح"
            if (submission.refundAmount.toDoubleOrNull()?.let { it > 0 } == true &&
                submission.refundMethod == PaymentMethod.CASH && submission.refundShiftId == null
            ) return "اختر وردية الدرج الذي سيخرج منه الاسترداد النقدي"
        }
        if (submission.clientRequestId.length !in 8..80) return "مفتاح أمان المرتجع غير صالح"
        return null
    }
}

object NativeSalesContractGaps {
    const val AUTHORITATIVE_PREVIEW =
        "sales exposes create but no side-effect-free preview contract; native cannot claim an authoritative cart total, tax, promotion, or change before committing the invoice."
    const val RETURN_PREVIEW =
        "returns.getInvoice exposes remaining quantities but no proportional return/refund preview; the authoritative returnedTotal exists only after returns.create."
    const val RETURN_CAPABILITY =
        "superApp bootstrap exposes resolved sales READ/FULL but not whether FULL is an explicit grant required by the narrower salesManagerProcedure; native limits returns to admin/manager until the BFF exposes an operation capability."
}

package online.alarabiya.superapp.model.purchasing

import java.util.UUID
import online.alarabiya.superapp.model.AppBootstrap

enum class PurchasingSection { ORDERS, SUPPLIERS, RETURNS, REMINDERS }
enum class PurchaseStatus { DRAFT, SENT, CONFIRMED, RECEIVED, CANCELLED, UNKNOWN }
enum class SupplierKind { REGULAR, CONSIGNOR, UNKNOWN }
enum class PaymentMethod { CASH, CARD, CHECK, TRANSFER, WALLET }
enum class ReturnSettlement { CASH, CREDIT }
enum class Currency { IQD, USD }

enum class PurchasingAccess {
    NONE, READ, FULL;
    val canRead get() = this != NONE
    val canWrite get() = this == FULL

    companion object {
        fun fromWire(value: String?): PurchasingAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class PurchasingCapabilities(
    val purchases: PurchasingAccess,
    val suppliers: PurchasingAccess,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
) {
    val canReadOrders get() = purchases.canRead
    val canWriteOrders get() = purchases.canWrite && (branchId != null || role == "admin")
    val canReadSuppliers get() = suppliers.canRead
    val canWriteSuppliers get() = suppliers.canWrite && role in setOf("admin", "manager", "purchasing", "warehouse")
    val canSetOpeningBalanceOnCreate get() = canWriteSuppliers
    val canEditOpeningBalance get() = canWriteSuppliers && role in setOf("admin", "manager")
    val canReadReturns get() = purchases.canWrite
    val canWriteReturns get() = canReadReturns && (branchId != null || role == "admin")
    val canReadReminders get() = suppliers.canWrite && role in setOf("admin", "manager", "purchasing", "warehouse")
    val canWriteReminders get() = canReadReminders && branchId != null
    val visibleSections: List<PurchasingSection>
        get() = buildList {
            if (canReadOrders) add(PurchasingSection.ORDERS)
            if (canReadSuppliers) add(PurchasingSection.SUPPLIERS)
            if (canReadReturns) add(PurchasingSection.RETURNS)
            if (canReadReminders) add(PurchasingSection.REMINDERS)
        }

    fun canConfirm(order: PurchaseOrderDetail) = canWriteOrders && order.status in setOf(PurchaseStatus.DRAFT, PurchaseStatus.SENT, PurchaseStatus.CONFIRMED)
    fun canCancel(order: PurchaseOrderDetail) = canWriteOrders && branchId != null && order.status in setOf(PurchaseStatus.DRAFT, PurchaseStatus.SENT, PurchaseStatus.CONFIRMED)

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap) = PurchasingCapabilities(
            purchases = PurchasingAccess.fromWire(bootstrap.modules.firstOrNull { it.key == "purchases" }?.access),
            suppliers = PurchasingAccess.fromWire(bootstrap.modules.firstOrNull { it.key == "suppliers" }?.access),
            role = bootstrap.user.role,
            branchId = bootstrap.branchId,
            allBranches = bootstrap.allBranches,
        )
    }
}

data class SupplierSummary(
    val id: Long,
    val name: String,
    val phone: String?,
    val whatsapp: String?,
    val city: String?,
    val paymentTerms: String?,
    val currentBalance: String?,
    val currentBalanceUsd: String?,
    val legacyCode: String?,
    val kind: SupplierKind,
    val active: Boolean,
)

data class SupplierDetail(
    val summary: SupplierSummary,
    val email: String?,
    val address: String?,
    val taxId: String?,
    val productTypes: String?,
    val category: String?,
    val leadTimeDays: Int?,
    val minimumOrderAmount: String?,
    val rating: String?,
    val iban: String?,
    val bankName: String?,
    val notes: String?,
    val openingBalance: String?,
)

data class SupplierPage(val rows: List<SupplierSummary>, val total: Int)

data class PurchaseCatalogItem(
    val productId: Long,
    val productName: String,
    val variantId: Long,
    val variantName: String?,
    val sku: String,
    val productUnitId: Long,
    val unitName: String,
    val conversionFactor: String,
    val baseUnit: Boolean,
    val costPriceBase: String,
    val stockBase: Int,
) {
    val label get() = listOfNotNull(productName, variantName, unitName).joinToString(" · ")
}

data class PurchaseOrderSummary(
    val id: Long,
    val number: String,
    val orderDate: String?,
    val supplierId: Long,
    val supplierName: String?,
    val branchId: Long,
    val total: String?,
    val paidAmount: String?,
    val shippingCost: String?,
    val customsCost: String?,
    val agreedCurrency: Currency,
    val usdTotal: String?,
    val paidUsd: String?,
    val returnedUsd: String?,
    val agreedRate: String?,
    val status: PurchaseStatus,
)

data class PurchaseOrderLine(
    val id: Long,
    val variantId: Long,
    val productUnitId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String?,
    val unitName: String?,
    val quantity: String,
    val baseQuantity: Int,
    val receivedBaseQuantity: Int,
    val unitPrice: String?,
    val total: String?,
    val usdUnitPrice: String?,
    val usdTotal: String?,
) {
    val remainingBaseQuantity get() = (baseQuantity - receivedBaseQuantity).coerceAtLeast(0)
}

data class PurchaseOrderDetail(
    val summary: PurchaseOrderSummary,
    val subtotal: String?,
    val taxAmount: String?,
    val taxRatePercent: String?,
    val notes: String?,
    val lines: List<PurchaseOrderLine>,
) {
    val id get() = summary.id
    val status get() = summary.status
}

data class PurchaseOrderDraftLine(
    val variantId: Long = 0,
    val productUnitId: Long = 0,
    val quantity: String = "",
    val unitPrice: String = "",
)

data class PurchaseOrderDraft(
    val supplierId: Long = 0,
    val branchId: Long? = null,
    val taxRatePercent: String = "0",
    val status: PurchaseStatus = PurchaseStatus.CONFIRMED,
    val items: List<PurchaseOrderDraftLine> = listOf(PurchaseOrderDraftLine()),
    val notes: String = "",
    val currency: Currency = Currency.IQD,
    val usdTotal: String = "",
    val agreedRate: String = "",
    val shippingCost: String = "0",
    val customsCost: String = "0",
    val shippingPaymentMethod: String = "CASH",
    val shippingPaymentReference: String = "",
    val shippingCardLastFour: String = "",
    val shippingBeneficiaryName: String = "",
    val shippingEvidenceReference: String = "",
    val clientRequestId: String = UUID.randomUUID().toString(),
)

data class PurchaseReturnSummary(
    val id: Long,
    val date: String?,
    val supplierId: Long,
    val branchId: Long,
    val purchaseOrderId: Long?,
    val amount: String,
    val notes: String?,
)
data class PurchaseReturnPage(val rows: List<PurchaseReturnSummary>, val total: Int)
data class PurchaseReturnLineDraft(val variantId: Long = 0, val productUnitId: Long = 0, val quantity: String = "", val unitPrice: String = "")
data class PurchaseReturnDraft(
    val supplierId: Long = 0,
    val branchId: Long? = null,
    val purchaseOrderRefId: Long? = null,
    val items: List<PurchaseReturnLineDraft> = listOf(PurchaseReturnLineDraft()),
    val reason: String = "",
    val paymentMethod: PaymentMethod? = null,
    val settlement: ReturnSettlement = ReturnSettlement.CREDIT,
    val clientRequestId: String = UUID.randomUUID().toString(),
)

data class ReminderQueueItem(
    val supplierId: Long,
    val supplierName: String,
    val phone: String?,
    val totalUnpaid: String,
    val oldestPoDate: String,
    val daysOverdue: Int,
    val lastReminderAt: String?,
    val lastStatus: String?,
    val promisedDate: String?,
    val promiseDue: Boolean,
)
data class ReminderHistoryItem(
    val id: Long,
    val supplierId: Long,
    val supplierName: String,
    val totalUnpaidSnapshot: String,
    val daysOverdue: Int,
    val status: String,
    val skipReason: String?,
    val promisedDate: String?,
    val createdBy: Long?,
    val createdAt: String?,
)

data class SupplierDraft(
    val id: Long? = null,
    val name: String = "",
    val phone: String = "",
    val email: String = "",
    val whatsapp: String = "",
    val address: String = "",
    val city: String = "",
    val paymentTerms: String = "",
    val category: String = "",
    val notes: String = "",
    val kind: SupplierKind = SupplierKind.REGULAR,
    val openingBalance: String = "",
    val openingDirection: String = "OWED_BY_US",
    val clientRequestId: String = UUID.randomUUID().toString(),
)

object PurchasingValidation {
    private val money = Regex("^(0|[1-9]\\d*)(\\.\\d{1,4})?$")
    private val ymd = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun money(value: String, positive: Boolean = false): Boolean {
        val normalized = value.trim()
        if (!money.matches(normalized)) return false
        return !positive || normalized.any { it in '1'..'9' }
    }

    fun supplier(draft: SupplierDraft, canEditOpeningBalance: Boolean): String? = when {
        draft.name.trim().isEmpty() -> "اسم المورد مطلوب"
        draft.name.length > 255 -> "اسم المورد أطول من الحد المسموح"
        draft.clientRequestId.length !in 8..64 -> "مفتاح الطلب غير صالح"
        draft.openingBalance.isNotBlank() && !canEditOpeningBalance -> "الرصيد الافتتاحي متاح للمدير فقط"
        draft.openingBalance.isNotBlank() && !money(draft.openingBalance) -> "الرصيد الافتتاحي غير صالح"
        else -> null
    }

    fun order(draft: PurchaseOrderDraft, expectedBranchId: Long?): String? {
        val hasShipping = (draft.shippingCost.toBigDecimalOrNull()?.signum() ?: 0) > 0 ||
            (draft.customsCost.toBigDecimalOrNull()?.signum() ?: 0) > 0
        return when {
        draft.supplierId <= 0 -> "اختر المورد"
        draft.branchId == null || draft.branchId <= 0 -> "حدد الفرع"
        expectedBranchId != null && draft.branchId != expectedBranchId -> "لا يمكن إنشاء أمر لفرع آخر"
        draft.items.isEmpty() -> "أضف بنداً واحداً على الأقل"
        draft.items.any { it.variantId <= 0 || it.productUnitId <= 0 } -> "بيانات الصنف أو الوحدة غير مكتملة"
        draft.items.any { !money(it.quantity, true) || !money(it.unitPrice) } -> "الكمية أو سعر الوحدة غير صالح"
        !money(draft.taxRatePercent) || draft.taxRatePercent.toBigDecimalOrNull()?.let { it > 100.toBigDecimal() } != false -> "نسبة الضريبة يجب أن تكون بين صفر و100"
        !money(draft.shippingCost) || !money(draft.customsCost) -> "تكلفة الشحن أو الجمارك غير صالحة"
        hasShipping && draft.shippingPaymentMethod !in setOf("CASH", "CARD", "CHECK", "TRANSFER", "WALLET") -> "طريقة تسوية الشحن غير صالحة"
        hasShipping && draft.shippingPaymentMethod in setOf("TRANSFER", "CHECK") && draft.shippingPaymentReference.isBlank() -> "مرجع تحويل/صك الشحن مطلوب"
        hasShipping && draft.shippingPaymentMethod == "CARD" && !draft.shippingCardLastFour.matches(Regex("^[0-9]{4}$")) -> "آخر أربعة أرقام لبطاقة الشحن مطلوبة"
        hasShipping && draft.shippingBeneficiaryName.isNotBlank() && draft.shippingBeneficiaryName.trim().length < 2 -> "اسم الناقل قصير"
        hasShipping && draft.shippingEvidenceReference.isNotBlank() && draft.shippingEvidenceReference.trim().length < 2 -> "مرجع مستند الشحن قصير"
        draft.currency == Currency.USD && (!money(draft.usdTotal, true) || !money(draft.agreedRate, true)) -> "إجمالي الدولار وسعر الاتفاق مطلوبان"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
        }
    }

    fun purchaseReturn(draft: PurchaseReturnDraft, expectedBranchId: Long?): String? = when {
        draft.supplierId <= 0 -> "اختر المورد"
        draft.branchId == null || draft.branchId <= 0 -> "حدد الفرع"
        expectedBranchId != null && draft.branchId != expectedBranchId -> "لا يمكن إنشاء مرتجع لفرع آخر"
        draft.items.isEmpty() -> "أضف بنداً واحداً على الأقل"
        draft.items.any { it.variantId <= 0 || it.productUnitId <= 0 || !money(it.quantity, true) || !money(it.unitPrice) } -> "بيانات بند المرتجع غير صالحة"
        draft.settlement == ReturnSettlement.CASH && draft.purchaseOrderRefId == null -> "الاسترداد النقدي يتطلب ربط أمر الشراء"
        draft.settlement == ReturnSettlement.CASH && draft.paymentMethod != PaymentMethod.CASH -> "الاسترداد النقدي يقبل طريقة CASH فقط"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
    }

    fun reminderDate(value: String) = ymd.matches(value)
}

object NativePurchasingContractGaps {
    const val PURCHASE_EDIT = "لا يوفر الخادم إجراء تحديث أمر شراء؛ التطبيق لا يوهم المستخدم بإمكانية التعديل."
    const val RETURN_DETAIL = "لا يوفر الخادم تفاصيل مرتجع منفرد؛ المتاح قائمة موثقة فقط."
    const val RETURN_SUPPLIER_NAME = "قائمة المرتجعات لا تعيد اسم المورد رغم استخدامه في البحث."
    const val NON_IDEMPOTENT_TRANSITIONS = "تأكيد/إلغاء الأمر وتحديث المورد وتسجيل التذكير لا تقبل clientRequestId؛ يمنع العميل التكرار ولا يعيد المحاولة تلقائياً."
    const val SUPPLIER_BRANCH = "إنشاء المورد لا يقبل branchId ويستخدم الخادم فرع الجلسة أو القيمة 1؛ يجب إصلاح العقد قبل تمكين إنشاء مورد لحساب بلا فرع."
    const val CATALOG_BRANCH_REQUIRED = "catalog.forPurchase يتطلب فرعاً صريحاً؛ لا يُعرض منتقي الأصناف لحساب مرتفع بلا فرع حتى يحدد الفرع في المحرر."
}

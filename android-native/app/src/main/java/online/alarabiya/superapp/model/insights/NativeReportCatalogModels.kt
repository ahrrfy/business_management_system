package online.alarabiya.superapp.model.insights

import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** Native, permission-scoped reports exposed inside the Insights workspace. */
enum class ReportCatalogKind(
    val label: String,
    val subtitle: String,
    val supportsSearch: Boolean = false,
    val requiresVariant: Boolean = false,
    val supportsServerPagination: Boolean = false,
) {
    DAY_CLOSE("إقفال اليوم", "مطابقة الورديات والنقد"),
    CASH_ORPHANS("العمليات النقدية", "الخزينة والعمليات غير المرتبطة بورديات"),
    SALES_REGISTER("سجل المبيعات", "بنود الفواتير والإيراد والربح", supportsSearch = true, supportsServerPagination = true),
    INVENTORY_VALUATION("تقييم المخزون", "قيمة المخزون بالتكلفة حسب الفئة"),
    ITEM_LEDGER("دفتر الصنف", "حركات الصنف والرصيد المتحرك", requiresVariant = true, supportsServerPagination = true),
    PURCHASE_REGISTER("سجل المشتريات", "بنود أوامر الشراء وقيمتها", supportsSearch = true, supportsServerPagination = true),
    PRODUCTION("الإنتاج", "تكلفة مستندات الإنتاج المؤكدة"),
    WORK_ORDERS("أوامر الشغل", "الحالات والقنوات وربحية المسلّم"),
}

enum class CashOrphanCategory(val label: String, val wireValue: String?) {
    ALL("الكل", null),
    TRUE_ORPHAN("تحتاج فحصاً", "TRUE_ORPHAN"),
    TREASURY("الخزينة", "TREASURY"),
}

data class ReportCatalogQuery(
    val kind: ReportCatalogKind,
    val range: InsightDateRange,
    val branchId: Long?,
    val search: String = "",
    val variantId: Long? = null,
    val orphanCategory: CashOrphanCategory = CashOrphanCategory.ALL,
    val page: Int = 0,
    val pageSize: Int = DEFAULT_REPORT_PAGE_SIZE,
) {
    val offset: Int get() = page * pageSize

    fun validationError(): String? {
        val maxDays = if (kind == ReportCatalogKind.PRODUCTION) 31L else 366L
        range.validationError(maxDays)?.let { return it }
        if (branchId != null && branchId <= 0L) return "معرّف الفرع غير صالح"
        if (search.length > 200) return "عبارة البحث طويلة جداً"
        if (page < 0) return "رقم الصفحة غير صالح"
        if (pageSize !in 10..50) return "حجم الصفحة غير صالح"
        if (kind.requiresVariant && (variantId == null || variantId <= 0L)) return "أدخل معرّف متغيّر الصنف"
        if (!kind.supportsServerPagination && kind != ReportCatalogKind.PRODUCTION && page != 0) {
            return "هذا التقرير لا يدعم صفحة إضافية"
        }
        return null
    }

    fun fingerprint(): String = listOf(
        kind.name,
        range.from,
        range.to,
        branchId?.toString().orEmpty(),
        search.trim(),
        variantId?.toString().orEmpty(),
        orphanCategory.name,
        page.toString(),
        pageSize.toString(),
    ).joinToString("|")

    companion object {
        fun productionRangeIsBounded(range: InsightDateRange): Boolean {
            val from = runCatching { LocalDate.parse(range.from) }.getOrNull() ?: return false
            val to = runCatching { LocalDate.parse(range.to) }.getOrNull() ?: return false
            return ChronoUnit.DAYS.between(from, to) + 1 <= 31
        }
    }
}

const val DEFAULT_REPORT_PAGE_SIZE = 25

data class ReportPageInfo(
    val page: Int,
    val pageSize: Int,
    val total: Int,
    val hasPrevious: Boolean,
    val hasNext: Boolean,
    /** True when the endpoint can only return a bounded first window and exposes no cursor/offset. */
    val serverWindowLimited: Boolean = false,
)

sealed interface ReportCatalogResult {
    val kind: ReportCatalogKind
    val isEmpty: Boolean
    val pageInfo: ReportPageInfo?
}

data class DayCloseShiftInsight(
    val shiftId: Long,
    val branchName: String?,
    val userName: String?,
    val shiftType: String,
    val status: String,
    val openedAt: String,
    val closedAt: String?,
    val expected: InsightMoney,
    val counted: InsightMoney?,
    val drift: InsightMoney?,
    val cashIn: InsightMoney,
    val operatingOut: InsightMoney,
    val handovers: InsightMoney,
)

data class DayCloseTotalsInsight(
    val shiftCount: Int,
    val openCount: Int,
    val closedCount: Int,
    val expected: InsightMoney,
    val counted: InsightMoney,
    val drift: InsightMoney,
    val cashIn: InsightMoney,
    val operatingOut: InsightMoney,
    val handovers: InsightMoney,
)

data class DayCloseDiscountInsight(
    val userName: String,
    val invoiceCount: Int,
    val manualDiscount: InsightMoney,
    val averageRate: PercentText,
)

data class DayCloseReportInsight(
    val date: String,
    val totals: DayCloseTotalsInsight,
    val balancedCount: Int,
    val overCount: Int,
    val shortCount: Int,
    val fundedDraftCount: Int,
    val fundedDraftAmount: InsightMoney,
    val discounts: List<DayCloseDiscountInsight>,
    val shifts: List<DayCloseShiftInsight>,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.DAY_CLOSE
    override val isEmpty: Boolean get() = shifts.isEmpty() && fundedDraftCount == 0 && discounts.isEmpty()
    override val pageInfo: ReportPageInfo? = null
}

data class CashOrphanRowInsight(
    val receiptId: Long,
    val branchName: String?,
    val direction: String,
    val amount: InsightMoney,
    val category: CashOrphanCategory,
    val source: String,
    val reference: String?,
    val description: String?,
    val createdAt: String,
    val createdBy: String?,
)

data class CashOrphansReportInsight(
    val count: Int,
    val totalIn: InsightMoney,
    val totalOut: InsightMoney,
    val net: InsightMoney,
    val treasuryCount: Int,
    val trueOrphanCount: Int,
    val trueOrphanNet: InsightMoney,
    val rows: List<CashOrphanRowInsight>,
    override val pageInfo: ReportPageInfo,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.CASH_ORPHANS
    override val isEmpty: Boolean get() = rows.isEmpty()
}

data class SalesRegisterRowInsight(
    val id: Long,
    val invoiceId: Long,
    val invoiceNumber: String,
    val date: String,
    val customerName: String?,
    val productName: String,
    val quantity: String,
    val unitPrice: InsightMoney,
    val total: InsightMoney,
    val profit: InsightMoney,
)

data class SalesRegisterReportInsight(
    val revenue: InsightMoney,
    val cost: InsightMoney,
    val profit: InsightMoney,
    val quantity: String,
    val rows: List<SalesRegisterRowInsight>,
    override val pageInfo: ReportPageInfo,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.SALES_REGISTER
    override val isEmpty: Boolean get() = rows.isEmpty()
}

data class InventoryValuationRowInsight(
    val categoryId: Long?,
    val categoryName: String,
    val items: Int,
    val quantity: Int,
    val value: InsightMoney,
)

data class InventoryValuationTotalsInsight(val items: Int, val quantity: Int, val value: InsightMoney)

data class InventoryValuationReportInsight(
    val totals: InventoryValuationTotalsInsight,
    val consignment: InventoryValuationTotalsInsight,
    val rows: List<InventoryValuationRowInsight>,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.INVENTORY_VALUATION
    override val isEmpty: Boolean get() = rows.isEmpty() && consignment.items == 0
    override val pageInfo: ReportPageInfo? = null
}

data class ItemLedgerVariantInsight(val id: Long, val productName: String, val label: String, val sku: String)

data class ItemLedgerRowInsight(
    val id: Long,
    val date: String,
    val type: String,
    val signedQuantity: Int,
    val balance: Int,
    val reference: String?,
)

data class ItemLedgerReportInsight(
    val variant: ItemLedgerVariantInsight?,
    val openingBalance: Int,
    val closingBalance: Int,
    val rows: List<ItemLedgerRowInsight>,
    override val pageInfo: ReportPageInfo,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.ITEM_LEDGER
    override val isEmpty: Boolean get() = rows.isEmpty()
}

data class PurchaseRegisterRowInsight(
    val id: Long,
    val purchaseOrderId: Long,
    val purchaseOrderNumber: String?,
    val date: String,
    val supplierName: String?,
    val productName: String?,
    val quantity: String,
    val unitPrice: InsightMoney,
    val total: InsightMoney,
)

data class PurchaseRegisterReportInsight(
    val amount: InsightMoney,
    val rows: List<PurchaseRegisterRowInsight>,
    override val pageInfo: ReportPageInfo,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.PURCHASE_REGISTER
    override val isEmpty: Boolean get() = rows.isEmpty()
}

data class ProductionRowInsight(
    val id: Long,
    val documentNumber: String?,
    val date: String,
    val branchName: String?,
    val inputsCost: InsightMoney,
    val laborCost: InsightMoney,
    val wasteCost: InsightMoney,
    val totalCost: InsightMoney,
)

data class ProductionReportInsight(
    val count: Int,
    val inputsCost: InsightMoney,
    val laborCost: InsightMoney,
    val wasteCost: InsightMoney,
    val totalCost: InsightMoney,
    val rows: List<ProductionRowInsight>,
    override val pageInfo: ReportPageInfo,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.PRODUCTION
    override val isEmpty: Boolean get() = rows.isEmpty()
}

data class WorkOrderCountInsight(val key: String, val label: String, val count: Int)

data class WorkOrdersReportInsight(
    val deliveredCount: Int,
    val revenue: InsightMoney,
    val materials: InsightMoney,
    val labor: InsightMoney,
    val grossProfit: InsightMoney,
    val statusDistribution: List<WorkOrderCountInsight>,
    val channelDistribution: List<WorkOrderCountInsight>,
) : ReportCatalogResult {
    override val kind = ReportCatalogKind.WORK_ORDERS
    override val isEmpty: Boolean
        get() = statusDistribution.sumOf { it.count } == 0 && channelDistribution.sumOf { it.count } == 0
    override val pageInfo: ReportPageInfo? = null
}

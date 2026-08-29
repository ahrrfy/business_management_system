package online.alarabiya.superapp.model.insights

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import online.alarabiya.superapp.core.time.baghdadToday
import java.time.temporal.ChronoUnit
import online.alarabiya.superapp.model.AppBootstrap

@JvmInline
value class InsightMoney private constructor(val value: String) {
    companion object {
        fun fromServer(raw: String?): InsightMoney = runCatching {
            InsightMoney(
                BigDecimal(raw?.trim().orEmpty().ifBlank { "0" })
                    .setScale(2, RoundingMode.HALF_UP)
                    .toPlainString(),
            )
        }.getOrElse { InsightMoney("0.00") }
    }
}

@JvmInline
value class PercentText private constructor(val value: String) {
    companion object {
        fun fromPercent(raw: String?): PercentText = runCatching {
            PercentText(
                BigDecimal(raw?.trim().orEmpty().ifBlank { "0" })
                    .setScale(1, RoundingMode.HALF_UP)
                    .toPlainString(),
            )
        }.getOrElse { PercentText("0.0") }

        fun fromFraction(raw: String?): PercentText = runCatching {
            PercentText(
                BigDecimal(raw?.trim().orEmpty().ifBlank { "0" })
                    .multiply(BigDecimal("100"))
                    .setScale(1, RoundingMode.HALF_UP)
                    .toPlainString(),
            )
        }.getOrElse { PercentText("0.0") }
    }
}

enum class InsightsSection(val label: String) {
    REPORTS("مؤشرات الإدارة"),
    REPORT_CATALOG("كتالوج التقارير"),
    FINANCIAL("التقارير المالية"),
    HR_REPORTS("الحضور والرواتب"),
    STORE("تحليلات المتجر"),
    SEARCH("البحث العام"),
}

enum class PeriodPreset(val label: String, val days: Long?) {
    LAST_7("7 أيام", 7),
    LAST_30("30 يوماً", 30),
    LAST_90("90 يوماً", 90),
    CUSTOM("مخصص", null),
}

data class InsightDateRange(val from: String, val to: String) {
    fun validationError(maxInclusiveDays: Long = 366): String? {
        val start = runCatching { LocalDate.parse(from) }.getOrNull() ?: return "تاريخ البداية غير صالح"
        val end = runCatching { LocalDate.parse(to) }.getOrNull() ?: return "تاريخ النهاية غير صالح"
        if (end < start) return "تاريخ النهاية أقدم من البداية"
        if (ChronoUnit.DAYS.between(start, end) + 1 > maxInclusiveDays) return "الفترة أطول من الحد المسموح"
        return null
    }

    companion object {
        fun forPreset(preset: PeriodPreset, today: LocalDate = baghdadToday()): InsightDateRange {
            val days = preset.days ?: 30
            return InsightDateRange(today.minusDays(days - 1), today)
        }
    }

    constructor(from: LocalDate, to: LocalDate) : this(from.toString(), to.toString())
}

data class InsightsFilter(
    val preset: PeriodPreset = PeriodPreset.LAST_30,
    val range: InsightDateRange = InsightDateRange.forPreset(PeriodPreset.LAST_30),
    val branchId: String = "",
    val rankBy: String = "revenue",
) {
    fun validationError(forStore: Boolean): String? {
        val dateError = range.validationError(if (forStore) 92 else 366)
        if (dateError != null) return dateError
        if (branchId.isNotBlank() && branchId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفرع غير صالح"
        if (rankBy !in setOf("revenue", "qty")) return "أسلوب الترتيب غير صالح"
        return null
    }
}

enum class AlertSeverity { CRITICAL, WARNING, INFO }

data class ManagementAlert(
    val key: String,
    val severity: AlertSeverity,
    val title: String,
    val count: Int,
    val amount: InsightMoney?,
    val actionLabel: String,
)

data class TopProductInsight(
    val productId: Long,
    val name: String,
    val category: String?,
    val quantity: String,
    val revenue: InsightMoney,
    val profit: InsightMoney,
    val margin: PercentText,
    val invoiceCount: Int,
)

data class CategoryProfitInsight(
    val categoryId: Long?,
    val name: String,
    val revenue: InsightMoney,
    val cost: InsightMoney,
    val profit: InsightMoney,
    val margin: PercentText,
    val itemCount: Int,
)

data class SlowMoverInsight(
    val productId: Long,
    val name: String,
    val category: String?,
    val quantityInStock: String,
    val lastSaleDate: String?,
    val daysSinceLastSale: Int?,
)

data class ReportInsights(
    val alerts: List<ManagementAlert>,
    val generatedAt: String,
    val topProducts: List<TopProductInsight>,
    val categoryProfit: List<CategoryProfitInsight>,
    val slowMovers: List<SlowMoverInsight>,
    val mayBeTruncated: Boolean,
)

data class FinancialLineInsight(val key: String, val label: String, val amount: InsightMoney)
data class ProfitLossInsight(val revenue: InsightMoney, val costOfSales: InsightMoney, val grossProfit: InsightMoney, val totalExpenses: InsightMoney, val netProfit: InsightMoney, val expenseLines: List<FinancialLineInsight>)
data class TrialBalanceInsight(val totalAssets: InsightMoney, val totalLiabilities: InsightMoney, val equity: InsightMoney, val reconciled: Boolean, val asOf: String?)
data class LedgerEntryInsight(val id: Long, val date: String, val type: String, val party: String?, val reference: String?, val amount: InsightMoney)
data class CashFlowInsight(val inflows: List<FinancialLineInsight>, val outflows: List<FinancialLineInsight>, val totalIn: InsightMoney, val totalOut: InsightMoney, val net: InsightMoney)
data class FinancialReportsInsight(val profitLoss: ProfitLossInsight, val trialBalance: TrialBalanceInsight, val ledger: List<LedgerEntryInsight>, val ledgerTotal: Int, val cashFlow: CashFlowInsight)

data class AttendanceRowInsight(val date: String, val employeeName: String, val status: String, val hours: String)
data class AttendanceSummaryInsight(val rows: List<AttendanceRowInsight>, val days: Int, val hours: String, val present: Int, val absent: Int)
data class PayrollRunInsight(val id: Long, val period: String, val status: String, val employees: Int, val gross: InsightMoney, val net: InsightMoney)
data class HrReportsInsight(val attendance: AttendanceSummaryInsight, val payrollRuns: List<PayrollRunInsight>, val payrollGross: InsightMoney, val payrollNet: InsightMoney)

data class StoreKpis(
    val totalOrders: Int,
    val activeOrders: Int,
    val cancelledOrders: Int,
    val deliveredOrders: Int,
    val revenue: InsightMoney,
    val deliveredRevenue: InsightMoney,
    val averageOrderValue: InsightMoney,
    val fulfillmentRate: PercentText,
    val cancellationRate: PercentText,
)

data class StoreTrendPoint(val date: String, val orders: Int, val revenue: InsightMoney)
data class StoreProductInsight(val productId: Long, val name: String, val quantity: Int, val revenue: InsightMoney)
data class GovernorateInsight(val name: String, val orders: Int, val revenue: InsightMoney)
data class FunnelStep(val key: String, val label: String, val count: Int, val conversion: PercentText?)

data class StoreInsights(
    val from: String,
    val to: String,
    val kpis: StoreKpis,
    val trend: List<StoreTrendPoint>,
    val statusBreakdown: Map<String, Int>,
    val topProducts: List<StoreProductInsight>,
    val byGovernorate: List<GovernorateInsight>,
    val funnel: List<FunnelStep>,
)

enum class SearchEntityType(val label: String, val moduleKey: String?) {
    PRODUCT("منتج", "products"),
    INVOICE("فاتورة", "sales"),
    QUOTATION("عرض سعر", "sales"),
    PURCHASE_ORDER("أمر شراء", "purchases"),
    WORK_ORDER("أمر شغل", "workorders"),
    CUSTOMER("عميل", "crm"),
    SUPPLIER("مورد", "suppliers"),
    EXPENSE("مصروف", "expenses"),
    EMPLOYEE("موظف", "hr"),
    USER("مستخدم", null),
}

data class InsightTarget(val type: SearchEntityType, val id: Long)

data class SearchInsight(
    val target: InsightTarget,
    val title: String,
    val subtitle: String?,
    val meta: String?,
    val rank: Int,
)

data class InsightsAccessPolicy(
    val readableSections: Set<InsightsSection>,
    val searchScopes: Set<SearchEntityType>,
    val branchId: Long?,
    val canFilterBranch: Boolean,
) {
    fun canRead(section: InsightsSection): Boolean = section in readableSections

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): InsightsAccessPolicy {
            val levels = bootstrap.modules.associate { it.key to it.access.uppercase() }
            fun reads(module: String) = levels[module] == "READ" || levels[module] == "FULL"
            val role = bootstrap.user.role.lowercase()
            val elevated = role == "admin" || role == "manager"
            val reportsRole = role in setOf("admin", "manager", "accountant", "auditor")
            val reportsAllowed = reads("reports") && reportsRole && (role == "admin" || bootstrap.branchId != null)
            val hrReportsAllowed = reads("hr") && role in setOf("admin", "manager", "accountant", "auditor")
            val storeAllowed = reads("store") && (elevated || bootstrap.branchId != null)

            val scopes = SearchEntityType.entries.filterTo(mutableSetOf()) { type ->
                when {
                    type == SearchEntityType.USER -> role == "admin"
                    type.moduleKey == null || !reads(type.moduleKey) -> false
                    type in setOf(SearchEntityType.SUPPLIER, SearchEntityType.PURCHASE_ORDER, SearchEntityType.EXPENSE) ->
                        elevated || role == "accountant"
                    else -> true
                }
            }
            return InsightsAccessPolicy(
                readableSections = buildSet {
                    if (reportsAllowed) add(InsightsSection.REPORTS)
                    if (reportsAllowed && elevated) add(InsightsSection.REPORT_CATALOG)
                    if (reportsAllowed) add(InsightsSection.FINANCIAL)
                    if (hrReportsAllowed) add(InsightsSection.HR_REPORTS)
                    if (storeAllowed) add(InsightsSection.STORE)
                    if (scopes.isNotEmpty()) add(InsightsSection.SEARCH)
                },
                searchScopes = scopes,
                branchId = bootstrap.branchId,
                canFilterBranch = role == "admin",
            )
        }
    }
}

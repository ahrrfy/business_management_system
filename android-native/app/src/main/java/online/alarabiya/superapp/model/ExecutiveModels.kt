package online.alarabiya.superapp.model

@JvmInline
value class ExecutiveMoney private constructor(val value: String) {
    companion object {
        private val DECIMAL = Regex("^-?\\d+(?:\\.\\d+)?$")
        fun fromServer(raw: String?): ExecutiveMoney = ExecutiveMoney(raw?.trim()?.takeIf(DECIMAL::matches) ?: "0")
    }
}

enum class ExecutiveDestinationKey { INSIGHTS, RECEIVABLES, PRODUCTS, SHIFTS, WORK_ORDERS, PURCHASING, TASKS }
enum class ExecutiveSeverity { CRITICAL, WARNING, INFO }
enum class ExecutiveHealthStatus { OK, DEGRADED }

data class ExecutiveScope(val branchId: Long?, val allBranches: Boolean)
data class ExecutiveCapabilities(
    val financial: Boolean,
    val sales: Boolean,
    val inventory: Boolean,
    val receivables: Boolean,
    val workOrders: Boolean,
    val tasks: Boolean,
    val treasury: Boolean,
)
data class ExecutiveFreshness(val asOf: String, val source: String)
data class ExecutiveSalesToday(val total: ExecutiveMoney, val invoiceCount: Int, val freshness: ExecutiveFreshness)
data class ExecutiveTreasurySnapshot(
    val treasuryBalance: ExecutiveMoney,
    val drawerBalance: ExecutiveMoney,
    val todayReceipts: ExecutiveMoney,
    val todayExpenses: ExecutiveMoney,
    val openShiftsCount: Int,
    val freshness: ExecutiveFreshness,
)
data class ExecutiveOperationalSnapshot(
    val salesToday: ExecutiveSalesToday?,
    val treasury: ExecutiveTreasurySnapshot?,
)
data class ExecutivePartialError(val section: String, val code: String)
data class ExecutiveHealth(val status: ExecutiveHealthStatus, val partialErrors: List<ExecutivePartialError>)
data class ExecutiveSalesPulse(val yesterday: ExecutiveMoney, val average7Days: ExecutiveMoney, val direction: String, val changePercent: Int)
data class ExecutiveMorningBrief(val receivableReminders: Int, val promisedToday: Int, val overdueWorkOrders: Int, val myOpenTasks: Int, val overdueTasks: Int)
data class ExecutiveMetrics(
    val lowStockCount: Int,
    val overdueReceivablesCount: Int,
    val overdueReceivablesTotal: ExecutiveMoney,
    val salesPulse: ExecutiveSalesPulse,
    val morningBrief: ExecutiveMorningBrief,
)
data class ExecutiveAction(val destination: ExecutiveDestinationKey, val arguments: Map<String, String>)
data class ExecutiveDecision(
    val id: String,
    val severity: ExecutiveSeverity,
    val title: String,
    val count: Int,
    val amount: ExecutiveMoney?,
    val actionLabel: String,
    val action: ExecutiveAction,
)
data class ExecutiveCommandCenter(
    val asOf: String,
    val scope: ExecutiveScope,
    val capabilities: ExecutiveCapabilities,
    val health: ExecutiveHealth,
    val operationalSnapshot: ExecutiveOperationalSnapshot,
    val metrics: ExecutiveMetrics,
    val decisions: List<ExecutiveDecision>,
)

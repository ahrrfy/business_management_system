package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.ExecutiveAction
import online.alarabiya.superapp.model.ExecutiveCapabilities
import online.alarabiya.superapp.model.ExecutiveCommandCenter
import online.alarabiya.superapp.model.ExecutiveDecision
import online.alarabiya.superapp.model.ExecutiveDestinationKey
import online.alarabiya.superapp.model.ExecutiveHealth
import online.alarabiya.superapp.model.ExecutiveHealthStatus
import online.alarabiya.superapp.model.ExecutiveFreshness
import online.alarabiya.superapp.model.ExecutiveMetrics
import online.alarabiya.superapp.model.ExecutiveMoney
import online.alarabiya.superapp.model.ExecutiveMorningBrief
import online.alarabiya.superapp.model.ExecutiveOperationalSnapshot
import online.alarabiya.superapp.model.ExecutivePartialError
import online.alarabiya.superapp.model.ExecutiveSalesPulse
import online.alarabiya.superapp.model.ExecutiveSalesToday
import online.alarabiya.superapp.model.ExecutiveScope
import online.alarabiya.superapp.model.ExecutiveSeverity
import online.alarabiya.superapp.model.ExecutiveTreasurySnapshot
import org.json.JSONArray
import org.json.JSONObject

interface ExecutiveDataSource {
    suspend fun commandCenter(branchId: Long? = null): ExecutiveCommandCenter
}

class ExecutiveRepository(private val api: TrpcClient) : ExecutiveDataSource {
    override suspend fun commandCenter(branchId: Long?): ExecutiveCommandCenter {
        require(branchId == null || branchId > 0) { "معرّف الفرع غير صالح" }
        val input = JSONObject().also { branchId?.let { id -> it.put("branchId", id) } }
        return ExecutiveMapper.commandCenter(api.query("executive.commandCenter", input))
    }
}

internal object ExecutiveMapper {
    fun commandCenter(root: JSONObject): ExecutiveCommandCenter {
        val scope = root.optJSONObject("scope") ?: JSONObject()
        val capabilities = root.optJSONObject("capabilities") ?: JSONObject()
        val health = root.optJSONObject("health") ?: JSONObject()
        val metrics = root.optJSONObject("metrics") ?: JSONObject()
        val operational = root.optJSONObject("operationalSnapshot") ?: JSONObject()
        val overdue = metrics.optJSONObject("overdueAR") ?: JSONObject()
        val pulse = metrics.optJSONObject("salesPulse") ?: JSONObject()
        val brief = metrics.optJSONObject("morningBrief") ?: JSONObject()
        return ExecutiveCommandCenter(
            asOf = root.optString("asOf"),
            scope = ExecutiveScope(scope.nullableLong("branchId"), scope.optBoolean("allBranches")),
            capabilities = ExecutiveCapabilities(
                financial = capabilities.optBoolean("financial"), sales = capabilities.optBoolean("sales"),
                inventory = capabilities.optBoolean("inventory"),
                receivables = capabilities.optBoolean("receivables"), workOrders = capabilities.optBoolean("workOrders"),
                tasks = capabilities.optBoolean("tasks"), treasury = capabilities.optBoolean("treasury"),
            ),
            health = ExecutiveHealth(
                status = if (health.optString("status") == "degraded") ExecutiveHealthStatus.DEGRADED else ExecutiveHealthStatus.OK,
                partialErrors = health.optJSONArray("partialErrors").objects().map {
                    ExecutivePartialError(it.optString("section"), it.optString("code"))
                },
            ),
            operationalSnapshot = ExecutiveOperationalSnapshot(
                salesToday = operational.optJSONObject("salesToday")?.let { sales ->
                    ExecutiveSalesToday(
                        total = ExecutiveMoney.fromServer(sales.text("total")),
                        invoiceCount = sales.optInt("invoiceCount").coerceAtLeast(0),
                        freshness = sales.freshness(),
                    )
                },
                treasury = operational.optJSONObject("treasury")?.let { treasury ->
                    ExecutiveTreasurySnapshot(
                        treasuryBalance = ExecutiveMoney.fromServer(treasury.text("treasuryBalance")),
                        drawerBalance = ExecutiveMoney.fromServer(treasury.text("drawerBalance")),
                        todayReceipts = ExecutiveMoney.fromServer(treasury.text("todayReceipts")),
                        todayExpenses = ExecutiveMoney.fromServer(treasury.text("todayExpenses")),
                        openShiftsCount = treasury.optInt("openShiftsCount").coerceAtLeast(0),
                        freshness = treasury.freshness(),
                    )
                },
            ),
            metrics = ExecutiveMetrics(
                lowStockCount = metrics.optInt("lowStockCount").coerceAtLeast(0),
                overdueReceivablesCount = overdue.optInt("count").coerceAtLeast(0),
                overdueReceivablesTotal = ExecutiveMoney.fromServer(overdue.text("total")),
                salesPulse = ExecutiveSalesPulse(
                    yesterday = ExecutiveMoney.fromServer(pulse.text("yesterday")),
                    average7Days = ExecutiveMoney.fromServer(pulse.text("avg7d")),
                    direction = pulse.optString("direction", "flat").takeIf { it in setOf("up", "down", "flat") } ?: "flat",
                    changePercent = pulse.optInt("changePct"),
                ),
                morningBrief = ExecutiveMorningBrief(
                    receivableReminders = brief.optInt("arRemindersDue").coerceAtLeast(0),
                    promisedToday = brief.optInt("promisedToday").coerceAtLeast(0),
                    overdueWorkOrders = brief.optInt("overdueWorkOrders").coerceAtLeast(0),
                    myOpenTasks = brief.optInt("myOpenTasks").coerceAtLeast(0),
                    overdueTasks = brief.optInt("overdueTasks").coerceAtLeast(0),
                ),
            ),
            decisions = root.optJSONArray("decisions").objects().mapNotNull(::decision),
        )
    }

    private fun decision(json: JSONObject): ExecutiveDecision? {
        val action = json.optJSONObject("action") ?: return null
        val destination = runCatching { ExecutiveDestinationKey.valueOf(action.optString("destinationKey")) }.getOrNull() ?: return null
        return ExecutiveDecision(
            id = json.optString("id").takeIf(String::isNotBlank) ?: return null,
            severity = when (json.optString("severity")) {
                "critical" -> ExecutiveSeverity.CRITICAL
                "warning" -> ExecutiveSeverity.WARNING
                else -> ExecutiveSeverity.INFO
            },
            title = json.optString("title"), count = json.optInt("count").coerceAtLeast(0),
            amount = json.text("amount")?.let(ExecutiveMoney::fromServer),
            actionLabel = json.optString("actionLabel"),
            action = ExecutiveAction(destination, action.optJSONObject("args").stringMap()),
        )
    }
}

private fun JSONObject.freshness(): ExecutiveFreshness {
    val value = optJSONObject("freshness") ?: JSONObject()
    return ExecutiveFreshness(value.optString("asOf"), value.optString("source"))
}

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}
private fun JSONObject?.stringMap(): Map<String, String> = buildMap {
    if (this@stringMap == null) return@buildMap
    val keys = keys()
    while (keys.hasNext()) { val key = keys.next(); opt(key)?.takeUnless { it == JSONObject.NULL }?.let { put(key, it.toString()) } }
}
private fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)
private fun JSONObject.nullableLong(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)

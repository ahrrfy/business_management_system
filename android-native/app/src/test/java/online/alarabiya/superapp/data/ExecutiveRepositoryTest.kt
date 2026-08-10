package online.alarabiya.superapp.data

import online.alarabiya.superapp.model.ExecutiveDestinationKey
import online.alarabiya.superapp.model.ExecutiveHealthStatus
import online.alarabiya.superapp.model.ExecutiveSeverity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExecutiveRepositoryTest {
    @Test
    fun `mapper preserves decimal money and typed native actions`() {
        val root = base().put("decisions", JSONArray().put(
            JSONObject().put("id", "stock-out").put("severity", "critical").put("title", "نفاد")
                .put("count", 2).put("amount", "12345678901234567890.25").put("actionLabel", "فتح")
                .put("action", JSONObject().put("destinationKey", "PRODUCTS").put("args", JSONObject().put("stockState", "out"))),
        ))

        val result = ExecutiveMapper.commandCenter(root)

        assertEquals("12345678901234567890.25", result.decisions.single().amount?.value)
        assertEquals(ExecutiveSeverity.CRITICAL, result.decisions.single().severity)
        assertEquals(ExecutiveDestinationKey.PRODUCTS, result.decisions.single().action.destination)
        assertEquals("out", result.decisions.single().action.arguments["stockState"])
    }

    @Test
    fun `unknown destinations are rejected rather than interpreted as routes`() {
        val decision = JSONObject().put("id", "bad").put("severity", "warning")
            .put("action", JSONObject().put("destinationKey", "WEBVIEW").put("args", JSONObject()))
        val result = ExecutiveMapper.commandCenter(base().put("decisions", JSONArray().put(decision)))
        assertEquals(emptyList<Any>(), result.decisions)
    }

    @Test
    fun `degraded health and unavailable financial capability remain explicit`() {
        val root = base()
        root.getJSONObject("capabilities").put("financial", false)
        root.getJSONObject("health").put("status", "degraded").put(
            "partialErrors", JSONArray().put(JSONObject().put("section", "alerts").put("code", "SOURCE_UNAVAILABLE")),
        )
        val result = ExecutiveMapper.commandCenter(root)
        assertEquals(ExecutiveHealthStatus.DEGRADED, result.health.status)
        assertEquals(false, result.capabilities.financial)
        assertEquals("alerts", result.health.partialErrors.single().section)
        assertNull(result.scope.branchId)
    }

    @Test
    fun `operational snapshots preserve authoritative decimal strings and freshness`() {
        val operational = JSONObject()
            .put("salesToday", JSONObject()
                .put("total", "98765432109876543210.75").put("invoiceCount", 42)
                .put("freshness", JSONObject().put("asOf", "2026-08-09T12:01:00.000Z").put("source", "database")))
            .put("treasury", JSONObject()
                .put("treasuryBalance", "700.25").put("drawerBalance", "90.00")
                .put("todayReceipts", "100.50").put("todayExpenses", "10.25").put("openShiftsCount", 2)
                .put("freshness", JSONObject().put("asOf", "2026-08-09T12:02:00.000Z").put("source", "treasury-ledger")))
        val result = ExecutiveMapper.commandCenter(base().put("operationalSnapshot", operational))
        assertEquals("98765432109876543210.75", result.operationalSnapshot.salesToday?.total?.value)
        assertEquals(42, result.operationalSnapshot.salesToday?.invoiceCount)
        assertEquals("database", result.operationalSnapshot.salesToday?.freshness?.source)
        assertEquals("700.25", result.operationalSnapshot.treasury?.treasuryBalance?.value)
        assertEquals("treasury-ledger", result.operationalSnapshot.treasury?.freshness?.source)
    }

    private fun base() = JSONObject()
        .put("asOf", "2026-08-09T12:00:00.000Z")
        .put("scope", JSONObject().put("branchId", JSONObject.NULL).put("allBranches", true))
        .put("capabilities", JSONObject().put("financial", true).put("sales", true).put("inventory", true).put("receivables", true).put("workOrders", true).put("tasks", true).put("treasury", true))
        .put("health", JSONObject().put("status", "ok").put("partialErrors", JSONArray()))
        .put("metrics", JSONObject()
            .put("lowStockCount", 2)
            .put("overdueAR", JSONObject().put("count", 1).put("total", "99.50"))
            .put("salesPulse", JSONObject().put("yesterday", "10.00").put("avg7d", "8.00").put("direction", "up").put("changePct", 25))
            .put("morningBrief", JSONObject().put("arRemindersDue", 1).put("promisedToday", 2).put("overdueWorkOrders", 3).put("myOpenTasks", 4).put("overdueTasks", 5)))
        .put("decisions", JSONArray())
}

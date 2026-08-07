package online.alarabiya.superapp.feature.accountingControls

import online.alarabiya.superapp.data.toAccountGroupOrNull
import online.alarabiya.superapp.data.toExchangeOperation
import online.alarabiya.superapp.data.toExchangeStatement
import online.alarabiya.superapp.data.toReconciliation
import online.alarabiya.superapp.data.toYearCloseResult
import online.alarabiya.superapp.data.toYearEndSnapshotOrNull
import online.alarabiya.superapp.model.accountingControls.AccountType
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountingControlsMappersTest {
    @Test
    fun `account tree preserves server grouping and active state`() {
        val group = JSONObject()
            .put("type", "ASSET")
            .put("label", "الأصول")
            .put("rows", JSONArray().put(JSONObject()
                .put("id", 8)
                .put("code", "1101")
                .put("name", "الصندوق")
                .put("type", "ASSET")
                .put("isActive", false)
                .put("sortOrder", 2)))
            .toAccountGroupOrNull()

        assertEquals(AccountType.ASSET, group?.type)
        assertEquals("1101", group?.rows?.single()?.code)
        assertFalse(group?.rows?.single()?.active ?: true)
    }

    @Test
    fun `unknown account group is rejected instead of guessed`() {
        assertNull(JSONObject().put("type", "MYSTERY").put("label", "x").toAccountGroupOrNull())
    }

    @Test
    fun `statement keeps authoritative server balances and transaction metadata`() {
        val statement = JSONObject()
            .put("house", JSONObject().put("id", 3).put("name", "صيرفة بغداد").put("balanceIqd", "900.10").put("balanceUsd", "12.50").put("usdCostRate", "1310.1250"))
            .put("summary", JSONObject().put("currentBalanceIqd", "900.10").put("currentBalanceUsd", "12.50").put("totalFxDiff", "-4.25"))
            .put("transactions", JSONArray().put(JSONObject()
                .put("id", 22)
                .put("txnNumber", "EX-22")
                .put("type", "WITHDRAW")
                .put("currency", "IQD")
                .put("iqdAmount", "100.00")
                .put("status", "ACTIVE")
                .put("branchName", "الكرادة")))
            .toExchangeStatement()

        assertEquals("900.10", statement.summary.currentIqd)
        assertEquals("-4.25", statement.summary.fxDifference)
        assertEquals("الكرادة", statement.transactions.single().branchName)
    }

    @Test
    fun `pending approval comes only from server operation state`() {
        val result = JSONObject()
            .put("txnId", 44)
            .put("txnNumber", "EX-44")
            .put("status", "PENDING_APPROVAL")
            .toExchangeOperation()

        assertTrue(result.pendingApproval)
    }

    @Test
    fun `reconciliation maps server differences without recomputation`() {
        val result = JSONObject()
            .put("ourBalanceIqd", "100.00")
            .put("ourBalanceUsd", "10.00")
            .put("statedBalanceIqd", "99.00")
            .put("statedBalanceUsd", "10.00")
            .put("diffIqd", "777.77")
            .put("diffUsd", "0.00")
            .put("matched", false)
            .put("pending", JSONArray().put(JSONObject().put("id", 1)))
            .toReconciliation()

        assertEquals("777.77", result.differenceIqd)
        assertFalse(result.matched)
        assertEquals(1, result.pendingCount)
    }

    @Test
    fun `year close and snapshots preserve server totals`() {
        val close = JSONObject()
            .put("snapshotId", 91)
            .put("periodLockId", 92)
            .put("year", 2025)
            .put("branchId", JSONObject.NULL)
            .put("totalRevenue", "123.45")
            .put("totalCogs", "23.45")
            .put("totalExpenses", "10.00")
            .put("netProfit", "444.44")
            .toYearCloseResult()
        val snapshot = JSONObject()
            .put("id", 91)
            .put("year", 2025)
            .put("branchId", JSONObject.NULL)
            .put("closedBy", 1)
            .put("totalRevenue", "123.45")
            .put("totalCogs", "23.45")
            .put("totalExpenses", "10.00")
            .put("netProfit", "444.44")
            .toYearEndSnapshotOrNull()

        assertEquals("444.44", close.netProfit)
        assertEquals("444.44", snapshot?.netProfit)
        assertNull(close.branchId)
    }
}

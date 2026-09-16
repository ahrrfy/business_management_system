package online.alarabiya.superapp.feature.shifts

import online.alarabiya.superapp.model.shifts.ShiftAccessPolicy
import online.alarabiya.superapp.model.shifts.ShiftFilters
import online.alarabiya.superapp.model.shifts.ShiftMappers
import online.alarabiya.superapp.model.shifts.ShiftMoney
import online.alarabiya.superapp.model.shifts.ShiftRecord
import online.alarabiya.superapp.model.shifts.ShiftReport
import online.alarabiya.superapp.model.shifts.ShiftStatus
import online.alarabiya.superapp.model.shifts.ShiftType
import online.alarabiya.superapp.model.shifts.ShiftVarianceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class ShiftContractTest {
    @Test
    fun `maps list without floating point conversion and keeps cursor truth`() {
        val page = ShiftMappers.page(
            mapOf(
                "rows" to listOf(
                    row(
                        id = 73,
                        expected = "9007199254740993.99",
                        counted = null,
                        variance = null,
                    ),
                    mapOf("id" to 0),
                ),
                "total" to "91",
                "hasMore" to true,
                "nextCursor" to "73",
            ),
        )

        assertEquals(1, page.rows.size)
        assertEquals("9007199254740993.99", page.rows.single().expectedCash?.value)
        assertNull(page.rows.single().countedCash)
        assertNull(page.rows.single().variance)
        assertEquals(91, page.total)
        assertTrue(page.hasMore)
        assertEquals(73L, page.nextCursor)
    }

    @Test
    fun `maps Z report counts from numbers or strings`() {
        val report = ShiftMappers.report(
            mapOf(
                "shift" to row(14, expected = "125000.00", counted = "125000.00", variance = "0.00"),
                "payments" to listOf(
                    mapOf("method" to "CASH", "direction" to "IN", "total" to "120000.50", "count" to "4"),
                    mapOf("method" to "CARD", "direction" to "IN", "total" to "5000.50", "count" to 1),
                ),
                "expectedCash" to "125000.00",
                "invoiceCount" to "5",
                "salesTotal" to "125001.00",
                "woInvoicesCount" to 1,
                "woInvoicesTotal" to "1000.00",
                "heldDepositsCount" to 2,
                "heldDepositsTotal" to "2000.00",
                "lateSyncedCount" to 0,
                "lateSyncedTotal" to "0.00",
            ),
        )

        requireNotNull(report)
        assertEquals(5, report.invoiceCount)
        assertEquals(4, report.payments.first().count)
        assertEquals("120000.5", report.payments.first().total.value)
        assertEquals("125000", report.expectedCash.value)
    }

    @Test
    fun `money accepts only unsigned decimal strings with two fraction digits`() {
        assertEquals(ShiftMoney.parseUnsigned("0.10"), ShiftMoney.parseUnsigned("0.1"))
        assertEquals("9007199254740993.99", ShiftMoney.parseUnsigned("9007199254740993.99")?.value)
        assertNull(ShiftMoney.parseUnsigned("-1"))
        assertNull(ShiftMoney.parseUnsigned(".50"))
        assertNull(ShiftMoney.parseUnsigned("1.001"))
        assertNull(ShiftMoney.parseUnsigned("1e3"))
        assertNull(ShiftMoney.parseUnsigned("1,000"))
    }

    @Test
    fun `filters validate branch dates range and server search limit`() {
        assertNull(ShiftFilters(branchId = "7", from = "2026-08-01", to = "2026-08-09").validate(true))
        assertTrue(ShiftFilters(branchId = "x").validate(true)!!.contains("الفرع"))
        assertTrue(ShiftFilters(branchId = "8").validate(false, fixedBranchId = 7)!!.contains("نطاق"))
        assertTrue(ShiftFilters(from = "2026-08-10", to = "2026-08-09").validate(true)!!.contains("البداية"))
        assertTrue(ShiftFilters(search = "x".repeat(101)).validate(true)!!.contains("البحث"))
    }

    @Test
    fun `management policy does not widen cashier and limits manager close to own branch`() {
        val own = record(branchId = 7)
        val other = record(branchId = 9)
        val manager = policy(role = "manager", branchId = 7)
        val admin = policy(role = "admin", branchId = null)
        val owner = policy(role = "manager", branchId = null, owner = true)
        val cashier = policy(role = "cashier", branchId = 7)

        assertTrue(manager.canReadManagement)
        assertTrue(manager.canClose(own))
        assertFalse(manager.canClose(other))
        assertTrue(admin.canClose(other))
        assertTrue(owner.canClose(other))
        assertTrue(policy(role = "admin", branchId = null, access = "NONE").canReadManagement)
        assertTrue(policy(role = "manager", branchId = null, access = "NONE", owner = true).canReadManagement)
        assertFalse(cashier.canReadManagement)
        assertFalse(cashier.canClose(own))
        assertFalse(policy(role = "manager", branchId = 7, access = "NONE").canReadManagement)
        assertFalse(manager.canClose(own.copy(status = ShiftStatus.CLOSED)))
    }

    @Test
    fun `close stays gated until load report exact recount and acknowledgement`() {
        val report = report(expected = "1000.10")
        val base = ShiftUiState(
            policy = policy(role = "manager", branchId = 7),
            loading = false,
            loaded = true,
            rows = listOf(report.shift),
            selectedShiftId = report.shift.id,
            detail = ShiftDetailState.Content(report),
            closeDraft = ShiftCloseDraft(report.shift.id),
        )

        assertTrue(ShiftStatePolicy.closeValidation(base)!!.contains("أدخل"))
        assertTrue(
            ShiftStatePolicy.closeValidation(
                base.copy(closeDraft = base.closeDraft?.copy(countedCash = "1000.10", countedCashConfirmation = "1000.11")),
            )!!.contains("لا تطابق"),
        )
        assertTrue(
            ShiftStatePolicy.closeValidation(
                base.copy(closeDraft = base.closeDraft?.copy(countedCash = "999.10", countedCashConfirmation = "999.10", acknowledged = true)),
            )!!.contains("فرق"),
        )
        assertNull(
            ShiftStatePolicy.closeValidation(
                base.copy(
                    closeDraft = base.closeDraft?.copy(
                        countedCash = "1000.1",
                        countedCashConfirmation = "1000.10",
                        acknowledged = true,
                    ),
                ),
            ),
        )
        assertTrue(ShiftStatePolicy.closeValidation(base.copy(loaded = false))!!.contains("تحميل"))
        assertFalse(ShiftStatePolicy.canRequestClose(base.copy(loaded = false), report.shift))
    }

    @Test
    fun `empty drawer closes after exact recount and acknowledgement`() {
        val report = report(expected = "0")
        val state = ShiftUiState(
            policy = policy(role = "manager", branchId = 7),
            loading = false,
            loaded = true,
            rows = listOf(report.shift),
            selectedShiftId = report.shift.id,
            detail = ShiftDetailState.Content(report),
            closeDraft = ShiftCloseDraft(
                shiftId = report.shift.id,
                countedCash = "0",
                countedCashConfirmation = "0.00",
                acknowledged = true,
            ),
        )

        assertNull(ShiftStatePolicy.closeValidation(state))
    }

    @Test
    fun `keyset load more requires successful load and a real cursor`() {
        val base = ShiftUiState(policy = policy("manager", 7), loading = false, loaded = true, hasMore = true, nextCursor = 41)
        assertTrue(ShiftStatePolicy.canLoadMore(base))
        assertFalse(ShiftStatePolicy.canLoadMore(base.copy(loaded = false)))
        assertFalse(ShiftStatePolicy.canLoadMore(base.copy(loadingMore = true)))
        assertFalse(ShiftStatePolicy.canLoadMore(base.copy(nextCursor = null)))
    }

    @Test
    fun `executive variance navigation changes the native shift filter and clears stale detail`() {
        val report = report(expected = "1000.10")
        val initial = ShiftUiState(
            policy = policy("admin", null),
            loading = false,
            loaded = true,
            selectedShiftId = report.shift.id,
            detail = ShiftDetailState.Content(report),
        )

        val next = initial.applyExecutiveNavigation(mapOf("variance" to "true"))

        assertEquals(ShiftVarianceState.WITH_VARIANCE, next.filters.variance)
        assertNull(next.selectedShiftId)
        assertEquals(ShiftDetailState.None, next.detail)
    }

    @Test
    fun `timestamp is converted from UTC to Baghdad and isolated for RTL`() {
        val formatted = formatShiftTimestamp("2026-08-09T10:15:00Z", ZoneId.of("Asia/Baghdad"))
        assertTrue(formatted.contains("13:15"))
        assertTrue(formatted.startsWith("\u2066"))
        assertTrue(formatted.endsWith("\u2069"))
    }

    private fun policy(role: String, branchId: Long?, access: String = "READ", owner: Boolean = false) = ShiftAccessPolicy(
        role = role,
        actorId = 1,
        branchId = branchId,
        treasuryAccess = access,
        isOwner = owner,
    )

    private fun report(expected: String): ShiftReport = ShiftReport(
        shift = record(branchId = 7),
        payments = emptyList(),
        expectedCash = ShiftMoney.fromServer(expected),
        invoiceCount = 3,
        salesTotal = ShiftMoney.fromServer("900.10"),
        workOrderInvoiceCount = 0,
        workOrderInvoiceTotal = ShiftMoney.ZERO,
        heldDepositsCount = 0,
        heldDepositsTotal = ShiftMoney.ZERO,
        lateSyncedCount = 0,
        lateSyncedTotal = ShiftMoney.ZERO,
    )

    private fun record(branchId: Long): ShiftRecord = ShiftRecord(
        id = 14,
        branchId = branchId,
        branchName = "الكرادة",
        userId = 5,
        userName = "أحمد",
        openingBalance = ShiftMoney.fromServer("100"),
        expectedCash = ShiftMoney.fromServer("1000.10"),
        countedCash = null,
        variance = null,
        status = ShiftStatus.OPEN,
        type = ShiftType.RETAIL,
        openedAt = "2026-08-09T10:15:00Z",
        closedAt = null,
    )

    private fun row(
        id: Long,
        expected: String?,
        counted: String?,
        variance: String?,
    ): Map<String, Any?> = mapOf(
        "id" to id,
        "branchId" to 7,
        "branchName" to "الكرادة",
        "userId" to 5,
        "userName" to "أحمد",
        "openingBalance" to "100.00",
        "expectedCash" to expected,
        "countedCash" to counted,
        "variance" to variance,
        "status" to "OPEN",
        "shiftType" to "RETAIL",
        "openedAt" to "2026-08-09T10:15:00Z",
        "closedAt" to null,
    )
}

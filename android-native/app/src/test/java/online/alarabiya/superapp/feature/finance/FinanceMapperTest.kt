package online.alarabiya.superapp.feature.finance

import online.alarabiya.superapp.data.DrawerBalancePayload
import online.alarabiya.superapp.data.FinanceMapper
import online.alarabiya.superapp.data.TreasuryBalancePayload
import online.alarabiya.superapp.data.TreasuryDashboardPayload
import online.alarabiya.superapp.data.VoucherPayload
import online.alarabiya.superapp.model.finance.FinanceItemKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FinanceMapperTest {
    @Test
    fun `dashboard joins drawer and treasury by branch id`() {
        val overview = FinanceMapper.treasury(
            TreasuryDashboardPayload(
                drawerBalances = listOf(
                    DrawerBalancePayload(2, "الفرع الثاني", "135.4", 3),
                    DrawerBalancePayload(1, "الفرع الأول", "20", 1),
                ),
                treasuryBalances = listOf(TreasuryBalancePayload(1, "900.05")),
                todayReceiptsTotal = "1500",
                todayExpensesTotal = "32.10",
                pendingIncomingTransfers = 2,
                hideTreasury = false,
                generatedAt = "2026-08-06T10:00:00Z",
            ),
        )

        assertNull(overview.branches[0].treasuryBalance)
        assertEquals("900.05", overview.branches[1].treasuryBalance?.value)
        assertEquals("1500.00", overview.todayReceipts.value)
        assertEquals(2, overview.pendingIncomingTransfers)
    }

    @Test
    fun `cashier contract hides treasury even when payload includes it`() {
        val overview = FinanceMapper.treasury(
            TreasuryDashboardPayload(
                drawerBalances = listOf(DrawerBalancePayload(1, "فرع", "10", 1)),
                treasuryBalances = listOf(TreasuryBalancePayload(1, "500")),
                todayReceiptsTotal = "0",
                todayExpensesTotal = "0",
                pendingIncomingTransfers = 0,
                hideTreasury = true,
                generatedAt = "now",
            ),
        )

        assertNull(overview.branches.single().treasuryBalance)
    }

    @Test
    fun `voucher mapper uses typed domain key and exact money`() {
        val voucher = FinanceMapper.voucher(
            VoucherPayload(
                id = 42,
                voucherNumber = "RV-42",
                branchId = 3,
                direction = "IN",
                amount = "54300.00",
                paymentMethod = "CASH",
                approvalStatus = "PENDING",
                status = "ACTIVE",
                description = "دفعة",
                counterpartyName = "عميل",
                createdAt = "now",
            ),
        )!!

        assertEquals(FinanceItemKind.VOUCHER, voucher.key.kind)
        assertEquals("42", voucher.key.id)
        assertEquals("54300.00", voucher.amount.value)
    }
}

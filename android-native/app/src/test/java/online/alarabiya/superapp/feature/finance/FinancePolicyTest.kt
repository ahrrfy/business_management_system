package online.alarabiya.superapp.feature.finance

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.finance.FinanceAccessPolicy
import online.alarabiya.superapp.model.finance.CashTransferSummary
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceItemKind
import online.alarabiya.superapp.model.finance.FinanceSection
import online.alarabiya.superapp.model.finance.MoneyText
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FinancePolicyTest {
    @Test
    fun `read access never enables financial creation`() {
        val policy = policy("manager", 1, module("treasury", "READ"), module("expenses", "READ"))

        assertTrue(policy.canRead(FinanceSection.OVERVIEW))
        assertTrue(policy.canRead(FinanceSection.EXPENSES))
        assertFalse(policy.canWrite(FinanceSection.VOUCHERS))
        assertFalse(policy.canWrite(FinanceSection.EXPENSES))
        assertFalse(policy.canFundTreasury)
    }

    @Test
    fun `accountant full treasury can create branch voucher but not manager-only transfer or expense`() {
        val policy = policy(
            "accountant", 7,
            module("treasury", "FULL"), module("expenses", "FULL"), module("reports", "READ"),
        )

        assertTrue(policy.canWrite(FinanceSection.VOUCHERS))
        assertFalse(policy.canWrite(FinanceSection.TRANSFERS))
        assertFalse(policy.canWrite(FinanceSection.EXPENSES))
        assertTrue(policy.canRead(FinanceSection.CARD_ACCOUNT))
    }

    @Test
    fun `branchless admin cannot create voucher but may select transfer source`() {
        val policy = policy("admin", null, module("treasury", "FULL"), module("expenses", "FULL"))

        assertFalse(policy.canWrite(FinanceSection.VOUCHERS))
        assertTrue(policy.canWrite(FinanceSection.TRANSFERS))
        assertTrue(policy.canFundTreasury)
        assertTrue(policy.canSelectBranch)
    }

    @Test
    fun `cashier reads own treasury overview but not manager ledgers`() {
        val policy = policy("cashier", 4, module("treasury", "READ"), module("reports", "READ"))

        assertTrue(policy.canRead(FinanceSection.OVERVIEW))
        assertTrue(policy.canRead(FinanceSection.MOVEMENTS))
        assertFalse(policy.canRead(FinanceSection.VOUCHERS))
        assertFalse(policy.canRead(FinanceSection.CARD_ACCOUNT))
    }

    @Test
    fun `manager transfer actions follow branch and maker checker rules`() {
        val receiver = policy("manager", 2, module("treasury", "FULL"))
        val incoming = transfer(from = 1, to = 2, sentBy = 8)
        val ownIncoming = transfer(from = 1, to = 2, sentBy = 1)
        val outgoing = transfer(from = 2, to = 3, sentBy = 1)

        assertTrue(receiver.canReceive(incoming))
        assertFalse(receiver.canReceive(ownIncoming))
        assertFalse(receiver.canCancel(incoming))
        assertTrue(receiver.canCancel(outgoing))
    }

    private fun module(key: String, access: String) = ModuleAccess(key, key, access)

    private fun policy(role: String, branchId: Long?, vararg modules: ModuleAccess) =
        FinanceAccessPolicy.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(1, "مختبر", null, null, role),
                modules = modules.toList(),
                branchId = branchId,
                allBranches = role == "admin",
            ),
        )

    private fun transfer(from: Long, to: Long, sentBy: Long) = CashTransferSummary(
        key = FinanceItemKey(FinanceItemKind.TRANSFER, "11"),
        number = "CT-11",
        fromBranchId = from,
        fromBranchName = "مصدر",
        toBranchId = to,
        toBranchName = "مستلم",
        amount = MoneyText.fromServer("10"),
        status = "IN_TRANSIT",
        sentBy = sentBy,
        sentAt = "now",
        notes = null,
        cancellationReason = null,
    )
}

package online.alarabiya.superapp.feature.finance

import online.alarabiya.superapp.model.finance.AccountSummary
import online.alarabiya.superapp.data.ExpensePage
import online.alarabiya.superapp.model.finance.ExpenseSummary
import online.alarabiya.superapp.model.finance.FinanceCreation
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceItemKind
import online.alarabiya.superapp.model.finance.FinanceSection
import online.alarabiya.superapp.model.finance.MoneyText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class FinanceStateTest {
    @Test
    fun `same numeric id cannot select a record from another finance domain`() {
        val expenseKey = FinanceItemKey(FinanceItemKind.EXPENSE, "7")
        val accountKey = FinanceItemKey(FinanceItemKind.ACCOUNT, "7")
        val state = FinanceUiState(
            section = FinanceSection.EXPENSES,
            expenses = listOf(expense(7)),
            accounts = listOf(AccountSummary(accountKey, "7", "حساب", "ASSET", null, null, true)),
        )

        assertEquals(expenseKey, state.select(expenseKey).selectedKey)
        assertSame(state, state.select(accountKey))
    }

    @Test
    fun `finish loading clears stale selection`() {
        val old = FinanceItemKey(FinanceItemKind.EXPENSE, "99")
        val state = FinanceUiState(section = FinanceSection.EXPENSES, selectedKey = old, expenses = listOf(expense(1)))

        assertNull(state.finishLoading(FinanceSection.EXPENSES).selectedKey)
    }

    @Test
    fun `draft rejects invalid transfer and preserves idempotency key in command`() {
        val invalid = FinanceDraft(
            kind = FinanceComposerKind.TRANSFER,
            branchId = "2",
            targetBranchId = "2",
            amount = "10",
            clientRequestId = "same-key",
        )
        assertNotNull(invalid.validationError())

        val command = invalid.copy(targetBranchId = "3").toCommand() as FinanceCreation.Transfer
        assertEquals("same-key", command.clientRequestId)
        assertEquals("10.00", command.amount.value)
    }

    @Test
    fun `pagination appends rows and clears has-more at the server boundary`() {
        val first = FinanceUiState(section = FinanceSection.EXPENSES).withExpenses(
            ExpensePage(listOf(expense(1)), MoneyText.fromServer("30"), 2, hasMore = true),
        )
        val second = first.withExpenses(
            ExpensePage(listOf(expense(2)), MoneyText.fromServer("30"), 2, hasMore = false),
            append = true,
        )

        assertEquals(listOf("1", "2"), second.expenses.map { it.key.id })
        assertEquals("30.00", second.expenseTotal.value)
        assertFalse(FinanceSection.EXPENSES in second.hasMoreSections)
    }

    @Test
    fun `writes require a fresh successfully loaded destination section`() {
        val initial = FinanceUiState(section = FinanceSection.EXPENSES)
        assertFalse(initial.canWrite(FinanceSection.EXPENSES))
        val loaded = initial.finishLoading(FinanceSection.EXPENSES)
        assertFalse(loaded.copy(staleSections = setOf(FinanceSection.EXPENSES)).canWrite(FinanceSection.EXPENSES))
        assertEquals(true, loaded.canWrite(FinanceSection.EXPENSES))
    }

    @Test
    fun `mutation commit closes composer and failed refresh keeps section stale`() {
        val loaded = FinanceUiState(
            section = FinanceSection.EXPENSES,
            loadedSections = setOf(FinanceSection.EXPENSES),
            composer = FinanceDraft(FinanceComposerKind.EXPENSE, "1", clientRequestId = "once"),
            submitting = true,
        )
        val committed = loaded.mutationCommitted(FinanceSection.EXPENSES, "تمت")
        assertNull(committed.composer)
        assertFalse(committed.canWrite(FinanceSection.EXPENSES))
        val refreshFailed = committed.loadFailed(FinanceSection.EXPENSES, "شبكة", afterMutation = true)
        assertEquals("تمت العملية وتعذر تحديث العرض", refreshFailed.notice)
        assertFalse(refreshFailed.canWrite(FinanceSection.EXPENSES))
        assertEquals(true, refreshFailed.finishLoading(FinanceSection.EXPENSES).canWrite(FinanceSection.EXPENSES))
    }

    private fun expense(id: Long) = ExpenseSummary(
        key = FinanceItemKey(FinanceItemKind.EXPENSE, id.toString()),
        category = "تشغيل",
        amount = MoneyText.fromServer("10"),
        paymentMethod = "CASH",
        source = "CASH",
        status = "ACTIVE",
        description = "مصروف",
        reference = null,
        branchName = "فرع",
        expenseDate = "2026-08-06",
    )
}

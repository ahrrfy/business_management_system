package online.alarabiya.superapp.feature.accountingControls

import online.alarabiya.superapp.model.accountingControls.AccountingControlsSection
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountingControlsStateTest {
    @Test
    fun `initial load failure remains a hard barrier for financial mutations`() {
        val failed = AccountingControlsUiState(section = AccountingControlsSection.PERIODS)
            .start(AccountingControlsBusy.INITIAL)!!
            .failed("تعذر الاتصال")

        assertFalse(failed.initialized)
        assertFalse(failed.currentSectionLoaded)
        assertFalse(failed.canMutate(AccountingControlsSection.PERIODS))
        assertFalse(failed.canMutate(AccountingControlsSection.YEAR_END))
    }

    @Test
    fun `only a successful load unlocks the matching visible workspace`() {
        val loaded = AccountingControlsUiState(section = AccountingControlsSection.YEAR_END)
            .start(AccountingControlsBusy.YEAR_END)!!
            .successfulLoad(AccountingControlsSection.YEAR_END)

        assertTrue(loaded.initialized)
        assertTrue(loaded.currentSectionLoaded)
        assertTrue(loaded.canMutate(AccountingControlsSection.YEAR_END))
        assertFalse(loaded.canMutate(AccountingControlsSection.PERIODS))
        assertFalse(loaded.copy(section = AccountingControlsSection.PERIODS)
            .canMutate(AccountingControlsSection.YEAR_END))
    }

    @Test
    fun `busy state blocks duplicate financial action after successful load`() {
        val loaded = AccountingControlsUiState(section = AccountingControlsSection.EXCHANGE)
            .successfulLoad(AccountingControlsSection.EXCHANGE)
        val busy = loaded.start(AccountingControlsBusy.RECONCILIATION)!!

        assertFalse(busy.canMutate(AccountingControlsSection.EXCHANGE))
    }

    @Test
    fun `period workspace keeps tablet split but stacks naturally at large text`() {
        assertTrue(periodWorkspaceLayout(widthDp = 1024f, fontScale = 1f) == PeriodWorkspaceLayout.SPLIT)
        assertTrue(periodWorkspaceLayout(widthDp = 1024f, fontScale = 2f) == PeriodWorkspaceLayout.STACKED)
        assertTrue(periodWorkspaceLayout(widthDp = 390f, fontScale = 1f) == PeriodWorkspaceLayout.STACKED)
    }

    @Test
    fun `mutation start invalidates successful section until authoritative refetch`() {
        val loaded = AccountingControlsUiState(section = AccountingControlsSection.EXCHANGE)
            .successfulLoad(AccountingControlsSection.EXCHANGE)

        val mutating = requireNotNull(
            loaded.start(
                AccountingControlsBusy.EXCHANGE_MUTATION,
                invalidateSection = AccountingControlsSection.EXCHANGE,
            ),
        )
        assertFalse(mutating.currentSectionLoaded)
        assertFalse(mutating.canMutate(AccountingControlsSection.EXCHANGE))

        val reloaded = mutating.successfulLoad(AccountingControlsSection.EXCHANGE)
        assertTrue(reloaded.currentSectionLoaded)
        assertTrue(reloaded.canMutate(AccountingControlsSection.EXCHANGE))
    }

    @Test
    fun `post mutation refresh failure preserves success and remains fail closed`() {
        val stale = AccountingControlsUiState(
            section = AccountingControlsSection.PERIODS,
            busy = AccountingControlsBusy.PERIOD_MUTATION,
            notice = "تم إقفال الفترة",
        ).refreshAfterMutationFailed("انقطع الاتصال")

        assertFalse(stale.currentSectionLoaded)
        assertFalse(stale.canMutate(AccountingControlsSection.PERIODS))
        assertTrue(requireNotNull(stale.error).contains("تم تنفيذ الإجراء"))
        assertTrue(stale.notice == "تم إقفال الفترة")
    }
}

package online.alarabiya.superapp.feature.accountingControls

import online.alarabiya.superapp.model.accountingControls.AccountingControlsValidation
import online.alarabiya.superapp.model.accountingControls.ExchangeCommand
import online.alarabiya.superapp.model.accountingControls.ExchangeCurrency
import online.alarabiya.superapp.model.accountingControls.ExchangeOperationKind
import online.alarabiya.superapp.model.accountingControls.ReconciliationCommand
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AccountingControlsValidationTest {
    @Test
    fun `exchange mutation requires positive amount rate and idempotency key`() {
        assertNotNull(AccountingControlsValidation.exchange(command(amount = "0")))
        assertNotNull(AccountingControlsValidation.exchange(command(rate = "0")))
        assertNotNull(AccountingControlsValidation.exchange(command(requestId = "")))
        assertNull(AccountingControlsValidation.exchange(command()))
    }

    @Test
    fun `reconciliation allows signed balances but validates the cut date`() {
        assertNull(AccountingControlsValidation.reconciliation(ReconciliationCommand(3, "-1.00", "2.00", "2026-08-06")))
        assertNotNull(AccountingControlsValidation.reconciliation(ReconciliationCommand(3, "-1.00", "2.00", "06/08/2026")))
    }

    @Test
    fun `unlock requires evidence and administrator password`() {
        assertNotNull(AccountingControlsValidation.unlock("قصير", "secret"))
        assertNotNull(AccountingControlsValidation.unlock("سبب تدقيقي كافٍ", ""))
        assertNull(AccountingControlsValidation.unlock("سبب تدقيقي كافٍ", "secret"))
    }

    private fun command(
        amount: String = "100.00",
        rate: String = "1310.1250",
        requestId: String = "mobile-1",
    ) = ExchangeCommand(
        houseId = 3,
        branchId = 7,
        kind = ExchangeOperationKind.BUY_USD,
        currency = ExchangeCurrency.USD,
        amount = amount,
        exchangeRate = rate,
        clientRequestId = requestId,
    )
}

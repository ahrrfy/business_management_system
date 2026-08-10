package online.alarabiya.superapp.feature.crm

import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CampaignSummary
import online.alarabiya.superapp.model.crm.CustomerDetail
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerPage
import online.alarabiya.superapp.model.crm.CustomerType
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.model.crm.QuotationDetail
import online.alarabiya.superapp.model.crm.QuotationDraft
import online.alarabiya.superapp.model.crm.QuotationPage
import online.alarabiya.superapp.model.crm.QuotationStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmMutationSafetyTest {
    @Test
    fun `initial defaults never permit customer or quotation mutations`() {
        val state = CrmUiState(
            selectedCustomer = customer,
            selectedQuotation = quotation,
        )

        assertFalse(state.canCreateCustomer)
        assertFalse(state.canMutateSelectedCustomer)
        assertFalse(state.canCreateQuotation)
        assertFalse(state.canMutateSelectedQuotation)
    }

    @Test
    fun `idempotent customer create failure preserves its request id for retry`() {
        val requestId = "customer-request-123"
        val retryable = CrmUiState(
            customersLoaded = true,
            busyKey = "customer:save",
            customerEditor = CustomerEditor(null, CustomerDraft(name = "عميل", clientRequestId = requestId)),
        ).customerCreateRetryable("تعذر الحفظ")

        assertEquals(requestId, retryable.customerEditor?.draft?.clientRequestId)
        assertTrue(retryable.customersLoaded)
        assertFalse(retryable.canCreateCustomer)
    }

    @Test
    fun `customer commit closes editor and active transition becomes monotonic then stale`() {
        val committed = CrmUiState(
            customersLoaded = true,
            selectedCustomerFresh = true,
            selectedCustomer = customer,
            customerEditor = CustomerEditor(customer.id, CustomerDraft(name = customer.name)),
        ).customerSaveCommitted(customer.id)

        assertNull(committed.customerEditor)
        assertFalse(committed.customersLoaded)
        assertEquals(customer.id, committed.pendingCustomerRefreshId)
        assertFalse(committed.canMutateSelectedCustomer)

        val transitioned = CrmUiState(
            customersLoaded = true,
            selectedCustomerFresh = true,
            selectedCustomer = customer,
        ).customerActiveCommitted(false)
        assertFalse(transitioned.selectedCustomer?.isActive ?: true)
        assertFalse(transitioned.customersLoaded)
        assertFalse(transitioned.canMutateSelectedCustomer)

        val refreshed = transitioned.customersRefreshed(CustomerPage(emptyList(), 0), customer.copy(isActive = false))
        assertTrue(refreshed.customersLoaded)
        assertTrue(refreshed.selectedCustomerFresh)
        assertTrue(refreshed.canMutateSelectedCustomer)
        assertNull(refreshed.pendingCustomerRefreshId)
    }

    @Test
    fun `idempotent quotation create failure preserves request and status commit cannot repeat`() {
        val requestId = "quotation-request-123"
        val retryable = CrmUiState(
            quotationsLoaded = true,
            busyKey = "quotation:save",
            quotationEditor = QuotationEditor(null, QuotationDraft(clientRequestId = requestId)),
        ).quotationCreateRetryable("تعذر الحفظ")

        assertEquals(requestId, retryable.quotationEditor?.draft?.clientRequestId)
        assertTrue(retryable.quotationsLoaded)
        assertFalse(retryable.canCreateQuotation)

        val transitioned = CrmUiState(
            quotationsLoaded = true,
            selectedQuotationFresh = true,
            selectedQuotation = quotation,
        ).quotationStatusCommitted(QuotationStatus.SENT)
        assertEquals(QuotationStatus.SENT, transitioned.selectedQuotation?.status)
        assertFalse(transitioned.quotationsLoaded)
        assertFalse(transitioned.canMutateSelectedQuotation)
        assertEquals(quotation.id, transitioned.pendingQuotationRefreshId)

        val refreshed = transitioned.quotationsRefreshed(QuotationPage(emptyList(), false, null), quotation.copy(status = QuotationStatus.SENT))
        assertTrue(refreshed.canMutateSelectedQuotation)
        assertNull(refreshed.pendingQuotationRefreshId)
    }

    @Test
    fun `campaign transition is locally monotonic and remains locked until refresh`() {
        val campaign = CampaignSummary(31, "حملة", null, null, null, null, CampaignStatus.DRAFT)
        val transitioned = CrmUiState(
            campaignsLoaded = true,
            campaigns = listOf(campaign),
        ).campaignTransitionCommitted(campaign.id, CampaignStatus.REVIEW)

        assertEquals(CampaignStatus.REVIEW, transitioned.campaigns.single().status)
        assertFalse(transitioned.campaignsLoaded)
        assertFalse(transitioned.canMutateCampaign)
        assertEquals(campaign.id, transitioned.pendingCampaignRefreshId)

        val uncertain = CrmUiState(campaignsLoaded = true, campaigns = listOf(campaign))
            .campaignTransitionUncertain(campaign.id)
        assertTrue(uncertain.campaignMutationOutcomeUnknown)
        assertFalse(uncertain.canCreateCampaign)
        assertFalse(uncertain.canMutateCampaign)
    }

    @Test
    fun `customer operations require independently fresh note due and contract reads`() {
        val base = CrmUiState(
            customersLoaded = true,
            selectedCustomerFresh = true,
            selectedCustomer = customer,
            customerOperations = CustomerOperationsState(
                notesFresh = true,
                dueFresh = false,
                contractsFresh = false,
            ),
        )

        assertFalse(base.canMutateCustomerFollowUps)
        assertFalse(base.canMutateCustomerContracts)

        val fresh = base.copy(
            customerOperations = base.customerOperations.copy(dueFresh = true, contractsFresh = true),
        )
        assertTrue(fresh.canMutateCustomerFollowUps)
        assertTrue(fresh.canMutateCustomerContracts)

        val staleAfterCommit = fresh.copy(
            customerOperations = fresh.customerOperations.copy(notesFresh = false, contractsFresh = false),
        )
        assertFalse(staleAfterCommit.canMutateCustomerFollowUps)
        assertFalse(staleAfterCommit.canMutateCustomerContracts)
    }

    @Test
    fun `customer operations collapse to one column for phones and large text`() {
        assertFalse(customerOperationsUseTwoPane(widthDp = 412, fontScale = 1f))
        assertTrue(customerOperationsUseTwoPane(widthDp = 900, fontScale = 1f))
        assertFalse(customerOperationsUseTwoPane(widthDp = 900, fontScale = 2f))
    }

    private companion object {
        val customer = CustomerDetail(
            id = 7,
            name = "عميل",
            phone = null,
            phone2 = null,
            phone3 = null,
            whatsapp = null,
            address = null,
            city = null,
            district = null,
            customerType = CustomerType.Individual,
            priceTier = PriceTier.RETAIL,
            creditLimit = null,
            currentBalance = null,
            openingBalance = null,
            notes = null,
            waConsent = null,
            isActive = true,
        )

        val quotation = QuotationDetail(
            id = 19,
            quoteNumber = "Q-19",
            branchId = 1,
            customerId = null,
            customerName = null,
            customerPhone = null,
            priceTier = PriceTier.RETAIL,
            quoteDate = null,
            validUntil = null,
            subtotal = "0",
            taxAmount = "0",
            taxRatePercent = "0",
            discountAmount = "0",
            total = "0",
            status = QuotationStatus.DRAFT,
            convertedInvoiceId = null,
            notes = null,
            items = emptyList(),
        )
    }
}

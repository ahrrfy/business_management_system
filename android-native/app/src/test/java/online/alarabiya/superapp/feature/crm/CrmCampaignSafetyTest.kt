package online.alarabiya.superapp.feature.crm

import online.alarabiya.superapp.model.crm.CampaignDraft
import online.alarabiya.superapp.model.crm.CrmDashboard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmCampaignSafetyTest {
    @Test
    fun `campaign creation is blocked until workspace is freshly loaded`() {
        val initial = CrmUiState(campaignEditor = CampaignDraft(name = "حملة"))
        assertFalse(initial.canCreateCampaign)

        val loaded = initial.campaignsRefreshed(emptyList(), dashboard)
        assertTrue(loaded.canCreateCampaign)
    }

    @Test
    fun `successful create closes editor before refresh and cannot be submitted twice`() {
        val committed = CrmUiState(
            campaignsLoaded = true,
            busyKey = "campaign:save",
            campaignEditor = CampaignDraft(name = "حملة الصيف"),
        ).campaignCreateCommitted(91)

        assertNull(committed.campaignEditor)
        assertFalse(committed.campaignsLoaded)
        assertFalse(committed.canCreateCampaign)
        assertEquals(91L, committed.lastCreatedCampaignId)
        assertEquals("تم إنشاء الحملة", committed.message)
    }

    @Test
    fun `unknown non-idempotent create remains locked until fresh reconciliation`() {
        val uncertain = CrmUiState(
            campaignsLoaded = true,
            busyKey = "campaign:save",
            campaignEditor = CampaignDraft(name = "حملة الصيف"),
        ).campaignCreateUncertain()

        assertNull(uncertain.campaignEditor)
        assertTrue(uncertain.campaignCreateOutcomeUnknown)
        assertFalse(uncertain.canCreateCampaign)

        val reconciled = uncertain.campaignsRefreshed(emptyList(), dashboard)
        assertFalse(reconciled.campaignCreateOutcomeUnknown)
        assertTrue(reconciled.canCreateCampaign)
        assertNull(reconciled.lastCreatedCampaignId)
    }

    private companion object {
        val dashboard = CrmDashboard(
            campaignsTotal = 0,
            campaignsActive = 0,
            programsTotal = 0,
            programsActive = 0,
            redemptionsTotal = 0,
            redemptionDiscount = "0",
        )
    }
}

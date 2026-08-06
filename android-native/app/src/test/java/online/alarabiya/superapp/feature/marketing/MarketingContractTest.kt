package online.alarabiya.superapp.feature.marketing

import online.alarabiya.superapp.model.marketing.AnomalyCode
import online.alarabiya.superapp.model.marketing.CouponPreviewLineInput
import online.alarabiya.superapp.model.marketing.CouponPreviewRequest
import online.alarabiya.superapp.model.marketing.CouponProgram
import online.alarabiya.superapp.model.marketing.CouponProgramDraft
import online.alarabiya.superapp.model.marketing.CouponProgramStatus
import online.alarabiya.superapp.model.marketing.CustomerTier
import online.alarabiya.superapp.model.marketing.MarketingCapabilities
import online.alarabiya.superapp.model.marketing.MarketingPolicy
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.marketing.MarketingValidation
import online.alarabiya.superapp.model.marketing.PromotionDraft
import online.alarabiya.superapp.model.marketing.PromotionScope
import online.alarabiya.superapp.model.marketing.PromotionTarget
import online.alarabiya.superapp.model.marketing.PromotionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarketingContractTest {
    @Test
    fun `branch scope exposes global reads but fails closed for writes`() {
        val manager = MarketingScope("manager", 4)
        val admin = MarketingScope("admin", null)

        assertEquals(4L, manager.effectiveBranch(99))
        assertTrue(manager.acceptsVisibleBranch(null))
        assertTrue(manager.acceptsVisibleBranch(4))
        assertFalse(manager.acceptsVisibleBranch(5))
        assertFalse(manager.acceptsWriteBranch(null))
        assertTrue(manager.acceptsWriteBranch(4))
        assertEquals(9L, admin.effectiveBranch(9))
        assertTrue(admin.acceptsWriteBranch(null))
    }

    @Test
    fun `campaign and catalog quality gates remain separate`() {
        val accountant = MarketingCapabilities.from("accountant", "READ", "READ")
        val manager = MarketingCapabilities.from("manager", "FULL", "FULL")
        val cashier = MarketingCapabilities.from("cashier", "READ", "FULL")

        assertTrue(accountant.canReadCampaigns)
        assertFalse(accountant.canManageCampaigns)
        assertTrue(accountant.canReadCatalogQuality)
        assertTrue(manager.canManageCampaigns)
        assertTrue(manager.canManageCatalogQuality)
        assertFalse(cashier.canReadCatalogQuality)
        assertFalse(cashier.canManageCatalogQuality)
    }

    @Test
    fun `coupon lifecycle mirrors server transition table`() {
        assertEquals(
            setOf(CouponProgramStatus.Active, CouponProgramStatus.Ended),
            MarketingPolicy.allowedProgramTransitions(CouponProgramStatus.Draft),
        )
        assertEquals(
            setOf(CouponProgramStatus.Paused, CouponProgramStatus.Ended),
            MarketingPolicy.allowedProgramTransitions(CouponProgramStatus.Active),
        )
        assertTrue(MarketingPolicy.allowedProgramTransitions(CouponProgramStatus.Ended).isEmpty())
        assertFalse(
            MarketingPolicy.canManageProgram(
                program(branchId = null),
                MarketingScope("manager", 1),
                MarketingCapabilities.from("manager", "FULL", "FULL"),
            ),
        )
    }

    @Test
    fun `promotion validation rejects malformed discounts and missing scoped target`() {
        val valid = PromotionDraft(
            name = "عرض الصيف",
            type = PromotionType.Percent,
            discountValue = "15.50",
            scope = PromotionScope.Products,
            effectiveFrom = "2026-08-01",
            effectiveTo = "2026-08-31",
            targets = listOf(PromotionTarget(productId = 9)),
        )

        assertNull(MarketingValidation.promotion(valid))
        assertNotNull(MarketingValidation.promotion(valid.copy(discountValue = "101")))
        assertNotNull(MarketingValidation.promotion(valid.copy(targets = emptyList())))
        assertNotNull(MarketingValidation.promotion(valid.copy(effectiveTo = "2026-07-31")))
        assertNull(MarketingValidation.promotion(valid.copy(targets = emptyList()), editing = true))
    }

    @Test
    fun `coupon program validation follows server limits`() {
        val draft = CouponProgramDraft(
            promotionId = 7,
            name = "عملاء أغسطس",
            branchId = 2,
            validFrom = "2026-08-01",
            validTo = "2026-08-31",
            codePrefix = "AUG26",
        )

        assertNull(MarketingValidation.couponProgram(draft))
        assertNotNull(MarketingValidation.couponProgram(draft.copy(perCouponLimit = 0)))
        assertNotNull(MarketingValidation.couponProgram(draft.copy(color = "emerald")))
        assertNotNull(MarketingValidation.couponProgram(draft.copy(codePrefix = "TOO-LONG-PREFIX")))
    }

    @Test
    fun `price preview requires server contract identifiers and never accepts fractional quantity`() {
        val request = CouponPreviewRequest(
            code = "AUG26-AAAAA-BBBBB",
            branchId = 3,
            customerId = null,
            customerTier = CustomerTier.Retail,
            lines = listOf(
                CouponPreviewLineInput(
                    productId = 10,
                    variantId = 11,
                    productUnitId = 12,
                    unitPrice = "12500.00",
                    quantity = 2,
                ),
            ),
        )

        assertNull(MarketingValidation.couponPreview(request))
        assertNotNull(MarketingValidation.couponPreview(request.copy(branchId = 0)))
        assertNotNull(MarketingValidation.couponPreview(request.copy(lines = emptyList())))
        assertNotNull(MarketingValidation.couponPreview(request.copy(lines = listOf(request.lines.single().copy(unitPrice = "12.999")))))
    }

    @Test
    fun `documented gaps prohibit local price math and unsafe financial rollback`() {
        val text = MarketingApiGaps.current.joinToString(" ")
        assertTrue(text.contains("clientRequestId"))
        assertTrue(text.contains("crm.coupons.preview"))
        assertTrue(text.contains("sales.create"))
        assertTrue(text.contains("maker-checker"))
        assertTrue(text.contains("salesPromotions"))
    }

    @Test
    fun `unknown anomaly codes cannot be used for write actions`() {
        assertEquals(AnomalyCode.Unknown, AnomalyCode.fromWire("L99"))
    }

    private fun program(branchId: Long?) = CouponProgram(
        id = 1,
        campaignId = null,
        promotionId = 2,
        name = "برنامج",
        status = CouponProgramStatus.Draft,
        branchId = branchId,
        validFrom = "2026-08-01",
        validTo = null,
        perCouponLimit = 1,
        perCustomerLimit = 1,
        codePrefix = "CRM",
        designTitle = null,
        designSubtitle = null,
        designTerms = null,
        designColor = null,
        issued = 0,
        redeemed = 0,
        createdAt = null,
    )
}

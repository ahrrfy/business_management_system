package online.alarabiya.superapp.feature.crm

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.crm.CampaignDraft
import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CrmSection
import online.alarabiya.superapp.model.crm.CrmValidation
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerContractPriceDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUpDraft
import online.alarabiya.superapp.model.crm.QuotationDraft
import online.alarabiya.superapp.model.crm.QuotationLineDraft
import online.alarabiya.superapp.model.crm.WhatsappIntentSanitizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmPolicyTest {
    @Test
    fun capabilitiesKeepReadAndFullOperationsDistinct() {
        val capabilities = CrmCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(1, "موظف", null, null, "sales_rep"),
                modules = listOf(
                    ModuleAccess("crm", "العملاء", "READ"),
                    ModuleAccess("sales", "المبيعات", "FULL"),
                    ModuleAccess("campaigns", "الحملات", "NONE"),
                    ModuleAccess("products", "المنتجات", "READ"),
                ),
                branchId = 2,
                allBranches = false,
            ),
        )

        assertTrue(capabilities.customers.canRead)
        assertFalse(capabilities.customers.canWrite)
        assertTrue(capabilities.sales.canWrite)
        assertEquals(listOf(CrmSection.Customers, CrmSection.Quotations), capabilities.visibleSections)
    }

    @Test
    fun fullCustomerAuthorityExposesNativeFollowUpWorkspace() {
        val capabilities = CrmCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(1, "مدير", null, null, "manager"),
                modules = listOf(ModuleAccess("crm", "العملاء", "FULL")),
                branchId = 2,
                allBranches = false,
            ),
        )

        assertEquals(listOf(CrmSection.Customers, CrmSection.FollowUps), capabilities.visibleSections)
    }

    @Test
    fun whatsappTargetNormalizesPhoneAndEncodesUntrustedText() {
        assertEquals("9647701234567", WhatsappIntentSanitizer.normalizePhone("0770 123 4567"))
        assertEquals("9647701234567", WhatsappIntentSanitizer.normalizePhone("00964-770-123-4567"))
        assertNull(WhatsappIntentSanitizer.normalizePhone("javascript:alert(1)"))
        assertNull(WhatsappIntentSanitizer.normalizePhone("+9647701234567&evil=1"))

        val target = WhatsappIntentSanitizer.buildTarget(
            "+9647701234567",
            "عرض رقم 5 & وافق؟\nشكراً",
        )
        assertNotNull(target)
        assertEquals("9647701234567", target?.normalizedPhone)
        assertTrue(target!!.uri.startsWith("https://wa.me/9647701234567?text="))
        assertFalse(target.uri.substringAfter("?text=").contains('&'))
        assertTrue(target.uri.contains("%26"))
        assertTrue(target.uri.contains("%0A"))
    }

    @Test
    fun draftsRejectIncompleteOrInvalidBusinessInput() {
        assertEquals("اسم العميل مطلوب", CrmValidation.customer(CustomerDraft()))
        assertNull(CrmValidation.customer(CustomerDraft(name = "عميل", phone = "07701234567")))

        assertEquals("اختر الفرع", CrmValidation.quotation(QuotationDraft()))
        assertNull(
            CrmValidation.quotation(
                QuotationDraft(
                    branchId = 1,
                    lines = listOf(QuotationLineDraft(2, 3, "صنف", quantity = "1.5", unitPriceOverride = "100.00")),
                ),
            ),
        )
        assertEquals(
            "نسبة الضريبة غير صالحة",
            CrmValidation.quotation(
                QuotationDraft(
                    branchId = 1,
                    taxRatePercent = "101",
                    lines = listOf(QuotationLineDraft(2, 3, "صنف", quantity = "1")),
                ),
            ),
        )
        assertEquals(
            "تاريخ نهاية الحملة يسبق بدايتها",
            CrmValidation.campaign(CampaignDraft(name = "حملة", startsOn = "2026-09-01", endsOn = "2026-08-01")),
        )
    }

    @Test
    fun campaignTransitionsMirrorServerStateMachine() {
        val active = online.alarabiya.superapp.model.crm.CampaignSummary(
            id = 1,
            name = "حملة",
            objective = null,
            branchId = 1,
            startsOn = null,
            endsOn = null,
            status = CampaignStatus.ACTIVE,
        )
        assertEquals(listOf(CampaignStatus.PAUSED, CampaignStatus.ENDED), active.allowedTransitions())
    }

    @Test
    fun followUpAndContractDraftsFailClosedBeforeNetworkMutation() {
        assertEquals("نص المتابعة مطلوب", CrmValidation.followUp(CustomerFollowUpDraft()))
        assertEquals(
            "تاريخ المتابعة يجب أن يكون YYYY-MM-DD",
            CrmValidation.followUp(CustomerFollowUpDraft(note = "اتصال", followUpDate = "10/08/2026")),
        )
        assertNull(CrmValidation.followUp(CustomerFollowUpDraft(note = "اتصال", followUpDate = "2026-08-10")))

        assertEquals("اختر الصنف والوحدة", CrmValidation.contractPrice(CustomerContractPriceDraft()))
        assertEquals(
            "السعر التعاقدي يجب أن يكون أكبر من صفر وبدقة منزلتين",
            CrmValidation.contractPrice(CustomerContractPriceDraft(productUnitId = 8, price = "0")),
        )
        assertNull(CrmValidation.contractPrice(CustomerContractPriceDraft(productUnitId = 8, price = "125000.50")))
    }
}

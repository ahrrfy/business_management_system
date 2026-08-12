package online.alarabiya.superapp.feature.crm

import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CrmMappers
import online.alarabiya.superapp.model.crm.CustomerType
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.model.crm.QuotationStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmMappersTest {
    @Test
    fun mapsCustomerPageAndSensitiveFieldsOnlyWhenServerReturnsThem() {
        val page = CrmMappers.customerPage(
            mapOf(
                "total" to 1,
                "rows" to listOf(
                    mapOf(
                        "id" to 41,
                        "name" to "شركة بغداد الحديثة",
                        "phone" to "+9647701234567",
                        "whatsapp" to null,
                        "city" to "بغداد",
                        "customerType" to "شركة",
                        "defaultPriceTier" to "WHOLESALE",
                        "creditLimit" to null,
                        "currentBalance" to null,
                        "isActive" to true,
                    ),
                ),
            ),
        )

        assertEquals(1, page.total)
        assertEquals(CustomerType.Company, page.rows.single().customerType)
        assertEquals(PriceTier.WHOLESALE, page.rows.single().priceTier)
        assertNull(page.rows.single().currentBalance)
        assertTrue(page.rows.single().isActive)

        val detail = CrmMappers.customerDetail(
            mapOf(
                "id" to 41,
                "name" to "شركة بغداد الحديثة",
                "phone" to "+9647701234567",
                "phone2" to "+9647801234567",
                "whatsapp" to "+9647901234567",
                "address" to "شارع الصناعة",
                "city" to "بغداد",
                "district" to "الكرادة",
                "customerType" to "شركة",
                "defaultPriceTier" to "GOVERNMENT",
                "currentBalance" to "125000.00",
                "openingBalance" to "25000.00",
                "waConsent" to "OPTED_IN",
                "isActive" to false,
            ),
        )
        assertEquals("+9647901234567", detail.whatsapp)
        assertEquals("125000.00", detail.currentBalance)
        assertFalse(detail.isActive)
    }

    @Test
    fun mapsQuotationPaginationAndFullDetailLines() {
        val page = CrmMappers.quotationPage(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "id" to 90,
                        "quoteNumber" to "QUO-1-20260806-00001",
                        "total" to "450000.00",
                        "status" to "SENT",
                        "customerId" to 41,
                        "customerName" to "شركة بغداد الحديثة",
                        "customerPhone" to "+9647701234567",
                    ),
                ),
                "hasMore" to true,
                "nextCursor" to 89,
            ),
        )
        assertTrue(page.hasMore)
        assertEquals(89L, page.nextCursor)
        assertEquals(QuotationStatus.SENT, page.rows.single().status)

        val detail = CrmMappers.quotationDetail(
            mapOf(
                "id" to 90,
                "quoteNumber" to "QUO-1-20260806-00001",
                "branchId" to 1,
                "customerId" to 41,
                "customerName" to "شركة بغداد الحديثة",
                "priceTier" to "WHOLESALE",
                "subtotal" to "400000.00",
                "taxAmount" to "50000.00",
                "taxRatePercent" to "12.50",
                "discountAmount" to "0.00",
                "total" to "450000.00",
                "status" to "DRAFT",
                "items" to listOf(
                    mapOf(
                        "id" to 3,
                        "variantId" to 7,
                        "productUnitId" to 12,
                        "productName" to "ورق طباعة",
                        "variantName" to "A4",
                        "unitName" to "كرتون",
                        "sku" to "P-A4",
                        "quantity" to "2.000",
                        "unitPrice" to "200000.00",
                        "discountAmount" to "0.00",
                        "total" to "400000.00",
                    ),
                ),
            ),
        )
        assertTrue(detail.canEdit)
        assertEquals(12L, detail.items.single().productUnitId)
        assertEquals("ورق طباعة", detail.items.single().productName)
    }

    @Test
    fun mapsCatalogCampaignsAndDashboardUsingServerValues() {
        val catalog = CrmMappers.catalogOptions(
            listOf(
                mapOf(
                    "productId" to 2,
                    "productName" to "حبر",
                    "variantId" to 5,
                    "variantName" to "أسود",
                    "productUnitId" to 8,
                    "unitName" to "علبة",
                    "sku" to "INK-BLK",
                    "price" to "15000.00",
                    "promotionEffectivePrice" to "13500.00",
                    "availableBase" to 20,
                    "isService" to false,
                ),
            ),
        )
        assertEquals("13500.00", catalog.single().effectivePrice)
        assertEquals(20, catalog.single().availableBase)

        val campaigns = CrmMappers.campaigns(
            listOf(
                mapOf(
                    "id" to 6,
                    "name" to "العودة للمدارس",
                    "objective" to "زيادة مبيعات القرطاسية",
                    "status" to "ACTIVE",
                    "branchId" to null,
                ),
            ),
        )
        assertEquals(CampaignStatus.ACTIVE, campaigns.single().status)

        val dashboard = CrmMappers.dashboard(
            mapOf(
                "campaigns" to mapOf("total" to 10, "active" to 3),
                "couponPrograms" to mapOf("total" to 4, "active" to 2),
                "redemptions" to mapOf("total" to 50, "discount" to "250000.00"),
            ),
        )
        assertEquals(3, dashboard.campaignsActive)
        assertEquals("250000.00", dashboard.redemptionDiscount)
    }

    @Test
    fun mapsBranchScopedFollowUpsAndKeepsContractMoneyAsDecimalStrings() {
        val page = CrmMappers.customerFollowUpPage(
            mapOf(
                "total" to 1,
                "rows" to listOf(
                    mapOf(
                        "id" to 71,
                        "customerId" to 41,
                        "note" to "اتصال بشأن العقد",
                        "followUpDate" to "2026-08-10",
                        "isResolved" to false,
                        "branchId" to 7,
                        "createdByName" to "مدير الفرع",
                    ),
                ),
            ),
        )
        val due = CrmMappers.customerFollowUpPage(
            mapOf(
                "total" to 143,
                "rows" to listOf(
                    mapOf(
                        "id" to 71,
                        "customerId" to 41,
                        "customerName" to "شركة بغداد الحديثة",
                        "customerPhone" to "+9647701234567",
                        "note" to "اتصال بشأن العقد",
                        "followUpDate" to "2026-08-10",
                        "branchId" to 7,
                    ),
                ),
            ),
        )
        val contracts = CrmMappers.contractPricePage(
            mapOf(
                "total" to 101,
                "hasMore" to true,
                "nextCursor" to "opaque-cursor",
                "rows" to listOf(
                    mapOf(
                        "id" to 9,
                        "customerId" to 41,
                        "productUnitId" to 8,
                        "price" to "125000.50",
                        "isActive" to true,
                        "note" to "عقد 2026/14",
                        "productId" to 2,
                        "productName" to "ورق",
                        "variantName" to "A4",
                        "sku" to "P-A4",
                        "unitName" to "كرتون",
                    ),
                ),
            ),
        )

        assertEquals(7L, page.rows.single().branchId)
        assertEquals(143, due.total)
        assertEquals("شركة بغداد الحديثة", due.rows.single().customerName)
        assertFalse(due.rows.single().isResolved)
        assertEquals(101, contracts.total)
        assertTrue(contracts.hasMore)
        assertEquals("opaque-cursor", contracts.nextCursor)
        assertEquals("125000.50", contracts.rows.single().price)
        assertTrue(contracts.rows.single().productLabel.contains("ورق"))
        assertEquals(8L, contracts.rows.single().productUnitId)
    }
}

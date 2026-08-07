package online.alarabiya.superapp.feature.commerce

import online.alarabiya.superapp.model.commerce.CommerceMappers
import online.alarabiya.superapp.model.commerce.DigitalCardAvailability
import online.alarabiya.superapp.model.commerce.GiftDirection
import online.alarabiya.superapp.model.commerce.GiftStatus
import online.alarabiya.superapp.model.commerce.ReservationStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommerceMappersTest {
    @Test
    fun giftPageAndDetailsKeepServerCostRedaction() {
        val page = CommerceMappers.giftPage(
            mapOf(
                "total" to 1,
                "hasMore" to false,
                "nextCursor" to null,
                "rows" to listOf(
                    mapOf(
                        "id" to 7,
                        "giftNumber" to "G-2026-7",
                        "direction" to "OUT",
                        "branchId" to 2,
                        "status" to "PENDING_APPROVAL",
                        "reason" to "تعويض عميل",
                        "sellable" to true,
                        "customerName" to "أحمد",
                        "estimatedValue" to "25000.00",
                        "totalCost" to null,
                    ),
                ),
            ),
        )
        val detail = CommerceMappers.giftDetail(
            mapOf(
                "id" to 7,
                "giftNumber" to "G-2026-7",
                "direction" to "OUT",
                "branchId" to 2,
                "status" to "PENDING_APPROVAL",
                "partyName" to "أحمد",
                "partyPhone" to "07700000000",
                "sellable" to true,
                "lines" to listOf(
                    mapOf(
                        "productName" to "دفتر",
                        "sku" to "SKU-1",
                        "unitName" to "قطعة",
                        "quantity" to 2,
                        "baseQuantity" to 2,
                    ),
                ),
            ),
        )

        assertEquals(1, page.total)
        assertEquals(GiftDirection.OUT, page.rows.single().direction)
        assertEquals(GiftStatus.PENDING_APPROVAL, page.rows.single().status)
        assertEquals("أحمد", page.rows.single().partyName)
        assertNull(page.rows.single().totalCost)
        assertEquals("دفتر", detail.lines.single().productName)
        assertEquals("2", detail.lines.single().quantity)
    }

    @Test
    fun reservationDetailUsesServerCalculatedTotalsAndPricingFlag() {
        val detail = CommerceMappers.reservationDetail(
            mapOf(
                "id" to 12,
                "reservationNumber" to "RSV-12",
                "branchId" to 3,
                "contactName" to "سارة",
                "contactPhone" to "07800000000",
                "status" to "ACTIVE",
                "expiresAt" to "2026-08-07T12:00:00.000Z",
                "total" to "15000.00",
                "hasUnpriced" to true,
                "lines" to listOf(
                    mapOf(
                        "id" to 4,
                        "productName" to "قلم",
                        "unitName" to "قطعة",
                        "quantity" to 3,
                        "fulfilledBase" to 0,
                        "quotedUnitPrice" to "5000.00",
                        "lineTotal" to "15000.00",
                    ),
                ),
            ),
        )
        val conversion = CommerceMappers.conversion(
            mapOf(
                "reservationId" to 12,
                "invoiceId" to 77,
                "invoiceNumber" to "INV-77",
                "total" to "15000.00",
                "status" to "PENDING",
                "idempotentReplay" to true,
            ),
        )

        assertEquals(ReservationStatus.ACTIVE, detail.summary.status)
        assertEquals("15000.00", detail.total)
        assertTrue(detail.hasUnpriced)
        assertEquals("15000.00", detail.lines.single().lineTotal)
        assertEquals("INV-77", conversion.invoiceNumber)
        assertTrue(conversion.idempotentReplay)
    }

    @Test
    fun digitalCardAndSubscriptionMapsOnlyPublishedMobileFields() {
        val branches = CommerceMappers.branches(
            listOf(mapOf("id" to 3, "name" to "فرع الكرادة", "code" to "KRD")),
        )
        val cards = CommerceMappers.digitalCards(
            listOf(
                mapOf(
                    "offeringId" to 18,
                    "name" to "بطاقة 10",
                    "providerId" to 2,
                    "providerName" to "المزوّد",
                    "offeringType" to "TELECOM_CARD",
                    "requiresStudentData" to false,
                    "faceValue" to "10.00",
                    "sellPrice" to "12000.00",
                    "priceVersionId" to 44,
                    "isFavorite" to true,
                    "availability" to "READY",
                ),
            ),
        )
        val subscriptions = CommerceMappers.subscriptions(
            listOf(
                mapOf(
                    "id" to 6,
                    "offeringName" to "تعليم شهر",
                    "branchId" to 1,
                    "invoiceId" to 90,
                    "studentName" to "نور",
                    "durationDays" to 30,
                    "status" to "ACTIVE",
                ),
            ),
        )

        assertEquals("فرع الكرادة", branches.single().name)
        assertEquals(DigitalCardAvailability.READY, cards.single().availability)
        assertTrue(cards.single().canConfirm)
        assertEquals("12000.00", cards.single().sellPrice)
        assertFalse(cards.single().requiresStudentData)
        assertEquals("نور", subscriptions.single().studentName)
        assertEquals(30, subscriptions.single().durationDays)
    }
}

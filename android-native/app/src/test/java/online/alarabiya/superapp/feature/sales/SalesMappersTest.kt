package online.alarabiya.superapp.feature.sales

import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.SalesMappers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SalesMappersTest {
    @Test
    fun `catalog preserves server price stock and unit identity`() {
        val rows = SalesMappers.catalog(
            listOf(
                mapOf(
                    "productId" to 1,
                    "productName" to "دفتر",
                    "variantId" to "2",
                    "sku" to "NB-01",
                    "productUnitId" to 3L,
                    "unitName" to "حبة",
                    "conversionFactor" to "1.000",
                    "price" to "1250.50",
                    "availableBase" to "11",
                    "isService" to false,
                    "isBundle" to false,
                    "isContractPrice" to true,
                ),
            ),
        )

        val row = rows.single()
        assertEquals(2L, row.variantId)
        assertEquals(3L, row.productUnitId)
        assertEquals("1250.50", row.serverPrice)
        assertEquals(11, row.availableBase)
        assertTrue(row.isContractPrice)
    }

    @Test
    fun `history pagination accepts decimal strings without client arithmetic`() {
        val page = SalesMappers.page(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "id" to 8,
                        "invoiceNumber" to "INV-8",
                        "total" to "101.257",
                        "paidAmount" to "100.00",
                        "returnedTotal" to "1.257",
                        "status" to "PARTIALLY_RETURNED",
                        "branchId" to 2,
                    ),
                ),
                "nextCursor" to "7",
                "hasMore" to true,
            ),
        )

        assertEquals("101.257", page.rows.single().total)
        assertEquals(7L, page.nextCursor)
        assertTrue(page.hasMore)
    }

    @Test
    fun `customer defaults unknown tier safely`() {
        val rows = SalesMappers.customers(
            mapOf("rows" to listOf(mapOf("id" to 4, "name" to "عميل", "defaultPriceTier" to "UNKNOWN"))),
        )

        assertEquals(PriceTier.RETAIL, rows.single().priceTier)
        assertNull(rows.single().phone)
    }

    /**
     * الاختبارُ السابق كان يُغذّي المُحوِّل خريطةً **بالشكل القديم** بلا `mode` — شكلٌ لم يعد
     * الخادمُ يُرجعه ⇒ أخضرُ أبداً بينما التطبيق يعرض «تم تسجيل المرتجع بقيمة 0» على الإنتاج.
     * الآن نختبر الشكلين الحقيقيَّين ونُثبت أنّ المجهولَ **يُرمى** لا يُبتلَع.
     */
    @Test
    fun `executed return maps server authority flags`() {
        val result = SalesMappers.returnCreation(
            mapOf(
                "mode" to "EXECUTED",
                "invoiceId" to 5,
                "returnedTotal" to "28.75",
                "fullyReturned" to false,
                "idempotentReplay" to true,
            ),
        )

        val executed = result as ReturnCreation.Executed
        assertEquals(5L, executed.invoiceId)
        assertEquals("28.75", executed.returnedTotal)
        assertFalse(executed.fullyReturned)
        assertTrue(executed.idempotentReplay)
    }

    @Test
    fun `requested return maps to a pending request, never to a zero-value success`() {
        val result = SalesMappers.returnCreation(
            mapOf("mode" to "REQUESTED", "requestId" to 91, "status" to "PENDING", "replayed" to false),
        )

        val requested = result as ReturnCreation.Requested
        assertEquals(91L, requested.requestId)
        assertEquals("PENDING", requested.status)
        assertFalse(requested.replayed)
    }

    @Test
    fun `unknown mode fails loudly instead of defaulting to zero`() {
        // الشكلُ القديم بلا `mode` هو بالضبط ما كان يُبتلَع — يجب أن يسقط صريحاً الآن.
        assertThrows(IllegalStateException::class.java) {
            SalesMappers.returnCreation(
                mapOf("invoiceId" to 5, "returnedTotal" to "28.75", "fullyReturned" to false),
            )
        }
    }
}

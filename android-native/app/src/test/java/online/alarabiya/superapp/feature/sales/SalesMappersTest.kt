package online.alarabiya.superapp.feature.sales

import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.SalesMappers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test
    fun `return result maps server authority flags`() {
        val result = SalesMappers.returnCreation(
            mapOf("invoiceId" to 5, "returnedTotal" to "28.75", "fullyReturned" to false, "idempotentReplay" to true),
        )

        assertEquals("28.75", result.returnedTotal)
        assertFalse(result.fullyReturned)
        assertTrue(result.idempotentReplay)
    }
}

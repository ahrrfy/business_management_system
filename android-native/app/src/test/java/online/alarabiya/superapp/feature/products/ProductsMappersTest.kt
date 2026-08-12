package online.alarabiya.superapp.feature.products

import online.alarabiya.superapp.model.products.PrintCategory
import online.alarabiya.superapp.model.products.ProductTier
import online.alarabiya.superapp.model.products.ProductsMappers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductsMappersTest {
    @Test
    fun `catalog keeps server money as text and redacted fields nullable`() {
        val page = ProductsMappers.page(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "productId" to 1, "productName" to "ورق", "productIsActive" to true,
                        "variantId" to 2, "sku" to "P-1", "productUnitId" to 3, "unitName" to "رزمة",
                        "price" to "12500.50", "wholesalePrice" to null, "governmentPrice" to null,
                        "costPrice" to null, "stockBase" to "9", "barcodeAliases" to listOf("A", "B"),
                    ),
                ),
                "total" to "1",
            ),
        )

        val row = page.rows.single()
        assertEquals("12500.50", row.price(ProductTier.RETAIL))
        assertNull(row.costPrice)
        assertEquals(listOf("A", "B"), row.barcodeAliases)
        assertEquals(9, row.stockBase)
    }

    @Test
    fun `price preview preserves below-cost decision from server`() {
        val preview = ProductsMappers.wavePreview(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "productUnitId" to 3, "productName" to "حبر", "sku" to "INK", "unitName" to "حبة",
                        "priceTier" to "WHOLESALE", "oldPrice" to "100", "newPrice" to "80", "costPrice" to "90", "belowCost" to true,
                    ),
                ),
                "belowCostCount" to 1,
            ),
        )

        assertTrue(preview.rows.single().belowCost)
        assertEquals(ProductTier.WHOLESALE, preview.rows.single().tier)
        assertEquals("80", preview.rows.single().newPrice)
    }

    @Test
    fun `print estimate maps only authoritative result`() {
        val result = ProductsMappers.estimate(
            mapOf(
                "category" to "WIDE", "areaSqm" to "2.500", "units" to 2,
                "lines" to listOf(mapOf("key" to "print", "label" to "طباعة", "amount" to "25.00")),
                "totalCost" to "25.00", "pricingMode" to "MARGIN", "marginPercent" to "20",
                "suggestedPrice" to "30.00", "unitPrice" to "15.00",
            ),
        )

        assertEquals(PrintCategory.WIDE, result.category)
        assertEquals("30.00", result.suggestedPrice)
        assertEquals("2.500", result.areaSqm)
        assertFalse(result.lines.isEmpty())
    }
}

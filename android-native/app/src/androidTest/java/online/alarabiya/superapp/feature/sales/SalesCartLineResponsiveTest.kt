package online.alarabiya.superapp.feature.sales

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.sales.CartLine
import online.alarabiya.superapp.model.sales.CatalogSaleItem
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SalesCartLineResponsiveTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun compactCartLine_keepsTextAndAllActionsInsideBounds_at200PercentFontScale() {
        val item = CatalogSaleItem(
            productId = 1,
            productName = "دفتر ملاحظات احترافي طويل الاسم للاختبار البصري",
            variantId = 2,
            variantName = "غلاف مقوّى",
            color = null,
            size = null,
            sku = "NOTE-001",
            productUnitId = 3,
            unitName = "قطعة",
            conversionFactor = "1",
            barcode = null,
            serverPrice = "12500",
            availableBase = 20,
            openedAt = null,
            isService = false,
            isBundle = false,
            isContractPrice = false,
            promotionName = null,
        )
        val line = CartLine(item, "12")

        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 1f, fontScale = 2f)) {
                MaterialTheme {
                    Box(Modifier.width(320.dp).padding(16.dp).testTag("cart-host")) {
                        CartLineCard(line, locked = false, onQuantity = { _, _ -> }, onRemove = {})
                    }
                }
            }
        }

        compose.onNodeWithText(item.label).assertIsDisplayed()
        compose.onNodeWithText("الكمية").assertIsDisplayed()
        val actions = listOf(
            compose.onNodeWithContentDescription("تقليل كمية ${item.label}"),
            compose.onNodeWithContentDescription("زيادة كمية ${item.label}"),
            compose.onNodeWithContentDescription("إزالة ${item.label} من السلة"),
        )
        val host = compose.onNodeWithTag("cart-host").fetchSemanticsNode().boundsInRoot
        actions.forEach { node ->
            node.assertIsDisplayed()
            val bounds = node.fetchSemanticsNode().boundsInRoot
            assertTrue("action starts before compact host", bounds.left >= host.left)
            assertTrue("action ends after compact host", bounds.right <= host.right)
        }
    }
}

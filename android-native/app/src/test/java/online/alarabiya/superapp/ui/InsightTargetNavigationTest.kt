package online.alarabiya.superapp.ui

import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule
import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.SearchEntityType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InsightTargetNavigationTest {
    @Test
    fun supportedSearchEntitiesRetainTheirTypeAndIdentifier() {
        val cases = listOf(
            Triple(SearchEntityType.INVOICE, NativeModule.SALES, "invoice-41"),
            Triple(SearchEntityType.QUOTATION, NativeModule.SALES, "quotation-42"),
            Triple(SearchEntityType.PURCHASE_ORDER, NativeModule.PURCHASES, "order-43"),
            Triple(SearchEntityType.WORK_ORDER, NativeModule.WORK_ORDERS, "order-44"),
            Triple(SearchEntityType.CUSTOMER, NativeModule.CRM, "customer-45"),
            Triple(SearchEntityType.SUPPLIER, NativeModule.SUPPLIERS, "supplier-46"),
        )

        cases.forEachIndexed { index, (type, module, entityId) ->
            val destination = InsightTarget(type, 41L + index).toNativeDestination()
            assertEquals(module, destination?.module)
            assertEquals(NativeFeatureIntent.VIEW, destination?.intent)
            assertEquals(entityId, destination?.entityId)
        }
    }

    @Test
    fun entitiesWithoutANativeDetailLookupDoNotPretendToNavigate() {
        listOf(
            SearchEntityType.PRODUCT,
            SearchEntityType.EXPENSE,
            SearchEntityType.EMPLOYEE,
            SearchEntityType.USER,
        ).forEach { type ->
            assertNull(type.name, InsightTarget(type, 7).toNativeDestination())
        }
    }
}

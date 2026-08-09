package online.alarabiya.superapp.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class CompactNestedBackCoverageTest {
    @Test
    fun everyNativeCompactDetailOrEditorHasAnExplicitBackContract() {
        assertEquals(
            setOf(
                "native-approvals",
                "native-accounting-controls",
                "native-admin",
                "native-crm",
                "native-conversations",
                "native-commerce",
                "native-collaboration",
                "native-receivables",
                "native-collections",
                "native-marketing",
                "native-operations",
                "native-inventory",
                "native-hr-admin",
                "native-sales",
                "native-purchasing",
                "native-work-orders",
                "native-warehouse-tools",
                "native-store-delivery",
                "native-store-admin",
                "native-finance",
                "native-shifts",
                "native-products",
                "native-profile",
            ),
            compactNestedBackRouteNames,
        )
    }
}

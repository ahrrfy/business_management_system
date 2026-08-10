package online.alarabiya.superapp.ui

import online.alarabiya.superapp.core.navigation.NativeScreen
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionBranchModuleWiringTest {
    @Test
    fun everyOperationalBranchWorkspaceIsGatedByTheUnifiedSessionSelector() {
        assertEquals(
            setOf(
                NativeScreen.CONVERSATIONS,
                NativeScreen.COLLABORATION,
                NativeScreen.INVENTORY,
                NativeScreen.SALES,
                NativeScreen.PURCHASING,
                NativeScreen.WORK_ORDERS,
                NativeScreen.WAREHOUSE_TOOLS,
                NativeScreen.PRODUCTS,
            ),
            sessionBranchRequiredScreens,
        )
    }
}

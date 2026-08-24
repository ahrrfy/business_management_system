package online.alarabiya.superapp.feature.notifications

import online.alarabiya.superapp.core.navigation.NativeDestination
import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationRouteMapperTest {
    @Test
    fun knownFragmentsMapToTheirNativeDestinations() {
        assertEquals(NativeDestination.Approvals, mapNotificationRouteToDestination("/mobile#approvals"))
        assertEquals(NativeDestination.Tasks, mapNotificationRouteToDestination("/mobile#tasks/17"))
        assertEquals(NativeDestination.Shifts, mapNotificationRouteToDestination("/mobile#shifts"))
        assertEquals(NativeDestination.WorkOrders, mapNotificationRouteToDestination("/mobile#workorders"))
        assertEquals(NativeDestination.Collaboration, mapNotificationRouteToDestination("/mobile#chat"))
        assertEquals(NativeDestination.Receivables, mapNotificationRouteToDestination("/mobile#receivables"))
        assertEquals(NativeDestination.Insights, mapNotificationRouteToDestination("/mobile#insights"))
        assertEquals(NativeDestination.Operations, mapNotificationRouteToDestination("/mobile#operations"))
        assertEquals(NativeDestination.Alerts, mapNotificationRouteToDestination("/mobile#notifications"))
    }

    @Test
    fun payrollFamilyRoutesLandOnSelfServiceUntilDeepLinkParserExists() {
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("/mobile#payroll"))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("/mobile#payslip/42"))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("/mobile#leave"))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("/mobile#attendance"))
    }

    @Test
    fun unknownFragmentDegradesToSelfServiceRatherThanCrash() {
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("/mobile#outer-space"))
    }

    @Test
    fun bareMobileRouteLandsOnHomeSinceItCarriesNoSectionHint() {
        // safeInternalRoute() on the server clamps any invalid path to "/mobile"; treating that
        // as the app entry point is safe and predictable — no crash, no wrong context.
        assertEquals(NativeDestination.Home, mapNotificationRouteToDestination("/mobile"))
    }

    @Test
    fun rejectsUnsafeRoutesByFallingBackToSelfService() {
        // safeInternalRoute on the server should have clamped these already; belt-and-suspenders
        // ensures we never obey an open-redirect-style payload if a mistaken caller slips one in.
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("https://evil.example/"))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination("//evil.example/"))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination(null))
        assertEquals(NativeDestination.SelfService, mapNotificationRouteToDestination(""))
    }

    @Test
    fun homeFragmentMapsToHome() {
        assertEquals(NativeDestination.Home, mapNotificationRouteToDestination("/mobile#home"))
    }
}

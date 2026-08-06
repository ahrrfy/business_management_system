package online.alarabiya.superapp.core.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBackStackTest {
    private val principal = NavigationPrincipal(
        authenticated = true,
        grants = mapOf(NativeModule.SALES to ModuleGrant.FULL),
    )

    @Test
    fun `open and back are deterministic and keep a root`() {
        val initial = NativeBackStack.initial()
        assertFalse(initial.canGoBack)

        val module = changed(
            initial.dispatch(
                NativeNavigationRequest.Open(NativeDestination.Module(NativeModule.SALES)),
                principal,
            ),
        )
        assertTrue(module.canGoBack)
        assertEquals(NativeDestination.Module(NativeModule.SALES), module.current)

        val duplicate = changed(
            module.dispatch(
                NativeNavigationRequest.Open(NativeDestination.Module(NativeModule.SALES)),
                principal,
            ),
        )
        assertEquals(module, duplicate)

        val home = changed(module.dispatch(NativeNavigationRequest.Back, principal))
        assertEquals(NativeDestination.Home, home.current)
        assertFalse(home.canGoBack)
        assertEquals(home, changed(home.dispatch(NativeNavigationRequest.Back, principal)))
    }

    @Test
    fun `denied and invalid navigation never mutate the stack`() {
        val initial = NativeBackStack.initial()
        val denied = initial.dispatch(
            NativeNavigationRequest.Open(NativeDestination.Module(NativeModule.INVENTORY)),
            principal,
        )
        assertEquals(
            NativeNavigationResult.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            denied,
        )
        assertEquals(NativeDestination.Home, initial.current)

        val invalid = initial.dispatch(
            NativeNavigationRequest.OpenDeepLink("https://example.invalid/pos"),
            principal,
        )
        assertTrue(invalid is NativeNavigationResult.InvalidDeepLink)
        assertEquals(NativeDestination.Home, initial.current)
    }

    @Test
    fun `deep links pass through parsing and authorization`() {
        val destination = NativeDestination.Feature(
            NativeModule.SALES,
            NativeFeatureIntent.VIEW,
            "invoice-9",
        )
        val result = NativeBackStack.initial().dispatch(
            NativeNavigationRequest.OpenDeepLink(NativeDeepLinkCodec.encode(destination)),
            principal,
        )

        assertEquals(destination, changed(result).current)
    }

    private fun changed(result: NativeNavigationResult): NativeBackStack =
        (result as NativeNavigationResult.Changed).stack
}

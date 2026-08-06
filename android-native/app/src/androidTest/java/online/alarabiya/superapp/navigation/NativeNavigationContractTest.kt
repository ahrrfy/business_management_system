package online.alarabiya.superapp.navigation

import androidx.test.ext.junit.runners.AndroidJUnit4
import online.alarabiya.superapp.core.navigation.AccessDecision
import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.ModuleGrant
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule
import online.alarabiya.superapp.core.navigation.NativeNavigationRegistry
import online.alarabiya.superapp.core.navigation.NavigationPrincipal
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeNavigationContractTest {
    @Test
    fun privateDeepLinkResolvesToAuthorizedTypedDestination() {
        val destination = NativeDestination.Feature(
            module = NativeModule.INVENTORY,
            intent = NativeFeatureIntent.VIEW,
            entityId = "stock-item-42",
        )
        val parsed = NativeDeepLinkCodec.parse(NativeDeepLinkCodec.encode(destination))
        assertEquals(DeepLinkResult.Accepted(destination), parsed)

        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.INVENTORY to ModuleGrant.READ),
        )
        assertEquals(
            AccessDecision.Allowed,
            NativeNavigationRegistry.Default.authorize(destination, principal),
        )
    }
}

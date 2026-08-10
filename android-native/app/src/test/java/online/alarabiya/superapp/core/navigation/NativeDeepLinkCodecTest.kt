package online.alarabiya.superapp.core.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeDeepLinkCodecTest {
    @Test
    fun `every registered destination round trips through the private scheme`() {
        val registry = NativeNavigationRegistry.Default
        val destinations = buildList {
            add(NativeDestination.Home)
            add(NativeDestination.ModuleDirectory)
            add(NativeDestination.SelfService)
            add(NativeDestination.Tasks)
            add(NativeDestination.Alerts)
            add(NativeDestination.Approvals)
            add(NativeDestination.AccountingControls)
            add(NativeDestination.Collaboration)
            add(NativeDestination.Marketing)
            add(NativeDestination.Operations)
            add(NativeDestination.CrmWorkspace)
            add(NativeDestination.Receivables)
            add(NativeDestination.Collections)
            add(NativeDestination.Insights)
            add(NativeDestination.Shifts)
            add(NativeDestination.WorkOrders)
            add(NativeDestination.WarehouseTools)
            add(NativeDestination.StoreAdmin)
            add(NativeDestination.Profile)
            registry.modules.forEach { module ->
                add(NativeDestination.Module(module))
                registry.spec(module).supportedIntents.forEach { intent ->
                    val entityId = when (intent.entityRequirement) {
                        EntityRequirement.FORBIDDEN -> null
                        EntityRequirement.OPTIONAL,
                        EntityRequirement.REQUIRED,
                        -> "record_2026-42"
                    }
                    add(NativeDestination.Feature(module, intent, entityId))
                }
            }
        }

        destinations.forEach { destination ->
            val encoded = NativeDeepLinkCodec.encode(destination)
            assertTrue(encoded.startsWith("${NativeDeepLinkCodec.SCHEME}://${NativeDeepLinkCodec.AUTHORITY}/"))
            assertFalse(encoded.contains("http", ignoreCase = true))
            assertEquals(DeepLinkResult.Accepted(destination), NativeDeepLinkCodec.parse(encoded))
        }
    }

    @Test
    fun `store administration link is explicit and cannot be confused with store operations`() {
        val admin = NativeDeepLinkCodec.encode(NativeDestination.StoreAdmin)
        val operations = NativeDeepLinkCodec.encode(NativeDestination.Module(NativeModule.STORE))

        assertEquals("alrueya://app/store-admin", admin)
        assertEquals("alrueya://app/module/store", operations)
        assertEquals(DeepLinkResult.Accepted(NativeDestination.StoreAdmin), NativeDeepLinkCodec.parse(admin))
        assertEquals(
            DeepLinkResult.Accepted(NativeDestination.Module(NativeModule.STORE)),
            NativeDeepLinkCodec.parse(operations),
        )
    }

    @Test
    fun `external and browser-style locations are rejected`() {
        val disallowed = listOf(
            "http://example.invalid/pos",
            "https://example.invalid/mobile",
            "file:///data/local/private",
            "intent://app/module/sales#Intent;end",
            "javascript:alert(1)",
            "/pos",
            "/sales",
            "/inventory",
            "/mobile",
            "/dashboard",
            "//example.invalid/pos",
        )

        disallowed.forEach { candidate ->
            assertTrue("Expected rejection for $candidate", NativeDeepLinkCodec.parse(candidate) is DeepLinkResult.Rejected)
        }
    }

    @Test
    fun `ambiguous or unknown private links are rejected`() {
        val disallowed = listOf(
            "alrueya://wrong/home",
            "alrueya://user@app/home",
            "alrueya://app:443/home",
            "alrueya://app/home?next=module",
            "alrueya://app/home#fragment",
            "alrueya://app//home",
            "alrueya://app/home/",
            "alrueya://app/module/unknown",
            "alrueya://app/module/sales/delete",
            "alrueya://app/module/sales/view",
            "alrueya://app/module/sales/browse/unexpected",
            "alrueya://app/module/sales/view/%2e%2e",
            "alrueya://app/module/sales/view/a%2fb",
            "alrueya://app/module/collections/create",
        )

        disallowed.forEach { candidate ->
            assertTrue("Expected rejection for $candidate", NativeDeepLinkCodec.parse(candidate) is DeepLinkResult.Rejected)
        }
    }
}

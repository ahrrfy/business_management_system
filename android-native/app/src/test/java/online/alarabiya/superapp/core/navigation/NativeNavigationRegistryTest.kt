package online.alarabiya.superapp.core.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNavigationRegistryTest {
    private val registry = NativeNavigationRegistry.Default

    @Test
    fun `registry contains the full permission module catalogue`() {
        val expected = setOf(
            "crm", "campaigns", "collections", "pos", "sales", "purchases", "inventory",
            "workorders", "channels", "tasks", "store", "treasury", "suppliers", "products",
            "expenses", "reports", "assets", "hr", "commissions", "consignments",
            "reservations", "digital_cards", "gifts", "catalogAnomalies", "courier", "users",
            "settings",
        )

        assertEquals(27, registry.modules.size)
        assertEquals(expected, registry.modules.map(NativeModule::wireName).toSet())
        assertTrue(registry.modules.all { registry.spec(it).supportedIntents.isNotEmpty() })
    }

    @Test
    fun `authentication and module grants gate destinations`() {
        val unauthenticated = NavigationPrincipal(authenticated = false)
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.NOT_AUTHENTICATED),
            registry.authorize(NativeDestination.Home, unauthenticated),
        )

        val salesReader = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.SALES to ModuleGrant.READ),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Module(NativeModule.SALES), salesReader))
        assertEquals(
            AccessDecision.Allowed,
            registry.authorize(
                NativeDestination.Feature(NativeModule.SALES, NativeFeatureIntent.VIEW, "invoice-1"),
                salesReader,
            ),
        )
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.FULL_ACCESS_REQUIRED),
            registry.authorize(
                NativeDestination.Feature(NativeModule.SALES, NativeFeatureIntent.CREATE),
                salesReader,
            ),
        )
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.Module(NativeModule.INVENTORY), salesReader),
        )
    }

    @Test
    fun `special destinations enforce their operational scopes`() {
        assertEquals(
            AccessDecision.Allowed,
            registry.authorize(NativeDestination.SelfService, NavigationPrincipal(authenticated = true)),
        )
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.CAPABILITY_NOT_AVAILABLE),
            registry.authorize(
                NativeDestination.SelfService,
                NavigationPrincipal(authenticated = true, hasPersonalWorkspace = false),
            ),
        )
        val aggregateReader = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(
                NativeModule.TASKS to ModuleGrant.READ,
                NativeModule.REPORTS to ModuleGrant.READ,
                NativeModule.CAMPAIGNS to ModuleGrant.READ,
                NativeModule.ASSETS to ModuleGrant.READ,
                NativeModule.CRM to ModuleGrant.READ,
                NativeModule.INVENTORY to ModuleGrant.READ,
                NativeModule.PRODUCTS to ModuleGrant.READ,
            ),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Collaboration, aggregateReader))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.AccountingControls, aggregateReader))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Marketing, aggregateReader))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Operations, aggregateReader))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.CrmWorkspace, aggregateReader))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.WarehouseTools, aggregateReader))
        val taskReader = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.TASKS to ModuleGrant.READ),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Tasks, taskReader))
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.NO_APPROVAL_SCOPE),
            registry.authorize(NativeDestination.Approvals, taskReader),
        )

        val purchaseApprover = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.PURCHASES to ModuleGrant.FULL),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Approvals, purchaseApprover))
    }

    @Test
    fun `registry rejects capabilities outside a module contract`() {
        val administrator = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.REPORTS to ModuleGrant.FULL),
        )
        val unsupported = NativeDestination.Feature(
            NativeModule.REPORTS,
            NativeFeatureIntent.CREATE,
        )

        assertEquals(
            AccessDecision.Denied(AccessDenialReason.CAPABILITY_NOT_AVAILABLE),
            registry.authorize(unsupported, administrator),
        )
    }

    @Test
    fun `financial aggregate destinations fail closed without grants and collections has no create`() {
        val noGrants = NavigationPrincipal(authenticated = true, role = "manager")
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.Receivables, noGrants),
        )
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.Collections, noGrants),
        )
        assertEquals(
            AccessDecision.Allowed,
            registry.authorize(
                NativeDestination.Collections,
                noGrants.copy(grants = mapOf(NativeModule.COLLECTIONS to ModuleGrant.FULL)),
            ),
        )
        assertTrue(
            NativeDeepLinkCodec.parse("alrueya://app/module/collections/create") is DeepLinkResult.Rejected,
        )
    }

    @Test
    fun `aggregate routes follow grants for custom roles`() {
        val customRole = NavigationPrincipal(
            authenticated = true,
            role = "finance_specialist",
            grants = mapOf(
                NativeModule.COLLECTIONS to ModuleGrant.FULL,
                NativeModule.REPORTS to ModuleGrant.READ,
            ),
        )

        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Collections, customRole))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Receivables, customRole))
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Insights, customRole))
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.Marketing, customRole),
        )
    }

    @Test
    fun `insights authorization matches every module that can make insights visible`() {
        val readableModules = setOf(
            NativeModule.REPORTS,
            NativeModule.STORE,
            NativeModule.PRODUCTS,
            NativeModule.SALES,
            NativeModule.PURCHASES,
            NativeModule.WORK_ORDERS,
            NativeModule.CRM,
            NativeModule.SUPPLIERS,
            NativeModule.EXPENSES,
            NativeModule.HR,
        )

        readableModules.forEach { module ->
            val principal = NavigationPrincipal(
                authenticated = true,
                grants = mapOf(module to ModuleGrant.READ),
            )
            assertEquals(
                "$module must never expose an Insights action that authorization then drops",
                AccessDecision.Allowed,
                registry.authorize(NativeDestination.Insights, principal),
            )
        }
        assertEquals(
            "administrator USER search is visible without a module grant",
            AccessDecision.Allowed,
            registry.authorize(
                NativeDestination.Insights,
                NavigationPrincipal(authenticated = true, role = "admin"),
            ),
        )
        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(
                NativeDestination.Insights,
                NavigationPrincipal(authenticated = true, grants = mapOf(NativeModule.TASKS to ModuleGrant.READ)),
            ),
        )
    }

    @Test
    fun `shift management route mirrors owner admin and treasury manager visibility`() {
        val noGrantManager = NavigationPrincipal(authenticated = true, role = "manager")
        val treasuryManager = noGrantManager.copy(grants = mapOf(NativeModule.TREASURY to ModuleGrant.READ))

        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.Shifts, noGrantManager),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.Shifts, treasuryManager))
        assertEquals(
            AccessDecision.Allowed,
            registry.authorize(NativeDestination.Shifts, NavigationPrincipal(authenticated = true, role = "admin")),
        )
        assertEquals(
            AccessDecision.Allowed,
            registry.authorize(NativeDestination.Shifts, NavigationPrincipal(authenticated = true, isOwner = true)),
        )
    }

    @Test
    fun `warehouse tools require inventory and product read grants`() {
        val inventoryOnly = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.INVENTORY to ModuleGrant.FULL),
        )
        val complete = inventoryOnly.copy(
            grants = inventoryOnly.grants + (NativeModule.PRODUCTS to ModuleGrant.READ),
        )

        assertEquals(
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED),
            registry.authorize(NativeDestination.WarehouseTools, inventoryOnly),
        )
        assertEquals(AccessDecision.Allowed, registry.authorize(NativeDestination.WarehouseTools, complete))
    }
}

package online.alarabiya.superapp.core.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeFeatureCatalogTest {
    @Test
    fun `installed native screens are reachable only with matching grants`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(
                NativeModule.CRM to ModuleGrant.READ,
                NativeModule.INVENTORY to ModuleGrant.FULL,
                NativeModule.SALES to ModuleGrant.READ,
            ),
        )
        val installed = setOf(NativeScreen.CRM, NativeScreen.INVENTORY, NativeScreen.PURCHASING, NativeScreen.SETTINGS)

        val reachable = NativeFeatureCatalog.reachableScreens(principal, installed)

        assertEquals(setOf(NativeScreen.CRM, NativeScreen.INVENTORY, NativeScreen.SETTINGS), reachable)
        assertFalse(NativeScreen.SALES in reachable)
        assertFalse(NativeScreen.PURCHASING in reachable)
    }

    @Test
    fun `permission contract never makes an uninstalled screen reachable`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.SALES to ModuleGrant.FULL),
        )

        assertNull(
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.SALES),
                principal,
                installed = setOf(NativeScreen.SETTINGS),
            ),
        )
    }

    @Test
    fun `module and feature deep links resolve to their original native surface`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            role = "admin",
            grants = mapOf(
                NativeModule.PURCHASES to ModuleGrant.FULL,
                NativeModule.SUPPLIERS to ModuleGrant.READ,
                NativeModule.HR to ModuleGrant.READ,
            ),
        )
        val installed = setOf(NativeScreen.PURCHASING, NativeScreen.HR_ADMIN)

        assertEquals(
            NativeScreen.PURCHASING,
            NativeFeatureCatalog.resolve(NativeDestination.Feature(NativeModule.PURCHASES, NativeFeatureIntent.VIEW, "44"), principal, installed),
        )
        assertEquals(
            NativeScreen.HR_ADMIN,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.HR), principal, installed),
        )
    }

    @Test
    fun `pos routes to retail sales or print work orders according to grants and intent`() {
        val printOnly = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.POS to ModuleGrant.FULL),
        )
        val installed = setOf(NativeScreen.SALES, NativeScreen.WORK_ORDERS)

        assertEquals(
            NativeScreen.WORK_ORDERS,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.POS), printOnly, installed),
        )
        assertEquals(
            NativeScreen.WORK_ORDERS,
            NativeFeatureCatalog.resolve(
                NativeDestination.Feature(NativeModule.POS, NativeFeatureIntent.BROWSE),
                printOnly,
                installed,
            ),
        )

        val retail = printOnly.copy(
            grants = printOnly.grants + (NativeModule.SALES to ModuleGrant.FULL),
        )
        assertEquals(
            NativeScreen.SALES,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.POS), retail, installed),
        )
        assertEquals(
            NativeScreen.SALES,
            NativeFeatureCatalog.resolve(
                NativeDestination.Feature(NativeModule.POS, NativeFeatureIntent.OPERATE),
                retail,
                installed,
            ),
        )
        assertNull(NativeFeatureCatalog.screenFor(NativeModule.POS))
    }

    @Test
    fun `settings is personal authenticated surface rather than module metric fallback`() {
        val authenticated = NavigationPrincipal(authenticated = true)
        val signedOut = NavigationPrincipal(authenticated = false)

        assertTrue(NativeScreen.SETTINGS in NativeFeatureCatalog.reachableScreens(authenticated, setOf(NativeScreen.SETTINGS)))
        assertFalse(NativeScreen.SETTINGS in NativeFeatureCatalog.reachableScreens(signedOut, setOf(NativeScreen.SETTINGS)))
        assertEquals(
            NativeScreen.SETTINGS,
            NativeFeatureCatalog.resolve(NativeDestination.Profile, authenticated, setOf(NativeScreen.SETTINGS)),
        )
    }

    @Test
    fun `commerce capabilities share one native surface without module collisions`() {
        val commerceModules = setOf(NativeModule.GIFTS, NativeModule.RESERVATIONS, NativeModule.DIGITAL_CARDS)
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = commerceModules.associateWith { ModuleGrant.READ },
        )

        commerceModules.forEach { module ->
            assertEquals(NativeScreen.COMMERCE, NativeFeatureCatalog.screenFor(module))
            assertEquals(
                NativeScreen.COMMERCE,
                NativeFeatureCatalog.resolve(
                    NativeDestination.Module(module),
                    principal,
                    installed = setOf(NativeScreen.COMMERCE),
                ),
            )
        }
    }

    @Test
    fun `each module belongs to at most one installed feature definition`() {
        val duplicatedModules = NativeFeatureCatalog.definitions
            .flatMap { definition -> definition.modules.map { module -> module to definition.screen } }
            .groupBy({ it.first }, { it.second })
            .filterValues { screens -> screens.distinct().size > 1 }

        assertTrue(duplicatedModules.isEmpty())
    }

    @Test
    fun `catalog defines every native screen once`() {
        assertEquals(NativeScreen.entries.toSet(), NativeFeatureCatalog.definitions.map { it.screen }.toSet())
        assertEquals(
            NativeFeatureCatalog.definitions.size,
            NativeFeatureCatalog.definitions.map { it.key }.distinct().size,
        )
    }

    @Test
    fun `admin surface requires both admin role and users grant`() {
        val installed = setOf(NativeScreen.ADMIN)
        val usersGrant = mapOf(NativeModule.USERS to ModuleGrant.FULL)

        assertTrue(
            NativeScreen.ADMIN in NativeFeatureCatalog.reachableScreens(
                NavigationPrincipal(authenticated = true, grants = usersGrant, role = "admin"),
                installed,
            ),
        )
        assertFalse(
            NativeScreen.ADMIN in NativeFeatureCatalog.reachableScreens(
                NavigationPrincipal(authenticated = true, grants = usersGrant, role = "manager"),
                installed,
            ),
        )
        assertFalse(
            NativeScreen.ADMIN in NativeFeatureCatalog.reachableScreens(
                NavigationPrincipal(authenticated = true, role = "admin"),
                installed,
            ),
        )
    }

    @Test
    fun `installed insights surface has a typed authenticated destination`() {
        val installed = setOf(NativeScreen.INSIGHTS)
        val authenticated = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.REPORTS to ModuleGrant.READ),
        )

        assertEquals(
            NativeScreen.INSIGHTS,
            NativeFeatureCatalog.resolve(NativeDestination.Insights, authenticated, installed),
        )
        assertNull(
            NativeFeatureCatalog.resolve(
                NativeDestination.Insights,
                NavigationPrincipal(authenticated = false),
                installed,
            ),
        )
    }

    @Test
    fun `collaboration has an independent typed destination without stealing task or campaign modules`() {
        val installed = setOf(NativeScreen.COLLABORATION)
        val authenticated = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.TASKS to ModuleGrant.READ),
        )

        assertEquals(
            NativeScreen.COLLABORATION,
            NativeFeatureCatalog.resolve(NativeDestination.Collaboration, authenticated, installed),
        )
        assertNull(NativeFeatureCatalog.screenFor(NativeModule.TASKS)?.takeIf { it == NativeScreen.COLLABORATION })
        assertNull(NativeFeatureCatalog.screenFor(NativeModule.CAMPAIGNS)?.takeIf { it == NativeScreen.COLLABORATION })
        assertNull(
            NativeFeatureCatalog.resolve(
                NativeDestination.Collaboration,
                NavigationPrincipal(authenticated = false),
                installed,
            ),
        )
    }

    @Test
    fun `marketing owns catalog quality while campaigns remain on the crm contract`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(
                NativeModule.CAMPAIGNS to ModuleGrant.READ,
                NativeModule.CATALOG_ANOMALIES to ModuleGrant.READ,
            ),
        )
        val installed = setOf(NativeScreen.CRM, NativeScreen.MARKETING)

        assertEquals(NativeScreen.CRM, NativeFeatureCatalog.screenFor(NativeModule.CAMPAIGNS))
        assertEquals(NativeScreen.MARKETING, NativeFeatureCatalog.screenFor(NativeModule.CATALOG_ANOMALIES))
        assertEquals(
            NativeScreen.MARKETING,
            NativeFeatureCatalog.resolve(NativeDestination.Marketing, principal, installed),
        )
        assertEquals(
            NativeScreen.MARKETING,
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.CATALOG_ANOMALIES),
                principal,
                installed,
            ),
        )
    }

    @Test
    fun `sales-only user can reach quotations through the typed crm workspace`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.SALES to ModuleGrant.READ),
            role = "sales_rep",
        )
        val installed = setOf(NativeScreen.CRM, NativeScreen.SALES)

        assertEquals(
            NativeScreen.CRM,
            NativeFeatureCatalog.resolve(NativeDestination.CrmWorkspace, principal, installed),
        )
        assertEquals(
            NativeScreen.SALES,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.SALES), principal, installed),
        )
    }

    @Test
    fun `accounting controls is a capability-composed surface rather than a duplicate module owner`() {
        val installed = setOf(NativeScreen.ACCOUNTING_CONTROLS)
        val principal = NavigationPrincipal(
            authenticated = true,
            role = "accountant",
            grants = mapOf(NativeModule.REPORTS to ModuleGrant.READ),
        )

        assertEquals(
            NativeScreen.ACCOUNTING_CONTROLS,
            NativeFeatureCatalog.resolve(NativeDestination.AccountingControls, principal, installed),
        )
        assertEquals(NativeScreen.FINANCE, NativeFeatureCatalog.screenFor(NativeModule.REPORTS))
        assertEquals(NativeScreen.FINANCE, NativeFeatureCatalog.screenFor(NativeModule.TREASURY))
    }

    @Test
    fun `operations owns assets commissions and consignments while warehouse tools is typed`() {
        val grants = mapOf(
            NativeModule.ASSETS to ModuleGrant.READ,
            NativeModule.COMMISSIONS to ModuleGrant.READ,
            NativeModule.CONSIGNMENTS to ModuleGrant.READ,
            NativeModule.INVENTORY to ModuleGrant.READ,
            NativeModule.PRODUCTS to ModuleGrant.READ,
        )
        val principal = NavigationPrincipal(authenticated = true, grants = grants)
        val installed = setOf(NativeScreen.OPERATIONS, NativeScreen.WAREHOUSE_TOOLS)

        setOf(NativeModule.ASSETS, NativeModule.COMMISSIONS, NativeModule.CONSIGNMENTS).forEach { module ->
            assertEquals(NativeScreen.OPERATIONS, NativeFeatureCatalog.screenFor(module))
            assertEquals(
                NativeScreen.OPERATIONS,
                NativeFeatureCatalog.resolve(NativeDestination.Module(module), principal, installed),
            )
        }
        assertEquals(
            NativeScreen.WAREHOUSE_TOOLS,
            NativeFeatureCatalog.resolve(NativeDestination.WarehouseTools, principal, installed),
        )
    }

    @Test
    fun `typed aggregate workspaces reject a user with no readable grants`() {
        val principal = NavigationPrincipal(authenticated = true, role = "employee")
        val destinations = mapOf(
            NativeDestination.AccountingControls to NativeScreen.ACCOUNTING_CONTROLS,
            NativeDestination.Collaboration to NativeScreen.COLLABORATION,
            NativeDestination.Marketing to NativeScreen.MARKETING,
            NativeDestination.Operations to NativeScreen.OPERATIONS,
            NativeDestination.Insights to NativeScreen.INSIGHTS,
            NativeDestination.WarehouseTools to NativeScreen.WAREHOUSE_TOOLS,
            NativeDestination.Receivables to NativeScreen.RECEIVABLES,
            NativeDestination.Collections to NativeScreen.COLLECTIONS,
        )
        val installed = destinations.values.toSet()

        destinations.forEach { (destination, _) ->
            assertNull(NativeFeatureCatalog.resolve(destination, principal, installed))
        }
    }

    @Test
    fun `typed receivables and collections destinations use conservative scopes`() {
        val installed = setOf(NativeScreen.RECEIVABLES, NativeScreen.COLLECTIONS)
        val accountant = NavigationPrincipal(
            authenticated = true,
            role = "accountant",
            grants = mapOf(NativeModule.TREASURY to ModuleGrant.READ),
        )
        assertEquals(
            NativeScreen.RECEIVABLES,
            NativeFeatureCatalog.resolve(NativeDestination.Receivables, accountant, installed),
        )
        assertNull(NativeFeatureCatalog.resolve(NativeDestination.Collections, accountant, installed))

        val manager = NavigationPrincipal(
            authenticated = true,
            role = "manager",
            grants = mapOf(NativeModule.COLLECTIONS to ModuleGrant.FULL),
        )
        assertEquals(
            NativeScreen.COLLECTIONS,
            NativeFeatureCatalog.resolve(NativeDestination.Collections, manager, installed),
        )
    }

    @Test
    fun `work orders top-level destination cannot reach an uninstalled branch surface`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.WORK_ORDERS to ModuleGrant.FULL),
        )

        assertNull(NativeFeatureCatalog.resolve(NativeDestination.WorkOrders, principal, emptySet()))
        assertEquals(
            NativeScreen.WORK_ORDERS,
            NativeFeatureCatalog.resolve(
                NativeDestination.WorkOrders,
                principal,
                setOf(NativeScreen.WORK_ORDERS),
            ),
        )
    }

    @Test
    fun `self service is personal while hr module is an admin surface`() {
        val employee = NavigationPrincipal(authenticated = true, role = "employee")
        assertEquals(
            NativeScreen.SELF_SERVICE,
            NativeFeatureCatalog.resolve(
                NativeDestination.SelfService,
                employee,
                setOf(NativeScreen.SELF_SERVICE),
            ),
        )

        val administrator = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.HR to ModuleGrant.FULL),
            role = "admin",
        )
        assertEquals(
            NativeScreen.HR_ADMIN,
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.HR),
                administrator,
                setOf(NativeScreen.HR_ADMIN),
            ),
        )
        assertEquals(
            NativeScreen.HR_ADMIN,
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.HR),
                employee.copy(grants = mapOf(NativeModule.HR to ModuleGrant.FULL)),
                setOf(NativeScreen.HR_ADMIN),
            ),
        )
    }

    @Test
    fun `personal profile and system settings remain distinct`() {
        val administrator = NavigationPrincipal(
            authenticated = true,
            grants = mapOf(NativeModule.SETTINGS to ModuleGrant.FULL),
            role = "admin",
        )
        val installed = setOf(NativeScreen.SETTINGS, NativeScreen.SYSTEM_SETTINGS)

        assertEquals(
            NativeScreen.SETTINGS,
            NativeFeatureCatalog.resolve(NativeDestination.Profile, administrator, installed),
        )
        assertEquals(
            NativeScreen.SYSTEM_SETTINGS,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.SETTINGS), administrator, installed),
        )
        assertEquals(
            NativeScreen.SYSTEM_SETTINGS,
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.SETTINGS),
                administrator.copy(role = "manager"),
                installed,
            ),
        )
        assertNull(
            NativeFeatureCatalog.resolve(
                NativeDestination.Module(NativeModule.SETTINGS),
                administrator.copy(role = "manager", grants = emptyMap()),
                installed,
            ),
        )
    }

    @Test
    fun `shifts is standalone and reachable only through the management policy`() {
        val installed = setOf(NativeScreen.SHIFTS)
        val manager = NavigationPrincipal(
            authenticated = true,
            role = "manager",
            grants = mapOf(NativeModule.TREASURY to ModuleGrant.READ),
        )

        assertTrue(NativeFeatureCatalog.definition(NativeScreen.SHIFTS).modules.isEmpty())
        assertEquals(
            NativeScreen.SHIFTS,
            NativeFeatureCatalog.resolve(NativeDestination.Shifts, manager, installed),
        )
        assertNull(
            NativeFeatureCatalog.resolve(
                NativeDestination.Shifts,
                NavigationPrincipal(authenticated = true, role = "manager"),
                installed,
            ),
        )
    }

    @Test
    fun `store operations and store administration resolve to distinct native surfaces`() {
        val principal = NavigationPrincipal(
            authenticated = true,
            role = "manager",
            grants = mapOf(NativeModule.STORE to ModuleGrant.FULL),
        )
        val installed = setOf(NativeScreen.STORE_DELIVERY, NativeScreen.STORE_ADMIN)

        assertEquals(
            NativeScreen.STORE_DELIVERY,
            NativeFeatureCatalog.resolve(NativeDestination.Module(NativeModule.STORE), principal, installed),
        )
        assertEquals(
            NativeScreen.STORE_ADMIN,
            NativeFeatureCatalog.resolve(NativeDestination.StoreAdmin, principal, installed),
        )
    }
}

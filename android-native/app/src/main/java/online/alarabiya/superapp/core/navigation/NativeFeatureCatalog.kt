package online.alarabiya.superapp.core.navigation

enum class NativeScreen {
    SELF_SERVICE,
    APPROVALS,
    ACCOUNTING_CONTROLS,
    CRM,
    INVENTORY,
    SALES,
    PURCHASING,
    STORE_DELIVERY,
    STORE_ADMIN,
    FINANCE,
    RECEIVABLES,
    COLLECTIONS,
    PRODUCTS,
    COMMERCE,
    COLLABORATION,
    MARKETING,
    OPERATIONS,
    CONVERSATIONS,
    ADMIN,
    INSIGHTS,
    SHIFTS,
    WORK_ORDERS,
    WAREHOUSE_TOOLS,
    HR_ADMIN,
    SYSTEM_SETTINGS,
    SETTINGS,
}

data class NativeFeatureDefinition(
    val key: String,
    val label: String,
    val screen: NativeScreen,
    val modules: Set<NativeModule>,
)

/**
 * The audited catalogue of production Compose surfaces.
 *
 * A module appearing in [NativeNavigationRegistry] is only a permission contract. It becomes
 * reachable in the application shell only when this catalogue owns a native screen and the
 * process supplied that screen's data source. This distinction prevents accidental web or
 * desktop fallbacks when backend permissions grow faster than the Android application.
 */
object NativeFeatureCatalog {
    val definitions: List<NativeFeatureDefinition> = listOf(
        NativeFeatureDefinition("self-service", "مساحتي", NativeScreen.SELF_SERVICE, setOf(NativeModule.TASKS)),
        NativeFeatureDefinition("approvals", "الاعتمادات", NativeScreen.APPROVALS, emptySet()),
        NativeFeatureDefinition("accounting-controls", "الضبط المحاسبي", NativeScreen.ACCOUNTING_CONTROLS, emptySet()),
        NativeFeatureDefinition("crm", "العملاء والعلاقات", NativeScreen.CRM, setOf(NativeModule.CRM, NativeModule.CAMPAIGNS)),
        NativeFeatureDefinition("inventory", "المخزون", NativeScreen.INVENTORY, setOf(NativeModule.INVENTORY)),
        NativeFeatureDefinition("sales", "المبيعات ونقطة البيع", NativeScreen.SALES, setOf(NativeModule.SALES)),
        NativeFeatureDefinition("purchasing", "المشتريات والموردون", NativeScreen.PURCHASING, setOf(NativeModule.PURCHASES, NativeModule.SUPPLIERS)),
        NativeFeatureDefinition("store", "المتجر والتوصيل", NativeScreen.STORE_DELIVERY, setOf(NativeModule.STORE, NativeModule.COURIER)),
        NativeFeatureDefinition("store-admin", "إدارة المتجر", NativeScreen.STORE_ADMIN, emptySet()),
        NativeFeatureDefinition("finance", "المالية والخزينة", NativeScreen.FINANCE, setOf(NativeModule.TREASURY, NativeModule.EXPENSES, NativeModule.REPORTS)),
        NativeFeatureDefinition("receivables", "المستحقات والمتابعة", NativeScreen.RECEIVABLES, emptySet()),
        NativeFeatureDefinition("collections", "قرارات التحصيل", NativeScreen.COLLECTIONS, setOf(NativeModule.COLLECTIONS)),
        NativeFeatureDefinition("products", "المنتجات والتسعير", NativeScreen.PRODUCTS, setOf(NativeModule.PRODUCTS)),
        NativeFeatureDefinition(
            "commerce",
            "الهدايا والحجوزات والبطاقات",
            NativeScreen.COMMERCE,
            setOf(NativeModule.GIFTS, NativeModule.RESERVATIONS, NativeModule.DIGITAL_CARDS),
        ),
        NativeFeatureDefinition("collaboration", "التعاون والمهام", NativeScreen.COLLABORATION, emptySet()),
        NativeFeatureDefinition("marketing", "التسويق والعروض", NativeScreen.MARKETING, setOf(NativeModule.CATALOG_ANOMALIES)),
        NativeFeatureDefinition(
            "operations",
            "العمليات والأداء",
            NativeScreen.OPERATIONS,
            setOf(NativeModule.ASSETS, NativeModule.COMMISSIONS, NativeModule.CONSIGNMENTS),
        ),
        NativeFeatureDefinition("conversations", "المحادثات", NativeScreen.CONVERSATIONS, setOf(NativeModule.CHANNELS)),
        NativeFeatureDefinition("admin", "إدارة النظام", NativeScreen.ADMIN, setOf(NativeModule.USERS)),
        NativeFeatureDefinition("insights", "التحليلات والبحث", NativeScreen.INSIGHTS, emptySet()),
        NativeFeatureDefinition("shifts", "الورديات والتسوية", NativeScreen.SHIFTS, emptySet()),
        NativeFeatureDefinition("work-orders", "الطباعة والإنتاج", NativeScreen.WORK_ORDERS, setOf(NativeModule.WORK_ORDERS)),
        NativeFeatureDefinition("warehouse-tools", "أدوات المستودع", NativeScreen.WAREHOUSE_TOOLS, emptySet()),
        NativeFeatureDefinition("hr-admin", "إدارة الموارد البشرية", NativeScreen.HR_ADMIN, setOf(NativeModule.HR)),
        NativeFeatureDefinition("system-settings", "إعدادات النظام", NativeScreen.SYSTEM_SETTINGS, setOf(NativeModule.SETTINGS)),
        NativeFeatureDefinition("settings", "الإعدادات الشخصية", NativeScreen.SETTINGS, emptySet()),
    )

    private val byScreen = definitions.associateBy(NativeFeatureDefinition::screen)
    private val byModule = definitions.flatMap { definition ->
        definition.modules.map { module -> module to definition }
    }.groupBy({ it.first }, { it.second })

    fun definition(screen: NativeScreen): NativeFeatureDefinition = checkNotNull(byScreen[screen])

    fun screenFor(module: NativeModule): NativeScreen? = byModule[module]
        ?.singleOrNull()
        ?.screen

    fun entryDestination(
        screen: NativeScreen,
        principal: NavigationPrincipal,
        registry: NativeNavigationRegistry = NativeNavigationRegistry.Default,
    ): NativeDestination? {
        val definition = definition(screen)
        return definition.modules.firstNotNullOfOrNull { module ->
            NativeDestination.Module(module).takeIf { registry.authorize(it, principal) == AccessDecision.Allowed }
        }
    }

    fun reachableScreens(
        principal: NavigationPrincipal,
        installed: Set<NativeScreen>,
        registry: NativeNavigationRegistry = NativeNavigationRegistry.Default,
    ): Set<NativeScreen> = installed.filterTo(linkedSetOf()) { screen ->
        when (screen) {
            NativeScreen.SETTINGS -> principal.authenticated
            NativeScreen.SELF_SERVICE -> principal.authenticated
            NativeScreen.ACCOUNTING_CONTROLS -> principal.role.equals("admin", ignoreCase = true) ||
                listOf(NativeModule.REPORTS, NativeModule.TREASURY)
                    .any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.COLLABORATION -> listOf(NativeModule.TASKS, NativeModule.CAMPAIGNS)
                .any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.MARKETING -> listOf(NativeModule.CAMPAIGNS, NativeModule.CATALOG_ANOMALIES)
                .any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.OPERATIONS -> listOf(
                NativeModule.ASSETS,
                NativeModule.COMMISSIONS,
                NativeModule.CONSIGNMENTS,
            ).any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.CRM -> listOf(NativeModule.CRM, NativeModule.CAMPAIGNS, NativeModule.SALES)
                .any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.RECEIVABLES -> registry.authorize(NativeDestination.Receivables, principal) == AccessDecision.Allowed
            NativeScreen.COLLECTIONS -> registry.authorize(NativeDestination.Collections, principal) == AccessDecision.Allowed
            NativeScreen.ADMIN -> principal.role.equals("admin", ignoreCase = true) &&
                entryDestination(screen, principal, registry) != null
            NativeScreen.HR_ADMIN -> entryDestination(screen, principal, registry) != null
            NativeScreen.SYSTEM_SETTINGS -> principal.grantFor(NativeModule.SETTINGS).satisfies(ModuleGrant.READ) &&
                entryDestination(screen, principal, registry) != null
            NativeScreen.INSIGHTS -> principal.role.equals("admin", ignoreCase = true) || listOf(
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
            ).any { principal.grantFor(it).satisfies(ModuleGrant.READ) }
            NativeScreen.SHIFTS -> registry.authorize(NativeDestination.Shifts, principal) == AccessDecision.Allowed
            NativeScreen.WORK_ORDERS -> principal.authenticated
            NativeScreen.WAREHOUSE_TOOLS -> principal.grantFor(NativeModule.INVENTORY).satisfies(ModuleGrant.READ) &&
                principal.grantFor(NativeModule.PRODUCTS).satisfies(ModuleGrant.READ)
            NativeScreen.STORE_ADMIN -> (principal.role.equals("admin", true) || principal.role.equals("manager", true)) &&
                principal.grantFor(NativeModule.STORE).satisfies(ModuleGrant.READ)
            NativeScreen.APPROVALS -> registry.authorize(NativeDestination.Approvals, principal) == AccessDecision.Allowed
            else -> entryDestination(screen, principal, registry) != null
        }
    }

    fun resolve(
        destination: NativeDestination,
        principal: NavigationPrincipal,
        installed: Set<NativeScreen>,
        registry: NativeNavigationRegistry = NativeNavigationRegistry.Default,
    ): NativeScreen? {
        if (registry.authorize(destination, principal) != AccessDecision.Allowed) return null
        val screen = when (destination) {
            NativeDestination.SelfService,
            NativeDestination.Tasks,
            -> NativeScreen.SELF_SERVICE
            NativeDestination.Approvals -> NativeScreen.APPROVALS
            NativeDestination.AccountingControls -> NativeScreen.ACCOUNTING_CONTROLS
            NativeDestination.Collaboration -> NativeScreen.COLLABORATION
            NativeDestination.Marketing -> NativeScreen.MARKETING
            NativeDestination.Operations -> NativeScreen.OPERATIONS
            NativeDestination.CrmWorkspace -> NativeScreen.CRM
            NativeDestination.Receivables -> NativeScreen.RECEIVABLES
            NativeDestination.Collections -> NativeScreen.COLLECTIONS
            NativeDestination.Insights -> NativeScreen.INSIGHTS
            NativeDestination.Shifts -> NativeScreen.SHIFTS
            NativeDestination.WorkOrders -> NativeScreen.WORK_ORDERS
            NativeDestination.WarehouseTools -> NativeScreen.WAREHOUSE_TOOLS
            NativeDestination.StoreAdmin -> NativeScreen.STORE_ADMIN
            NativeDestination.Profile -> NativeScreen.SETTINGS
            is NativeDestination.Module -> if (destination.module == NativeModule.POS) {
                resolvePos(destination, principal, installed)
            } else {
                screenFor(destination.module)
            }
            is NativeDestination.Feature -> if (destination.module == NativeModule.POS) {
                resolvePos(destination, principal, installed)
            } else {
                screenFor(destination.module)
            }
            NativeDestination.Home,
            NativeDestination.ModuleDirectory,
            NativeDestination.Alerts,
            -> null
        }
        return screen?.takeIf { it in installed && it in reachableScreens(principal, installed, registry) }
    }

    private fun resolvePos(
        destination: NativeDestination,
        principal: NavigationPrincipal,
        installed: Set<NativeScreen>,
    ): NativeScreen? {
        val requiredSalesGrant = (destination as? NativeDestination.Feature)?.intent?.requiredGrant ?: ModuleGrant.READ
        val salesAvailable = NativeScreen.SALES in installed &&
            principal.grantFor(NativeModule.SALES).satisfies(requiredSalesGrant)
        val printAvailable = NativeScreen.WORK_ORDERS in installed

        return when ((destination as? NativeDestination.Feature)?.intent) {
            NativeFeatureIntent.CREATE,
            NativeFeatureIntent.EDIT,
            NativeFeatureIntent.OPERATE,
            -> NativeScreen.SALES.takeIf { salesAvailable }
                ?: NativeScreen.WORK_ORDERS.takeIf { printAvailable }

            NativeFeatureIntent.BROWSE,
            NativeFeatureIntent.VIEW,
            NativeFeatureIntent.REPORT,
            NativeFeatureIntent.APPROVE,
            -> NativeScreen.WORK_ORDERS.takeIf { printAvailable }
                ?: NativeScreen.SALES.takeIf { salesAvailable }

            null -> NativeScreen.SALES.takeIf { salesAvailable }
                ?: NativeScreen.WORK_ORDERS.takeIf { printAvailable }
        }
    }
}

package online.alarabiya.superapp.core.navigation

data class NativeModuleSpec(
    val module: NativeModule,
    val supportedIntents: Set<NativeFeatureIntent>,
)

data class NavigationPrincipal(
    val authenticated: Boolean,
    val grants: Map<NativeModule, ModuleGrant> = emptyMap(),
    val role: String? = null,
) {
    fun grantFor(module: NativeModule): ModuleGrant = grants[module] ?: ModuleGrant.NONE
}

enum class AccessDenialReason {
    NOT_AUTHENTICATED,
    MODULE_NOT_GRANTED,
    FULL_ACCESS_REQUIRED,
    CAPABILITY_NOT_AVAILABLE,
    NO_APPROVAL_SCOPE,
}

sealed interface AccessDecision {
    data object Allowed : AccessDecision
    data class Denied(val reason: AccessDenialReason) : AccessDecision
}

/**
 * Native-only routing contract. A registered capability means that a future native screen may
 * handle it; it never points at a browser URL and does not claim that the screen is implemented.
 */
class NativeNavigationRegistry private constructor(
    private val specs: Map<NativeModule, NativeModuleSpec>,
) {
    init {
        require(specs.keys == NativeModule.entries.toSet()) {
            "Every permission module must have exactly one native navigation specification."
        }
        require(specs.all { (module, spec) -> module == spec.module }) {
            "Registry keys and specifications must agree."
        }
    }

    val modules: Set<NativeModule> = specs.keys

    fun spec(module: NativeModule): NativeModuleSpec = checkNotNull(specs[module])

    fun supports(destination: NativeDestination): Boolean = when (destination) {
        is NativeDestination.Feature -> destination.intent in spec(destination.module).supportedIntents
        else -> true
    }

    fun authorize(
        destination: NativeDestination,
        principal: NavigationPrincipal,
    ): AccessDecision {
        if (!principal.authenticated) {
            return AccessDecision.Denied(AccessDenialReason.NOT_AUTHENTICATED)
        }

        return when (destination) {
            NativeDestination.Home,
            NativeDestination.ModuleDirectory,
            NativeDestination.SelfService,
            NativeDestination.Alerts,
            NativeDestination.AccountingControls,
            NativeDestination.Collaboration,
            NativeDestination.Marketing,
            NativeDestination.Operations,
            NativeDestination.CrmWorkspace,
            NativeDestination.Insights,
            NativeDestination.WorkOrders,
            NativeDestination.WarehouseTools,
            NativeDestination.Profile,
            -> AccessDecision.Allowed

            NativeDestination.Receivables -> principal.authorizeReceivables()
            NativeDestination.Collections -> principal.authorizeCollections()

            NativeDestination.Tasks -> principal.require(NativeModule.TASKS, ModuleGrant.READ)
            NativeDestination.Approvals -> {
                val hasApprovalScope = specs.values.any { spec ->
                    NativeFeatureIntent.APPROVE in spec.supportedIntents &&
                        principal.grantFor(spec.module).satisfies(ModuleGrant.FULL)
                }
                if (hasApprovalScope) {
                    AccessDecision.Allowed
                } else {
                    AccessDecision.Denied(AccessDenialReason.NO_APPROVAL_SCOPE)
                }
            }

            is NativeDestination.Module -> principal.require(destination.module, ModuleGrant.READ)
            is NativeDestination.Feature -> {
                if (!supports(destination)) {
                    AccessDecision.Denied(AccessDenialReason.CAPABILITY_NOT_AVAILABLE)
                } else {
                    principal.require(destination.module, destination.intent.requiredGrant)
                }
            }
        }
    }

    private fun NavigationPrincipal.require(
        module: NativeModule,
        required: ModuleGrant,
    ): AccessDecision {
        val actual = grantFor(module)
        if (actual.satisfies(required)) return AccessDecision.Allowed
        return if (required == ModuleGrant.FULL && actual == ModuleGrant.READ) {
            AccessDecision.Denied(AccessDenialReason.FULL_ACCESS_REQUIRED)
        } else {
            AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED)
        }
    }

    private fun NavigationPrincipal.authorizeReceivables(): AccessDecision {
        val normalizedRole = role?.lowercase()
        val permitted = when (normalizedRole) {
            "admin", "manager", "accountant" ->
                grantFor(NativeModule.TREASURY).satisfies(ModuleGrant.READ) ||
                    grantFor(NativeModule.COLLECTIONS).satisfies(ModuleGrant.FULL) ||
                    grantFor(NativeModule.SUPPLIERS).satisfies(ModuleGrant.FULL) ||
                    grantFor(NativeModule.REPORTS).satisfies(ModuleGrant.READ)
            "auditor" -> grantFor(NativeModule.REPORTS).satisfies(ModuleGrant.READ)
            "warehouse", "purchasing" -> grantFor(NativeModule.SUPPLIERS).satisfies(ModuleGrant.FULL)
            else -> false
        }
        return if (permitted) AccessDecision.Allowed
        else AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED)
    }

    private fun NavigationPrincipal.authorizeCollections(): AccessDecision {
        if (role?.lowercase() !in setOf("admin", "manager")) {
            return AccessDecision.Denied(AccessDenialReason.MODULE_NOT_GRANTED)
        }
        return require(NativeModule.COLLECTIONS, ModuleGrant.FULL)
    }

    companion object {
        private val READ_ONLY = setOf(
            NativeFeatureIntent.BROWSE,
            NativeFeatureIntent.VIEW,
            NativeFeatureIntent.REPORT,
        )
        private val CRUD = READ_ONLY + setOf(
            NativeFeatureIntent.CREATE,
            NativeFeatureIntent.EDIT,
        )
        private val OPERATIONS = CRUD + NativeFeatureIntent.OPERATE
        private val WORKFLOW = OPERATIONS + NativeFeatureIntent.APPROVE

        val Default: NativeNavigationRegistry = NativeNavigationRegistry(
            listOf(
                spec(NativeModule.CRM, OPERATIONS),
                spec(NativeModule.CAMPAIGNS, WORKFLOW),
                spec(NativeModule.COLLECTIONS, READ_ONLY + NativeFeatureIntent.OPERATE),
                spec(NativeModule.POS, OPERATIONS),
                spec(NativeModule.SALES, WORKFLOW),
                spec(NativeModule.PURCHASES, WORKFLOW),
                spec(NativeModule.INVENTORY, WORKFLOW),
                spec(NativeModule.WORK_ORDERS, WORKFLOW),
                spec(NativeModule.CHANNELS, OPERATIONS),
                spec(NativeModule.TASKS, WORKFLOW),
                spec(NativeModule.STORE, OPERATIONS),
                spec(NativeModule.TREASURY, WORKFLOW),
                spec(NativeModule.SUPPLIERS, CRUD),
                spec(NativeModule.PRODUCTS, WORKFLOW),
                spec(NativeModule.EXPENSES, WORKFLOW),
                spec(NativeModule.REPORTS, READ_ONLY),
                spec(NativeModule.ASSETS, WORKFLOW),
                spec(NativeModule.HR, WORKFLOW),
                spec(NativeModule.COMMISSIONS, WORKFLOW),
                spec(NativeModule.CONSIGNMENTS, WORKFLOW),
                spec(NativeModule.RESERVATIONS, OPERATIONS),
                spec(NativeModule.DIGITAL_CARDS, OPERATIONS),
                spec(NativeModule.GIFTS, WORKFLOW),
                spec(NativeModule.CATALOG_ANOMALIES, READ_ONLY),
                spec(NativeModule.COURIER, OPERATIONS),
                spec(NativeModule.USERS, CRUD),
                spec(NativeModule.SETTINGS, CRUD),
            ).associateBy(NativeModuleSpec::module),
        )

        private fun spec(
            module: NativeModule,
            intents: Set<NativeFeatureIntent>,
        ) = NativeModuleSpec(module, intents)
    }
}

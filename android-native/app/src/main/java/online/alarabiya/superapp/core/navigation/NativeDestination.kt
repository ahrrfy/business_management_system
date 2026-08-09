package online.alarabiya.superapp.core.navigation

enum class NativeModule(val wireName: String) {
    CRM("crm"),
    CAMPAIGNS("campaigns"),
    COLLECTIONS("collections"),
    POS("pos"),
    SALES("sales"),
    PURCHASES("purchases"),
    INVENTORY("inventory"),
    WORK_ORDERS("workorders"),
    CHANNELS("channels"),
    TASKS("tasks"),
    STORE("store"),
    TREASURY("treasury"),
    SUPPLIERS("suppliers"),
    PRODUCTS("products"),
    EXPENSES("expenses"),
    REPORTS("reports"),
    ASSETS("assets"),
    HR("hr"),
    COMMISSIONS("commissions"),
    CONSIGNMENTS("consignments"),
    RESERVATIONS("reservations"),
    DIGITAL_CARDS("digital_cards"),
    GIFTS("gifts"),
    CATALOG_ANOMALIES("catalogAnomalies"),
    COURIER("courier"),
    USERS("users"),
    SETTINGS("settings"),
    ;

    companion object {
        private val byWireName = entries.associateBy(NativeModule::wireName)

        fun fromWireName(value: String): NativeModule? = byWireName[value]
    }
}

enum class ModuleGrant(private val rank: Int) {
    NONE(0),
    READ(1),
    FULL(2),
    ;

    fun satisfies(required: ModuleGrant): Boolean = rank >= required.rank
}

enum class EntityRequirement {
    FORBIDDEN,
    OPTIONAL,
    REQUIRED,
}

enum class NativeFeatureIntent(
    val wireName: String,
    val requiredGrant: ModuleGrant,
    val entityRequirement: EntityRequirement,
) {
    BROWSE("browse", ModuleGrant.READ, EntityRequirement.FORBIDDEN),
    VIEW("view", ModuleGrant.READ, EntityRequirement.REQUIRED),
    REPORT("report", ModuleGrant.READ, EntityRequirement.OPTIONAL),
    CREATE("create", ModuleGrant.FULL, EntityRequirement.FORBIDDEN),
    EDIT("edit", ModuleGrant.FULL, EntityRequirement.REQUIRED),
    OPERATE("operate", ModuleGrant.FULL, EntityRequirement.OPTIONAL),
    APPROVE("approve", ModuleGrant.FULL, EntityRequirement.REQUIRED),
    ;

    companion object {
        private val byWireName = entries.associateBy(NativeFeatureIntent::wireName)

        fun fromWireName(value: String): NativeFeatureIntent? = byWireName[value]
    }
}

sealed interface NativeDestination {
    data object Home : NativeDestination
    data object ModuleDirectory : NativeDestination
    data object SelfService : NativeDestination
    data object Tasks : NativeDestination
    data object Alerts : NativeDestination
    data object Approvals : NativeDestination
    data object AccountingControls : NativeDestination
    data object Collaboration : NativeDestination
    data object Marketing : NativeDestination
    data object Operations : NativeDestination
    data object CrmWorkspace : NativeDestination
    data object Receivables : NativeDestination
    data object Collections : NativeDestination
    data object Insights : NativeDestination
    data object Shifts : NativeDestination
    data object WorkOrders : NativeDestination
    data object WarehouseTools : NativeDestination
    data object StoreAdmin : NativeDestination
    data object Profile : NativeDestination

    data class Module(val module: NativeModule) : NativeDestination

    data class Feature(
        val module: NativeModule,
        val intent: NativeFeatureIntent,
        val entityId: String? = null,
    ) : NativeDestination {
        init {
            require(entityId == null || SAFE_ENTITY_ID.matches(entityId)) {
                "Entity identifiers may contain only ASCII letters, numbers, underscore, and hyphen."
            }
            when (intent.entityRequirement) {
                EntityRequirement.FORBIDDEN -> require(entityId == null) {
                    "${intent.wireName} does not accept an entity identifier."
                }

                EntityRequirement.REQUIRED -> require(entityId != null) {
                    "${intent.wireName} requires an entity identifier."
                }

                EntityRequirement.OPTIONAL -> Unit
            }
        }

        companion object {
            private val SAFE_ENTITY_ID = Regex("[A-Za-z0-9_-]{1,96}")
        }
    }
}

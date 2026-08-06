package online.alarabiya.superapp.core.navigation

import java.net.URI

enum class DeepLinkRejectionReason {
    MALFORMED,
    EXTERNAL_SCHEME,
    INVALID_AUTHORITY,
    AMBIGUOUS_URI,
    UNKNOWN_DESTINATION,
    UNKNOWN_MODULE,
    UNKNOWN_INTENT,
    INVALID_ENTITY,
    UNSUPPORTED_CAPABILITY,
}

sealed interface DeepLinkResult {
    data class Accepted(val destination: NativeDestination) : DeepLinkResult
    data class Rejected(val reason: DeepLinkRejectionReason) : DeepLinkResult
}

/** Converts only the app's private URI format to typed native destinations. */
object NativeDeepLinkCodec {
    const val SCHEME = "alrueya"
    const val AUTHORITY = "app"

    fun parse(
        raw: String,
        registry: NativeNavigationRegistry = NativeNavigationRegistry.Default,
    ): DeepLinkResult {
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return DeepLinkResult.Rejected(DeepLinkRejectionReason.MALFORMED)
        }

        if (uri.scheme != SCHEME) {
            return DeepLinkResult.Rejected(DeepLinkRejectionReason.EXTERNAL_SCHEME)
        }
        if (uri.host != AUTHORITY || uri.port != -1 || uri.rawUserInfo != null) {
            return DeepLinkResult.Rejected(DeepLinkRejectionReason.INVALID_AUTHORITY)
        }
        if (uri.rawQuery != null || uri.rawFragment != null || '%' in uri.rawPath.orEmpty()) {
            return DeepLinkResult.Rejected(DeepLinkRejectionReason.AMBIGUOUS_URI)
        }

        val path = uri.rawPath.orEmpty()
        val segments = path.removePrefix("/").split('/').filter(String::isNotEmpty)
        if (segments.isEmpty() || path != segments.joinToString(separator = "/", prefix = "/")) {
            return DeepLinkResult.Rejected(DeepLinkRejectionReason.UNKNOWN_DESTINATION)
        }

        val destination = when (segments) {
            listOf("home") -> NativeDestination.Home
            listOf("modules") -> NativeDestination.ModuleDirectory
            listOf("self-service") -> NativeDestination.SelfService
            listOf("tasks") -> NativeDestination.Tasks
            listOf("alerts") -> NativeDestination.Alerts
            listOf("approvals") -> NativeDestination.Approvals
            listOf("accounting-controls") -> NativeDestination.AccountingControls
            listOf("collaboration") -> NativeDestination.Collaboration
            listOf("marketing") -> NativeDestination.Marketing
            listOf("operations") -> NativeDestination.Operations
            listOf("crm-workspace") -> NativeDestination.CrmWorkspace
            listOf("receivables") -> NativeDestination.Receivables
            listOf("collections") -> NativeDestination.Collections
            listOf("insights") -> NativeDestination.Insights
            listOf("work-orders") -> NativeDestination.WorkOrders
            listOf("warehouse-tools") -> NativeDestination.WarehouseTools
            listOf("profile") -> NativeDestination.Profile
            else -> when (val result = parseModuleDestination(segments, registry)) {
                is ModuleParseResult.Accepted -> result.destination
                is ModuleParseResult.Rejected -> return DeepLinkResult.Rejected(result.reason)
            }
        }
        return DeepLinkResult.Accepted(destination)
    }

    fun encode(destination: NativeDestination): String {
        val segments = when (destination) {
            NativeDestination.Home -> listOf("home")
            NativeDestination.ModuleDirectory -> listOf("modules")
            NativeDestination.SelfService -> listOf("self-service")
            NativeDestination.Tasks -> listOf("tasks")
            NativeDestination.Alerts -> listOf("alerts")
            NativeDestination.Approvals -> listOf("approvals")
            NativeDestination.AccountingControls -> listOf("accounting-controls")
            NativeDestination.Collaboration -> listOf("collaboration")
            NativeDestination.Marketing -> listOf("marketing")
            NativeDestination.Operations -> listOf("operations")
            NativeDestination.CrmWorkspace -> listOf("crm-workspace")
            NativeDestination.Receivables -> listOf("receivables")
            NativeDestination.Collections -> listOf("collections")
            NativeDestination.Insights -> listOf("insights")
            NativeDestination.WorkOrders -> listOf("work-orders")
            NativeDestination.WarehouseTools -> listOf("warehouse-tools")
            NativeDestination.Profile -> listOf("profile")
            is NativeDestination.Module -> listOf("module", destination.module.wireName)
            is NativeDestination.Feature -> buildList {
                add("module")
                add(destination.module.wireName)
                add(destination.intent.wireName)
                destination.entityId?.let(::add)
            }
        }
        return "$SCHEME://$AUTHORITY/${segments.joinToString("/")}"
    }

    private fun parseModuleDestination(
        segments: List<String>,
        registry: NativeNavigationRegistry,
    ): ModuleParseResult {
        if (segments.firstOrNull() != "module" || segments.size !in 2..4) {
            return ModuleParseResult.Rejected(DeepLinkRejectionReason.UNKNOWN_DESTINATION)
        }
        val module = NativeModule.fromWireName(segments[1])
            ?: return ModuleParseResult.Rejected(DeepLinkRejectionReason.UNKNOWN_MODULE)
        if (segments.size == 2) return ModuleParseResult.Accepted(NativeDestination.Module(module))

        val intent = NativeFeatureIntent.fromWireName(segments[2])
            ?: return ModuleParseResult.Rejected(DeepLinkRejectionReason.UNKNOWN_INTENT)
        val entityId = segments.getOrNull(3)
        val destination = try {
            NativeDestination.Feature(module, intent, entityId)
        } catch (_: IllegalArgumentException) {
            return ModuleParseResult.Rejected(DeepLinkRejectionReason.INVALID_ENTITY)
        }
        if (!registry.supports(destination)) {
            return ModuleParseResult.Rejected(DeepLinkRejectionReason.UNSUPPORTED_CAPABILITY)
        }
        return ModuleParseResult.Accepted(destination)
    }

    private sealed interface ModuleParseResult {
        data class Accepted(val destination: NativeDestination) : ModuleParseResult
        data class Rejected(val reason: DeepLinkRejectionReason) : ModuleParseResult
    }
}

package online.alarabiya.superapp.core.navigation

sealed interface NativeNavigationRequest {
    data class Open(val destination: NativeDestination) : NativeNavigationRequest
    data class OpenDeepLink(val raw: String) : NativeNavigationRequest
    data object Back : NativeNavigationRequest
}

sealed interface NativeNavigationResult {
    data class Changed(val stack: NativeBackStack) : NativeNavigationResult
    data class Denied(val reason: AccessDenialReason) : NativeNavigationResult
    data class InvalidDeepLink(val reason: DeepLinkRejectionReason) : NativeNavigationResult
}

class NativeBackStack private constructor(
    val entries: List<NativeDestination>,
) {
    init {
        require(entries.isNotEmpty()) { "The native back stack must retain a root destination." }
    }

    val current: NativeDestination get() = entries.last()
    val canGoBack: Boolean get() = entries.size > 1

    fun dispatch(
        request: NativeNavigationRequest,
        principal: NavigationPrincipal,
        registry: NativeNavigationRegistry = NativeNavigationRegistry.Default,
    ): NativeNavigationResult = when (request) {
        NativeNavigationRequest.Back -> {
            val next = if (canGoBack) NativeBackStack(entries.dropLast(1)) else this
            NativeNavigationResult.Changed(next)
        }

        is NativeNavigationRequest.Open -> open(request.destination, principal, registry)
        is NativeNavigationRequest.OpenDeepLink -> when (
            val parsed = NativeDeepLinkCodec.parse(request.raw, registry)
        ) {
            is DeepLinkResult.Accepted -> open(parsed.destination, principal, registry)
            is DeepLinkResult.Rejected -> NativeNavigationResult.InvalidDeepLink(parsed.reason)
        }
    }

    private fun open(
        destination: NativeDestination,
        principal: NavigationPrincipal,
        registry: NativeNavigationRegistry,
    ): NativeNavigationResult = when (val decision = registry.authorize(destination, principal)) {
        AccessDecision.Allowed -> {
            val nextEntries = if (current == destination) entries else entries + destination
            NativeNavigationResult.Changed(
                if (nextEntries === entries) this else NativeBackStack(nextEntries),
            )
        }

        is AccessDecision.Denied -> NativeNavigationResult.Denied(decision.reason)
    }

    override fun equals(other: Any?): Boolean =
        other is NativeBackStack && entries == other.entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = "NativeBackStack(entries=$entries)"

    companion object {
        fun initial(): NativeBackStack = NativeBackStack(listOf(NativeDestination.Home))
    }
}

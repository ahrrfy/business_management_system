package online.alarabiya.superapp.core.navigation

import online.alarabiya.superapp.model.ExecutiveDestinationKey

/**
 * Typed hand-off between the executive command centre and an installed native workspace.
 *
 * Executive actions are server-authored. Keeping their arguments beside the destination prevents
 * the shell from degrading a precise alert (for example, a cash variance) into a generic module
 * launch. Arguments remain internal to the authenticated process; they are never appended to a
 * browser URL or accepted as an untrusted external query string.
 */
data class ExecutiveNavigationRequest(
    val destination: NativeDestination,
    val arguments: Map<String, String>,
)

object ExecutiveNavigation {
    fun request(
        key: ExecutiveDestinationKey,
        rawArguments: Map<String, String>,
    ): ExecutiveNavigationRequest {
        val arguments = rawArguments
            .filterKeys { it in allowedKeys(key) }
            .mapValues { (_, value) -> value.trim().take(MAX_ARGUMENT_LENGTH) }
            .filterValues(String::isNotEmpty)

        return when (key) {
            ExecutiveDestinationKey.INSIGHTS -> reportRequest(arguments)

            ExecutiveDestinationKey.RECEIVABLES ->
                ExecutiveNavigationRequest(NativeDestination.Receivables, arguments)

            ExecutiveDestinationKey.PRODUCTS -> when (arguments["stockState"]) {
                // Stock balances (including the reorder threshold) belong to Inventory, not the
                // product catalogue. This target can apply the server's lowOnly filter directly.
                "low", "out" -> ExecutiveNavigationRequest(
                    NativeDestination.Module(NativeModule.INVENTORY),
                    arguments,
                )

                // The installed inventory/product APIs do not expose last-sale age. Keep this
                // one decision on the authoritative report until a native slow-mover API exists.
                "dead" -> reportRequest(arguments + ("focus" to "dead-stock"))
                else -> ExecutiveNavigationRequest(NativeDestination.Module(NativeModule.PRODUCTS), arguments)
            }

            ExecutiveDestinationKey.SHIFTS ->
                ExecutiveNavigationRequest(NativeDestination.Shifts, arguments)

            ExecutiveDestinationKey.WORK_ORDERS ->
                ExecutiveNavigationRequest(NativeDestination.WorkOrders, arguments)

            ExecutiveDestinationKey.PURCHASING -> ExecutiveNavigationRequest(
                NativeDestination.Module(NativeModule.PURCHASES),
                arguments,
            )

            ExecutiveDestinationKey.TASKS -> ExecutiveNavigationRequest(NativeDestination.Tasks, arguments)
        }
    }

    private fun reportRequest(arguments: Map<String, String>): ExecutiveNavigationRequest =
        ExecutiveNavigationRequest(
            destination = NativeDestination.Insights,
            arguments = arguments + ("section" to (arguments["section"] ?: "managementAlerts")),
        )

    private fun allowedKeys(key: ExecutiveDestinationKey): Set<String> = when (key) {
        ExecutiveDestinationKey.INSIGHTS -> setOf("section", "focus")
        ExecutiveDestinationKey.RECEIVABLES -> setOf("bucket", "view")
        ExecutiveDestinationKey.PRODUCTS -> setOf("stockState")
        ExecutiveDestinationKey.SHIFTS -> setOf("variance")
        ExecutiveDestinationKey.WORK_ORDERS -> setOf("overdue")
        ExecutiveDestinationKey.PURCHASING -> setOf("view")
        ExecutiveDestinationKey.TASKS -> setOf("overdue")
    }

    private const val MAX_ARGUMENT_LENGTH = 64
}

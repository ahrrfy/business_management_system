package online.alarabiya.superapp.model.store

enum class StoreOrderStatus(val wire: String, val label: String) {
    Pending("PENDING", "جديد"),
    Confirmed("CONFIRMED", "مؤكد"),
    Processing("PROCESSING", "قيد التجهيز"),
    Shipped("SHIPPED", "قيد التوصيل"),
    Delivered("DELIVERED", "تم التسليم"),
    Cancelled("CANCELLED", "ملغى"),
    Unknown("UNKNOWN", "حالة غير معروفة");

    companion object {
        val filterable: List<StoreOrderStatus> = entries.filterNot { it == Unknown }

        fun fromWire(value: String?): StoreOrderStatus = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class StoreOrderSummary(
    val id: Long,
    val orderNumber: String,
    val status: StoreOrderStatus,
    val customerName: String?,
    val customerPhone: String?,
    val governorate: String?,
    val total: String,
    val deliveryFee: String,
    val deliveryPartyId: Long?,
    val cancelReason: String?,
    val itemCount: Int,
    val createdAt: String?,
)

data class StoreOrderLine(
    val productName: String,
    val variantLabel: String?,
    val unitName: String?,
    val quantity: String,
    val unitPrice: String,
    val total: String,
)

data class StoreOrderDetail(
    val summary: StoreOrderSummary,
    val branchId: Long,
    val address: String?,
    val subtotal: String,
    val deliveryPartyName: String?,
    val items: List<StoreOrderLine>,
)

data class DeliveryPartyOption(
    val id: Long,
    val name: String,
    val phone: String?,
    val currentBalance: String,
    val isActive: Boolean,
)

data class CourierDelivery(
    val id: Long,
    val orderNumber: String,
    val status: StoreOrderStatus,
    val customerName: String?,
    val customerPhone: String?,
    val governorate: String?,
    val address: String?,
    val orderTotal: String,
    val codDue: String,
    val createdAt: String?,
)

data class CourierWorkspace(
    val linked: Boolean,
    val partyName: String?,
    val custodyBalance: String,
    val toDeliver: List<CourierDelivery>,
    val delivered: List<CourierDelivery>,
)

data class StoreOrderFilter(
    val query: String = "",
    val status: StoreOrderStatus? = null,
    val from: String? = null,
    val to: String? = null,
)

data class StoreCapabilities(
    val canReadOrders: Boolean,
    val canFulfillOrders: Boolean,
    val canDispatchOrders: Boolean,
    val courierSelfService: Boolean,
) {
    companion object {
        fun from(role: String, storeAccess: String?, courierAccess: String?): StoreCapabilities {
            val normalizedRole = role.lowercase()
            val storeLevel = storeAccess?.uppercase() ?: "NONE"
            val courierLevel = courierAccess?.uppercase() ?: "NONE"
            return StoreCapabilities(
                canReadOrders = storeLevel == "READ" || storeLevel == "FULL",
                canFulfillOrders = storeLevel == "FULL",
                canDispatchOrders = storeLevel == "FULL" && normalizedRole in setOf("admin", "manager"),
                courierSelfService = normalizedRole == "courier" && courierLevel == "FULL",
            )
        }
    }
}

enum class StoreOrderAction {
    Confirm,
    StartProcessing,
    Cancel,
    Dispatch,
    MarkDelivered,
    CourierDelivered,
    CourierFailed,
}

object StoreOrderPolicy {
    fun allowedActions(status: StoreOrderStatus, capabilities: StoreCapabilities): Set<StoreOrderAction> {
        if (capabilities.courierSelfService) {
            return if (status == StoreOrderStatus.Shipped) {
                setOf(StoreOrderAction.CourierDelivered, StoreOrderAction.CourierFailed)
            } else {
                emptySet()
            }
        }
        if (!capabilities.canFulfillOrders) return emptySet()
        return when (status) {
            StoreOrderStatus.Pending -> setOf(StoreOrderAction.Confirm, StoreOrderAction.Cancel)
            StoreOrderStatus.Confirmed -> buildSet {
                add(StoreOrderAction.StartProcessing)
                add(StoreOrderAction.Cancel)
                if (capabilities.canDispatchOrders) add(StoreOrderAction.Dispatch)
            }
            StoreOrderStatus.Processing -> buildSet {
                add(StoreOrderAction.Cancel)
                if (capabilities.canDispatchOrders) add(StoreOrderAction.Dispatch)
            }
            StoreOrderStatus.Shipped -> setOf(StoreOrderAction.MarkDelivered)
            StoreOrderStatus.Delivered,
            StoreOrderStatus.Cancelled,
            StoreOrderStatus.Unknown,
            -> emptySet()
        }
    }
}

object PhoneSanitizer {
    fun normalizeIraqi(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val normalizedDigits = buildString {
            raw.trim().forEach { character ->
                when {
                    character == '+' && isEmpty() -> append(character)
                    character.isDigit() -> append(character.digitToInt())
                    character in setOf(' ', '-', '(', ')') -> Unit
                    else -> return null
                }
            }
        }
        val e164 = when {
            normalizedDigits.startsWith("+") -> normalizedDigits
            normalizedDigits.startsWith("00") -> "+" + normalizedDigits.drop(2)
            normalizedDigits.startsWith("07") -> "+964" + normalizedDigits.drop(1)
            normalizedDigits.startsWith("964") -> "+$normalizedDigits"
            else -> return null
        }
        val digits = e164.drop(1)
        return e164.takeIf { digits.length in 8..15 && digits.all(Char::isDigit) }
    }

    fun whatsappNumber(raw: String?): String? = normalizeIraqi(raw)?.drop(1)
}

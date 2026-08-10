package online.alarabiya.superapp.model.commerce

import online.alarabiya.superapp.model.AppBootstrap

enum class CommerceAccess {
    NONE,
    READ,
    FULL,
    ;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL

    companion object {
        fun fromWire(value: String?): CommerceAccess =
            entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: NONE
    }
}

data class CommerceCapabilities(
    val gifts: CommerceAccess,
    val reservations: CommerceAccess,
    val digitalCards: CommerceAccess,
    val sales: CommerceAccess,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
    val actorId: Long,
    val isOwner: Boolean,
) {
    private val elevated: Boolean get() = role.lowercase() in setOf("admin", "manager")

    val canReadGifts: Boolean get() = gifts.canRead
    val canApproveGifts: Boolean get() = gifts.canWrite && elevated
    val canReadReservations: Boolean get() = reservations.canRead
    val canCancelReservations: Boolean get() = reservations.canWrite
    val canExtendReservations: Boolean get() = reservations.canWrite && elevated
    val canConvertReservations: Boolean get() = reservations.canWrite

    /** Mirrors digitalCardsPosProcedure conservatively. Custom-role station grants need server evidence. */
    val canBrowseDigitalCards: Boolean
        get() = digitalCards.canRead && (
            role.equals("admin", ignoreCase = true) ||
                (sales.canWrite && role.lowercase() in setOf("manager", "cashier"))
            )

    val canReadDigitalSubscriptions: Boolean
        get() = digitalCards.canRead && role.lowercase() in setOf("admin", "manager", "accountant", "auditor")

    /** بوابة محافظة لقرارات البطاقات الحساسة؛ الخادم يبقى المرجع النهائي للصلاحية وSOD. */
    val canReviewDigitalCardApprovals: Boolean
        get() = digitalCards.canWrite && (isOwner || role.equals("admin", ignoreCase = true))

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): CommerceCapabilities {
            val access = bootstrap.modules.associate { it.key to CommerceAccess.fromWire(it.access) }
            return CommerceCapabilities(
                gifts = access["gifts"] ?: CommerceAccess.NONE,
                reservations = access["reservations"] ?: CommerceAccess.NONE,
                digitalCards = access["digital_cards"] ?: CommerceAccess.NONE,
                sales = access["sales"] ?: CommerceAccess.NONE,
                role = bootstrap.user.role,
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
                actorId = bootstrap.user.id,
                isOwner = bootstrap.isOwner || bootstrap.user.isOwner,
            )
        }
    }
}

enum class DigitalCardApprovalKind {
    REVIEW_RESOLUTION,
    WRITEOFF,
    PRICE_MISMATCH,
    WALLET_VARIANCE,
}

data class DigitalCardApproval(
    val id: Long,
    val kind: DigitalCardApprovalKind,
    val branchId: Long?,
    val branchName: String?,
    val title: String,
    val description: String?,
    val amount: String?,
    val requesterId: Long?,
    val requesterName: String?,
    val createdAt: String?,
    val currentSellPrice: String? = null,
) {
    fun canDecide(capabilities: CommerceCapabilities): Boolean =
        capabilities.canReviewDigitalCardApprovals &&
            (capabilities.isOwner || requesterId == null || requesterId != capabilities.actorId)
}

data class DigitalCardApprovalDecision(
    val reason: String? = null,
    val businessDate: String? = null,
    val sellPrice: String? = null,
)

data class CommerceBranch(val id: Long, val name: String, val code: String?)

enum class GiftDirection { IN, OUT }

enum class GiftStatus {
    DRAFT,
    PENDING_APPROVAL,
    APPROVED,
    DELIVERED,
    CANCELLED,
    REVERSED,
    UNKNOWN,
    ;

    companion object {
        fun fromWire(value: String?): GiftStatus = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

data class GiftSummary(
    val id: Long,
    val number: String,
    val direction: GiftDirection,
    val branchId: Long,
    val status: GiftStatus,
    val type: String?,
    val reason: String?,
    val sellable: Boolean,
    val supplierName: String?,
    val customerName: String?,
    val estimatedValue: String?,
    val totalCost: String?,
    val createdAt: String?,
) {
    val partyName: String? get() = if (direction == GiftDirection.IN) supplierName else customerName
    fun canApprove(capabilities: CommerceCapabilities): Boolean =
        direction == GiftDirection.OUT && status == GiftStatus.PENDING_APPROVAL && capabilities.canApproveGifts
}

data class GiftLine(
    val productName: String,
    val sku: String?,
    val unitName: String?,
    val quantity: String,
    val baseQuantity: String,
)

data class GiftDetail(
    val id: Long,
    val number: String,
    val direction: GiftDirection,
    val branchId: Long,
    val status: GiftStatus,
    val type: String?,
    val reason: String?,
    val sellable: Boolean,
    val partyName: String?,
    val partyPhone: String?,
    val createdAt: String?,
    val lines: List<GiftLine>,
)

data class GiftPage(
    val rows: List<GiftSummary>,
    val total: Int,
    val hasMore: Boolean,
    val nextCursor: Long?,
)

enum class ReservationStatus {
    ACTIVE,
    PARTIALLY_FULFILLED,
    FULFILLED,
    EXPIRED,
    CANCELLED,
    RELEASED,
    UNKNOWN,
    ;

    val open: Boolean get() = this == ACTIVE || this == PARTIALLY_FULFILLED

    companion object {
        fun fromWire(value: String?): ReservationStatus = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

data class ReservationSummary(
    val id: Long,
    val number: String,
    val branchId: Long,
    val customerId: Long?,
    val contactName: String?,
    val contactPhone: String?,
    val channel: String?,
    val status: ReservationStatus,
    val expiresAt: String?,
    val notes: String?,
    val createdAt: String?,
)

data class ReservationLine(
    val id: Long,
    val productName: String,
    val variantName: String?,
    val unitName: String?,
    val quantity: String,
    val fulfilledBase: String,
    val quotedUnitPrice: String?,
    val lineTotal: String?,
)

data class ReservationDetail(
    val summary: ReservationSummary,
    val total: String,
    val hasUnpriced: Boolean,
    val lines: List<ReservationLine>,
) {
    fun canCancel(capabilities: CommerceCapabilities): Boolean = summary.status.open && capabilities.canCancelReservations
    fun canExtend(capabilities: CommerceCapabilities): Boolean = summary.status.open && capabilities.canExtendReservations
    fun canConvert(capabilities: CommerceCapabilities): Boolean = summary.status.open && capabilities.canConvertReservations
}

data class ReservationPage(val rows: List<ReservationSummary>, val hasMore: Boolean)

data class ReservationConversion(
    val reservationId: Long,
    val invoiceId: Long,
    val invoiceNumber: String,
    val total: String,
    val status: String,
    val idempotentReplay: Boolean,
)

enum class DigitalCardAvailability {
    READY,
    STALE_PRICE,
    NO_PRICE,
    UNKNOWN,
    ;

    companion object {
        fun fromWire(value: String?): DigitalCardAvailability = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

enum class DigitalCardCategory { FAVORITES, TELECOM, GLOBAL, EDUCATIONAL, ALL }

data class DigitalCard(
    val offeringId: Long,
    val name: String,
    val providerId: Long,
    val providerName: String,
    val offeringType: String,
    val requiresStudentData: Boolean,
    val faceValue: String?,
    val sellPrice: String?,
    val priceVersionId: Long?,
    val imageUrl: String?,
    val colorToken: String?,
    val favorite: Boolean,
    val availability: DigitalCardAvailability,
) {
    val canConfirm: Boolean get() = availability == DigitalCardAvailability.READY
}

data class ConfirmedDigitalCard(val card: DigitalCard, val sellPrice: String, val priceVersionId: Long)

data class DigitalSubscription(
    val id: Long,
    val offeringName: String,
    val branchId: Long,
    val invoiceId: Long,
    val studentName: String,
    val durationDays: Int,
    val startsAt: String?,
    val expiresAt: String?,
    val status: String,
)

object NativeCommerceBlockers {
    const val GIFT_CREATE_CATALOG =
        "Native gift creation needs an employee-safe product/unit picker; raw variant and unit identifiers must not be typed or guessed."
    const val RESERVATION_CREATE =
        "reservations.create changes reserved stock but has no clientRequestId/idempotency contract."
    const val DIGITAL_CARD_SALE =
        "The digital-card sale requires an external provider executor between prepare and markExecution; native execution is not implemented."
    const val CUSTOM_RETAIL_STATION =
        "AppBootstrap does not expose effective POS station evidence, so custom-role retail grants cannot be proven natively."
    const val DIGITAL_CARD_APPROVAL_DISCOVERY =
        "The server has no global pending endpoint for reversal loss-refunds, wallet adjustments, or pricing big-change drafts; native code must not scan every invoice, wallet, provider, and date."
    const val WALLET_VARIANCE_APPROVAL =
        "Variance approval requires an adjustmentTransactionId that the reconciliation list does not return; the server must expose the linked pending adjustment."
}

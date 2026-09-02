package online.alarabiya.superapp.model.shifts

import online.alarabiya.superapp.model.AppBootstrap
import java.math.BigDecimal

enum class ShiftStatus(val wire: String, val label: String) {
    OPEN("OPEN", "مفتوحة"),
    CLOSED("CLOSED", "مغلقة");

    companion object {
        fun fromWire(value: String?): ShiftStatus? = entries.firstOrNull { it.wire == value?.uppercase() }
    }
}

enum class ShiftType(val wire: String, val label: String) {
    RETAIL("RETAIL", "تجزئة"),
    RECEPTION("RECEPTION", "خدمة العملاء"),
    PRINT_SERVICES("PRINT_SERVICES", "خدمات الطباعة");

    companion object {
        fun fromWire(value: String?): ShiftType? = entries.firstOrNull { it.wire == value?.uppercase() }
    }
}

enum class ShiftVarianceState(val wire: String, val label: String) {
    WITH_VARIANCE("WITH_VARIANCE", "بفرق نقدي"),
    MATCHED("MATCHED", "مطابقة"),
    UNRECONCILED("UNRECONCILED", "غير محسوبة");
}

/**
 * Exact decimal value received from or submitted to the shift API.
 *
 * Keeping the wire value as a decimal string prevents a financial amount from ever crossing a
 * Double/Float boundary in the native application.
 */
data class ShiftMoney private constructor(val value: String) : Comparable<ShiftMoney> {
    val decimal: BigDecimal get() = value.toBigDecimal()

    operator fun minus(other: ShiftMoney): ShiftMoney = fromDecimal(decimal.subtract(other.decimal))
    fun isZero(): Boolean = decimal.compareTo(BigDecimal.ZERO) == 0
    fun isPositive(): Boolean = decimal.signum() > 0
    fun isNegative(): Boolean = decimal.signum() < 0

    override fun compareTo(other: ShiftMoney): Int = decimal.compareTo(other.decimal)

    companion object {
        val ZERO = ShiftMoney("0")
        private val UNSIGNED = Regex("^\\d+(?:\\.\\d{1,2})?$")

        fun fromServer(raw: String?): ShiftMoney = fromServerOrNull(raw) ?: ZERO

        fun fromServerOrNull(raw: String?): ShiftMoney? =
            raw?.trim()?.takeIf(String::isNotEmpty)?.toBigDecimalOrNull()?.let(::fromDecimal)

        fun parseUnsigned(raw: String): ShiftMoney? {
            val clean = raw.trim()
            if (!UNSIGNED.matches(clean)) return null
            return runCatching { fromDecimal(clean.toBigDecimal()) }
                .getOrNull()
                ?.takeIf { !it.isNegative() }
        }

        fun fromDecimal(value: BigDecimal): ShiftMoney {
            val normalized = value.stripTrailingZeros().toPlainString()
            return ShiftMoney(if (normalized == "-0") "0" else normalized)
        }
    }
}

data class ShiftFilters(
    val branchId: String = "",
    val status: ShiftStatus? = null,
    val type: ShiftType? = null,
    val variance: ShiftVarianceState? = null,
    val from: String = "",
    val to: String = "",
    val search: String = "",
) {
    fun branchIdOrNull(): Long? = branchId.trim().toLongOrNull()?.takeIf { it > 0 }

    fun validate(canSelectBranch: Boolean, fixedBranchId: Long? = null): String? = when {
        branchId.isNotBlank() && branchIdOrNull() == null -> "معرّف الفرع غير صالح"
        !canSelectBranch && branchIdOrNull() != fixedBranchId -> "نطاق الفرع يحدده حسابك"
        from.isNotBlank() && !DATE.matches(from) -> "تاريخ البداية غير صالح"
        to.isNotBlank() && !DATE.matches(to) -> "تاريخ النهاية غير صالح"
        from.isNotBlank() && to.isNotBlank() && from > to -> "تاريخ البداية يجب ألا يتجاوز تاريخ النهاية"
        search.length > 100 -> "البحث أطول من الحد المسموح"
        else -> null
    }

    companion object {
        private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    }
}

data class ShiftRecord(
    val id: Long,
    val branchId: Long,
    val branchName: String?,
    val userId: Long,
    val userName: String?,
    val openingBalance: ShiftMoney,
    val expectedCash: ShiftMoney?,
    val countedCash: ShiftMoney?,
    val variance: ShiftMoney?,
    val status: ShiftStatus,
    val type: ShiftType,
    val openedAt: String,
    val closedAt: String?,
)

data class ShiftPage(
    val rows: List<ShiftRecord>,
    val total: Int,
    val hasMore: Boolean,
    val nextCursor: Long?,
)

data class ShiftPayment(
    val method: String,
    val direction: String,
    val total: ShiftMoney,
    val count: Int,
)

data class ShiftReport(
    val shift: ShiftRecord,
    val payments: List<ShiftPayment>,
    val expectedCash: ShiftMoney,
    val invoiceCount: Int,
    val salesTotal: ShiftMoney,
    val workOrderInvoiceCount: Int,
    val workOrderInvoiceTotal: ShiftMoney,
    val heldDepositsCount: Int,
    val heldDepositsTotal: ShiftMoney,
    val lateSyncedCount: Int,
    val lateSyncedTotal: ShiftMoney,
)

data class CurrentShift(
    val id: Long,
    val branchId: Long,
    val userId: Long,
    val openingBalance: ShiftMoney,
    val status: ShiftStatus,
    val type: ShiftType,
    val openedAt: String,
)

data class ShiftCloseCommand(
    val shiftId: Long,
    val countedCash: ShiftMoney,
)

data class ShiftCloseResult(
    val shiftId: Long,
    val openingBalance: ShiftMoney,
    val expectedCash: ShiftMoney,
    val countedCash: ShiftMoney,
    val variance: ShiftMoney,
    val reconciliationStatus: String?,
    val requiresManagerReview: Boolean,
    val alreadyClosed: Boolean,
    val treasuryHandoverNumber: String?,
)

data class ShiftAccessPolicy(
    val role: String,
    val actorId: Long,
    val branchId: Long?,
    val treasuryAccess: String,
    val isOwner: Boolean,
) {
    private val normalizedRole get() = role.lowercase()
    private val canReadTreasury get() = treasuryAccess.uppercase() in setOf("READ", "FULL")

    val canReadManagement: Boolean
        get() = isOwner || normalizedRole == "admin" || (normalizedRole == "manager" && canReadTreasury)

    val canSelectBranch: Boolean
        get() = canReadManagement && (normalizedRole == "admin" || isOwner)

    /** `shifts.close` authorizes admin globally and manager only inside the manager's branch. */
    fun canClose(shift: ShiftRecord): Boolean = shift.status == ShiftStatus.OPEN && when {
        isOwner || normalizedRole == "admin" -> true
        normalizedRole == "manager" -> canReadTreasury && branchId != null && shift.branchId == branchId
        else -> false
    }

    fun effectiveBranch(requested: Long?): Long? = if (canSelectBranch) requested else branchId

    companion object {
        fun fromBootstrap(value: AppBootstrap): ShiftAccessPolicy {
            val treasury = value.modules.firstOrNull { it.key == "treasury" }?.access ?: "NONE"
            return ShiftAccessPolicy(
                role = value.user.role,
                actorId = value.user.id,
                branchId = value.branchId,
                treasuryAccess = treasury,
                isOwner = value.isOwner || value.user.isOwner,
            )
        }
    }
}

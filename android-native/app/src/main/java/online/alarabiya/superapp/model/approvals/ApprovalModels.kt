package online.alarabiya.superapp.model.approvals

import online.alarabiya.superapp.model.AppBootstrap

enum class ApprovalKind(
    val apiValue: String,
    val moduleKey: String,
    val title: String,
) {
    INVENTORY("inventory", "inventory", "المخزون"),
    LEAVE("leave", "hr", "الإجازات"),
    VOUCHER("voucher", "treasury", "السندات"),
    GIFT("gift", "gifts", "الهدايا");

    companion object {
        fun fromApi(value: String): ApprovalKind? = entries.firstOrNull { it.apiValue == value }
    }
}

enum class RejectionReasonPolicy {
    REQUIRED,
    NOT_SUPPORTED,
}

data class ApprovalCapabilities(
    val canApprove: Boolean,
    val canReject: Boolean,
    val rejectionReasonPolicy: RejectionReasonPolicy,
    /** The current domain mutations do not accept an idempotency key. */
    val hasServerIdempotencyKey: Boolean = false,
)

data class ApprovalRequest(
    val id: Long,
    val kind: ApprovalKind,
    val title: String,
    val reference: String,
    val detail: String,
    val createdAt: String,
    val amount: String? = null,
    val currentQuantity: Double? = null,
    val targetQuantity: Double? = null,
    val capabilities: ApprovalCapabilities,
) {
    val key: ApprovalKey get() = ApprovalKey(kind, id)
}

data class ApprovalKey(val kind: ApprovalKind, val id: Long)

sealed interface ApprovalDecision {
    data object Approve : ApprovalDecision
    data class Reject(val reason: String? = null) : ApprovalDecision
}

data class ApprovalDecisionReceipt(
    val requestId: Long,
    val kind: ApprovalKind,
    val decision: ApprovalDecision,
)

/**
 * Client-side visibility is defense in depth. The server remains authoritative and repeats
 * module access, branch scope, role, and maker-checker checks for both inbox and mutations.
 */
data class ApprovalAccessPolicy(private val writableKinds: Set<ApprovalKind>) {
    fun canManage(kind: ApprovalKind): Boolean = kind in writableKinds

    fun filter(requests: List<ApprovalRequest>): List<ApprovalRequest> =
        requests.filter { canManage(it.kind) }

    companion object {
        fun fromBootstrap(
            bootstrap: AppBootstrap,
            effectiveBranchId: Long? = bootstrap.branchId,
        ): ApprovalAccessPolicy {
            val fullModules = bootstrap.modules
                .filter { it.access.equals("FULL", ignoreCase = true) }
                .mapTo(mutableSetOf()) { it.key }
            val role = bootstrap.user.role.lowercase()
            val manager = role == "admin" || role == "manager"
            val treasuryApprover = manager || role == "accountant"

            return ApprovalAccessPolicy(buildSet {
                if (manager && "inventory" in fullModules) add(ApprovalKind.INVENTORY)
                if ("hr" in fullModules) add(ApprovalKind.LEAVE)
                // vouchers.approve/reject explicitly reject sessions without an assigned branch,
                // including an otherwise global admin session.
                if (treasuryApprover && effectiveBranchId != null && "treasury" in fullModules) {
                    add(ApprovalKind.VOUCHER)
                }
                if (manager && "gifts" in fullModules) add(ApprovalKind.GIFT)
            })
        }

        fun allow(kinds: Set<ApprovalKind>): ApprovalAccessPolicy = ApprovalAccessPolicy(kinds)
    }
}

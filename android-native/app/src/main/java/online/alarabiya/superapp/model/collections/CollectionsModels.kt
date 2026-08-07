package online.alarabiya.superapp.model.collections

import online.alarabiya.superapp.model.AppBootstrap

data class CollectionsCapabilities(
    val userId: Long,
    val role: String,
) {
    val canReadCreditDecisions get() = role.lowercase() in setOf("admin", "manager")
    val canCancelActiveDecision get() = canReadCreditDecisions

    companion object {
        fun fromBootstrap(value: AppBootstrap) = CollectionsCapabilities(
            userId = value.user.id,
            role = value.user.role,
        )
    }
}

enum class CreditDecisionStatus { ACTIVE, EXPIRED, CONSUMED, CANCELLED }

data class CreditDecision(
    val id: Long,
    val customerId: Long,
    val customerName: String,
    val customerPhone: String?,
    val maxAmount: String,
    val approvedBy: Long?,
    val approvedByName: String?,
    val approvedAt: String?,
    val expiresAt: String?,
    val consumedAt: String?,
    val consumedByInvoiceId: Long?,
    val notes: String?,
    /** Authoritative because the row came from the matching server-side status filter. */
    val status: CreditDecisionStatus,
)

data class CreditDecisionPage(
    val rows: List<CreditDecision>,
    val total: Int,
    val offset: Int,
    val limit: Int,
) {
    val hasMore get() = offset + rows.size < total
}

data class CancelCreditDecisionCommand(
    val decisionId: Long,
    val reason: String,
)

object CollectionsValidation {
    fun cancel(command: CancelCreditDecisionCommand): String? = when {
        command.decisionId <= 0 -> "معرّف قرار الائتمان غير صالح"
        command.reason.trim().length < 5 -> "سبب الإلغاء يجب ألا يقل عن 5 أحرف"
        command.reason.length > 255 -> "سبب الإلغاء أطول من الحد المسموح"
        else -> null
    }
}

object CollectionsContractGaps {
    const val RECEIVABLES_OWNS_REMINDERS =
        "The native receivables workspace already owns AR/AP reminder queue, history, API send, promises, installments, and payment flows. Collections does not duplicate those contracts."
    const val CUSTOMER_NOTES_CRM_BOUNDARY =
        "customerNotes are CRM-owned. Their list and mutation services do not enforce note branch ownership, so they are intentionally excluded from collections."
    const val CREDIT_GLOBAL_SCOPE =
        "creditApproval uses managerProcedure and returns company-wide rows without branch ownership. Native visibility is limited to admin/manager and is labelled company-wide."
    const val CREDIT_CREATE_NON_IDEMPOTENT =
        "creditApproval.create has no clientRequestId. Native creation is omitted because a lost response can create duplicate active approvals."
    const val CREDIT_CREATOR_CONSUMER_SOD =
        "credit approval validation does not compare approvedBy with the sale actor. A manager can technically create and consume the same approval; native creation is omitted and the server must enforce maker != consumer."
    const val CREDIT_CANCEL_RECONCILIATION =
        "creditApproval.cancel has no clientRequestId, but is a monotonic ACTIVE-to-CANCELLED transition. Native allows it only with explicit confirmation and refreshes the server-filtered state after success; ambiguous transport failures require manual refresh."
    const val STATUS_FILTER_AUTHORITY =
        "creditApproval.list does not return an explicit status field. Native never derives status from device time; it labels rows using the server-side status filter that produced the page."
}

package online.alarabiya.superapp.model.collections

import online.alarabiya.superapp.model.AppBootstrap

data class CollectionsCapabilities(
    val userId: Long,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
    val collectionsAccess: String,
) {
    private val hasFullCollectionsAccess get() =
        role.equals("admin", true) || collectionsAccess.equals("FULL", true)
    val canReadCreditDecisions get() =
        role.lowercase() in setOf("admin", "manager") && hasFullCollectionsAccess
    val canCancelActiveDecision get() = canReadCreditDecisions
    val canCreateCreditDecision get() = canReadCreditDecisions && (role.equals("admin", true) || branchId != null)
    val canSelectBranch get() = role.equals("admin", true) && allBranches

    companion object {
        fun fromBootstrap(value: AppBootstrap) = CollectionsCapabilities(
            userId = value.user.id,
            role = value.user.role,
            branchId = value.branchId,
            allBranches = value.allBranches,
            collectionsAccess = value.modules.firstOrNull { it.key == "collections" }?.access ?: "NONE",
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
    val branchId: Long? = null,
    val branchName: String? = null,
)

data class CreditCustomerOption(
    val id: Long,
    val name: String,
    val phone: String?,
    val currentBalance: String,
)

data class CreditBranchOption(
    val id: Long,
    val name: String,
    val code: String?,
)

data class CreateCreditDecisionDraft(
    val branchId: Long? = null,
    val customerId: Long? = null,
    val customerName: String = "",
    val maxAmount: String = "",
    val ttlMinutes: String = "60",
    val notes: String = "",
    val clientRequestId: String,
)

data class CreateCreditDecisionCommand(
    val branchId: Long,
    val customerId: Long,
    val maxAmount: String,
    val ttlMinutes: Int,
    val notes: String?,
    val clientRequestId: String,
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

    fun create(draft: CreateCreditDecisionDraft, capabilities: CollectionsCapabilities): String? {
        val amount = draft.maxAmount.trim()
        val ttl = draft.ttlMinutes.toIntOrNull()
        return when {
            !capabilities.canCreateCreditDecision -> "لا توجد صلاحية إصدار قرار ائتمان"
            draft.branchId == null || draft.branchId <= 0 -> "اختر الفرع"
            !capabilities.canSelectBranch && draft.branchId != capabilities.branchId -> "نطاق الفرع يحدده حسابك"
            draft.customerId == null || draft.customerId <= 0 -> "اختر العميل"
            !MONEY.matches(amount) || amount.toBigDecimalOrNull()?.signum() != 1 -> "أدخل مبلغاً موجباً بمنزلتين عشريتين كحد أقصى"
            ttl == null || ttl !in 1..1440 -> "مدة القرار يجب أن تكون بين دقيقة و24 ساعة"
            draft.notes.length > 255 -> "الملاحظات أطول من الحد المسموح"
            !UUID.matches(draft.clientRequestId) -> "معرّف الطلب غير صالح"
            else -> null
        }
    }

    fun command(draft: CreateCreditDecisionDraft, capabilities: CollectionsCapabilities): CreateCreditDecisionCommand? {
        if (create(draft, capabilities) != null) return null
        return CreateCreditDecisionCommand(
            branchId = requireNotNull(draft.branchId),
            customerId = requireNotNull(draft.customerId),
            maxAmount = draft.maxAmount.trim(),
            ttlMinutes = requireNotNull(draft.ttlMinutes.toIntOrNull()),
            notes = draft.notes.trim().takeIf(String::isNotEmpty),
            clientRequestId = draft.clientRequestId,
        )
    }

    private val MONEY = Regex("^\\d+(\\.\\d{1,2})?$")
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
}

object CollectionsContractGaps {
    const val RECEIVABLES_OWNS_REMINDERS =
        "The native receivables workspace already owns AR/AP reminder queue, history, API send, promises, installments, and payment flows. Collections does not duplicate those contracts."
    const val CUSTOMER_NOTES_CRM_BOUNDARY =
        "customerNotes are CRM-owned. Their list and mutation services do not enforce note branch ownership, so they are intentionally excluded from collections."
    const val CREDIT_BRANCH_SCOPE =
        "creditApproval rows are branch-bound. Managers are pinned to the session branch; administrators choose an explicit branch."
    const val CREDIT_CREATE_IDEMPOTENT =
        "creditApproval.create uses a stable UUID scoped server-side by company, user, and branch. The UUID rotates only after a committed response."
    const val CREDIT_CREATOR_CONSUMER_SOD =
        "credit approval validation rejects the issuing user as the sale consumer and rejects cross-branch consumption."
    const val CREDIT_CANCEL_RECONCILIATION =
        "creditApproval.cancel has no clientRequestId, but is a monotonic ACTIVE-to-CANCELLED transition. Native allows it only with explicit confirmation and refreshes the server-filtered state after success; ambiguous transport failures require manual refresh."
    const val STATUS_FILTER_AUTHORITY =
        "creditApproval.list does not return an explicit status field. Native never derives status from device time; it labels rows using the server-side status filter that produced the page."
}

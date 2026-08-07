package online.alarabiya.superapp.feature.approvals

import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalKey
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.approvals.ApprovalRequest

enum class ApprovalFilter(val label: String) {
    ALL("الكل"),
    INVENTORY("المخزون"),
    LEAVE("الإجازات"),
    VOUCHER("السندات"),
    GIFT("الهدايا");

    fun accepts(kind: ApprovalKind): Boolean = when (this) {
        ALL -> true
        INVENTORY -> kind == ApprovalKind.INVENTORY
        LEAVE -> kind == ApprovalKind.LEAVE
        VOUCHER -> kind == ApprovalKind.VOUCHER
        GIFT -> kind == ApprovalKind.GIFT
    }
}

data class PendingApprovalDecision(
    val requestKey: ApprovalKey,
    val decision: ApprovalDecision,
)

data class ApprovalsUiState(
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val requests: List<ApprovalRequest> = emptyList(),
    val selectedKey: ApprovalKey? = null,
    val filter: ApprovalFilter = ApprovalFilter.ALL,
    val confirmation: PendingApprovalDecision? = null,
    val submittingKey: ApprovalKey? = null,
    val error: String? = null,
    val notice: String? = null,
) {
    val visibleRequests: List<ApprovalRequest>
        get() = requests.filter { filter.accepts(it.kind) }

    val selectedRequest: ApprovalRequest?
        get() = requests.firstOrNull { it.key == selectedKey }

    fun loaded(items: List<ApprovalRequest>): ApprovalsUiState {
        val retained = selectedKey?.takeIf { key -> items.any { it.key == key } }
        return copy(
            loading = false,
            refreshing = false,
            requests = items,
            selectedKey = retained,
            error = null,
        )
    }

    fun failed(message: String): ApprovalsUiState = copy(
        loading = false,
        refreshing = false,
        submittingKey = null,
        confirmation = null,
        error = message,
    )

    fun decisionStarted(pending: PendingApprovalDecision): ApprovalsUiState {
        if (submittingKey != null) return this
        return copy(confirmation = null, submittingKey = pending.requestKey, error = null, notice = null)
    }

    fun decisionCompleted(requestKey: ApprovalKey, approved: Boolean): ApprovalsUiState = copy(
        requests = requests.filterNot { it.key == requestKey },
        selectedKey = selectedKey.takeUnless { it == requestKey },
        submittingKey = null,
        confirmation = null,
        error = null,
        notice = if (approved) "تم اعتماد الطلب" else "تم رفض الطلب",
    )
}

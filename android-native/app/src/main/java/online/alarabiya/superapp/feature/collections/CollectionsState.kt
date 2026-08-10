package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.model.collections.CreditDecision
import online.alarabiya.superapp.model.collections.CreditBranchOption
import online.alarabiya.superapp.model.collections.CreditCustomerOption
import online.alarabiya.superapp.model.collections.CreateCreditDecisionDraft
import online.alarabiya.superapp.model.collections.CreditDecisionStatus

enum class CollectionsBusy { INITIAL, LIST, LOAD_MORE, BRANCHES, CUSTOMERS, CREATE, CANCEL }

data class CollectionsUiState(
    val initialized: Boolean = false,
    val catalogFresh: Boolean = false,
    val busy: CollectionsBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val status: CreditDecisionStatus = CreditDecisionStatus.ACTIVE,
    val customerIdFilter: String = "",
    val appliedCustomerId: Long? = null,
    val rows: List<CreditDecision> = emptyList(),
    val total: Int = 0,
    val hasMore: Boolean = false,
    val selectedId: Long? = null,
    val cancelReason: String = "",
    val branches: List<CreditBranchOption> = emptyList(),
    val branchesFresh: Boolean = false,
    val createOpen: Boolean = false,
    val createDraft: CreateCreditDecisionDraft = CreateCreditDecisionDraft(clientRequestId = ""),
    val customerQuery: String = "",
    val customerOptions: List<CreditCustomerOption> = emptyList(),
    val customerOptionsFresh: Boolean = false,
) {
    val locked get() = busy != null
    val selected get() = rows.firstOrNull { it.id == selectedId }

    fun start(operation: CollectionsBusy): CollectionsUiState? =
        if (locked) null else copy(busy = operation, error = null, notice = null)

    fun failed(message: String) = copy(
        initialized = true,
        busy = null,
        error = message,
        notice = null,
        catalogFresh = false,
    )

    fun loaded(
        rows: List<CreditDecision>,
        total: Int,
        hasMore: Boolean,
        append: Boolean,
    ) = copy(
        initialized = true,
        busy = null,
        catalogFresh = true,
        rows = if (append) (this.rows + rows).distinctBy { it.id } else rows,
        total = total,
        hasMore = hasMore,
        selectedId = selectedId?.takeIf { id -> (if (append) this.rows + rows else rows).any { it.id == id } },
        error = null,
    )

    fun cancellationCommitted(id: Long) = copy(
        busy = null,
        catalogFresh = false,
        rows = rows.map { if (it.id == id) it.copy(status = CreditDecisionStatus.CANCELLED) else it },
        selectedId = null,
        cancelReason = "",
        error = null,
        notice = "أُلغي قرار الائتمان #$id وحُفظ السبب في سجل التدقيق",
    )

    fun branchesLoaded(rows: List<CreditBranchOption>) = copy(
        branches = rows,
        branchesFresh = true,
        error = null,
    )

    fun customerOptionsLoaded(rows: List<CreditCustomerOption>) = copy(
        busy = null,
        customerOptions = rows,
        customerOptionsFresh = true,
        error = null,
    )

    fun creationCommitted(decision: CreditDecision, nextDraft: CreateCreditDecisionDraft): CollectionsUiState {
        val visible = status == CreditDecisionStatus.ACTIVE &&
            (appliedCustomerId == null || appliedCustomerId == decision.customerId)
        val nextRows = if (visible) listOf(decision) + rows.filterNot { it.id == decision.id } else rows
        return copy(
            busy = null,
            catalogFresh = false,
            createOpen = false,
            createDraft = nextDraft,
            customerQuery = "",
            customerOptions = emptyList(),
            customerOptionsFresh = false,
            rows = nextRows,
            total = if (visible && rows.none { it.id == decision.id }) total + 1 else total,
            selectedId = decision.id.takeIf { visible },
            error = null,
            notice = "صدر قرار الائتمان #${decision.id}",
        )
    }

    fun refreshFailedAfterMutation(message: String) = copy(
        busy = null,
        catalogFresh = false,
        error = message,
        notice = "تمت العملية وتعذر تحديث العرض",
    )
}

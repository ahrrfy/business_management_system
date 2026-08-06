package online.alarabiya.superapp.feature.collections

import online.alarabiya.superapp.model.collections.CreditDecision
import online.alarabiya.superapp.model.collections.CreditDecisionStatus

enum class CollectionsBusy { INITIAL, LIST, LOAD_MORE, CANCEL }

data class CollectionsUiState(
    val initialized: Boolean = false,
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
    )
}

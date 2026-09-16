package online.alarabiya.superapp.feature.approvals

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.ApprovalsDataSource
import online.alarabiya.superapp.model.approvals.ApprovalAccessPolicy
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalKey

class ApprovalsViewModel(
    private val repository: ApprovalsDataSource,
    private val accessPolicy: ApprovalAccessPolicy,
) : ViewModel() {
    var state by mutableStateOf(ApprovalsUiState())
        private set

    init {
        load()
    }

    fun refresh() = load(refreshing = state.requests.isNotEmpty())

    fun select(requestKey: ApprovalKey?) {
        if (requestKey == null) {
            state = state.copy(selectedKey = null, confirmation = null, error = null)
            return
        }
        val selected = state.requests.firstOrNull { it.key == requestKey } ?: return
        state = state.copy(selectedKey = requestKey, confirmation = null, error = null)
        viewModelScope.launch {
            runCatching { repository.loadDetail(selected) }
                .onSuccess { detail ->
                    if (detail.key == requestKey) {
                        state = state.copy(
                            requests = state.requests.map { if (it.key == requestKey) detail else it },
                            error = null,
                        )
                    }
                }
                .onFailure { error ->
                    if (state.selectedKey == requestKey) state = state.copy(error = error.userMessage())
                }
        }
    }

    fun setFilter(filter: ApprovalFilter) {
        state = state.copy(filter = filter, selectedKey = null, confirmation = null)
    }

    fun requestDecision(requestKey: ApprovalKey, decision: ApprovalDecision) {
        if (state.submittingKey != null) return
        val request = state.requests.firstOrNull { it.key == requestKey } ?: return
        if (!accessPolicy.canManage(request.kind)) return
        val allowed = when (decision) {
            is ApprovalDecision.Approve -> request.capabilities.canApprove
            is ApprovalDecision.Reject -> request.capabilities.canReject
        }
        if (allowed) state = state.copy(
            confirmation = PendingApprovalDecision(requestKey, decision),
            error = null,
            notice = null,
        )
    }

    fun cancelDecision() {
        if (state.submittingKey == null) state = state.copy(confirmation = null)
    }

    fun confirmDecision(decision: ApprovalDecision) {
        val pending = state.confirmation ?: return
        if (state.submittingKey != null) return
        val request = state.requests.firstOrNull { it.key == pending.requestKey } ?: return
        val sameDecisionType = (pending.decision is ApprovalDecision.Approve && decision is ApprovalDecision.Approve) ||
            (pending.decision is ApprovalDecision.Reject && decision is ApprovalDecision.Reject)
        if (!sameDecisionType) return
        state = state.decisionStarted(pending.copy(decision = decision))
        viewModelScope.launch {
            runCatching { repository.decide(request, decision) }
                .onSuccess {
                    state = state.decisionCompleted(
                        requestKey = request.key,
                        approved = decision is ApprovalDecision.Approve,
                    )
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun clearNotice() {
        state = state.copy(notice = null)
    }

    private fun load(refreshing: Boolean = false) {
        if (state.loading || state.refreshing) return
        state = state.copy(
            loading = !refreshing,
            refreshing = refreshing,
            error = null,
            notice = null,
        )
        viewModelScope.launch {
            runCatching { accessPolicy.filter(repository.loadPending()) }
                .onSuccess { state = state.loaded(it) }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }
}

private fun Throwable.userMessage(): String =
    message?.takeIf { it.isNotBlank() } ?: "تعذّر إكمال العملية"

class ApprovalsViewModelFactory(
    private val repository: ApprovalsDataSource,
    private val accessPolicy: ApprovalAccessPolicy,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        ApprovalsViewModel(repository, accessPolicy) as T
}

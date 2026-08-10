package online.alarabiya.superapp.feature.finance

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.FinanceDataSource
import online.alarabiya.superapp.model.finance.FinanceAccessPolicy
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceItemKind
import online.alarabiya.superapp.model.finance.FinanceSection

class FinanceViewModel(
    private val repository: FinanceDataSource,
    val accessPolicy: FinanceAccessPolicy,
) : ViewModel() {
    var state by mutableStateOf(
        FinanceUiState(accessPolicy.readableSections.firstOrNull() ?: FinanceSection.OVERVIEW),
    )
        private set

    init {
        if (accessPolicy.canRead(state.section)) load(state.section)
    }

    fun setSection(section: FinanceSection) {
        if (!accessPolicy.canRead(section) || section == state.section) return
        state = state.copy(section = section, selectedKey = null, composer = null, error = null, notice = null)
        if (section !in state.loadedSections) load(section)
    }

    fun refresh() = load(state.section, refresh = state.loadedSections.contains(state.section))

    fun loadMore() {
        if (state.section in state.hasMoreSections) load(state.section, refresh = true, append = true)
    }

    fun select(key: FinanceItemKey?) {
        if (key != null && key.kind != state.section.expectedKind()) return
        state = state.select(key)
        if (key?.kind == FinanceItemKind.VOUCHER) loadVoucherDetail(key)
    }

    fun openComposer(kind: FinanceComposerKind) {
        if (state.submitting || !canCompose(kind)) return
        state = state.copy(
            composer = FinanceDraft(
                kind = kind,
                branchId = accessPolicy.branchId?.toString().orEmpty(),
                secondaryText = if (kind == FinanceComposerKind.EXPENSE) "OTHER" else "",
                clientRequestId = UUID.randomUUID().toString(),
            ),
            error = null,
            notice = null,
        )
    }

    fun updateComposer(transform: (FinanceDraft) -> FinanceDraft) {
        if (!state.submitting) state.composer?.let { state = state.copy(composer = transform(it)) }
    }

    fun closeComposer() {
        if (!state.submitting) state = state.copy(composer = null, createConfirmation = null)
    }

    fun requestCreate() {
        val draft = state.composer ?: return
        val error = draft.validationError()
        state = if (error == null) state.copy(createConfirmation = draft, error = null)
        else state.copy(error = error)
    }

    fun cancelConfirmation() {
        if (!state.submitting) state = state.copy(createConfirmation = null, transferConfirmation = null)
    }

    fun confirmCreate() {
        val draft = state.createConfirmation ?: return
        if (state.submitting || !canCompose(draft.kind)) return
        val command = runCatching(draft::toCommand).getOrElse {
            state = state.copy(error = it.message, createConfirmation = null)
            return
        }
        state = state.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching { repository.create(command) }
                .onSuccess { receipt ->
                    val destination = sectionFor(draft.kind)
                    state = state.mutationCommitted(
                        destination,
                        receipt.reference?.let { "تم إنشاء العملية $it" } ?: "تم إنشاء العملية المالية",
                    )
                    load(destination, refresh = true, keepNotice = true, afterMutation = true)
                }
                .onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun requestTransferAction(key: FinanceItemKey, action: TransferAction) {
        if (!accessPolicy.canReceiveOrCancelTransfer || state.submitting || !state.canWrite(FinanceSection.TRANSFERS)) return
        val transfer = state.transfers.firstOrNull { it.key == key } ?: return
        val allowed = when (action) {
            TransferAction.RECEIVE -> accessPolicy.canReceive(transfer)
            TransferAction.CANCEL -> accessPolicy.canCancel(transfer)
        }
        if (!allowed) return
        state = state.copy(transferConfirmation = PendingTransferAction(key, action), error = null, notice = null)
    }

    fun updateTransferReason(reason: String) {
        if (!state.submitting) state.transferConfirmation?.let {
            state = state.copy(transferConfirmation = it.copy(reason = reason.take(500)))
        }
    }

    fun confirmTransferAction() {
        val pending = state.transferConfirmation ?: return
        if (state.submitting || !accessPolicy.canReceiveOrCancelTransfer || !state.canWrite(FinanceSection.TRANSFERS)) return
        val id = pending.transferKey.numericId() ?: return
        if (pending.action == TransferAction.CANCEL && pending.reason.trim().length < 3) {
            state = state.copy(error = "سبب الإلغاء مطلوب (3 أحرف على الأقل)")
            return
        }
        state = state.copy(submitting = true, error = null)
        viewModelScope.launch {
            runCatching {
                when (pending.action) {
                    TransferAction.RECEIVE -> repository.receiveTransfer(id)
                    TransferAction.CANCEL -> repository.cancelTransfer(id, pending.reason)
                }
            }.onSuccess {
                state = state.transferCommitted(
                    pending.transferKey,
                    status = if (pending.action == TransferAction.RECEIVE) "RECEIVED" else "CANCELLED",
                    message = if (pending.action == TransferAction.RECEIVE) "تم استلام التحويل" else "تم إلغاء التحويل",
                )
                load(FinanceSection.TRANSFERS, refresh = true, keepNotice = true, afterMutation = true)
            }.onFailure { state = state.failed(it.userMessage()) }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private fun load(
        section: FinanceSection,
        refresh: Boolean = false,
        keepNotice: Boolean = false,
        append: Boolean = false,
        afterMutation: Boolean = false,
    ) {
        if (!accessPolicy.canRead(section) || state.loading || state.refreshing) return
        state = state.startLoading(refresh).let { if (keepNotice) it.copy(notice = state.notice) else it }
        viewModelScope.launch {
            runCatching {
                when (section) {
                    FinanceSection.OVERVIEW -> state = state.copy(overview = repository.loadOverview(accessPolicy.branchId))
                    FinanceSection.MOVEMENTS -> state = state.withMovements(
                        repository.loadMovements(accessPolicy.branchId, if (append) state.movements.size else 0), append,
                    )
                    FinanceSection.VOUCHERS -> state = state.withVouchers(
                        repository.loadVouchers(accessPolicy.branchId, if (append) state.vouchers.size else 0), append,
                    )
                    FinanceSection.EXPENSES -> state = state.withExpenses(
                        repository.loadExpenses(accessPolicy.branchId, if (append) state.expenses.size else 0), append,
                    )
                    FinanceSection.TRANSFERS -> state = state.withTransfers(
                        repository.loadTransfers(accessPolicy.branchId, if (append) state.transfers.size else 0), append,
                    )
                    FinanceSection.CARD_ACCOUNT -> {
                        val summary = repository.loadCardSummary(accessPolicy.branchId)
                        state = state.copy(cardSummary = summary)
                            .withCard(
                                repository.loadCardMovements(
                                    accessPolicy.branchId,
                                    if (append) state.cardMovements.size else 0,
                                ),
                                append,
                            )
                    }
                    FinanceSection.ACCOUNTS -> state = state.copy(accounts = repository.loadAccounts())
                }
            }.onSuccess {
                state = state.finishLoading(section)
                val requestedWhileLoading = state.section
                    .takeIf { it != section && it !in state.loadedSections && accessPolicy.canRead(it) }
                if (requestedWhileLoading != null) load(requestedWhileLoading)
            }
                .onFailure { state = state.loadFailed(section, it.userMessage(), afterMutation) }
        }
    }

    private fun canCompose(kind: FinanceComposerKind): Boolean {
        val section = sectionFor(kind)
        if (!state.canWrite(section)) return false
        return when (kind) {
        FinanceComposerKind.VOUCHER -> accessPolicy.canWrite(FinanceSection.VOUCHERS)
        FinanceComposerKind.EXPENSE -> accessPolicy.canWrite(FinanceSection.EXPENSES)
        FinanceComposerKind.TRANSFER -> accessPolicy.canWrite(FinanceSection.TRANSFERS)
        FinanceComposerKind.FUNDING -> accessPolicy.canFundTreasury
        }
    }

    private fun sectionFor(kind: FinanceComposerKind) = when (kind) {
        FinanceComposerKind.VOUCHER -> FinanceSection.VOUCHERS
        FinanceComposerKind.EXPENSE -> FinanceSection.EXPENSES
        FinanceComposerKind.TRANSFER -> FinanceSection.TRANSFERS
        FinanceComposerKind.FUNDING -> FinanceSection.OVERVIEW
    }

    private fun loadVoucherDetail(key: FinanceItemKey) {
        val id = key.numericId() ?: return
        if (state.detailLoadingKey == key) return
        state = state.copy(detailLoadingKey = key, error = null)
        viewModelScope.launch {
            runCatching { repository.loadVoucher(id) }
                .onSuccess { detail ->
                    state = state.copy(
                        vouchers = state.vouchers.map { if (it.key == key) detail else it },
                        detailLoadingKey = state.detailLoadingKey.takeUnless { it == key },
                    )
                }
                .onFailure {
                    state = state.copy(
                        detailLoadingKey = state.detailLoadingKey.takeUnless { it == key },
                        error = it.userMessage(),
                    )
                }
        }
    }
}

private fun Throwable.userMessage(): String = message?.takeIf(String::isNotBlank)
    ?: "تعذّر إكمال العملية المالية"

class FinanceViewModelFactory(
    private val repository: FinanceDataSource,
    private val accessPolicy: FinanceAccessPolicy,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        FinanceViewModel(repository, accessPolicy) as T
}

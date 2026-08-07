package online.alarabiya.superapp.feature.operations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.AssetQuery
import online.alarabiya.superapp.data.ConsignmentQuery
import online.alarabiya.superapp.data.OperationsDataSource
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.ConsignmentNoteType
import online.alarabiya.superapp.model.operations.ConsignorProduct
import online.alarabiya.superapp.model.operations.OperationsCapabilities
import online.alarabiya.superapp.model.operations.OperationsPolicy
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.operations.OperationsSection
import online.alarabiya.superapp.model.operations.OperationsValidation
import online.alarabiya.superapp.model.operations.QuickConsignmentInput

class OperationsViewModel(
    private val source: OperationsDataSource,
    scope: OperationsScope,
    capabilities: OperationsCapabilities,
) : ViewModel() {
    var state by mutableStateOf(OperationsUiState(scope = scope, capabilities = capabilities))
        private set

    private var searchJob: Job? = null

    init {
        val initial = when {
            capabilities.canReadAssets -> OperationsSection.Assets
            capabilities.canReadConsignments -> OperationsSection.Consignment
            else -> OperationsSection.MyCommission
        }
        state = state.copy(section = initial)
        refresh()
    }

    fun availableSections(): List<OperationsSection> = state.capabilities.sections

    fun setSection(section: OperationsSection) {
        if (section !in availableSections() || state.busyKey != null) return
        searchJob?.cancel()
        state = state.copy(
            section = section,
            query = "",
            selectedAssetId = null,
            assetDetail = OperationsDetailState.None,
            selectedNoteId = null,
            noteDetail = OperationsDetailState.None,
            error = null,
            notice = null,
        )
        when (section) {
            OperationsSection.Assets,
            OperationsSection.Custody,
            -> if (!state.assetsLoaded) refresh()
            OperationsSection.MyCommission -> if (state.commission == OperationsDetailState.None) refresh()
            OperationsSection.Consignment -> if (!state.notesLoaded) refresh()
        }
    }

    fun refresh() {
        if (state.busyKey != null) return
        when (state.section) {
            OperationsSection.Assets,
            OperationsSection.Custody,
            -> loadAssets()
            OperationsSection.MyCommission -> loadCommission()
            OperationsSection.Consignment -> loadNotes(reset = true)
        }
    }

    fun setQuery(query: String) {
        state = state.copy(query = query.take(80))
        if (state.section == OperationsSection.Consignment) {
            searchJob?.cancel()
            searchJob = viewModelScope.launch {
                delay(350)
                state = state.copy(loading = true, error = null)
                loadNotesInternal(reset = true)
            }
        }
    }

    fun setAssetStatus(status: AssetStatus?) {
        if (state.busyKey != null || status == AssetStatus.Unknown) return
        state = state.copy(assetStatus = status, selectedAssetId = null, assetDetail = OperationsDetailState.None)
        loadAssets()
    }

    fun setConsignmentType(type: ConsignmentNoteType?) {
        if (state.busyKey != null || type == ConsignmentNoteType.Unknown) return
        searchJob?.cancel()
        state = state.copy(consignmentType = type, selectedNoteId = null, noteDetail = OperationsDetailState.None)
        loadNotes(reset = true)
    }

    fun loadMoreNotes() {
        if (state.loading || state.loadingMore || state.notes.size >= state.notesTotal) return
        state = state.copy(loadingMore = true)
        viewModelScope.launch { loadNotesInternal(reset = false) }
    }

    fun selectAsset(id: Long?) {
        state = state.copy(selectedAssetId = id, assetDetail = OperationsDetailState.None)
        val asset = state.assets.firstOrNull { it.id == id } ?: return
        state = state.copy(assetDetail = OperationsDetailState.Loading)
        viewModelScope.launch {
            runCatching { source.assetDetail(asset) }
                .onSuccess { detail ->
                    if (state.selectedAssetId == id) state = state.copy(assetDetail = OperationsDetailState.Content(detail))
                }
                .onFailure { error ->
                    if (state.selectedAssetId == id) state = state.copy(assetDetail = OperationsDetailState.Error(userMessage(error)))
                }
        }
    }

    fun selectNote(id: Long?) {
        state = state.copy(selectedNoteId = id, noteDetail = OperationsDetailState.None)
        val note = state.notes.firstOrNull { it.id == id } ?: return
        state = state.copy(noteDetail = OperationsDetailState.Loading)
        viewModelScope.launch {
            runCatching { source.consignmentDetail(note) }
                .onSuccess { detail ->
                    if (state.selectedNoteId == id) state = state.copy(noteDetail = OperationsDetailState.Content(detail))
                }
                .onFailure { error ->
                    if (state.selectedNoteId == id) state = state.copy(noteDetail = OperationsDetailState.Error(userMessage(error)))
                }
        }
    }

    fun setCommissionPeriod(period: String) {
        if (!PERIOD.matches(period)) {
            state = state.copy(error = "الشهر بصيغة YYYY-MM")
            return
        }
        state = state.copy(commissionPeriod = period, error = null)
        loadCommission()
    }

    fun requestStartMaintenance(type: String, vendor: String?, note: String?, date: String?) {
        val asset = selectedAsset() ?: return
        if (!OperationsPolicy.canStartMaintenance(asset, state.capabilities) || type.isBlank()) return
        state = state.copy(
            pendingAction = PendingOperationsAction.StartMaintenance(asset, type.trim(), vendor, note, date),
            error = null,
        )
    }

    fun requestReturnAsset() {
        val asset = selectedAsset() ?: return
        if (!OperationsPolicy.canReturnFromMaintenance(asset, state.capabilities)) return
        state = state.copy(pendingAction = PendingOperationsAction.ReturnAsset(asset), error = null)
    }

    fun openQuickNote() {
        val note = selectedNote() ?: return
        if (!OperationsPolicy.canCreateFollowUpNote(note, state.capabilities, state.scope)) return
        state = state.copy(quickNoteTarget = note, quickProducts = OperationsDetailState.Loading, error = null)
        viewModelScope.launch {
            runCatching { source.consignorProducts(note.consignorId, note.branchId) }
                .onSuccess { products ->
                    if (state.quickNoteTarget?.id == note.id) {
                        state = state.copy(quickProducts = OperationsDetailState.Content(products))
                    }
                }
                .onFailure { error ->
                    if (state.quickNoteTarget?.id == note.id) {
                        state = state.copy(quickProducts = OperationsDetailState.Error(userMessage(error)))
                    }
                }
        }
    }

    fun dismissQuickNote() {
        if (state.busyKey == null) state = state.copy(quickNoteTarget = null, quickProducts = OperationsDetailState.None)
    }

    fun requestQuickNote(
        type: ConsignmentNoteType,
        product: ConsignorProduct,
        quantity: String,
        notes: String?,
    ) {
        val target = state.quickNoteTarget ?: return
        if (type !in setOf(ConsignmentNoteType.Deposit, ConsignmentNoteType.Withdraw)) return
        if (!OperationsValidation.isPositiveQuantity(quantity)) return
        state = state.copy(
            quickNoteTarget = null,
            quickProducts = OperationsDetailState.None,
            pendingAction = PendingOperationsAction.CreateConsignment(
                note = target,
                type = type,
                product = product,
                quantity = quantity.trim(),
                notes = notes,
                clientRequestId = UUID.randomUUID().toString(),
            ),
        )
    }

    fun dismissConfirmation() {
        if (state.busyKey == null) state = state.copy(pendingAction = null)
    }

    fun confirmPendingAction() {
        val action = state.pendingAction ?: return
        if (state.busyKey != null) return
        state = state.copy(pendingAction = null, busyKey = action.key, error = null, notice = null)
        viewModelScope.launch {
            runCatching { execute(action) }
                .onSuccess {
                    state = state.copy(busyKey = null, notice = successMessage(action))
                    when (action) {
                        is PendingOperationsAction.ReturnAsset,
                        is PendingOperationsAction.StartMaintenance,
                        -> {
                            val selectedId = state.selectedAssetId
                            loadAssetsInternal(preserveNotice = true)
                            selectedId?.let(::selectAsset)
                        }
                        is PendingOperationsAction.CreateConsignment -> {
                            state = state.copy(selectedNoteId = null, noteDetail = OperationsDetailState.None)
                            loadNotesInternal(reset = true, preserveNotice = true)
                        }
                    }
                }
                .onFailure { error ->
                    // Keep the exact action/clientRequestId so retry cannot duplicate an accepted write.
                    state = state.copy(busyKey = null, pendingAction = action, error = userMessage(error))
                }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private fun loadAssets() {
        state = state.copy(loading = true, error = null)
        viewModelScope.launch { loadAssetsInternal() }
    }

    private suspend fun loadAssetsInternal(preserveNotice: Boolean = false) {
        val statusSnapshot = state.assetStatus
        runCatching { source.listAssets(AssetQuery(status = statusSnapshot)) }
            .onSuccess { rows ->
                if (state.assetStatus != statusSnapshot) return@onSuccess
                val selected = state.selectedAssetId?.takeIf { id -> rows.any { it.id == id } }
                state = state.copy(
                    loading = false,
                    assets = rows,
                    assetsLoaded = true,
                    selectedAssetId = selected,
                    assetDetail = state.assetDetail.takeIf { selected != null } ?: OperationsDetailState.None,
                    error = null,
                    notice = state.notice.takeIf { preserveNotice },
                )
            }
            .onFailure { error ->
                if (state.assetStatus != statusSnapshot) return@onFailure
                state = state.copy(loading = false, error = userMessage(error), notice = state.notice.takeIf { preserveNotice })
            }
    }

    private fun loadCommission() {
        state = state.copy(loading = true, commission = OperationsDetailState.Loading, error = null)
        val period = state.commissionPeriod
        viewModelScope.launch {
            runCatching { source.myCommission(period) }
                .onSuccess { value ->
                    if (state.commissionPeriod == period) {
                        state = state.copy(loading = false, commission = OperationsDetailState.Content(value), error = null)
                    }
                }
                .onFailure { error ->
                    if (state.commissionPeriod == period) {
                        state = state.copy(
                            loading = false,
                            commission = OperationsDetailState.Error(userMessage(error)),
                            error = userMessage(error),
                        )
                    }
                }
        }
    }

    private fun loadNotes(reset: Boolean) {
        if (reset) state = state.copy(loading = true, error = null) else state = state.copy(loadingMore = true)
        viewModelScope.launch { loadNotesInternal(reset) }
    }

    private suspend fun loadNotesInternal(reset: Boolean, preserveNotice: Boolean = false) {
        val querySnapshot = state.query
        val typeSnapshot = state.consignmentType
        val offset = if (reset) 0 else state.notes.size
        runCatching {
            source.listConsignments(
                ConsignmentQuery(query = querySnapshot, type = typeSnapshot, offset = offset),
            )
        }.onSuccess { page ->
            if (state.query != querySnapshot || state.consignmentType != typeSnapshot) {
                state = state.copy(loading = false, loadingMore = false)
                return@onSuccess
            }
            val rows = if (reset) page.rows else (state.notes + page.rows).distinctBy { it.id }
            val selected = state.selectedNoteId?.takeIf { id -> rows.any { it.id == id } }
            state = state.copy(
                loading = false,
                loadingMore = false,
                notes = rows,
                notesTotal = page.total,
                notesLoaded = true,
                selectedNoteId = selected,
                noteDetail = state.noteDetail.takeIf { selected != null } ?: OperationsDetailState.None,
                error = null,
                notice = state.notice.takeIf { preserveNotice },
            )
        }.onFailure { error ->
            if (state.query != querySnapshot || state.consignmentType != typeSnapshot) return@onFailure
            state = state.copy(
                loading = false,
                loadingMore = false,
                error = userMessage(error),
                notice = state.notice.takeIf { preserveNotice },
            )
        }
    }

    private suspend fun execute(action: PendingOperationsAction) {
        when (action) {
            is PendingOperationsAction.ReturnAsset -> source.returnFromMaintenance(action.asset)
            is PendingOperationsAction.StartMaintenance -> source.startWarrantyMaintenance(
                action.asset,
                action.type,
                action.vendor,
                action.note,
                action.date,
            )
            is PendingOperationsAction.CreateConsignment -> source.createQuickConsignment(
                QuickConsignmentInput(
                    type = action.type,
                    consignorId = action.note.consignorId,
                    branchId = action.note.branchId,
                    product = action.product,
                    quantity = action.quantity,
                    notes = action.notes,
                    clientRequestId = action.clientRequestId,
                ),
            )
        }
    }

    private fun selectedAsset() = state.assets.firstOrNull { it.id == state.selectedAssetId }
    private fun selectedNote() = state.notes.firstOrNull { it.id == state.selectedNoteId }

    private fun successMessage(action: PendingOperationsAction): String = when (action) {
        is PendingOperationsAction.ReturnAsset -> "أُعيد الأصل إلى الخدمة"
        is PendingOperationsAction.StartMaintenance -> "سُجلت الصيانة وحدثت حالة الأصل"
        is PendingOperationsAction.CreateConsignment -> "أُنشئ سند ${action.type.label} جديد"
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    private companion object {
        val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
    }
}

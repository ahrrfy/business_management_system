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
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.model.operations.AssetDepreciationResult
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetDisposalInput
import online.alarabiya.superapp.model.operations.AssetDocument
import online.alarabiya.superapp.model.operations.AssetFormOptions
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.AssetUpsertInput
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
            assetDetailFresh = false,
            assetOverlay = null,
            selectedNoteId = null,
            noteDetail = OperationsDetailState.None,
            error = null,
            notice = null,
        )
        when (section) {
            OperationsSection.Assets,
            OperationsSection.Custody,
            -> if (!state.assetsFresh) refresh()
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
        if (state.busyKey != null) return
        state = state.copy(
            selectedAssetId = id,
            assetDetail = OperationsDetailState.None,
            assetDetailFresh = false,
            assetOverlay = null,
        )
        val asset = state.assets.firstOrNull { it.id == id } ?: return
        state = state.copy(assetDetail = OperationsDetailState.Loading)
        viewModelScope.launch {
            runCatching { source.assetDetail(asset) }
                .onSuccess { detail ->
                    if (state.selectedAssetId == id) {
                        state = state.copy(assetDetail = OperationsDetailState.Content(detail), assetDetailFresh = true)
                    }
                }
                .onFailure { error ->
                    if (state.selectedAssetId == id) {
                        state = state.copy(
                            assetDetail = OperationsDetailState.Error(userMessage(error)),
                            assetDetailFresh = false,
                        )
                    }
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

    fun openCreateAsset() {
        if (!state.capabilities.canCreateAssets || state.assetMutationLocked) return
        state = state.copy(assetOverlay = AssetOverlay.Create, error = null, notice = null)
        ensureAssetOptions()
    }

    fun openEditAsset() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canEditAsset(asset, state.capabilities)
        ) return
        state = state.copy(assetOverlay = AssetOverlay.Edit, error = null, notice = null)
        ensureAssetOptions()
    }

    fun openAssetHandover() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canHandoverAsset(asset, state.capabilities)
        ) return
        state = state.copy(assetOverlay = AssetOverlay.Handover, error = null, notice = null)
        ensureAssetOptions()
    }

    fun openCustodyRelease() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked || asset.custodianId == null ||
            !OperationsPolicy.canHandoverAsset(asset, state.capabilities)
        ) return
        state = state.copy(assetOverlay = AssetOverlay.ReleaseCustody, error = null, notice = null)
    }

    fun openAssetDisposal() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canDisposeAsset(asset, state.capabilities)
        ) return
        state = state.copy(assetOverlay = AssetOverlay.Dispose, error = null, notice = null)
    }

    fun openAssetDocument() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canManageDocuments(asset, state.capabilities)
        ) return
        state = state.copy(assetOverlay = AssetOverlay.AddDocument, error = null, notice = null)
    }

    fun openDepreciationPosting() {
        if (!state.capabilities.canPostDepreciation || state.assetMutationLocked) return
        state = state.copy(assetOverlay = AssetOverlay.PostDepreciation, error = null, notice = null)
    }

    fun closeAssetOverlay() {
        if (state.busyKey == null) state = state.copy(assetOverlay = null)
    }

    fun requestCreateAsset(input: AssetUpsertInput) {
        if (state.assetOverlay != AssetOverlay.Create || !state.capabilities.canCreateAssets ||
            state.assetMutationLocked || !state.assetOptionsFresh
        ) return
        val scoped = input.copy(branchId = state.scope.effectiveBranch(input.branchId))
        OperationsValidation.asset(scoped, state.scope)?.let { return fail(it) }
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.CreateAsset(scoped, UUID.randomUUID().toString()),
            error = null,
        )
    }

    fun requestUpdateAsset(input: AssetUpsertInput) {
        val asset = selectedAsset() ?: return
        if (state.assetOverlay != AssetOverlay.Edit || !state.selectedAssetFresh || state.assetMutationLocked ||
            !state.assetOptionsFresh || !OperationsPolicy.canEditAsset(asset, state.capabilities)
        ) return
        val scoped = input.copy(id = asset.id, branchId = state.scope.effectiveBranch(input.branchId), custodianId = null)
        OperationsValidation.asset(scoped, state.scope)?.let { return fail(it) }
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.UpdateAsset(asset, scoped),
            error = null,
        )
    }

    fun requestAssetHandover(employeeId: Long, note: String?) {
        val asset = selectedAsset() ?: return
        val employee = (state.assetOptions as? OperationsDetailState.Content)?.value?.employees
            ?.firstOrNull { it.id == employeeId }
        if (state.assetOverlay != AssetOverlay.Handover || employee == null || !state.assetOptionsFresh ||
            state.assetMutationLocked || !state.selectedAssetFresh || employee.id == asset.custodianId ||
            !OperationsPolicy.canHandoverAsset(asset, state.capabilities)
        ) return
        if (state.scope.branchId != null && employee.branchId != state.scope.branchId) {
            return fail("الموظف خارج نطاق فرع الجلسة")
        }
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.HandoverAsset(asset, employee.id, employee.name, note),
            error = null,
        )
    }

    fun requestCustodyRelease() {
        val asset = selectedAsset() ?: return
        if (state.assetOverlay != AssetOverlay.ReleaseCustody || asset.custodianId == null ||
            state.assetMutationLocked || !state.selectedAssetFresh ||
            !OperationsPolicy.canHandoverAsset(asset, state.capabilities)
        ) return
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.ReleaseAssetCustody(asset),
            error = null,
        )
    }

    fun requestAssetDisposal(input: AssetDisposalInput) {
        val asset = selectedAsset() ?: return
        val command = input.copy(assetId = asset.id)
        if (state.assetOverlay != AssetOverlay.Dispose || state.assetMutationLocked || !state.selectedAssetFresh ||
            !OperationsPolicy.canDisposeAsset(asset, state.capabilities)
        ) return
        OperationsValidation.disposal(command)?.let { return fail(it) }
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.DisposeAsset(asset, command),
            error = null,
        )
    }

    fun requestAddAssetDocument(title: String, dataUrl: String) {
        val asset = selectedAsset() ?: return
        if (state.assetOverlay != AssetOverlay.AddDocument || state.assetMutationLocked || !state.selectedAssetFresh ||
            !OperationsPolicy.canManageDocuments(asset, state.capabilities)
        ) return
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty()) return fail("عنوان المستند مطلوب")
        if (dataUrl.length !in 16..3_500_000 || !dataUrl.startsWith("data:image/")) {
            return fail("اختر صورة مستند صالحة بالحجم المسموح")
        }
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.AddAssetDocument(asset, cleanTitle, dataUrl),
            error = null,
        )
    }

    fun requestDeleteAssetDocument(document: AssetDocument) {
        val asset = selectedAsset() ?: return
        val detail = selectedAssetDetail() ?: return
        if (state.assetMutationLocked || !state.selectedAssetFresh || document !in detail.documents ||
            !OperationsPolicy.canManageDocuments(asset, state.capabilities)
        ) return
        state = state.copy(pendingAction = PendingOperationsAction.DeleteAssetDocument(asset, document), error = null)
    }

    fun requestPostDepreciation(year: Int, month: Int) {
        if (state.assetOverlay != AssetOverlay.PostDepreciation || state.assetMutationLocked ||
            !state.capabilities.canPostDepreciation || year !in 2000..2200 || month !in 1..12
        ) return
        state = state.copy(
            assetOverlay = null,
            pendingAction = PendingOperationsAction.PostDepreciation(year, month),
            error = null,
        )
    }

    fun acknowledgeOutcomeReview() {
        if (!state.outcomeReviewReady || state.loading || state.busyKey != null) return
        state = state.copy(
            outcomeUnknownAction = null,
            notice = "أُعيد فتح الإجراءات بعد مراجعة سجل الأصول المحدث",
            error = null,
        )
    }

    fun handleNestedBack(): Boolean = when {
        state.pendingAction != null && state.busyKey == null -> true.also { dismissConfirmation() }
        state.assetOverlay != null && state.busyKey == null -> true.also { closeAssetOverlay() }
        state.quickNoteTarget != null && state.busyKey == null -> true.also { dismissQuickNote() }
        state.selectedAssetId != null -> true.also { selectAsset(null) }
        state.selectedNoteId != null -> true.also { selectNote(null) }
        else -> false
    }

    fun requestStartMaintenance(type: String, vendor: String?, note: String?, date: String?) {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canStartMaintenance(asset, state.capabilities) || type.isBlank()
        ) return
        state = state.copy(
            pendingAction = PendingOperationsAction.StartMaintenance(asset, type.trim(), vendor, note, date),
            error = null,
        )
    }

    fun requestReturnAsset() {
        val asset = selectedAsset() ?: return
        if (!state.selectedAssetFresh || state.assetMutationLocked ||
            !OperationsPolicy.canReturnFromMaintenance(asset, state.capabilities)
        ) return
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
            val committed = runCatching { execute(action) }.getOrElse { error ->
                state = if (outcomeMayBeUnknown(action, error)) {
                    state.copy(
                        busyKey = null,
                        pendingAction = null,
                        outcomeUnknownAction = action,
                        assetsFresh = false,
                        assetDetailFresh = false,
                        error = "تعذر تأكيد نتيجة العملية. حدّث سجل الأصول وراجعه قبل تنفيذ أي إجراء جديد.",
                    )
                } else {
                    // Idempotent commands keep the same key; deterministic server rejections may be corrected/retried.
                    state.copy(busyKey = null, pendingAction = action, error = userMessage(error))
                }
                return@launch
            }

            commitAcknowledged(action, committed)
            val success = successMessage(action)
            state = state.copy(busyKey = action.key, notice = success, error = null)
            runCatching { refreshAfterMutation(action) }
                .onSuccess { state = state.copy(busyKey = null, notice = success, error = null) }
                .onFailure { refreshError ->
                    state = state.copy(
                        busyKey = null,
                        assetsFresh = state.assetsFresh && !action.isAssetWrite(),
                        assetDetailFresh = state.assetDetailFresh && !action.isAssetWrite(),
                        notice = success,
                        error = "تم تنفيذ الإجراء، لكن تعذر تحديث البيانات. حدّث الشاشة قبل إجراء جديد. ${userMessage(refreshError)}",
                    )
                }
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private fun loadAssets() {
        state = state.copy(loading = true, assetsFresh = false, assetDetailFresh = false, error = null)
        viewModelScope.launch { loadAssetsInternal() }
    }

    private suspend fun loadAssetsInternal(preserveNotice: Boolean = false) {
        val statusSnapshot = state.assetStatus
        val rows = try {
            source.listAssets(AssetQuery(status = statusSnapshot))
        } catch (error: Throwable) {
            if (state.assetStatus == statusSnapshot) {
                state = state.copy(
                    loading = false,
                    assetsFresh = false,
                    assetDetailFresh = false,
                    error = userMessage(error),
                    notice = state.notice.takeIf { preserveNotice },
                )
            }
            return
        }
        if (state.assetStatus != statusSnapshot) return
        val selected = state.selectedAssetId?.takeIf { id -> rows.any { it.id == id } }
        val summary = rows.firstOrNull { it.id == selected }
        val detail = summary?.let { runCatching { source.assetDetail(it) } }
        if (detail?.isFailure == true) {
            val error = requireNotNull(detail.exceptionOrNull())
            state = state.copy(
                loading = false,
                assets = rows,
                assetsLoaded = true,
                assetsFresh = true,
                selectedAssetId = selected,
                assetDetail = OperationsDetailState.Error(userMessage(error)),
                assetDetailFresh = false,
                error = userMessage(error),
                notice = state.notice.takeIf { preserveNotice },
            )
            return
        }
        state = state.copy(
            loading = false,
            assets = rows,
            assetsLoaded = true,
            assetsFresh = true,
            selectedAssetId = selected,
            assetDetail = detail?.getOrNull()?.let { OperationsDetailState.Content(it) } ?: OperationsDetailState.None,
            assetDetailFresh = detail?.isSuccess == true,
            error = null,
            notice = state.notice.takeIf { preserveNotice },
        )
    }

    private fun ensureAssetOptions() {
        if (state.assetOptionsFresh || state.assetOptions == OperationsDetailState.Loading) return
        state = state.copy(assetOptions = OperationsDetailState.Loading, assetOptionsFresh = false)
        viewModelScope.launch {
            runCatching { source.assetFormOptions() }
                .onSuccess { options ->
                    state = state.copy(assetOptions = OperationsDetailState.Content(options), assetOptionsFresh = true)
                }
                .onFailure { error ->
                    state = state.copy(
                        assetOptions = OperationsDetailState.Error(userMessage(error)),
                        assetOptionsFresh = false,
                        error = userMessage(error),
                    )
                }
        }
    }

    fun retryAssetOptions() {
        if (state.busyKey == null) {
            state = state.copy(assetOptions = OperationsDetailState.None, assetOptionsFresh = false)
            ensureAssetOptions()
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

    private suspend fun execute(action: PendingOperationsAction): OperationsCommit = when (action) {
        is PendingOperationsAction.ReturnAsset -> OperationsCommit.Asset(source.returnFromMaintenance(action.asset))
        is PendingOperationsAction.StartMaintenance -> OperationsCommit.Asset(
            source.startWarrantyMaintenance(action.asset, action.type, action.vendor, action.note, action.date),
        )
        is PendingOperationsAction.CreateAsset -> OperationsCommit.Asset(source.createAsset(action.input))
        is PendingOperationsAction.UpdateAsset -> OperationsCommit.Asset(source.updateAsset(action.asset, action.input))
        is PendingOperationsAction.HandoverAsset -> OperationsCommit.Asset(
            source.handoverAsset(action.asset, action.employeeId, action.note),
        )
        is PendingOperationsAction.ReleaseAssetCustody -> OperationsCommit.Asset(
            source.releaseAssetCustody(action.asset),
        )
        is PendingOperationsAction.DisposeAsset -> OperationsCommit.Asset(source.disposeAsset(action.asset, action.input))
        is PendingOperationsAction.AddAssetDocument -> OperationsCommit.DocumentAdded(
            source.addAssetDocument(action.asset, action.title, action.dataUrl),
        )
        is PendingOperationsAction.DeleteAssetDocument -> OperationsCommit.DocumentDeleted(
            source.deleteAssetDocument(action.asset, action.document.id),
        )
        is PendingOperationsAction.PostDepreciation -> OperationsCommit.Depreciation(
            source.postAssetDepreciation(action.year, action.month),
        )
        is PendingOperationsAction.CreateConsignment -> OperationsCommit.Consignment(
            source.createQuickConsignment(
                QuickConsignmentInput(
                    type = action.type,
                    consignorId = action.note.consignorId,
                    branchId = action.note.branchId,
                    product = action.product,
                    quantity = action.quantity,
                    notes = action.notes,
                    clientRequestId = action.clientRequestId,
                ),
            ),
        )
    }

    private fun commitAcknowledged(action: PendingOperationsAction, commit: OperationsCommit) {
        when (commit) {
            is OperationsCommit.Asset -> {
                val detail = commit.detail
                val rows = (state.assets.filterNot { it.id == detail.summary.id } + detail.summary)
                    .sortedByDescending(AssetSummary::id)
                state = state.copy(
                    assets = rows,
                    assetsLoaded = true,
                    assetsFresh = true,
                    selectedAssetId = detail.summary.id,
                    assetDetail = OperationsDetailState.Content(detail),
                    assetDetailFresh = true,
                    outcomeUnknownAction = null,
                )
            }
            is OperationsCommit.DocumentAdded -> {
                val detail = selectedAssetDetail()
                if (detail != null) {
                    state = state.copy(
                        assetDetail = OperationsDetailState.Content(
                            detail.copy(documents = (detail.documents + commit.document).distinctBy(AssetDocument::id)),
                        ),
                        assetDetailFresh = true,
                    )
                }
            }
            is OperationsCommit.DocumentDeleted -> {
                val detail = selectedAssetDetail()
                if (detail != null) {
                    val deletedId = (action as PendingOperationsAction.DeleteAssetDocument).document.id
                    state = state.copy(
                        assetDetail = OperationsDetailState.Content(
                            detail.copy(documents = detail.documents.filterNot { it.id == deletedId }),
                        ),
                        assetDetailFresh = true,
                    )
                }
            }
            is OperationsCommit.Depreciation -> {
                state = state.copy(
                    assetsFresh = false,
                    assetDetailFresh = false,
                    notice = "رُحّل إهلاك ${commit.result.period} لـ ${commit.result.assetsPosted} أصل",
                )
            }
            is OperationsCommit.Consignment -> {
                state = state.copy(selectedNoteId = null, noteDetail = OperationsDetailState.None)
            }
        }
    }

    private suspend fun refreshAfterMutation(action: PendingOperationsAction) {
        when {
            action.isAssetWrite() -> refreshAssetsAfterAcknowledgedMutation()
            action is PendingOperationsAction.CreateConsignment -> loadNotesInternal(reset = true, preserveNotice = true)
        }
    }

    private suspend fun refreshAssetsAfterAcknowledgedMutation() {
        val statusSnapshot = state.assetStatus
        val selectedId = state.selectedAssetId
        val rows = source.listAssets(AssetQuery(status = statusSnapshot))
        if (state.assetStatus != statusSnapshot) return
        val summary = rows.firstOrNull { it.id == selectedId }
        val detail = summary?.let { source.assetDetail(it) }
        state = state.copy(
            assets = rows,
            assetsLoaded = true,
            assetsFresh = true,
            selectedAssetId = summary?.id,
            assetDetail = detail?.let { OperationsDetailState.Content(it) } ?: OperationsDetailState.None,
            assetDetailFresh = detail != null,
        )
    }

    private fun outcomeMayBeUnknown(action: PendingOperationsAction, error: Throwable): Boolean {
        if (action is PendingOperationsAction.CreateConsignment || action is PendingOperationsAction.PostDepreciation) return false
        val api = error as? ApiException ?: return true
        return api.retryableTransportFailure || api.status == null || api.status == 408 || (api.status ?: 0) >= 500
    }

    private fun PendingOperationsAction.isAssetWrite(): Boolean = this !is PendingOperationsAction.CreateConsignment

    private fun selectedAsset() = state.assets.firstOrNull { it.id == state.selectedAssetId }
    private fun selectedAssetDetail() = (state.assetDetail as? OperationsDetailState.Content)?.value
    private fun selectedNote() = state.notes.firstOrNull { it.id == state.selectedNoteId }

    private fun successMessage(action: PendingOperationsAction): String = when (action) {
        is PendingOperationsAction.ReturnAsset -> "أُعيد الأصل إلى الخدمة"
        is PendingOperationsAction.StartMaintenance -> "سُجلت الصيانة وحدثت حالة الأصل"
        is PendingOperationsAction.CreateAsset -> "أُنشئ الأصل وأضيف إلى السجل"
        is PendingOperationsAction.UpdateAsset -> "حُفظت بيانات الأصل"
        is PendingOperationsAction.HandoverAsset -> "سُلّمت العهدة إلى ${action.employeeName}"
        is PendingOperationsAction.ReleaseAssetCustody -> "استُرجعت العهدة وأصبح الأصل بلا عهدة"
        is PendingOperationsAction.DisposeAsset -> if (action.input.status == AssetStatus.Disposed) {
            "استُبعد الأصل ورُحّل أثره المالي"
        } else {
            "أُخرج الأصل من الخدمة"
        }
        is PendingOperationsAction.AddAssetDocument -> "أُضيف مستند الأصل"
        is PendingOperationsAction.DeleteAssetDocument -> "حُذف مستند الأصل"
        is PendingOperationsAction.PostDepreciation -> "اكتمل ترحيل الإهلاك للفترة المحددة"
        is PendingOperationsAction.CreateConsignment -> "أُنشئ سند ${action.type.label} جديد"
    }

    private fun fail(message: String) {
        state = state.copy(error = message)
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    private companion object {
        val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
    }
}

private sealed interface OperationsCommit {
    data class Asset(val detail: AssetDetail) : OperationsCommit
    data class DocumentAdded(val document: AssetDocument) : OperationsCommit
    data class DocumentDeleted(val assetId: Long) : OperationsCommit
    data class Depreciation(val result: AssetDepreciationResult) : OperationsCommit
    data class Consignment(val noteId: Long) : OperationsCommit
}

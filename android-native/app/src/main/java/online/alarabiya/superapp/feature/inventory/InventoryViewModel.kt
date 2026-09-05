package online.alarabiya.superapp.feature.inventory

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.core.scanner.NativeBarcodeResolution
import online.alarabiya.superapp.data.InventoryDataSource
import online.alarabiya.superapp.model.inventory.AdjustmentDraft
import online.alarabiya.superapp.model.inventory.AdjustmentRequest
import online.alarabiya.superapp.model.inventory.AdjustmentStatus
import online.alarabiya.superapp.model.inventory.CountAssignment
import online.alarabiya.superapp.model.inventory.CountSession
import online.alarabiya.superapp.model.inventory.InventoryBranch
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.inventory.InventorySection
import online.alarabiya.superapp.model.inventory.InventoryValidation
import online.alarabiya.superapp.model.inventory.MovementPage
import online.alarabiya.superapp.model.inventory.MovementType
import online.alarabiya.superapp.model.inventory.ReceiveDraft
import online.alarabiya.superapp.model.inventory.ReceiveLineDraft
import online.alarabiya.superapp.model.inventory.StockBalance
import online.alarabiya.superapp.model.inventory.StocktakeDetail
import online.alarabiya.superapp.model.inventory.StocktakeDraft
import online.alarabiya.superapp.model.inventory.StocktakeStatus
import online.alarabiya.superapp.model.inventory.StocktakeSummary
import online.alarabiya.superapp.model.inventory.TransferDetail
import online.alarabiya.superapp.model.inventory.TransferDraft
import online.alarabiya.superapp.model.inventory.TransferPage
import online.alarabiya.superapp.model.inventory.TransferStatus
import online.alarabiya.superapp.model.warehouseTools.CountSubmitOutcome

enum class ExecutiveStockState { LOW, OUT }

private const val INVENTORY_PAGE_SIZE = 100
private const val MAX_EXECUTIVE_BALANCES = 5_000

data class InventoryUiState(
    val section: InventorySection,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    /** Sections with at least one complete, successful server snapshot in this session. */
    val loadedSections: Set<InventorySection> = emptySet(),
    /** Sections whose displayed snapshot is current enough to permit operational actions. */
    val freshSections: Set<InventorySection> = emptySet(),
    /**
     * Non-idempotent writes whose transport result was ambiguous. These remain locked for the
     * lifetime of this workspace instead of inviting a duplicate adjustment or stocktake.
     */
    val outcomeUnknownSections: Set<InventorySection> = emptySet(),
    val branchesFresh: Boolean = false,
    val branches: List<InventoryBranch> = emptyList(),
    val balanceQuery: String = "",
    val lowOnly: Boolean = false,
    val executiveStockState: ExecutiveStockState? = null,
    val balances: List<StockBalance> = emptyList(),
    val movementQuery: String = "",
    val movementType: MovementType? = null,
    val movements: MovementPage = MovementPage(emptyList(), false, null),
    val transferQuery: String = "",
    val transferStatus: TransferStatus? = null,
    val transfers: TransferPage = TransferPage(emptyList(), null),
    val selectedTransfer: TransferDetail? = null,
    val transferDraft: TransferDraft? = null,
    val receiveDraft: ReceiveDraft? = null,
    val adjustmentStatus: AdjustmentStatus = AdjustmentStatus.PENDING_APPROVAL,
    val adjustments: List<AdjustmentRequest> = emptyList(),
    val adjustmentDraft: AdjustmentDraft? = null,
    val rejectingAdjustmentId: Long? = null,
    val rejectionReason: String = "",
    val stocktakeStatus: StocktakeStatus? = null,
    val stocktakes: List<StocktakeSummary> = emptyList(),
    val selectedStocktake: StocktakeDetail? = null,
    val stocktakeDraft: StocktakeDraft? = null,
    val recountVariantId: Long? = null,
    val recountReason: String = "",
    val cancelStocktakeReason: String = "",
    val countAssignments: List<CountAssignment> = emptyList(),
    val selectedCount: CountSession? = null,
    val countQuery: String = "",
    val countScannedVariantId: Long? = null,
    val countScannedBarcode: String? = null,
) {
    val visibleBalances: List<StockBalance>
        get() = when (executiveStockState) {
            ExecutiveStockState.LOW -> balances.filter(StockBalance::isLow)
            ExecutiveStockState.OUT -> balances.filter { it.quantity <= 0 }
            null -> balances
        }

    fun isLoaded(section: InventorySection): Boolean = section in loadedSections

    fun isFresh(section: InventorySection): Boolean =
        section in freshSections && section !in outcomeUnknownSections

    fun canInteract(section: InventorySection): Boolean =
        !initializing && busyKey == null && isFresh(section)
}

internal fun InventoryUiState.markFresh(section: InventorySection): InventoryUiState = copy(
    loadedSections = loadedSections + section,
    freshSections = freshSections + section,
)

internal fun InventoryUiState.markStale(section: InventorySection): InventoryUiState = copy(
    freshSections = freshSections - section,
)

internal fun InventoryUiState.markOutcomeUnknown(section: InventorySection): InventoryUiState = copy(
    freshSections = freshSections - section,
    outcomeUnknownSections = outcomeUnknownSections + section,
)

private fun InventoryUiState.withReadResult(
    section: InventorySection,
    result: Result<*>?,
): InventoryUiState = when {
    result == null -> this
    result.isSuccess -> markFresh(section)
    else -> markStale(section)
}

private fun Result<*>?.combineRequired(
    detail: Result<*>?,
    detailRequired: Boolean,
): Result<Unit>? = when {
    this == null -> null
    isFailure -> Result.failure(exceptionOrNull() ?: IllegalStateException("تعذر تحميل البيانات"))
    detailRequired && detail?.isFailure != false -> Result.failure(
        detail?.exceptionOrNull() ?: IllegalStateException("تعذر تحميل التفاصيل"),
    )
    else -> Result.success(Unit)
}

internal fun InventoryUiState.acknowledgeTransferStatus(
    id: Long,
    status: TransferStatus,
): InventoryUiState = copy(
    selectedTransfer = selectedTransfer?.takeIf { it.id == id }?.copy(status = status)
        ?: selectedTransfer,
    transfers = transfers.copy(
        rows = transfers.rows.map { row -> if (row.id == id) row.copy(status = status) else row },
    ),
    receiveDraft = null,
)

internal fun InventoryUiState.acknowledgeAdjustment(
    id: Long,
    status: AdjustmentStatus,
    rejectionReason: String? = null,
): InventoryUiState = copy(
    adjustments = adjustments.map { row ->
        if (row.id == id) row.copy(status = status, rejectionReason = rejectionReason) else row
    }.filter { row -> adjustmentStatus == AdjustmentStatus.UNKNOWN || row.status == adjustmentStatus },
    rejectingAdjustmentId = null,
    rejectionReason = "",
)

internal fun InventoryUiState.acknowledgeStocktakeStatus(
    id: Long,
    status: StocktakeStatus,
): InventoryUiState = copy(
    selectedStocktake = selectedStocktake?.takeIf { it.summary.id == id }?.let { detail ->
        detail.copy(summary = detail.summary.copy(status = status))
    } ?: selectedStocktake,
    stocktakes = stocktakes.map { row -> if (row.id == id) row.copy(status = status) else row }
        .filter { row -> stocktakeStatus == null || row.status == stocktakeStatus },
    recountVariantId = null,
    recountReason = "",
    cancelStocktakeReason = "",
)

internal fun InventoryUiState.acknowledgeCount(
    sessionCode: String,
    variantId: Long,
    quantity: Int,
): InventoryUiState {
    val session = selectedCount?.takeIf { it.code == sessionCode } ?: return this
    val wasCounted = session.items.firstOrNull { it.variantId == variantId }?.counted == true
    return copy(
        selectedCount = session.copy(
            counted = (session.counted + if (wasCounted) 0 else 1).coerceAtMost(session.total),
            items = session.items.map { row ->
                if (row.variantId == variantId) {
                    row.copy(counted = true, myQuantity = quantity, recountReason = null)
                } else {
                    row
                }
            },
        ),
    )
}

internal fun InventoryUiState.applyExecutiveNavigation(arguments: Map<String, String>): InventoryUiState {
    val stockState = when (arguments["stockState"]?.lowercase()) {
        "low" -> ExecutiveStockState.LOW
        "out" -> ExecutiveStockState.OUT
        else -> return this
    }
    return copy(
        section = InventorySection.BALANCES,
        lowOnly = stockState == ExecutiveStockState.LOW,
        executiveStockState = stockState,
        error = null,
        message = null,
    )
}

private data class InitialInventory(
    val branches: Result<List<InventoryBranch>>?,
    val balances: Result<List<StockBalance>>?,
    val movements: Result<MovementPage>?,
    val transfers: Result<TransferPage>?,
    val selectedTransfer: Result<TransferDetail>?,
    val adjustments: Result<List<AdjustmentRequest>>?,
    val stocktakes: Result<List<StocktakeSummary>>?,
    val selectedStocktake: Result<StocktakeDetail>?,
    val counts: Result<List<CountAssignment>>,
    val selectedCount: Result<CountSession>?,
)

internal data class CountRequestKey(
    val sessionCode: String,
    val variantId: Long,
    val quantity: Int,
)

internal class CountRequestIdRegistry(
    private val createId: () -> String = { UUID.randomUUID().toString() },
) {
    private val ids = mutableMapOf<CountRequestKey, String>()

    fun idFor(sessionCode: String, variantId: Long, quantity: Int): String =
        ids.getOrPut(CountRequestKey(sessionCode, variantId, quantity), createId)
}

private enum class MutationReplayPolicy {
    /** A stable clientRequestId makes a repeated request safe after a fresh reconciliation read. */
    IDEMPOTENT,

    /** A state transition is locked until a fresh read proves its authoritative server state. */
    MONOTONIC,

    /** No idempotency/reconciliation contract exists; an ambiguous outcome locks the section. */
    NON_IDEMPOTENT,
}

private typealias InventoryReducer = (InventoryUiState) -> InventoryUiState

class InventoryViewModel(
    private val source: InventoryDataSource,
    val capabilities: InventoryCapabilities,
) : ViewModel() {
    private var pendingExecutiveBalanceRefresh = false
    private val countRequestIds = CountRequestIdRegistry()

    var state by mutableStateOf(
        InventoryUiState(section = capabilities.visibleSections.first()),
    )
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, error = null, message = null)
        viewModelScope.launch {
            val scopedRead = capabilities.canRead && capabilities.branchId != null
            val selectedTransferId = state.selectedTransfer?.id
            val selectedStocktakeId = state.selectedStocktake?.summary?.id
            val selectedCountCode = state.selectedCount?.code
            val result = coroutineScope {
                val branches = async { if (capabilities.canWrite) runCatching { source.branches() } else null }
                val balances = async {
                    if (scopedRead) runCatching { loadBalances() } else null
                }
                val movements = async { if (scopedRead) runCatching { source.movements() } else null }
                val transfers = async { if (scopedRead) runCatching { source.transfers() } else null }
                val selectedTransfer = async {
                    if (scopedRead && selectedTransferId != null) runCatching { source.transfer(selectedTransferId) } else null
                }
                val adjustments = async { if (scopedRead) runCatching { source.adjustments() } else null }
                val stocktakes = async { if (capabilities.canViewStocktakes && capabilities.branchId != null) runCatching { source.stocktakes() } else null }
                val selectedStocktake = async {
                    if (capabilities.canViewStocktakes && selectedStocktakeId != null) {
                        runCatching { source.stocktake(selectedStocktakeId) }
                    } else {
                        null
                    }
                }
                val counts = async { runCatching { source.countAssignments() } }
                val selectedCount = async {
                    selectedCountCode?.let { code -> runCatching { source.countSession(code) } }
                }
                InitialInventory(
                    branches.await(), balances.await(), movements.await(), transfers.await(), selectedTransfer.await(),
                    adjustments.await(), stocktakes.await(), selectedStocktake.await(), counts.await(), selectedCount.await(),
                )
            }
            val firstError = listOf(
                result.branches, result.balances, result.movements, result.transfers, result.selectedTransfer,
                result.adjustments, result.stocktakes, result.selectedStocktake, result.counts, result.selectedCount,
            ).firstNotNullOfOrNull { it?.exceptionOrNull() }
            var next = state.copy(
                initializing = false,
                branchesFresh = result.branches?.isSuccess == true || !capabilities.canWrite,
                branches = result.branches?.getOrNull() ?: state.branches,
                balances = result.balances?.getOrNull() ?: state.balances,
                movements = result.movements?.getOrNull() ?: state.movements,
                transfers = result.transfers?.getOrNull() ?: state.transfers,
                selectedTransfer = result.selectedTransfer?.getOrNull() ?: state.selectedTransfer,
                adjustments = result.adjustments?.getOrNull() ?: state.adjustments,
                stocktakes = result.stocktakes?.getOrNull() ?: state.stocktakes,
                selectedStocktake = result.selectedStocktake?.getOrNull() ?: state.selectedStocktake,
                countAssignments = result.counts.getOrNull() ?: state.countAssignments,
                selectedCount = result.selectedCount?.getOrNull() ?: state.selectedCount,
                error = firstError?.let(::userMessage)
                    ?: if (capabilities.canRead && capabilities.branchId == null) "لا يوجد فرع مرتبط بالجلسة؛ عُطّلت قراءات وكتابات المخزون بأمان" else null,
            )
            val countsReadResult: Result<Unit> = if (
                result.counts.isSuccess && (selectedCountCode == null || result.selectedCount?.isSuccess == true)
            ) {
                Result.success(Unit)
            } else {
                Result.failure(firstError ?: IllegalStateException("تعذر تحديث تكليفات الجرد"))
            }
            next = next.withReadResult(InventorySection.BALANCES, result.balances)
                .withReadResult(InventorySection.MOVEMENTS, result.movements)
                .withReadResult(
                    InventorySection.TRANSFERS,
                    result.transfers.combineRequired(result.selectedTransfer, selectedTransferId != null),
                )
                .withReadResult(InventorySection.ADJUSTMENTS, result.adjustments)
                .withReadResult(
                    InventorySection.STOCKTAKES,
                    result.stocktakes.combineRequired(result.selectedStocktake, selectedStocktakeId != null),
                )
                .withReadResult(
                    InventorySection.MY_COUNTS,
                    countsReadResult,
                )
            val refreshedTransfer = next.selectedTransfer
            if (refreshedTransfer != null && !capabilities.canReceive(refreshedTransfer)) {
                next = next.copy(receiveDraft = null)
            }
            state = next
            if (pendingExecutiveBalanceRefresh) {
                pendingExecutiveBalanceRefresh = false
                searchBalances()
            }
        }
    }

    fun applyNavigationArguments(arguments: Map<String, String>) {
        if (InventorySection.BALANCES !in capabilities.visibleSections) return
        if (arguments["stockState"]?.lowercase() !in setOf("low", "out")) return
        val next = state.applyExecutiveNavigation(arguments)
        state = next
        if (state.initializing || state.busyKey != null) pendingExecutiveBalanceRefresh = true
        else searchBalances()
    }

    fun selectSection(section: InventorySection) {
        if (section !in capabilities.visibleSections) return
        state = state.copy(section = section, error = null, message = null)
    }

    fun clearFeedback() { state = state.copy(error = null, message = null) }

    fun setBalanceQuery(value: String) { state = state.copy(balanceQuery = value.take(120)) }
    fun toggleLowOnly() {
        state = if (state.executiveStockState != null) {
            state.copy(lowOnly = false, executiveStockState = null)
        } else {
            state.copy(lowOnly = !state.lowOnly)
        }
        searchBalances()
    }
    fun searchBalances() = launchRead("balances", InventorySection.BALANCES) {
        val rows = loadBalances()
        return@launchRead { current -> current.copy(balances = rows) }
    }

    private suspend fun loadBalances(): List<StockBalance> {
        val query = state.balanceQuery
        val executiveStockState = state.executiveStockState
        val lowOnly = executiveStockState == ExecutiveStockState.LOW ||
            (executiveStockState == null && state.lowOnly)
        if (executiveStockState == null) return source.balances(query, lowOnly)

        // Executive decisions must not silently inspect only the first 100 rows. The API exposes
        // offset pagination, so exhaust the same 5,000-row ceiling used by the authoritative report.
        val rows = mutableListOf<StockBalance>()
        var offset = 0
        do {
            val page = source.balances(query, lowOnly, offset)
            rows += page
            offset += page.size
        } while (page.size == INVENTORY_PAGE_SIZE && rows.size < MAX_EXECUTIVE_BALANCES)
        return rows
    }

    fun setMovementQuery(value: String) { state = state.copy(movementQuery = value.take(120)) }
    fun setMovementType(value: MovementType?) { state = state.copy(movementType = value); searchMovements() }
    fun searchMovements() = launchRead("movements", InventorySection.MOVEMENTS) {
        val page = source.movements(state.movementQuery, state.movementType)
        return@launchRead { current -> current.copy(movements = page) }
    }
    fun loadMoreMovements() {
        val cursor = state.movements.nextCursor ?: return
        launchRead("movements:more", InventorySection.MOVEMENTS) {
            val next = source.movements(state.movementQuery, state.movementType, cursor)
            return@launchRead { current -> current.copy(movements = next.copy(rows = current.movements.rows + next.rows)) }
        }
    }

    fun setTransferQuery(value: String) { state = state.copy(transferQuery = value.take(60)) }
    fun setTransferStatus(value: TransferStatus?) { state = state.copy(transferStatus = value); searchTransfers() }
    fun searchTransfers() = launchRead("transfers", InventorySection.TRANSFERS) {
        val page = source.transfers(state.transferQuery, state.transferStatus)
        return@launchRead { current -> current.copy(transfers = page, selectedTransfer = null, receiveDraft = null) }
    }
    fun loadMoreTransfers() {
        val cursor = state.transfers.nextCursor ?: return
        launchRead("transfers:more", InventorySection.TRANSFERS) {
            val next = source.transfers(state.transferQuery, state.transferStatus, cursor)
            return@launchRead { current -> current.copy(transfers = next.copy(rows = current.transfers.rows + next.rows)) }
        }
    }
    fun selectTransfer(id: Long) = launchRead("transfer:$id", InventorySection.TRANSFERS) {
        val detail = source.transfer(id)
        return@launchRead { current -> current.copy(selectedTransfer = detail, transferDraft = null, receiveDraft = null) }
    }
    fun closeTransferDetail() { state = state.copy(selectedTransfer = null, receiveDraft = null) }

    fun beginTransfer(item: StockBalance) {
        if (
            !capabilities.canWrite ||
            !state.canInteract(InventorySection.BALANCES) ||
            !state.isFresh(InventorySection.TRANSFERS) ||
            !state.branchesFresh
        ) return
        state = state.copy(
            section = InventorySection.TRANSFERS,
            transferDraft = TransferDraft(
                variantId = item.variantId,
                itemLabel = item.label,
                clientRequestId = UUID.randomUUID().toString(),
            ),
            selectedTransfer = null,
            error = null,
        )
    }
    fun updateTransferDraft(draft: TransferDraft) { state = state.copy(transferDraft = draft, error = null) }
    fun closeTransferDraft() { state = state.copy(transferDraft = null) }
    fun saveTransfer() {
        val draft = state.transferDraft ?: return
        if (!capabilities.canWrite || !state.branchesFresh) return
        InventoryValidation.transfer(draft, capabilities.branchId)?.let { return setError(it) }
        launchMutation(
            key = "transfer:create",
            section = InventorySection.TRANSFERS,
            success = "تم إنشاء سند التحويل",
            replayPolicy = MutationReplayPolicy.IDEMPOTENT,
            request = { source.createTransfer(draft) },
            acknowledge = { current, _ -> current.copy(transferDraft = null, selectedTransfer = null) },
            refresh = { id ->
                val page = source.transfers(state.transferQuery, state.transferStatus)
                val detail = source.transfer(id)
                val reducer: InventoryReducer = { current ->
                    current.copy(transfers = page, selectedTransfer = detail)
                }
                reducer
            },
        )
    }

    fun beginReceive() {
        val detail = state.selectedTransfer ?: return
        if (!capabilities.canReceive(detail) || !state.canInteract(InventorySection.TRANSFERS)) return
        state = state.copy(
            receiveDraft = ReceiveDraft(
                transferId = detail.id,
                lines = detail.lines.map { ReceiveLineDraft(it.id, it.quantitySent.toString()) },
                clientRequestId = UUID.randomUUID().toString(),
            ),
        )
    }
    fun updateReceiveDraft(draft: ReceiveDraft) { state = state.copy(receiveDraft = draft, error = null) }
    fun closeReceiveDraft() { state = state.copy(receiveDraft = null) }
    fun saveReceive() {
        val detail = state.selectedTransfer ?: return
        val draft = state.receiveDraft ?: return
        if (!capabilities.canReceive(detail)) return
        InventoryValidation.receive(detail, draft)?.let { return setError(it) }
        launchMutation(
            key = "transfer:receive",
            section = InventorySection.TRANSFERS,
            success = "تم استلام السند",
            replayPolicy = MutationReplayPolicy.IDEMPOTENT,
            request = { source.receiveTransfer(detail, draft) },
            acknowledge = { current, _ -> current.acknowledgeTransferStatus(detail.id, TransferStatus.RECEIVED) },
            refresh = {
                val page = source.transfers(state.transferQuery, state.transferStatus)
                val refreshed = source.transfer(detail.id)
                val reducer: InventoryReducer = { current ->
                    current.copy(transfers = page, selectedTransfer = refreshed, receiveDraft = null)
                }
                reducer
            },
        )
    }
    fun cancelTransfer() {
        val detail = state.selectedTransfer ?: return
        if (!capabilities.canCancel(detail)) return
        launchMutation(
            key = "transfer:cancel",
            section = InventorySection.TRANSFERS,
            success = "تم إلغاء السند وإعادة الرصيد",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.cancelTransfer(detail.id) },
            acknowledge = { current, _ -> current.acknowledgeTransferStatus(detail.id, TransferStatus.CANCELLED) },
            refresh = {
                val page = source.transfers(state.transferQuery, state.transferStatus)
                val refreshed = source.transfer(detail.id)
                val reducer: InventoryReducer = { current ->
                    current.copy(transfers = page, selectedTransfer = refreshed)
                }
                reducer
            },
        )
    }

    fun setAdjustmentStatus(value: AdjustmentStatus) {
        state = state.copy(adjustmentStatus = value)
        refreshAdjustments()
    }
    fun refreshAdjustments() = launchRead("adjustments", InventorySection.ADJUSTMENTS) {
        val rows = source.adjustments(state.adjustmentStatus)
        return@launchRead { current -> current.copy(adjustments = rows) }
    }
    fun beginAdjustment(item: StockBalance) {
        if (
            !capabilities.canWrite ||
            !state.canInteract(InventorySection.BALANCES) ||
            !state.isFresh(InventorySection.ADJUSTMENTS)
        ) return
        state = state.copy(
            section = InventorySection.ADJUSTMENTS,
            adjustmentDraft = AdjustmentDraft(item.variantId, item.label, item.quantity.toString()),
            error = null,
        )
    }
    fun updateAdjustmentDraft(draft: AdjustmentDraft) { state = state.copy(adjustmentDraft = draft, error = null) }
    fun closeAdjustmentDraft() { state = state.copy(adjustmentDraft = null) }
    fun saveAdjustment() {
        val draft = state.adjustmentDraft ?: return
        if (!capabilities.canWrite) return
        InventoryValidation.adjustment(draft, capabilities.branchId)?.let { return setError(it) }
        val balance = state.balances.firstOrNull { it.variantId == draft.variantId }
        launchMutation(
            key = "adjustment:create",
            section = InventorySection.ADJUSTMENTS,
            success = "أُرسل طلب التسوية للاعتماد",
            replayPolicy = MutationReplayPolicy.NON_IDEMPOTENT,
            request = { source.requestAdjustment(draft) },
            acknowledge = { current, id ->
                val local = balance?.let { row ->
                    AdjustmentRequest(
                        id = id,
                        variantId = row.variantId,
                        branchId = requireNotNull(capabilities.branchId),
                        productName = row.productName,
                        variantName = row.variantName,
                        sku = row.sku,
                        expectedQuantity = row.quantity,
                        currentQuantity = row.quantity,
                        targetQuantity = requireNotNull(draft.targetQuantity.toIntOrNull()),
                        status = AdjustmentStatus.PENDING_APPROVAL,
                        notes = draft.notes.trim().takeIf(String::isNotEmpty),
                        createdBy = capabilities.userId,
                        createdByName = capabilities.userName,
                        createdAt = null,
                        rejectionReason = null,
                    )
                }
                current.copy(
                    adjustmentDraft = null,
                    adjustments = if (
                        local != null && current.adjustmentStatus == AdjustmentStatus.PENDING_APPROVAL
                    ) listOf(local) + current.adjustments.filterNot { it.id == id } else current.adjustments,
                )
            },
            refresh = {
                val rows = source.adjustments(state.adjustmentStatus)
                val reducer: InventoryReducer = { current -> current.copy(adjustments = rows) }
                reducer
            },
        )
    }
    fun approveAdjustment(id: Long) {
        if (!capabilities.canManage) return
        launchMutation(
            key = "adjustment:approve:$id",
            section = InventorySection.ADJUSTMENTS,
            success = "تم اعتماد التسوية",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.approveAdjustment(id) },
            acknowledge = { current, _ -> current.acknowledgeAdjustment(id, AdjustmentStatus.APPROVED) },
            refresh = {
                val rows = source.adjustments(state.adjustmentStatus)
                val reducer: InventoryReducer = { current -> current.copy(adjustments = rows) }
                reducer
            },
        )
    }
    fun beginRejectAdjustment(id: Long) {
        if (!capabilities.canManage || !state.canInteract(InventorySection.ADJUSTMENTS)) return
        state = state.copy(rejectingAdjustmentId = id, rejectionReason = "", error = null)
    }
    fun setRejectionReason(value: String) { state = state.copy(rejectionReason = value.take(500)) }
    fun closeRejectAdjustment() { state = state.copy(rejectingAdjustmentId = null, rejectionReason = "") }
    fun confirmRejectAdjustment() {
        val id = state.rejectingAdjustmentId ?: return
        if (state.rejectionReason.trim().isEmpty()) return setError("سبب الرفض مطلوب")
        val reason = state.rejectionReason
        launchMutation(
            key = "adjustment:reject:$id",
            section = InventorySection.ADJUSTMENTS,
            success = "تم رفض طلب التسوية",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.rejectAdjustment(id, reason) },
            acknowledge = { current, _ -> current.acknowledgeAdjustment(id, AdjustmentStatus.REJECTED, reason) },
            refresh = {
                val rows = source.adjustments(state.adjustmentStatus)
                val reducer: InventoryReducer = { current -> current.copy(adjustments = rows) }
                reducer
            },
        )
    }

    fun setStocktakeStatus(value: StocktakeStatus?) { state = state.copy(stocktakeStatus = value); refreshStocktakes() }
    fun refreshStocktakes() = launchRead("stocktakes", InventorySection.STOCKTAKES) {
        val rows = source.stocktakes(state.stocktakeStatus)
        return@launchRead { current -> current.copy(stocktakes = rows, selectedStocktake = null) }
    }
    fun selectStocktake(id: Long) = launchRead("stocktake:$id", InventorySection.STOCKTAKES) {
        val detail = source.stocktake(id)
        return@launchRead { current -> current.copy(selectedStocktake = detail, stocktakeDraft = null) }
    }
    fun closeStocktakeDetail() { state = state.copy(selectedStocktake = null) }
    fun beginStocktake() {
        if (!capabilities.canCreateStocktake || !state.canInteract(InventorySection.STOCKTAKES)) return
        state = state.copy(stocktakeDraft = StocktakeDraft(), selectedStocktake = null, error = null)
    }
    fun updateStocktakeDraft(draft: StocktakeDraft) { state = state.copy(stocktakeDraft = draft, error = null) }
    fun closeStocktakeDraft() { state = state.copy(stocktakeDraft = null) }
    fun saveStocktake() {
        val draft = state.stocktakeDraft ?: return
        InventoryValidation.stocktake(draft, capabilities.branchId)?.let { return setError(it) }
        launchMutation(
            key = "stocktake:create",
            section = InventorySection.STOCKTAKES,
            success = "تم إنشاء جلسة الجرد وتكليفك بها",
            replayPolicy = MutationReplayPolicy.NON_IDEMPOTENT,
            request = { source.createStocktake(draft) },
            acknowledge = { current, id ->
                val branchName = current.branches.firstOrNull { it.id == capabilities.branchId }?.name ?: "فرع الجلسة"
                val summary = StocktakeSummary(
                    id = id,
                    code = "#$id",
                    name = draft.name.trim(),
                    branchId = requireNotNull(capabilities.branchId),
                    branchName = branchName,
                    scopeLabel = if (draft.scopeType == "FULL") "شامل" else "متحرك ${draft.movingDays} يوم",
                    status = StocktakeStatus.COUNTING,
                    itemCount = 0,
                    countedCount = 0,
                    createdAt = null,
                    createdByName = capabilities.userName,
                )
                current.copy(
                    stocktakeDraft = null,
                    selectedStocktake = null,
                    stocktakes = if (current.stocktakeStatus in setOf(null, StocktakeStatus.COUNTING)) {
                        listOf(summary) + current.stocktakes.filterNot { it.id == id }
                    } else {
                        current.stocktakes
                    },
                )
            },
            refresh = { id ->
                val rows = source.stocktakes(state.stocktakeStatus)
                val detail = source.stocktake(id)
                val assignments = source.countAssignments()
                val reducer: InventoryReducer = { current ->
                    current.copy(stocktakes = rows, selectedStocktake = detail, countAssignments = assignments)
                        .markFresh(InventorySection.MY_COUNTS)
                }
                reducer
            },
        )
    }
    fun beginRecount(variantId: Long) {
        if (!state.canInteract(InventorySection.STOCKTAKES)) return
        state = state.copy(recountVariantId = variantId, recountReason = "", error = null)
    }
    fun setRecountReason(value: String) { state = state.copy(recountReason = value.take(255)) }
    fun closeRecount() { state = state.copy(recountVariantId = null, recountReason = "") }
    fun confirmRecount() {
        val detail = state.selectedStocktake ?: return
        val variantId = state.recountVariantId ?: return
        if (state.recountReason.trim().length < 3) return setError("اكتب سبب إعادة العد")
        val reason = state.recountReason
        launchMutation(
            key = "stocktake:recount",
            section = InventorySection.STOCKTAKES,
            success = "تم طلب إعادة العد",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.requestRecount(detail.summary.id, variantId, reason) },
            acknowledge = { current, _ -> current.copy(recountVariantId = null, recountReason = "") },
            refresh = {
                val refreshed = source.stocktake(detail.summary.id)
                val rows = source.stocktakes(state.stocktakeStatus)
                val reducer: InventoryReducer = { current ->
                    current.copy(selectedStocktake = refreshed, stocktakes = rows)
                }
                reducer
            },
        )
    }
    fun forceReview() = stocktakeAction("stocktake:review", "نُقلت الجلسة للمراجعة") { source.forceStocktakeReview(it) }
    fun firstSign() = stocktakeAction("stocktake:sign", "تم التوقيع الأول") { source.firstSignStocktake(it) }
    fun approveStocktake() = stocktakeAction(
        key = "stocktake:approve",
        message = "تم اعتماد الجرد",
        successOf = { negativeSettlements: Int ->
            if (negativeSettlements > 0) {
                "تم اعتماد الجرد — $negativeSettlements صنف بأرصدة سالبة، راجع تقرير السوالب"
            } else {
                "تم اعتماد الجرد"
            }
        },
    ) { source.approveStocktake(it) }
    fun setCancelStocktakeReason(value: String) { state = state.copy(cancelStocktakeReason = value.take(500)) }
    fun cancelStocktake() {
        val detail = state.selectedStocktake ?: return
        if (!capabilities.canCancelStocktake) return
        val reason = state.cancelStocktakeReason
        launchMutation(
            key = "stocktake:cancel",
            section = InventorySection.STOCKTAKES,
            success = "تم إلغاء جلسة الجرد",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.cancelStocktake(detail.summary.id, reason) },
            acknowledge = { current, _ ->
                current.acknowledgeStocktakeStatus(detail.summary.id, StocktakeStatus.CANCELLED)
            },
            refresh = {
                val refreshed = source.stocktake(detail.summary.id)
                val rows = source.stocktakes(state.stocktakeStatus)
                val reducer: InventoryReducer = { current ->
                    current.copy(selectedStocktake = refreshed, stocktakes = rows)
                }
                reducer
            },
        )
    }

    private fun <T> stocktakeAction(
        key: String,
        message: String,
        successOf: ((T) -> String)? = null,
        action: suspend (Long) -> T,
    ) {
        val detail = state.selectedStocktake ?: return
        if (!capabilities.canManage) return
        val acknowledgedStatus = when (key) {
            "stocktake:review" -> StocktakeStatus.REVIEW
            "stocktake:approve" -> StocktakeStatus.APPROVED
            else -> null
        }
        launchMutation(
            key = key,
            section = InventorySection.STOCKTAKES,
            success = message,
            successOf = successOf,
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { action(detail.summary.id) },
            acknowledge = { current, _ ->
                acknowledgedStatus?.let { current.acknowledgeStocktakeStatus(detail.summary.id, it) } ?: current
            },
            refresh = {
                val refreshed = source.stocktake(detail.summary.id)
                val rows = source.stocktakes(state.stocktakeStatus)
                val reducer: InventoryReducer = { current ->
                    current.copy(selectedStocktake = refreshed, stocktakes = rows)
                }
                reducer
            },
        )
    }

    fun refreshCountAssignments() = launchRead("counts", InventorySection.MY_COUNTS) {
        val rows = source.countAssignments()
        return@launchRead { current -> current.copy(countAssignments = rows, selectedCount = null) }
    }
    fun selectCount(sessionCode: String) = launchRead("count:$sessionCode", InventorySection.MY_COUNTS) {
        val detail = source.countSession(sessionCode)
        return@launchRead { current -> current.copy(selectedCount = detail, countQuery = "", countScannedVariantId = null, countScannedBarcode = null) }
    }
    fun closeCount() { state = state.copy(selectedCount = null, countScannedVariantId = null, countScannedBarcode = null) }
    fun setCountQuery(value: String) { state = state.copy(countQuery = value.take(120), countScannedVariantId = null, countScannedBarcode = null) }
    fun scanCount(raw: String) {
        val count = state.selectedCount ?: return
        state = state.copy(countScannedVariantId = null, countScannedBarcode = null)
        when (val match = count.barcodeMatch(raw)) {
            NativeBarcodeResolution.NoMatch ->
                setError("الباركود الممسوح لا يخص صنفاً في هذا التكليف")
            NativeBarcodeResolution.Ambiguous ->
                setError("الباركود يطابق أكثر من صنف في هذا التكليف؛ صحّح هوية الباركود قبل العد")
            is NativeBarcodeResolution.Unique -> state = state.copy(
                countQuery = match.value.label,
                countScannedVariantId = match.value.variantId,
                countScannedBarcode = match.normalizedBarcode,
                error = null,
            )
        }
    }
    fun submitCount(variantId: Long, quantity: String) {
        val count = state.selectedCount ?: return
        InventoryValidation.count(quantity)?.let { return setError(it) }
        val scannedBarcode = state.countScannedBarcode.takeIf { state.countScannedVariantId == variantId }
        if (count.countMethod == "SCAN_REQUIRED" && scannedBarcode == null) {
            return setError("هذه الجلسة تتطلب مسح باركود الصنف بالكاميرا قبل حفظ العد")
        }
        val parsedQuantity = requireNotNull(quantity.toIntOrNull())
        val clientRequestId = countRequestIds.idFor(count.code, variantId, parsedQuantity)
        launchMutation(
            key = "count:submit:$variantId",
            section = InventorySection.MY_COUNTS,
            success = "تم حفظ العدّة",
            successOf = { outcome ->
                when (outcome) {
                    is CountSubmitOutcome.Submitted -> "تم حفظ العدّة"
                    is CountSubmitOutcome.Queued -> "تعذر الاتصال؛ حُفظت العدّة في طابور أدوات المستودع"
                }
            },
            replayPolicy = MutationReplayPolicy.IDEMPOTENT,
            request = { source.submitCount(count.code, variantId, parsedQuantity, clientRequestId, if (scannedBarcode == null) "SEARCH_PICK" else "SCAN_CAMERA", scannedBarcode) },
            acknowledge = { current, _ -> current.acknowledgeCount(count.code, variantId, parsedQuantity).copy(countScannedVariantId = null, countScannedBarcode = null) },
            refresh = { outcome ->
                val refreshed = if (outcome is CountSubmitOutcome.Queued) null else source.countSession(count.code)
                val reducer: InventoryReducer = { current ->
                    if (refreshed == null) current else current.copy(selectedCount = refreshed)
                }
                reducer
            },
        )
    }
    fun finishCount() {
        val count = state.selectedCount ?: return
        launchMutation(
            key = "count:finish",
            section = InventorySection.MY_COUNTS,
            success = "تم تسليم العدّ",
            replayPolicy = MutationReplayPolicy.MONOTONIC,
            request = { source.finishCount(count.code) },
            acknowledge = { current, _ ->
                current.copy(
                    selectedCount = null,
                    countAssignments = current.countAssignments.filterNot { it.sessionCode == count.code },
                )
            },
            refresh = {
                val rows = source.countAssignments()
                val reducer: InventoryReducer = { current -> current.copy(countAssignments = rows, selectedCount = null) }
                reducer
            },
        )
    }

    private fun launchRead(
        key: String,
        section: InventorySection,
        block: suspend () -> InventoryReducer,
    ) {
        if (state.busyKey != null || state.initializing) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { reducer ->
                    state = reducer(state).markFresh(section).copy(busyKey = null)
                }
                .onFailure { error ->
                    state = state.markStale(section).copy(busyKey = null, error = userMessage(error))
                }
            drainPendingExecutiveRefresh()
        }
    }

    private fun <T> launchMutation(
        key: String,
        section: InventorySection,
        success: String,
        replayPolicy: MutationReplayPolicy,
        request: suspend () -> T,
        acknowledge: (InventoryUiState, T) -> InventoryUiState,
        refresh: suspend (T) -> InventoryReducer,
        successOf: ((T) -> String)? = null,
    ) {
        if (!state.canInteract(section)) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            val response = runCatching { request() }
            if (response.isFailure) {
                val failure = requireNotNull(response.exceptionOrNull())
                val ambiguous = isAmbiguousMutationFailure(failure)
                var failed = state.copy(busyKey = null, error = userMessage(failure))
                if (ambiguous) failed = failed.markStale(section)
                if (ambiguous && replayPolicy == MutationReplayPolicy.NON_IDEMPOTENT) {
                    failed = failed.markOutcomeUnknown(section).copy(
                        error = "تعذر حسم نتيجة العملية. أُوقفت الكتابة في هذا القسم لمنع إنشاء عملية مكررة؛ تحقق من النظام ثم أعد فتح مساحة المخزون.",
                    )
                }
                state = failed
                drainPendingExecutiveRefresh()
                return@launch
            }

            val value = response.getOrThrow()
            val resolvedSuccess = successOf?.invoke(value) ?: success
            // Commit the acknowledged server outcome first. The following read is reconciliation,
            // never part of the write, so its failure cannot reopen the draft or repeat the action.
            state = acknowledge(state, value).markStale(section).copy(message = resolvedSuccess)
            runCatching { refresh(value) }
                .onSuccess { reducer ->
                    state = reducer(state).markFresh(section).copy(busyKey = null, error = null, message = resolvedSuccess)
                }
                .onFailure { refreshFailure ->
                    state = state.copy(
                        busyKey = null,
                        message = resolvedSuccess,
                        error = "اكتملت العملية، لكن تعذر تحديث بيانات القسم. اضغط إعادة المحاولة قبل تنفيذ إجراء آخر: ${userMessage(refreshFailure)}",
                    )
                }
            drainPendingExecutiveRefresh()
        }
    }

    private fun drainPendingExecutiveRefresh() {
        if (!pendingExecutiveBalanceRefresh || state.busyKey != null || state.initializing) return
        pendingExecutiveBalanceRefresh = false
        searchBalances()
    }

    private fun setError(message: String) { state = state.copy(error = message) }
    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

private fun isAmbiguousMutationFailure(error: Throwable): Boolean = when (error) {
    is IllegalArgumentException -> false
    is ApiException -> error.retryableTransportFailure || error.status == null || error.status !in 400..499
    else -> true
}

class InventoryViewModelFactory(
    private val source: InventoryDataSource,
    private val capabilities: InventoryCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = InventoryViewModel(source, capabilities) as T
}

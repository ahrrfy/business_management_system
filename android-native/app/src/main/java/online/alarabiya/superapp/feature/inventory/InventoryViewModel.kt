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

data class InventoryUiState(
    val section: InventorySection,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    val branches: List<InventoryBranch> = emptyList(),
    val balanceQuery: String = "",
    val lowOnly: Boolean = false,
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
)

private data class InitialInventory(
    val branches: Result<List<InventoryBranch>>?,
    val balances: Result<List<StockBalance>>?,
    val movements: Result<MovementPage>?,
    val transfers: Result<TransferPage>?,
    val adjustments: Result<List<AdjustmentRequest>>?,
    val stocktakes: Result<List<StocktakeSummary>>?,
    val counts: Result<List<CountAssignment>>,
)

class InventoryViewModel(
    private val source: InventoryDataSource,
    val capabilities: InventoryCapabilities,
) : ViewModel() {
    var state by mutableStateOf(
        InventoryUiState(section = capabilities.visibleSections.first()),
    )
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, error = null, message = null)
        viewModelScope.launch {
            val scopedRead = capabilities.canRead && capabilities.branchId != null
            val result = coroutineScope {
                val branches = async { if (capabilities.canWrite) runCatching { source.branches() } else null }
                val balances = async { if (scopedRead) runCatching { source.balances() } else null }
                val movements = async { if (scopedRead) runCatching { source.movements() } else null }
                val transfers = async { if (scopedRead) runCatching { source.transfers() } else null }
                val adjustments = async { if (scopedRead) runCatching { source.adjustments() } else null }
                val stocktakes = async { if (capabilities.canViewStocktakes && capabilities.branchId != null) runCatching { source.stocktakes() } else null }
                val counts = async { runCatching { source.countAssignments() } }
                InitialInventory(
                    branches.await(), balances.await(), movements.await(), transfers.await(),
                    adjustments.await(), stocktakes.await(), counts.await(),
                )
            }
            val firstError = listOf(
                result.branches, result.balances, result.movements, result.transfers,
                result.adjustments, result.stocktakes, result.counts,
            ).firstNotNullOfOrNull { it?.exceptionOrNull() }
            state = state.copy(
                initializing = false,
                branches = result.branches?.getOrNull() ?: state.branches,
                balances = result.balances?.getOrNull() ?: state.balances,
                movements = result.movements?.getOrNull() ?: state.movements,
                transfers = result.transfers?.getOrNull() ?: state.transfers,
                adjustments = result.adjustments?.getOrNull() ?: state.adjustments,
                stocktakes = result.stocktakes?.getOrNull() ?: state.stocktakes,
                countAssignments = result.counts.getOrNull() ?: state.countAssignments,
                error = firstError?.let(::userMessage)
                    ?: if (capabilities.canRead && capabilities.branchId == null) "لا يوجد فرع مرتبط بالجلسة؛ عُطّلت قراءات وكتابات المخزون بأمان" else null,
            )
        }
    }

    fun selectSection(section: InventorySection) {
        if (section !in capabilities.visibleSections) return
        state = state.copy(section = section, error = null, message = null)
    }

    fun clearFeedback() { state = state.copy(error = null, message = null) }

    fun setBalanceQuery(value: String) { state = state.copy(balanceQuery = value.take(120)) }
    fun toggleLowOnly() { state = state.copy(lowOnly = !state.lowOnly); searchBalances() }
    fun searchBalances() = launch("balances") {
        state = state.copy(balances = source.balances(state.balanceQuery, state.lowOnly))
    }

    fun setMovementQuery(value: String) { state = state.copy(movementQuery = value.take(120)) }
    fun setMovementType(value: MovementType?) { state = state.copy(movementType = value); searchMovements() }
    fun searchMovements() = launch("movements") {
        state = state.copy(movements = source.movements(state.movementQuery, state.movementType))
    }
    fun loadMoreMovements() {
        val cursor = state.movements.nextCursor ?: return
        launch("movements:more") {
            val next = source.movements(state.movementQuery, state.movementType, cursor)
            state = state.copy(movements = next.copy(rows = state.movements.rows + next.rows))
        }
    }

    fun setTransferQuery(value: String) { state = state.copy(transferQuery = value.take(60)) }
    fun setTransferStatus(value: TransferStatus?) { state = state.copy(transferStatus = value); searchTransfers() }
    fun searchTransfers() = launch("transfers") {
        state = state.copy(transfers = source.transfers(state.transferQuery, state.transferStatus), selectedTransfer = null)
    }
    fun loadMoreTransfers() {
        val cursor = state.transfers.nextCursor ?: return
        launch("transfers:more") {
            val next = source.transfers(state.transferQuery, state.transferStatus, cursor)
            state = state.copy(transfers = next.copy(rows = state.transfers.rows + next.rows))
        }
    }
    fun selectTransfer(id: Long) = launch("transfer:$id") {
        state = state.copy(selectedTransfer = source.transfer(id), transferDraft = null, receiveDraft = null)
    }
    fun closeTransferDetail() { state = state.copy(selectedTransfer = null, receiveDraft = null) }

    fun beginTransfer(item: StockBalance) {
        if (!capabilities.canWrite) return
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
        if (!capabilities.canWrite) return
        InventoryValidation.transfer(draft, capabilities.branchId)?.let { return setError(it) }
        launch("transfer:create", "تم إنشاء سند التحويل") {
            val id = source.createTransfer(draft)
            state = state.copy(
                transferDraft = null,
                transfers = source.transfers(state.transferQuery, state.transferStatus),
                selectedTransfer = source.transfer(id),
            )
        }
    }

    fun beginReceive() {
        val detail = state.selectedTransfer ?: return
        if (!capabilities.canReceive(detail)) return
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
        launch("transfer:receive", "تم استلام السند") {
            source.receiveTransfer(detail, draft)
            state = state.copy(
                receiveDraft = null,
                selectedTransfer = source.transfer(detail.id),
                transfers = source.transfers(state.transferQuery, state.transferStatus),
            )
        }
    }
    fun cancelTransfer() {
        val detail = state.selectedTransfer ?: return
        if (!capabilities.canCancel(detail)) return
        launch("transfer:cancel", "تم إلغاء السند وإعادة الرصيد") {
            source.cancelTransfer(detail.id)
            state = state.copy(
                selectedTransfer = source.transfer(detail.id),
                transfers = source.transfers(state.transferQuery, state.transferStatus),
            )
        }
    }

    fun setAdjustmentStatus(value: AdjustmentStatus) {
        state = state.copy(adjustmentStatus = value)
        refreshAdjustments()
    }
    fun refreshAdjustments() = launch("adjustments") {
        state = state.copy(adjustments = source.adjustments(state.adjustmentStatus))
    }
    fun beginAdjustment(item: StockBalance) {
        if (!capabilities.canWrite) return
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
        launch("adjustment:create", "أُرسل طلب التسوية للاعتماد") {
            source.requestAdjustment(draft)
            state = state.copy(adjustmentDraft = null, adjustments = source.adjustments(state.adjustmentStatus))
        }
    }
    fun approveAdjustment(id: Long) {
        if (!capabilities.canManage) return
        launch("adjustment:approve:$id", "تم اعتماد التسوية") {
            source.approveAdjustment(id)
            state = state.copy(adjustments = source.adjustments(state.adjustmentStatus))
        }
    }
    fun beginRejectAdjustment(id: Long) {
        if (!capabilities.canManage) return
        state = state.copy(rejectingAdjustmentId = id, rejectionReason = "", error = null)
    }
    fun setRejectionReason(value: String) { state = state.copy(rejectionReason = value.take(500)) }
    fun closeRejectAdjustment() { state = state.copy(rejectingAdjustmentId = null, rejectionReason = "") }
    fun confirmRejectAdjustment() {
        val id = state.rejectingAdjustmentId ?: return
        if (state.rejectionReason.trim().isEmpty()) return setError("سبب الرفض مطلوب")
        launch("adjustment:reject:$id", "تم رفض طلب التسوية") {
            source.rejectAdjustment(id, state.rejectionReason)
            state = state.copy(
                rejectingAdjustmentId = null,
                rejectionReason = "",
                adjustments = source.adjustments(state.adjustmentStatus),
            )
        }
    }

    fun setStocktakeStatus(value: StocktakeStatus?) { state = state.copy(stocktakeStatus = value); refreshStocktakes() }
    fun refreshStocktakes() = launch("stocktakes") {
        state = state.copy(stocktakes = source.stocktakes(state.stocktakeStatus), selectedStocktake = null)
    }
    fun selectStocktake(id: Long) = launch("stocktake:$id") {
        state = state.copy(selectedStocktake = source.stocktake(id), stocktakeDraft = null)
    }
    fun closeStocktakeDetail() { state = state.copy(selectedStocktake = null) }
    fun beginStocktake() {
        if (!capabilities.canCreateStocktake) return
        state = state.copy(stocktakeDraft = StocktakeDraft(), selectedStocktake = null, error = null)
    }
    fun updateStocktakeDraft(draft: StocktakeDraft) { state = state.copy(stocktakeDraft = draft, error = null) }
    fun closeStocktakeDraft() { state = state.copy(stocktakeDraft = null) }
    fun saveStocktake() {
        val draft = state.stocktakeDraft ?: return
        InventoryValidation.stocktake(draft, capabilities.branchId)?.let { return setError(it) }
        launch("stocktake:create", "تم إنشاء جلسة الجرد وتكليفك بها") {
            val id = source.createStocktake(draft)
            state = state.copy(
                stocktakeDraft = null,
                stocktakes = source.stocktakes(state.stocktakeStatus),
                selectedStocktake = source.stocktake(id),
                countAssignments = source.countAssignments(),
            )
        }
    }
    fun beginRecount(variantId: Long) {
        state = state.copy(recountVariantId = variantId, recountReason = "", error = null)
    }
    fun setRecountReason(value: String) { state = state.copy(recountReason = value.take(255)) }
    fun closeRecount() { state = state.copy(recountVariantId = null, recountReason = "") }
    fun confirmRecount() {
        val detail = state.selectedStocktake ?: return
        val variantId = state.recountVariantId ?: return
        if (state.recountReason.trim().length < 3) return setError("اكتب سبب إعادة العد")
        launch("stocktake:recount", "تم طلب إعادة العد") {
            source.requestRecount(detail.summary.id, variantId, state.recountReason)
            state = state.copy(recountVariantId = null, recountReason = "", selectedStocktake = source.stocktake(detail.summary.id))
        }
    }
    fun forceReview() = stocktakeAction("stocktake:review", "نُقلت الجلسة للمراجعة") { source.forceStocktakeReview(it) }
    fun firstSign() = stocktakeAction("stocktake:sign", "تم التوقيع الأول") { source.firstSignStocktake(it) }
    fun approveStocktake() = stocktakeAction("stocktake:approve", "تم اعتماد الجرد") { source.approveStocktake(it) }
    fun setCancelStocktakeReason(value: String) { state = state.copy(cancelStocktakeReason = value.take(500)) }
    fun cancelStocktake() {
        val detail = state.selectedStocktake ?: return
        if (!capabilities.canCancelStocktake) return
        launch("stocktake:cancel", "تم إلغاء جلسة الجرد") {
            source.cancelStocktake(detail.summary.id, state.cancelStocktakeReason)
            state = state.copy(
                cancelStocktakeReason = "",
                selectedStocktake = source.stocktake(detail.summary.id),
                stocktakes = source.stocktakes(state.stocktakeStatus),
            )
        }
    }

    private fun stocktakeAction(key: String, message: String, action: suspend (Long) -> Unit) {
        val detail = state.selectedStocktake ?: return
        if (!capabilities.canManage) return
        launch(key, message) {
            action(detail.summary.id)
            state = state.copy(
                selectedStocktake = source.stocktake(detail.summary.id),
                stocktakes = source.stocktakes(state.stocktakeStatus),
            )
        }
    }

    fun refreshCountAssignments() = launch("counts") {
        state = state.copy(countAssignments = source.countAssignments(), selectedCount = null)
    }
    fun selectCount(sessionCode: String) = launch("count:$sessionCode") {
        state = state.copy(selectedCount = source.countSession(sessionCode), countQuery = "")
    }
    fun closeCount() { state = state.copy(selectedCount = null) }
    fun setCountQuery(value: String) { state = state.copy(countQuery = value.take(120)) }
    fun submitCount(variantId: Long, quantity: String) {
        val count = state.selectedCount ?: return
        InventoryValidation.count(quantity)?.let { return setError(it) }
        launch("count:submit:$variantId", "تم حفظ العدّة") {
            source.submitCount(count.code, variantId, requireNotNull(quantity.toIntOrNull()), UUID.randomUUID().toString())
            state = state.copy(selectedCount = source.countSession(count.code))
        }
    }
    fun finishCount() {
        val count = state.selectedCount ?: return
        launch("count:finish", "تم تسليم العدّ") {
            source.finishCount(count.code)
            state = state.copy(selectedCount = null, countAssignments = source.countAssignments())
        }
    }

    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { state = state.copy(busyKey = null, message = success) }
                .onFailure { state = state.copy(busyKey = null, error = userMessage(it)) }
        }
    }

    private fun setError(message: String) { state = state.copy(error = message) }
    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class InventoryViewModelFactory(
    private val source: InventoryDataSource,
    private val capabilities: InventoryCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = InventoryViewModel(source, capabilities) as T
}

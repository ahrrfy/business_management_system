package online.alarabiya.superapp.feature.warehouseTools

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.WarehouseToolsDataSource
import online.alarabiya.superapp.model.warehouseTools.*

data class WarehouseToolsUiState(
    val section: WarehouseSection = WarehouseSection.SCANNER,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    val scanInput: String = "",
    val signedResult: SignedBarcodeResult? = null,
    val catalogResult: WarehouseCatalogItem? = null,
    val assignments: List<CountAssignment> = emptyList(),
    val selectedCount: CountSession? = null,
    val countQuery: String = "",
    val selectedItem: CountItem? = null,
    val countDraft: CountDraft? = null,
    val snapshot: WarehouseSnapshot? = null,
    val pending: List<PendingCount> = emptyList(),
    val assignmentsFresh: Boolean = false,
    val countFresh: Boolean = false,
    val pendingFresh: Boolean = false,
)

internal const val WAREHOUSE_REFRESH_REQUIRED = "تمت العملية وتعذر تحديث العرض. أعد المحاولة قبل تنفيذ عملية أخرى"

internal fun canOpenWarehouseAssignment(state: WarehouseToolsUiState): Boolean =
    state.assignmentsFresh && !state.initializing && state.busyKey == null

internal fun canBeginWarehouseCount(state: WarehouseToolsUiState, item: CountItem): Boolean =
    state.selectedCount?.let { session ->
        state.assignmentsFresh &&
            state.countFresh &&
            state.pendingFresh &&
            state.busyKey == null &&
            session.canCount(item) &&
            state.pending.none {
                it.status == PendingCountStatus.QUEUED &&
                    it.sessionCode == session.code &&
                    it.variantId == item.variantId
            }
    } == true

internal fun canSubmitWarehouseCount(state: WarehouseToolsUiState): Boolean =
    state.selectedItem?.let { canBeginWarehouseCount(state, it) } == true && state.countDraft != null

internal fun canFinishWarehouseCount(state: WarehouseToolsUiState): Boolean {
    val session = state.selectedCount ?: return false
    return state.assignmentsFresh &&
        state.countFresh &&
        state.pendingFresh &&
        state.busyKey == null &&
        session.active &&
        session.sessionCounted == session.sessionTotal &&
        state.pending.none { it.sessionCode == session.code }
}

internal fun canReplayWarehouseQueue(state: WarehouseToolsUiState): Boolean =
    state.assignmentsFresh &&
        state.pendingFresh &&
        (state.selectedCount == null || state.countFresh) &&
        state.busyKey == null &&
        state.pending.any { it.status == PendingCountStatus.QUEUED }

internal fun canDiscardWarehousePending(state: WarehouseToolsUiState, clientRequestId: String): Boolean =
    state.assignmentsFresh &&
        state.pendingFresh &&
        (state.selectedCount == null || state.countFresh) &&
        state.busyKey == null &&
        state.pending.any { it.clientRequestId == clientRequestId && it.status == PendingCountStatus.REJECTED }

internal fun preserveWarehouseQueue(
    current: List<PendingCount>,
    newlyQueued: PendingCount,
): List<PendingCount> = (current + newlyQueued).distinctBy(PendingCount::clientRequestId)

class WarehouseToolsViewModel(
    private val source: WarehouseToolsDataSource,
    val capabilities: WarehouseCapabilities,
) : ViewModel() {
    private val initialSnapshot = runCatching { source.cachedWarehouseSnapshot() }
    private val initialPending = runCatching { source.pendingCounts() }
    var state by mutableStateOf(WarehouseToolsUiState(
        snapshot = initialSnapshot.getOrNull(),
        pending = initialPending.getOrDefault(emptyList()),
        pendingFresh = initialPending.isSuccess,
        error = initialPending.exceptionOrNull()?.message ?: initialSnapshot.exceptionOrNull()?.message,
    ))
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, assignmentsFresh = false, error = null)
        viewModelScope.launch {
            runCatching { source.assignments() to source.pendingCounts() }
                .onSuccess { (assignments, pending) ->
                    state = state.copy(
                        initializing = false,
                        assignments = assignments,
                        pending = pending,
                        assignmentsFresh = true,
                        pendingFresh = true,
                    )
                }
                .onFailure {
                    state = state.copy(
                        initializing = false,
                        assignmentsFresh = false,
                        error = it.message ?: "تعذر تحميل تكليفات العد",
                    )
                }
        }
    }

    fun selectSection(value: WarehouseSection) {
        if (value !in capabilities.sections) return
        if (value == WarehouseSection.OFFLINE) {
            runCatching { source.pendingCounts() }
                .onSuccess { state = state.copy(section = value, pending = it, pendingFresh = true, error = null, message = null) }
                .onFailure {
                    state = state.copy(section = value, pendingFresh = false)
                    fail(it.message ?: "تعذر قراءة الطابور المشفر")
                }
        } else state = state.copy(section = value, error = null, message = null)
    }
    fun clearFeedback() { state = state.copy(error = null, message = null) }
    fun setScanInput(value: String) { state = state.copy(scanInput = value.take(1_000), signedResult = null, catalogResult = null, error = null) }
    fun setCountQuery(value: String) { state = state.copy(countQuery = value.take(120)) }

    fun scan(capturedByCamera: Boolean = false, capturedByHid: Boolean = false, scannedValue: String = state.scanInput) {
        val raw = scannedValue.trim()
        if (raw.isEmpty()) return fail("أدخل أو امسح رمزاً")
        state.selectedCount?.barcodeMatch(raw)?.let { (item, barcode) ->
            return beginCount(
                item,
                entryMethod = when { capturedByCamera -> "SCAN_CAMERA"; capturedByHid -> "SCAN_HID"; else -> "SEARCH_PICK" },
                scannedBarcode = barcode.takeIf { capturedByCamera || capturedByHid },
            )
        }
        state.selectedCount?.exactMatch(raw)?.let { return beginCount(it) }
        state.snapshot?.exactMatch(raw)?.let { state = state.copy(catalogResult = it, signedResult = null, message = "تمت المطابقة من اللقطة المشفرة"); return }
        if (raw.count { it == '|' } >= 5) {
            launch("barcode:verify") { state = state.copy(signedResult = source.verifySignedBarcode(raw), catalogResult = null) }
        } else fail("لا توجد مطابقة دقيقة للباركود أو SKU في البيانات المتاحة")
    }

    fun selectAssignment(value: CountAssignment) {
        if (!canOpenWarehouseAssignment(state)) return fail("حدّث تكليفات العد قبل فتح الجلسة")
        state = state.copy(countFresh = false)
        launch("count:${value.sessionCode}") {
            val session = source.countSession(value.sessionCode)
            val pending = source.pendingCounts(value.sessionCode)
            state = state.copy(
                selectedCount = session,
                selectedItem = null,
                countDraft = null,
                pending = pending,
                countFresh = true,
                pendingFresh = true,
            )
        }
    }

    fun closeCount() {
        runCatching { source.pendingCounts() }
            .onSuccess { state = state.copy(selectedCount = null, selectedItem = null, countDraft = null, countQuery = "", pending = it, countFresh = false, pendingFresh = true) }
            .onFailure {
                state = state.copy(selectedCount = null, selectedItem = null, countDraft = null, countQuery = "", countFresh = false, pendingFresh = false)
                fail(it.message ?: "تعذر قراءة الطابور المشفر")
            }
    }
    fun refreshCount() {
        val code = state.selectedCount?.code ?: return
        state = state.copy(countFresh = false)
        launch("count:refresh") {
            val session = source.countSession(code)
            val pending = source.pendingCounts(code)
            state = state.copy(selectedCount = session, pending = pending, countFresh = true, pendingFresh = true)
        }
    }

    fun beginCount(
        item: CountItem,
        entryMethod: String = "SEARCH_PICK",
        scannedBarcode: String? = null,
    ) {
        val session = state.selectedCount ?: return fail("اختر جلسة العد أولاً")
        if (session.countMethod == "SCAN_REQUIRED" && entryMethod == "SEARCH_PICK") {
            return fail("هذه الجلسة تتطلب مسح باركود الصنف بالكاميرا قبل فتح العد")
        }
        if (!canBeginWarehouseCount(state, item)) {
            return fail(
                if (!state.countFresh || !state.pendingFresh) "حدّث الجلسة قبل تسجيل عد جديد"
                else "سياسة الجلسة أو عملية معلقة تمنع تكرار عد هذا الصنف",
            )
        }
        val units = item.units.ifEmpty { listOf(CountUnit("الوحدة الأساس", "1", null, emptyList())) }
        state = state.copy(
            section = WarehouseSection.COUNTS,
            selectedItem = item,
            countDraft = CountDraft(
                session.code,
                item.variantId,
                units.map { CountUnitEntry(it.name, it.factor) },
                UUID.randomUUID().toString(),
                entryMethod,
                scannedBarcode,
            ),
            error = null,
        )
    }

    fun updateUnitQuantity(index: Int, value: String) {
        val draft = state.countDraft ?: return
        if (index !in draft.entries.indices) return
        state = state.copy(countDraft = draft.copy(entries = draft.entries.mapIndexed { current, entry -> if (current == index) entry.copy(quantity = value.take(12)) else entry }), error = null)
    }

    fun closeCountEntry() { state = state.copy(selectedItem = null, countDraft = null) }

    fun submitCount() {
        val session = state.selectedCount ?: return
        val item = state.selectedItem ?: return
        val draft = state.countDraft ?: return
        if (!canSubmitWarehouseCount(state)) return fail("حدّث الجلسة قبل تسجيل العد")
        WarehouseValidation.count(session, item, draft)?.let { return fail(it) }
        state = state.copy(busyKey = "count:submit", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.submitCount(session, item, draft) }
                .onSuccess { result ->
                    val locallyCommitted = session.commitCount(item, draft)
                    val pendingResult = runCatching { source.pendingCounts(session.code) }
                    when (result) {
                        is CountSubmitOutcome.Queued -> {
                            val preservedQueue = pendingResult.getOrElse {
                                preserveWarehouseQueue(state.pending, result.pending)
                            }
                            state = state.copy(
                                busyKey = null,
                                selectedCount = locallyCommitted,
                                selectedItem = null,
                                countDraft = null,
                                pending = preservedQueue,
                                pendingFresh = pendingResult.isSuccess,
                                message = "حُفظت العدّة مشفرة وستُرسل عند عودة الاتصال",
                                error = pendingResult.exceptionOrNull()?.let { WAREHOUSE_REFRESH_REQUIRED },
                            )
                        }
                        is CountSubmitOutcome.Submitted -> {
                            state = state.copy(
                                selectedCount = locallyCommitted,
                                selectedItem = null,
                                countDraft = null,
                                pending = pendingResult.getOrDefault(state.pending),
                                pendingFresh = pendingResult.isSuccess,
                                countFresh = false,
                                message = result.receipt.label(),
                            )
                            reconcileCountAfterMutation(session.code, result.receipt.label(), session.version)
                        }
                    }
                }
                .onFailure { error ->
                    state = state.copy(busyKey = null, error = error.message ?: "تعذر إكمال العملية")
                }
        }
    }

    fun finishCount() {
        val code = state.selectedCount?.code ?: return
        if (!canFinishWarehouseCount(state)) return fail("حدّث الجلسة وعالج الطابور قبل رفع الجرد")
        state = state.copy(busyKey = "count:finish", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.finishCount(code) }
                .onSuccess {
                    state = state.copy(
                        selectedCount = state.selectedCount?.copy(assignmentStatus = "SUBMITTED"),
                        countFresh = false,
                        message = "رُفع الجرد للمراجعة",
                    )
                    reconcileCountAfterMutation(code, "رُفع الجرد للمراجعة", state.selectedCount?.version)
                }
                .onFailure { error ->
                    state = state.copy(busyKey = null, error = error.message ?: "تعذر إكمال العملية")
                }
        }
    }

    fun syncSnapshot() = launch("offline:snapshot", "تم تحديث لقطة المخزن المشفرة") {
        state = state.copy(snapshot = source.syncWarehouseSnapshot())
    }

    fun replayPending() {
        if (!canReplayWarehouseQueue(state)) return fail("حدّث تكليفات العد والطابور قبل المزامنة")
        state = state.copy(busyKey = "offline:queue", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.replayPendingCounts() }
                .onSuccess { result ->
                    val code = state.selectedCount?.code
                    val pendingResult = runCatching { source.pendingCounts(code) }
                    val summary = "أُرسلت ${result.sent} · مرفوضة ${result.rejected} · متبقية ${result.remaining}"
                    state = state.copy(
                        pending = pendingResult.getOrDefault(state.pending),
                        pendingFresh = pendingResult.isSuccess,
                        countFresh = if (code != null && result.sent > 0) false else state.countFresh,
                        message = summary,
                    )
                    if (code != null && result.sent > 0) {
                        reconcileCountAfterMutation(code, summary, state.selectedCount?.version)
                    }
                    else state = state.copy(
                        busyKey = null,
                        error = pendingResult.exceptionOrNull()?.let { WAREHOUSE_REFRESH_REQUIRED },
                    )
                }
                .onFailure { error ->
                    state = state.copy(busyKey = null, error = error.message ?: "تعذر إكمال العملية")
                }
        }
    }

    fun discardPending(clientRequestId: String) {
        if (!canDiscardWarehousePending(state, clientRequestId)) return fail("حدّث الطابور قبل حذف الإدخال")
        runCatching {
            source.discardPendingCount(clientRequestId)
        }.onSuccess {
            val locallyRemoved = state.pending.filterNot { it.clientRequestId == clientRequestId }
            val pendingResult = runCatching { source.pendingCounts(state.selectedCount?.code) }
            state = state.copy(
                pending = pendingResult.getOrDefault(locallyRemoved),
                pendingFresh = pendingResult.isSuccess,
                message = "حُذف الإدخال المحلي",
                error = pendingResult.exceptionOrNull()?.let { WAREHOUSE_REFRESH_REQUIRED },
            )
        }.onFailure { fail(it.message ?: "تعذر تعديل الطابور المشفر") }
    }

    private suspend fun reconcileCountAfterMutation(code: String, success: String, previousVersion: String?) {
        runCatching { source.countSession(code) to source.pendingCounts(code) }
            .onSuccess { (session, pending) ->
                if (!previousVersion.isNullOrBlank() && session.version == previousVersion) {
                    state = state.copy(
                        busyKey = null,
                        countFresh = false,
                        pending = pending,
                        pendingFresh = true,
                        error = WAREHOUSE_REFRESH_REQUIRED,
                        message = success,
                    )
                    return@onSuccess
                }
                state = state.copy(
                    busyKey = null,
                    selectedCount = session,
                    pending = pending,
                    countFresh = true,
                    pendingFresh = true,
                    error = null,
                    message = success,
                )
            }
            .onFailure {
                state = state.copy(
                    busyKey = null,
                    countFresh = false,
                    error = WAREHOUSE_REFRESH_REQUIRED,
                    message = success,
                )
            }
    }

    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { state = state.copy(busyKey = null, message = success ?: state.message) }
                .onFailure { state = state.copy(busyKey = null, error = it.message ?: "تعذر إكمال العملية") }
        }
    }

    private fun fail(message: String) { state = state.copy(error = message) }
}

private fun CountReceipt.label() = when {
    idempotent -> "العدّة مسجلة مسبقاً"
    kind == "VERIFY" && verifyMatch == true -> "العدّ التحققي مطابق"
    kind == "VERIFY" && verifyMatch == false -> "سُجل اختلاف للتحقق"
    kind == "RECOUNT" -> "تم تسجيل إعادة العد"
    else -> "تم تسجيل العد"
}

internal fun CountSession.commitCount(item: CountItem, draft: CountDraft): CountSession {
    val submission = WarehouseValidation.submission(draft)
    val alreadyMine = item.myCount != null
    val committed = item.copy(
        counted = true,
        myCount = MyCount(submission.quantityBase, null, submission.unitBreakdown),
    )
    return copy(
        mineCounted = if (alreadyMine) mineCounted else (mineCounted + 1).coerceAtMost(mineTotal),
        sessionCounted = if (item.counted) sessionCounted else (sessionCounted + 1).coerceAtMost(sessionTotal),
        items = items.map { if (it.variantId == item.variantId) committed else it },
    )
}

class WarehouseToolsViewModelFactory(
    private val source: WarehouseToolsDataSource,
    private val capabilities: WarehouseCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = WarehouseToolsViewModel(source, capabilities) as T
}

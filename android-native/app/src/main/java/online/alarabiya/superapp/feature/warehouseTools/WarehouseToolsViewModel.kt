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
)

class WarehouseToolsViewModel(
    private val source: WarehouseToolsDataSource,
    val capabilities: WarehouseCapabilities,
) : ViewModel() {
    private val initialSnapshot = runCatching { source.cachedWarehouseSnapshot() }
    private val initialPending = runCatching { source.pendingCounts() }
    var state by mutableStateOf(WarehouseToolsUiState(
        snapshot = initialSnapshot.getOrNull(),
        pending = initialPending.getOrDefault(emptyList()),
        error = initialPending.exceptionOrNull()?.message ?: initialSnapshot.exceptionOrNull()?.message,
    ))
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, error = null)
        viewModelScope.launch {
            runCatching { source.assignments() to source.pendingCounts() }
                .onSuccess { (assignments, pending) -> state = state.copy(initializing = false, assignments = assignments, pending = pending) }
                .onFailure { state = state.copy(initializing = false, error = it.message ?: "تعذر تحميل تكليفات العد") }
        }
    }

    fun selectSection(value: WarehouseSection) {
        if (value !in capabilities.sections) return
        if (value == WarehouseSection.OFFLINE) {
            runCatching { source.pendingCounts() }
                .onSuccess { state = state.copy(section = value, pending = it, error = null, message = null) }
                .onFailure { fail(it.message ?: "تعذر قراءة الطابور المشفر") }
        } else state = state.copy(section = value, error = null, message = null)
    }
    fun clearFeedback() { state = state.copy(error = null, message = null) }
    fun setScanInput(value: String) { state = state.copy(scanInput = value.take(1_000), signedResult = null, catalogResult = null, error = null) }
    fun setCountQuery(value: String) { state = state.copy(countQuery = value.take(120)) }

    fun scan() {
        val raw = state.scanInput.trim()
        if (raw.isEmpty()) return fail("أدخل أو امسح رمزاً")
        state.selectedCount?.exactMatch(raw)?.let { return beginCount(it) }
        state.snapshot?.exactMatch(raw)?.let { state = state.copy(catalogResult = it, signedResult = null, message = "تمت المطابقة من اللقطة المشفرة"); return }
        if (raw.count { it == '|' } >= 5) {
            launch("barcode:verify") { state = state.copy(signedResult = source.verifySignedBarcode(raw), catalogResult = null) }
        } else fail("لا توجد مطابقة دقيقة للباركود أو SKU في البيانات المتاحة")
    }

    fun selectAssignment(value: CountAssignment) = launch("count:${value.sessionCode}") {
        state = state.copy(selectedCount = source.countSession(value.sessionCode), selectedItem = null, countDraft = null, pending = source.pendingCounts(value.sessionCode))
    }

    fun closeCount() {
        runCatching { source.pendingCounts() }
            .onSuccess { state = state.copy(selectedCount = null, selectedItem = null, countDraft = null, countQuery = "", pending = it) }
            .onFailure { fail(it.message ?: "تعذر قراءة الطابور المشفر") }
    }
    fun refreshCount() { val code = state.selectedCount?.code ?: return; launch("count:refresh") { state = state.copy(selectedCount = source.countSession(code), pending = source.pendingCounts(code)) } }

    fun beginCount(item: CountItem) {
        val session = state.selectedCount ?: return fail("اختر جلسة العد أولاً")
        if (!session.canCount(item)) return fail("سياسة الجلسة تمنع تكرار عد هذا الصنف")
        val units = item.units.ifEmpty { listOf(CountUnit("الوحدة الأساس", "1", null, emptyList())) }
        state = state.copy(
            section = WarehouseSection.COUNTS,
            selectedItem = item,
            countDraft = CountDraft(session.code, item.variantId, units.map { CountUnitEntry(it.name, it.factor) }, UUID.randomUUID().toString()),
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
        WarehouseValidation.count(session, item, draft)?.let { return fail(it) }
        launch("count:submit") {
            when (val result = source.submitCount(session, item, draft)) {
                is CountSubmitOutcome.Submitted -> {
                    val updated = source.countSession(session.code)
                    state = state.copy(selectedCount = updated, selectedItem = null, countDraft = null, pending = source.pendingCounts(session.code), message = result.receipt.label())
                }
                is CountSubmitOutcome.Queued -> state = state.copy(selectedItem = null, countDraft = null, pending = source.pendingCounts(session.code), message = "حُفظت العدّة مشفرة وستُرسل عند عودة الاتصال")
            }
        }
    }

    fun finishCount() {
        val code = state.selectedCount?.code ?: return
        launch("count:finish", "رُفع الجرد للمراجعة") {
            source.finishCount(code)
            state = state.copy(selectedCount = source.countSession(code), pending = source.pendingCounts(code))
        }
    }

    fun syncSnapshot() = launch("offline:snapshot", "تم تحديث لقطة المخزن المشفرة") {
        state = state.copy(snapshot = source.syncWarehouseSnapshot())
    }

    fun replayPending() = launch("offline:queue") {
        val result = source.replayPendingCounts()
        val code = state.selectedCount?.code
        val refreshed = code?.let { runCatching { source.countSession(it) }.getOrNull() } ?: state.selectedCount
        state = state.copy(selectedCount = refreshed, pending = source.pendingCounts(code), message = "أُرسلت ${result.sent} · مرفوضة ${result.rejected} · متبقية ${result.remaining}")
    }

    fun discardPending(clientRequestId: String) {
        runCatching {
            source.discardPendingCount(clientRequestId)
            source.pendingCounts(state.selectedCount?.code)
        }.onSuccess { state = state.copy(pending = it, message = "حُذف الإدخال المحلي") }
            .onFailure { fail(it.message ?: "تعذر تعديل الطابور المشفر") }
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

class WarehouseToolsViewModelFactory(
    private val source: WarehouseToolsDataSource,
    private val capabilities: WarehouseCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = WarehouseToolsViewModel(source, capabilities) as T
}

package online.alarabiya.superapp.feature.shifts

import online.alarabiya.superapp.model.shifts.CurrentShift
import online.alarabiya.superapp.model.shifts.ShiftAccessPolicy
import online.alarabiya.superapp.model.shifts.ShiftFilters
import online.alarabiya.superapp.model.shifts.ShiftMoney
import online.alarabiya.superapp.model.shifts.ShiftRecord
import online.alarabiya.superapp.model.shifts.ShiftReport
import online.alarabiya.superapp.model.shifts.ShiftVarianceState

sealed interface ShiftDetailState {
    data object None : ShiftDetailState
    data object Loading : ShiftDetailState
    data class Content(val report: ShiftReport) : ShiftDetailState
    data class Error(val shiftId: Long, val message: String) : ShiftDetailState
}

data class ShiftCloseDraft(
    val shiftId: Long,
    val countedCash: String = "",
    val countedCashConfirmation: String = "",
    val acknowledged: Boolean = false,
)

data class ShiftUiState(
    val policy: ShiftAccessPolicy,
    val loading: Boolean = true,
    val loaded: Boolean = false,
    val loadingMore: Boolean = false,
    val rows: List<ShiftRecord> = emptyList(),
    val total: Int = 0,
    val hasMore: Boolean = false,
    val nextCursor: Long? = null,
    val filters: ShiftFilters = ShiftFilters(),
    val selectedShiftId: Long? = null,
    val detail: ShiftDetailState = ShiftDetailState.None,
    val currentShifts: List<CurrentShift> = emptyList(),
    val currentChecked: Boolean = false,
    val closeDraft: ShiftCloseDraft? = null,
    val closing: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

internal fun ShiftUiState.applyExecutiveNavigation(arguments: Map<String, String>): ShiftUiState {
    val variance = when (arguments["variance"]?.trim()?.lowercase()) {
        "true", "1", "with_variance", "with-variance" -> ShiftVarianceState.WITH_VARIANCE
        "matched" -> ShiftVarianceState.MATCHED
        "unreconciled" -> ShiftVarianceState.UNRECONCILED
        else -> return this
    }
    return copy(
        filters = filters.copy(variance = variance),
        selectedShiftId = null,
        detail = ShiftDetailState.None,
        closeDraft = null,
        error = null,
        notice = null,
    )
}

internal object ShiftStatePolicy {
    fun canLoadMore(state: ShiftUiState): Boolean =
        state.loaded && !state.loading && !state.loadingMore && !state.closing && state.hasMore && state.nextCursor != null

    fun canRequestClose(state: ShiftUiState, shift: ShiftRecord): Boolean =
        state.loaded && !state.loading && !state.loadingMore && !state.closing &&
            state.detail is ShiftDetailState.Content && state.policy.canClose(shift)

    fun closeValidation(state: ShiftUiState): String? {
        if (!state.loaded || state.loading || state.loadingMore) return "انتظر اكتمال تحميل بيانات الوردية"
        val draft = state.closeDraft ?: return "لم تحدد وردية للإغلاق"
        val report = (state.detail as? ShiftDetailState.Content)?.report
            ?.takeIf { it.shift.id == draft.shiftId }
            ?: return "حمّل تقرير الوردية قبل الإغلاق"
        val counted = ShiftMoney.parseUnsigned(draft.countedCash) ?: return "أدخل النقد المعدود بدقة"
        val confirmation = ShiftMoney.parseUnsigned(draft.countedCashConfirmation)
            ?: return "أعد إدخال النقد المعدود للتأكيد"
        if (counted != confirmation) return "قيمة التأكيد لا تطابق النقد المعدود"
        if (counted != report.expectedCash) return "يوجد فرق نقدي؛ راجع العمليات المسجلة قبل الإغلاق"
        if (!draft.acknowledged) return "أكد مراجعة ملخص الإغلاق"
        if (!state.policy.canClose(report.shift)) return "لا تسمح صلاحية حسابك بإغلاق هذه الوردية"
        return null
    }

    fun variance(report: ShiftReport, rawCountedCash: String): ShiftMoney? =
        ShiftMoney.parseUnsigned(rawCountedCash)?.minus(report.expectedCash)

}

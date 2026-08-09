package online.alarabiya.superapp.feature.commerce

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.CommerceDataSource
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.commerce.CommerceBranch
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardCategory
import online.alarabiya.superapp.model.commerce.DigitalSubscription
import online.alarabiya.superapp.model.commerce.DigitalCardApproval
import online.alarabiya.superapp.model.commerce.DigitalCardApprovalDecision
import online.alarabiya.superapp.model.commerce.GiftDetail
import online.alarabiya.superapp.model.commerce.GiftDirection
import online.alarabiya.superapp.model.commerce.GiftPage
import online.alarabiya.superapp.model.commerce.GiftStatus
import online.alarabiya.superapp.model.commerce.ReservationConversion
import online.alarabiya.superapp.model.commerce.ReservationDetail
import online.alarabiya.superapp.model.commerce.ReservationPage

enum class CommerceSection { Gifts, Reservations, DigitalCards, Subscriptions, Approvals }

internal fun CommerceCapabilities.readableSections(): List<CommerceSection> = buildList {
    if (canReadGifts) add(CommerceSection.Gifts)
    if (canReadReservations) add(CommerceSection.Reservations)
    if (canBrowseDigitalCards) add(CommerceSection.DigitalCards)
    if (canReadDigitalSubscriptions) add(CommerceSection.Subscriptions)
    if (canReviewDigitalCardApprovals) add(CommerceSection.Approvals)
}

data class CommerceUiState(
    val section: CommerceSection = CommerceSection.Gifts,
    val branchId: Long? = null,
    val branches: List<CommerceBranch> = emptyList(),
    val query: String = "",
    val gifts: GiftPage? = null,
    val giftDetail: GiftDetail? = null,
    val reservations: ReservationPage? = null,
    val reservationDetail: ReservationDetail? = null,
    val digitalCards: List<DigitalCard> = emptyList(),
    val confirmedCard: DigitalCard? = null,
    val subscriptions: List<DigitalSubscription> = emptyList(),
    val approvals: List<DigitalCardApproval> = emptyList(),
    val lastConversion: ReservationConversion? = null,
    val loading: Boolean = false,
    val busyKey: String? = null,
    val notice: String? = null,
    val error: String? = null,
    val loadedSections: Set<CommerceSection> = emptySet(),
    val staleSections: Set<CommerceSection> = emptySet(),
)

internal fun CommerceUiState.isFresh(section: CommerceSection): Boolean =
    section in loadedSections && section !in staleSections

internal fun CommerceUiState.canAct(section: CommerceSection): Boolean =
    this.section == section && isFresh(section) && !loading && busyKey == null

internal fun CommerceUiState.freshDigitalCard(offeringId: Long): DigitalCard? =
    takeIf { it.canAct(CommerceSection.DigitalCards) }
        ?.digitalCards
        ?.singleOrNull { it.offeringId == offeringId }
        ?.takeIf { it.canConfirm }

internal object CommerceStateReducer {
    fun initialized(state: CommerceUiState, branchId: Long?, readable: List<CommerceSection>): CommerceUiState {
        val section = state.section.takeIf { it in readable } ?: readable.firstOrNull() ?: state.section
        return state.copy(branchId = state.branchId ?: branchId, section = section)
    }

    fun selected(state: CommerceUiState, section: CommerceSection): CommerceUiState =
        state.copy(
            section = section,
            query = "",
            giftDetail = null,
            reservationDetail = null,
            lastConversion = null,
            confirmedCard = null,
            notice = null,
            error = null,
        )

    fun branchChanged(state: CommerceUiState, branchId: Long?): CommerceUiState = state.copy(
        branchId = branchId,
        gifts = null,
        giftDetail = null,
        reservations = null,
        reservationDetail = null,
        digitalCards = emptyList(),
        confirmedCard = null,
        subscriptions = emptyList(),
        approvals = emptyList(),
        lastConversion = null,
        loadedSections = emptySet(),
        staleSections = emptySet(),
        notice = null,
        error = null,
    )

    fun queryChanged(state: CommerceUiState, query: String): CommerceUiState {
        val next = query.take(200)
        if (next == state.query) return state
        return state.copy(
            query = next,
            giftDetail = null,
            reservationDetail = null,
            lastConversion = null,
            confirmedCard = null,
            staleSections = if (state.section in state.loadedSections) {
                state.staleSections + state.section
            } else {
                state.staleSections
            },
            notice = null,
            error = null,
        )
    }

    fun loading(state: CommerceUiState, keepNotice: Boolean = false): CommerceUiState =
        state.copy(loading = true, notice = state.notice.takeIf { keepNotice }, error = null)

    fun loaded(state: CommerceUiState, section: CommerceSection, keepNotice: Boolean = false): CommerceUiState = state.copy(
        loading = false,
        error = null,
        notice = state.notice.takeIf { keepNotice },
        loadedSections = state.loadedSections + section,
        staleSections = state.staleSections - section,
    )

    fun operationStarted(state: CommerceUiState, key: String): CommerceUiState =
        state.copy(busyKey = key, notice = null, error = null)

    fun mutationCommitted(state: CommerceUiState, section: CommerceSection, message: String): CommerceUiState {
        val committed = state.copy(
            busyKey = null,
            staleSections = state.staleSections + section,
            notice = message,
            error = null,
        )
        return when (section) {
            CommerceSection.Gifts -> committed.copy(giftDetail = null)
            CommerceSection.Reservations -> committed.copy(reservationDetail = null, lastConversion = null)
            CommerceSection.DigitalCards -> committed.copy(confirmedCard = null)
            CommerceSection.Subscriptions, CommerceSection.Approvals -> committed
        }
    }

    fun failed(state: CommerceUiState, message: String): CommerceUiState =
        state.copy(loading = false, busyKey = null, error = message)

    fun loadFailed(
        state: CommerceUiState,
        section: CommerceSection,
        message: String,
        afterMutation: Boolean = false,
    ): CommerceUiState {
        val retainedMutationNotice = state.notice?.takeIf { section in state.staleSections }
        return state.copy(
            loading = false,
            busyKey = null,
            staleSections = state.staleSections + section,
            notice = when {
                afterMutation -> MUTATION_REFRESH_NOTICE
                retainedMutationNotice != null -> retainedMutationNotice
                else -> null
            },
            error = message.takeUnless { afterMutation || retainedMutationNotice != null },
        )
    }

    const val MUTATION_REFRESH_NOTICE = "تمت العملية وتعذر تحديث العرض. أعد المحاولة للمزامنة"
}

class CommerceViewModel(private val source: CommerceDataSource) : ViewModel() {
    var state by mutableStateOf(CommerceUiState())
        private set

    fun initialize(branchId: Long?, capabilities: CommerceCapabilities) {
        state = CommerceStateReducer.initialized(state, branchId, capabilities.readableSections())
    }

    fun select(section: CommerceSection, capabilities: CommerceCapabilities) {
        if (state.loading || state.busyKey != null) return
        if (section !in capabilities.readableSections()) return
        state = CommerceStateReducer.selected(state, section)
        if (!state.isFresh(section)) refresh(capabilities)
    }

    fun changeQuery(value: String) {
        if (state.loading || state.busyKey != null) return
        state = CommerceStateReducer.queryChanged(state, value)
    }

    fun changeBranch(value: Long) {
        if (state.loading || state.busyKey != null) return
        state = CommerceStateReducer.branchChanged(state, value.takeIf { it > 0 })
    }

    fun refresh(capabilities: CommerceCapabilities) {
        if (state.loading || state.busyKey != null) return
        val section = state.section
        val keepNotice = section in state.staleSections && state.notice != null
        state = CommerceStateReducer.loading(state, keepNotice)
        viewModelScope.launch {
            refreshNow(section, capabilities, afterMutation = false, keepNoticeOnSuccess = false)
        }
    }

    fun openGift(id: Long) {
        if (!state.canAct(CommerceSection.Gifts)) return
        val row = state.gifts?.rows?.singleOrNull { it.id == id } ?: return
        load("gift:$id", CommerceSection.Gifts) {
            val detail = source.gift(id)
            require(detail.id == row.id && detail.branchId == row.branchId) { "تعذر التحقق من تفاصيل الهدية" }
            state = state.copy(giftDetail = detail)
        }
    }

    fun closeGift() {
        state = state.copy(giftDetail = null)
    }

    fun approveGift(id: Long, capabilities: CommerceCapabilities) {
        val detail = state.giftDetail?.takeIf { it.id == id } ?: return
        if (
            !state.canAct(CommerceSection.Gifts) ||
            detail.direction != GiftDirection.OUT ||
            detail.status != GiftStatus.PENDING_APPROVAL ||
            !capabilities.canApproveGifts
        ) return
        mutateAndRefresh(
            section = CommerceSection.Gifts,
            key = "gift:approve:$id",
            capabilities = capabilities,
            success = { "تم اعتماد الهدية" },
            operation = { source.approveGift(id) },
        )
    }

    fun openReservation(id: Long) {
        if (!state.canAct(CommerceSection.Reservations)) return
        val row = state.reservations?.rows?.singleOrNull { it.id == id } ?: return
        load("reservation:$id", CommerceSection.Reservations) {
            val detail = source.reservation(id)
            require(detail.summary.id == row.id && detail.summary.branchId == row.branchId) {
                "تعذر التحقق من تفاصيل الحجز"
            }
            state = state.copy(reservationDetail = detail, lastConversion = null)
        }
    }

    fun closeReservation() {
        state = state.copy(reservationDetail = null, lastConversion = null)
    }

    fun cancelReservation(id: Long, reason: String?, capabilities: CommerceCapabilities) {
        val detail = state.reservationDetail?.takeIf { it.summary.id == id } ?: return
        if (!state.canAct(CommerceSection.Reservations) || !detail.canCancel(capabilities)) return
        mutateAndRefresh(
            section = CommerceSection.Reservations,
            key = "reservation:cancel:$id",
            capabilities = capabilities,
            success = { "تم إلغاء الحجز وتحرير الرصيد المحجوز" },
            operation = { source.cancelReservation(id, reason) },
        )
    }

    fun extendReservation(id: Long, hours: Int, capabilities: CommerceCapabilities) {
        val detail = state.reservationDetail?.takeIf { it.summary.id == id } ?: return
        if (!state.canAct(CommerceSection.Reservations) || !detail.canExtend(capabilities) || hours !in 1..72) return
        mutateAndRefresh(
            section = CommerceSection.Reservations,
            key = "reservation:extend:$id",
            capabilities = capabilities,
            success = { "تم تمديد الحجز" },
            operation = { source.extendReservation(id, hours) },
        )
    }

    fun convertReservation(id: Long, capabilities: CommerceCapabilities) {
        val detail = state.reservationDetail?.takeIf { it.summary.id == id } ?: return
        if (!state.canAct(CommerceSection.Reservations) || !detail.canConvert(capabilities)) return
        mutateAndRefresh(
            section = CommerceSection.Reservations,
            key = "reservation:convert:$id",
            capabilities = capabilities,
            success = { conversion -> "تم تحويل الحجز إلى الفاتورة ${conversion.invoiceNumber}" },
            operation = { source.convertReservationWithoutCollection(id) },
        )
    }

    fun confirmCard(offeringId: Long, capabilities: CommerceCapabilities) {
        if (!capabilities.canBrowseDigitalCards) return
        val catalogCard = state.freshDigitalCard(offeringId) ?: return
        val branchId = state.branchId ?: return
        load("card:confirm:$offeringId", CommerceSection.DigitalCards) {
            val confirmed = source.confirmDigitalCard(branchId, offeringId)
            require(confirmed.card.offeringId == catalogCard.offeringId) { "تعذر التحقق من البطاقة المؤكدة" }
            state = state.copy(confirmedCard = confirmed.card)
        }
    }

    fun approveDigitalCard(
        item: DigitalCardApproval,
        decision: DigitalCardApprovalDecision,
        capabilities: CommerceCapabilities,
    ) {
        val current = state.approvals.singleOrNull { it.id == item.id && it.kind == item.kind } ?: return
        if (!state.canAct(CommerceSection.Approvals) || current != item || !current.canDecide(capabilities)) return
        mutateAndRefresh(
            section = CommerceSection.Approvals,
            key = "digital-card-approval:approve:${item.kind}:${item.id}",
            capabilities = capabilities,
            success = { "تم اعتماد الطلب" },
            operation = { source.approveDigitalCard(current, decision) },
            commit = { committed, _ -> committed.copy(approvals = committed.approvals - current) },
        )
    }

    fun rejectDigitalCard(item: DigitalCardApproval, reason: String?, capabilities: CommerceCapabilities) {
        val current = state.approvals.singleOrNull { it.id == item.id && it.kind == item.kind } ?: return
        if (!state.canAct(CommerceSection.Approvals) || current != item || !current.canDecide(capabilities)) return
        mutateAndRefresh(
            section = CommerceSection.Approvals,
            key = "digital-card-approval:reject:${item.kind}:${item.id}",
            capabilities = capabilities,
            success = { "تم رفض الطلب" },
            operation = { source.rejectDigitalCard(current, reason) },
            commit = { committed, _ -> committed.copy(approvals = committed.approvals - current) },
        )
    }

    private suspend fun loadSelected(
        section: CommerceSection,
        branchId: Long?,
        query: String,
        capabilities: CommerceCapabilities,
    ) {
        when (section) {
            CommerceSection.Gifts -> {
                require(capabilities.canReadGifts) { "لا تملك صلاحية عرض الهدايا" }
                state = state.copy(gifts = source.gifts(query, null, null, branchId), giftDetail = null)
            }
            CommerceSection.Reservations -> {
                require(capabilities.canReadReservations) { "لا تملك صلاحية عرض الحجوزات" }
                state = state.copy(
                    reservations = source.reservations(query, null, branchId),
                    reservationDetail = null,
                    lastConversion = null,
                )
            }
            CommerceSection.DigitalCards -> {
                require(capabilities.canBrowseDigitalCards) { "هذه المحطة غير مخولة لبطاقات التجزئة" }
                val selectedBranchId = requireNotNull(branchId) { "حدّد الفرع لعرض البطاقات" }
                state = state.copy(
                    digitalCards = source.digitalCards(selectedBranchId, DigitalCardCategory.ALL, query),
                    confirmedCard = null,
                )
            }
            CommerceSection.Subscriptions -> {
                require(capabilities.canReadDigitalSubscriptions) { "لا تملك صلاحية عرض الاشتراكات" }
                state = state.copy(subscriptions = source.subscriptions(branchId, query, null))
            }
            CommerceSection.Approvals -> {
                require(capabilities.canReviewDigitalCardApprovals) { "لا تملك صلاحية مراجعة اعتمادات البطاقات الرقمية" }
                state = state.copy(approvals = source.digitalCardApprovals(branchId))
            }
        }
    }

    private fun load(key: String, section: CommerceSection, operation: suspend () -> Unit) {
        if (!state.canAct(section)) return
        state = CommerceStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = state.copy(busyKey = null, error = null) }
                .onFailure { state = CommerceStateReducer.failed(state, userMessage(it)) }
        }
    }

    private fun <T> mutateAndRefresh(
        section: CommerceSection,
        key: String,
        capabilities: CommerceCapabilities,
        success: (T) -> String,
        operation: suspend () -> T,
        commit: (CommerceUiState, T) -> CommerceUiState = { committed, _ -> committed },
    ) {
        if (!state.canAct(section)) return
        state = CommerceStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            val result = runCatching { operation() }.getOrElse {
                state = CommerceStateReducer.failed(state, userMessage(it))
                return@launch
            }
            state = commit(CommerceStateReducer.mutationCommitted(state, section, success(result)), result)
            state = CommerceStateReducer.loading(state, keepNotice = true)
            refreshNow(section, capabilities, afterMutation = true, keepNoticeOnSuccess = true)
        }
    }

    private suspend fun refreshNow(
        section: CommerceSection,
        capabilities: CommerceCapabilities,
        afterMutation: Boolean,
        keepNoticeOnSuccess: Boolean,
    ) {
        val branchId = state.branchId
        val query = state.query
        runCatching {
            if (capabilities.allBranches && state.branches.isEmpty()) {
                state = state.copy(branches = source.branches())
            }
            loadSelected(section, branchId, query, capabilities)
        }
            .onSuccess { state = CommerceStateReducer.loaded(state, section, keepNoticeOnSuccess) }
            .onFailure {
                state = CommerceStateReducer.loadFailed(state, section, userMessage(it), afterMutation)
            }
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class CommerceViewModelFactory(private val source: CommerceDataSource) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CommerceViewModel(source) as T
}

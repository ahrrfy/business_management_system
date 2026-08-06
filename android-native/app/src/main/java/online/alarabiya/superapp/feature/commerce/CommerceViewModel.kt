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
import online.alarabiya.superapp.model.commerce.GiftDetail
import online.alarabiya.superapp.model.commerce.GiftPage
import online.alarabiya.superapp.model.commerce.ReservationConversion
import online.alarabiya.superapp.model.commerce.ReservationDetail
import online.alarabiya.superapp.model.commerce.ReservationPage

enum class CommerceSection { Gifts, Reservations, DigitalCards, Subscriptions }

internal fun CommerceCapabilities.readableSections(): List<CommerceSection> = buildList {
    if (canReadGifts) add(CommerceSection.Gifts)
    if (canReadReservations) add(CommerceSection.Reservations)
    if (canBrowseDigitalCards) add(CommerceSection.DigitalCards)
    if (canReadDigitalSubscriptions) add(CommerceSection.Subscriptions)
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
    val lastConversion: ReservationConversion? = null,
    val loading: Boolean = false,
    val busyKey: String? = null,
    val message: String? = null,
    val error: String? = null,
    val loadedSections: Set<CommerceSection> = emptySet(),
)

internal object CommerceStateReducer {
    fun initialized(state: CommerceUiState, branchId: Long?, readable: List<CommerceSection>): CommerceUiState {
        val section = state.section.takeIf { it in readable } ?: readable.firstOrNull() ?: state.section
        return state.copy(branchId = state.branchId ?: branchId, section = section)
    }

    fun selected(state: CommerceUiState, section: CommerceSection): CommerceUiState =
        state.copy(section = section, query = "", message = null, error = null)

    fun branchChanged(state: CommerceUiState, branchId: Long?): CommerceUiState = state.copy(
        branchId = branchId,
        confirmedCard = null,
        loadedSections = state.loadedSections - CommerceSection.DigitalCards,
        message = null,
        error = null,
    )

    fun queryChanged(state: CommerceUiState, query: String): CommerceUiState =
        state.copy(query = query.take(200), message = null, error = null)

    fun loading(state: CommerceUiState): CommerceUiState =
        state.copy(loading = true, message = null, error = null)

    fun loaded(state: CommerceUiState): CommerceUiState = state.copy(
        loading = false,
        error = null,
        loadedSections = state.loadedSections + state.section,
    )

    fun operationStarted(state: CommerceUiState, key: String): CommerceUiState =
        state.copy(busyKey = key, message = null, error = null)

    fun operationFinished(state: CommerceUiState, message: String): CommerceUiState =
        state.copy(busyKey = null, message = message, error = null)

    fun failed(state: CommerceUiState, message: String): CommerceUiState =
        state.copy(loading = false, busyKey = null, error = message)
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
        if (section !in state.loadedSections) refresh(capabilities)
    }

    fun changeQuery(value: String) {
        state = CommerceStateReducer.queryChanged(state, value)
    }

    fun changeBranch(value: Long) {
        state = CommerceStateReducer.branchChanged(state, value.takeIf { it > 0 })
    }

    fun refresh(capabilities: CommerceCapabilities) {
        if (state.loading || state.busyKey != null) return
        state = CommerceStateReducer.loading(state)
        viewModelScope.launch {
            runCatching {
                if (capabilities.allBranches && state.branches.isEmpty()) {
                    state = state.copy(branches = source.branches())
                }
                loadSelected(capabilities)
            }
                .onSuccess { state = CommerceStateReducer.loaded(state) }
                .onFailure { state = CommerceStateReducer.failed(state, userMessage(it)) }
        }
    }

    fun openGift(id: Long) = load("gift:$id") { state = state.copy(giftDetail = source.gift(id)) }

    fun closeGift() {
        state = state.copy(giftDetail = null)
    }

    fun approveGift(id: Long, capabilities: CommerceCapabilities) = mutate("gift:approve:$id", "تم اعتماد الهدية") {
        require(capabilities.canApproveGifts) { "لا تملك صلاحية اعتماد الهدايا" }
        source.approveGift(id)
        state = state.copy(giftDetail = source.gift(id))
        state = state.copy(gifts = source.gifts(state.query, null, null, state.branchId))
    }

    fun openReservation(id: Long) = load("reservation:$id") {
        state = state.copy(reservationDetail = source.reservation(id), lastConversion = null)
    }

    fun closeReservation() {
        state = state.copy(reservationDetail = null, lastConversion = null)
    }

    fun cancelReservation(id: Long, reason: String?, capabilities: CommerceCapabilities) =
        mutate("reservation:cancel:$id", "تم إلغاء الحجز وتحرير الرصيد المحجوز") {
            require(capabilities.canCancelReservations) { "لا تملك صلاحية إلغاء الحجوزات" }
            source.cancelReservation(id, reason)
            reloadReservation(id)
        }

    fun extendReservation(id: Long, hours: Int, capabilities: CommerceCapabilities) =
        mutate("reservation:extend:$id", "تم تمديد الحجز") {
            require(capabilities.canExtendReservations) { "التمديد متاح للمدير فقط" }
            source.extendReservation(id, hours)
            reloadReservation(id)
        }

    fun convertReservation(id: Long, capabilities: CommerceCapabilities) =
        mutate("reservation:convert:$id", "تم تحويل الحجز إلى فاتورة دون تحصيل") {
            require(capabilities.canConvertReservations) { "لا تملك صلاحية تحويل الحجز" }
            val conversion = source.convertReservationWithoutCollection(id)
            state = state.copy(lastConversion = conversion)
            reloadReservation(id)
        }

    fun confirmCard(offeringId: Long, capabilities: CommerceCapabilities) =
        mutate("card:confirm:$offeringId", "أكد الخادم السعر الحالي") {
            require(capabilities.canBrowseDigitalCards) { "هذه المحطة غير مخولة لبطاقات التجزئة" }
            val branchId = requireNotNull(state.branchId) { "حدّد الفرع لتأكيد السعر" }
            val confirmed = source.confirmDigitalCard(branchId, offeringId)
            state = state.copy(confirmedCard = confirmed.card)
        }

    private suspend fun loadSelected(capabilities: CommerceCapabilities) {
        when (state.section) {
            CommerceSection.Gifts -> {
                require(capabilities.canReadGifts) { "لا تملك صلاحية عرض الهدايا" }
                state = state.copy(gifts = source.gifts(state.query, null, null, state.branchId))
            }
            CommerceSection.Reservations -> {
                require(capabilities.canReadReservations) { "لا تملك صلاحية عرض الحجوزات" }
                state = state.copy(reservations = source.reservations(state.query, null, state.branchId))
            }
            CommerceSection.DigitalCards -> {
                require(capabilities.canBrowseDigitalCards) { "هذه المحطة غير مخولة لبطاقات التجزئة" }
                val branchId = requireNotNull(state.branchId) { "حدّد الفرع لعرض البطاقات" }
                state = state.copy(
                    digitalCards = source.digitalCards(branchId, DigitalCardCategory.ALL, state.query),
                    confirmedCard = null,
                )
            }
            CommerceSection.Subscriptions -> {
                require(capabilities.canReadDigitalSubscriptions) { "لا تملك صلاحية عرض الاشتراكات" }
                state = state.copy(subscriptions = source.subscriptions(state.branchId, state.query, null))
            }
        }
    }

    private suspend fun reloadReservation(id: Long) {
        state = state.copy(
            reservationDetail = source.reservation(id),
            reservations = source.reservations(state.query, null, state.branchId),
        )
    }

    private fun load(key: String, operation: suspend () -> Unit) {
        if (state.loading || state.busyKey != null) return
        state = CommerceStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = state.copy(busyKey = null, error = null) }
                .onFailure { state = CommerceStateReducer.failed(state, userMessage(it)) }
        }
    }

    private fun mutate(key: String, success: String, operation: suspend () -> Unit) {
        if (state.loading || state.busyKey != null) return
        state = CommerceStateReducer.operationStarted(state, key)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = CommerceStateReducer.operationFinished(state, success) }
                .onFailure { state = CommerceStateReducer.failed(state, userMessage(it)) }
        }
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class CommerceViewModelFactory(private val source: CommerceDataSource) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CommerceViewModel(source) as T
}

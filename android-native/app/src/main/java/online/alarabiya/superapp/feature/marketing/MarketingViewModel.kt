package online.alarabiya.superapp.feature.marketing

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.CatalogAnomalyQuery
import online.alarabiya.superapp.data.MarketingDataSource
import online.alarabiya.superapp.model.marketing.AnomalyCode
import online.alarabiya.superapp.model.marketing.AnomalySeverity
import online.alarabiya.superapp.model.marketing.CatalogAnomaly
import online.alarabiya.superapp.model.marketing.CouponPreviewRequest
import online.alarabiya.superapp.model.marketing.CouponProgram
import online.alarabiya.superapp.model.marketing.CouponProgramDraft
import online.alarabiya.superapp.model.marketing.CouponProgramStatus
import online.alarabiya.superapp.model.marketing.MarketingCapabilities
import online.alarabiya.superapp.model.marketing.MarketingPolicy
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.marketing.MarketingSection
import online.alarabiya.superapp.model.marketing.MarketingValidation
import online.alarabiya.superapp.model.marketing.PromotionDraft
import online.alarabiya.superapp.model.marketing.PromotionSummary

class MarketingViewModel(
    private val source: MarketingDataSource,
    scope: MarketingScope,
    capabilities: MarketingCapabilities,
) : ViewModel() {
    var state by mutableStateOf(MarketingUiState(scope = scope, capabilities = capabilities))
        private set

    init {
        val initial = when {
            capabilities.canReadCampaigns -> MarketingSection.Promotions
            capabilities.canReadCatalogQuality -> MarketingSection.CatalogQuality
            else -> MarketingSection.Promotions
        }
        state = state.copy(section = initial)
        refresh()
    }

    fun availableSections(): List<MarketingSection> = buildList {
        if (state.capabilities.canReadCampaigns) {
            add(MarketingSection.Promotions)
            add(MarketingSection.Coupons)
        }
        if (state.capabilities.canReadCatalogQuality) add(MarketingSection.CatalogQuality)
    }

    fun setSection(section: MarketingSection) {
        if (section !in availableSections() || state.section == section) return
        state = state.copy(
            section = section,
            query = "",
            selectedPromotionId = null,
            promotionDetail = MarketingDetailState.None,
            selectedProgramId = null,
            issuedCoupons = MarketingDetailState.None,
            couponPreview = MarketingDetailState.None,
            selectedAnomalyKey = null,
            error = null,
            notice = null,
        )
        refresh()
    }

    fun setQuery(value: String) {
        state = state.copy(query = value.take(120))
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    fun refresh() {
        if (state.loading) return
        when (state.section) {
            MarketingSection.Promotions -> loadPromotions()
            MarketingSection.Coupons -> loadPrograms()
            MarketingSection.CatalogQuality -> loadAnomalies(reset = true)
        }
    }

    fun setIncludeInactive(value: Boolean) {
        if (state.includeInactivePromotions == value) return
        state = state.copy(includeInactivePromotions = value, selectedPromotionId = null, promotionDetail = MarketingDetailState.None)
        loadPromotions()
    }

    fun selectPromotion(id: Long?) {
        if (id == null) {
            state = state.copy(selectedPromotionId = null, promotionDetail = MarketingDetailState.None)
            return
        }
        val summary = state.promotions.firstOrNull { it.id == id } ?: return
        if (!state.scope.acceptsVisibleBranch(summary.branchId)) return
        state = state.copy(selectedPromotionId = id, promotionDetail = MarketingDetailState.Loading)
        viewModelScope.launch {
            runCatching { source.promotion(id) }
                .onSuccess { state = state.copy(promotionDetail = MarketingDetailState.Content(it)) }
                .onFailure { state = state.copy(promotionDetail = MarketingDetailState.Error(message(it))) }
        }
    }

    fun savePromotion(id: Long?, draft: PromotionDraft) {
        if (!state.capabilities.canManageCampaigns || state.busyKey != null) return
        val key = if (id == null) "promotion:create" else "promotion:$id:update"
        state = state.copy(busyKey = key, error = null, notice = null)
        viewModelScope.launch {
            runCatching {
                if (id == null) source.createPromotion(draft) else source.updatePromotion(id, draft)
            }.onSuccess { result ->
                state = state.copy(busyKey = null, notice = if (id == null) "تم إنشاء العرض" else "تم حفظ التعديلات")
                loadPromotions(selectId = (result as? Long) ?: id)
            }.onFailure { state = state.copy(busyKey = null, error = message(it)) }
        }
    }

    fun requestPromotionActive(promotion: PromotionSummary, active: Boolean) {
        if (!state.capabilities.canManageCampaigns || state.busyKey != null || promotion.isActive == active) return
        state = state.copy(pendingAction = PendingMarketingAction.PromotionActive(promotion, active))
    }

    fun selectProgram(id: Long?) {
        if (id == null) {
            state = state.copy(selectedProgramId = null, issuedCoupons = MarketingDetailState.None, couponPreview = MarketingDetailState.None)
            return
        }
        val program = state.couponPrograms.firstOrNull { it.id == id } ?: return
        if (!state.scope.acceptsVisibleBranch(program.branchId)) return
        state = state.copy(selectedProgramId = id, issuedCoupons = MarketingDetailState.Loading, couponPreview = MarketingDetailState.None)
        loadIssued(program.id, reset = true)
    }

    fun saveCouponProgram(draft: CouponProgramDraft) {
        if (!state.capabilities.canManageCampaigns || state.busyKey != null) return
        state = state.copy(busyKey = "program:create", error = null, notice = null)
        viewModelScope.launch {
            runCatching { source.createCouponProgram(draft) }
                .onSuccess { id ->
                    state = state.copy(busyKey = null, notice = "تم إنشاء برنامج الكوبونات")
                    loadPrograms(selectId = id)
                }
                .onFailure { state = state.copy(busyKey = null, error = message(it)) }
        }
    }

    fun requestProgramStatus(program: CouponProgram, status: CouponProgramStatus) {
        if (!MarketingPolicy.canManageProgram(program, state.scope, state.capabilities) || state.busyKey != null) return
        if (status !in MarketingPolicy.allowedProgramTransitions(program.status)) return
        state = state.copy(pendingAction = PendingMarketingAction.ProgramStatus(program, status))
    }

    fun requestIssueCoupons(program: CouponProgram, count: Int, customerId: Long?) {
        if (!MarketingPolicy.canManageProgram(program, state.scope, state.capabilities) || count !in 1..500 || state.busyKey != null) return
        state = state.copy(pendingAction = PendingMarketingAction.IssueCoupons(program, count, customerId))
    }

    fun requestVoidCoupon(couponId: Long) {
        if (!state.capabilities.canManageCampaigns || couponId <= 0 || state.busyKey != null) return
        state = state.copy(pendingAction = PendingMarketingAction.VoidCoupon(couponId))
    }

    fun previewCoupon(request: CouponPreviewRequest) {
        if (!state.capabilities.canReadCampaigns || state.busyKey != null) return
        state = state.copy(busyKey = "coupon:preview", couponPreview = MarketingDetailState.Loading, error = null)
        viewModelScope.launch {
            runCatching { source.previewCoupon(request) }
                .onSuccess { state = state.copy(busyKey = null, couponPreview = MarketingDetailState.Content(it)) }
                .onFailure { state = state.copy(busyKey = null, couponPreview = MarketingDetailState.Error(message(it))) }
        }
    }

    fun setAnomalyFilters(code: AnomalyCode?, severity: AnomalySeverity?, includeOverridden: Boolean) {
        state = state.copy(
            anomalyCode = code?.takeIf { it != AnomalyCode.Unknown },
            anomalySeverity = severity?.takeIf { it != AnomalySeverity.Unknown },
            includeOverriddenAnomalies = includeOverridden,
            selectedAnomalyKey = null,
        )
        loadAnomalies(reset = true)
    }

    fun selectAnomaly(anomaly: CatalogAnomaly?) {
        state = state.copy(selectedAnomalyKey = anomaly?.let(MarketingStateFilter::anomalyKey))
    }

    fun loadMoreAnomalies() {
        if (state.anomalies?.hasMore == true) loadAnomalies(reset = false)
    }

    fun loadMoreCoupons() {
        val programId = state.selectedProgramId ?: return
        val page = (state.issuedCoupons as? MarketingDetailState.Content)?.value ?: return
        if (page.hasMore) loadIssued(programId, reset = false)
    }

    fun requestMarkIntentional(anomaly: CatalogAnomaly, justification: String, excludeUntil: String?) {
        if (!state.capabilities.canManageCatalogQuality || state.busyKey != null) return
        if (justification.trim().length !in 10..500 || !MarketingValidation.optionalDate(excludeUntil)) {
            state = state.copy(error = "التبرير أو تاريخ الاستثناء غير صالح")
            return
        }
        state = state.copy(pendingAction = PendingMarketingAction.MarkIntentional(anomaly, justification, excludeUntil))
    }

    fun requestMarkIgnored(anomaly: CatalogAnomaly, justification: String) {
        if (!state.capabilities.canManageCatalogQuality || state.busyKey != null) return
        if (justification.trim().length !in 10..500) {
            state = state.copy(error = "التبرير يجب أن يكون بين 10 و500 حرف")
            return
        }
        state = state.copy(pendingAction = PendingMarketingAction.MarkIgnored(anomaly, justification))
    }

    fun requestClearOverride(anomaly: CatalogAnomaly) {
        if (!state.capabilities.canManageCatalogQuality || state.busyKey != null) return
        state = state.copy(pendingAction = PendingMarketingAction.ClearOverride(anomaly))
    }

    fun dismissConfirmation() {
        if (state.busyKey == null) state = state.copy(pendingAction = null)
    }

    fun confirmPendingAction() {
        val action = state.pendingAction ?: return
        if (state.busyKey != null) return
        state = state.copy(busyKey = action.key, error = null, notice = null)
        viewModelScope.launch {
            runCatching {
                when (action) {
                    is PendingMarketingAction.PromotionActive -> source.setPromotionActive(action.promotion.id, action.active)
                    is PendingMarketingAction.ProgramStatus -> source.setCouponProgramStatus(action.program.id, action.status)
                    is PendingMarketingAction.IssueCoupons -> source.issueCoupons(action.program.id, action.count, action.customerId)
                    is PendingMarketingAction.VoidCoupon -> source.voidCoupon(action.couponId)
                    is PendingMarketingAction.MarkIntentional -> source.markAnomalyIntentional(
                        action.anomaly.variantId,
                        action.anomaly.code,
                        action.justification,
                        action.excludeUntil,
                    )
                    is PendingMarketingAction.MarkIgnored -> source.markAnomalyIgnored(action.anomaly.variantId, action.anomaly.code, action.justification)
                    is PendingMarketingAction.ClearOverride -> source.clearAnomalyOverride(action.anomaly.variantId, action.anomaly.code)
                }
            }.onSuccess { result ->
                val notice = when (action) {
                    is PendingMarketingAction.IssueCoupons -> "تم إصدار ${(result as? List<*>)?.size ?: 0} كوبون"
                    else -> "تم تنفيذ الإجراء"
                }
                state = state.copy(busyKey = null, pendingAction = null, notice = notice)
                when (action) {
                    is PendingMarketingAction.PromotionActive -> loadPromotions(selectId = action.promotion.id)
                    is PendingMarketingAction.ProgramStatus -> loadPrograms(selectId = action.program.id)
                    is PendingMarketingAction.IssueCoupons -> loadIssued(action.program.id, reset = true)
                    is PendingMarketingAction.VoidCoupon -> state.selectedProgramId?.let { loadIssued(it, reset = true) }
                    is PendingMarketingAction.MarkIntentional,
                    is PendingMarketingAction.MarkIgnored,
                    is PendingMarketingAction.ClearOverride,
                    -> loadAnomalies(reset = true)
                }
            }.onFailure { state = state.copy(busyKey = null, pendingAction = null, error = message(it)) }
        }
    }

    private fun loadPromotions(selectId: Long? = state.selectedPromotionId) {
        if (!state.capabilities.canReadCampaigns || state.loading) return
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { source.promotions(state.includeInactivePromotions) }
                .onSuccess { rows ->
                    val validSelection = selectId?.takeIf { id -> rows.any { it.id == id } }
                    state = state.copy(loading = false, promotions = rows, promotionsLoaded = true, selectedPromotionId = validSelection)
                    validSelection?.let(::selectPromotion)
                }
                .onFailure { state = state.copy(loading = false, promotionsLoaded = true, error = message(it)) }
        }
    }

    private fun loadPrograms(selectId: Long? = state.selectedProgramId) {
        if (!state.capabilities.canReadCampaigns || state.loading) return
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { source.couponPrograms() }
                .onSuccess { rows ->
                    val validSelection = selectId?.takeIf { id -> rows.any { it.id == id } }
                    state = state.copy(loading = false, couponPrograms = rows, programsLoaded = true, selectedProgramId = validSelection)
                    validSelection?.let(::selectProgram)
                }
                .onFailure { state = state.copy(loading = false, programsLoaded = true, error = message(it)) }
        }
    }

    private fun loadIssued(programId: Long, reset: Boolean) {
        if (state.loadingMore) return
        val previous = (state.issuedCoupons as? MarketingDetailState.Content)?.value
        val offset = if (reset) 0 else previous?.let { it.offset + it.rows.size } ?: 0
        if (reset) state = state.copy(issuedCoupons = MarketingDetailState.Loading)
        else state = state.copy(loadingMore = true)
        viewModelScope.launch {
            runCatching { source.issuedCoupons(programId, offset) }
                .onSuccess { page ->
                    val merged = if (!reset && previous != null) page.copy(rows = previous.rows + page.rows, offset = 0) else page
                    state = state.copy(loadingMore = false, issuedCoupons = MarketingDetailState.Content(merged))
                }
                .onFailure { state = state.copy(loadingMore = false, issuedCoupons = MarketingDetailState.Error(message(it))) }
        }
    }

    private fun loadAnomalies(reset: Boolean) {
        if (!state.capabilities.canReadCatalogQuality || state.loading || state.loadingMore) return
        val previous = state.anomalies
        val offset = if (reset) 0 else previous?.let { it.offset + it.findings.size } ?: 0
        state = if (reset) state.copy(loading = true, error = null) else state.copy(loadingMore = true)
        viewModelScope.launch {
            val query = CatalogAnomalyQuery(
                includeOverridden = state.includeOverriddenAnomalies,
                codes = state.anomalyCode?.let(::setOf) ?: emptySet(),
                severities = state.anomalySeverity?.let(::setOf) ?: emptySet(),
                offset = offset,
            )
            runCatching { source.catalogAnomalies(query) }
                .onSuccess { page ->
                    val merged = if (!reset && previous != null) page.copy(findings = previous.findings + page.findings, offset = 0) else page
                    state = state.copy(loading = false, loadingMore = false, anomalies = merged, anomaliesLoaded = true)
                }
                .onFailure { state = state.copy(loading = false, loadingMore = false, anomaliesLoaded = true, error = message(it)) }
        }
    }

    private fun message(error: Throwable): String = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال الطلب"
}

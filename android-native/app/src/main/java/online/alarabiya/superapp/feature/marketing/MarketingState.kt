package online.alarabiya.superapp.feature.marketing

import online.alarabiya.superapp.model.marketing.AnomalyCode
import online.alarabiya.superapp.model.marketing.AnomalySeverity
import online.alarabiya.superapp.model.marketing.CatalogAnomaly
import online.alarabiya.superapp.model.marketing.CatalogAnomalyPage
import online.alarabiya.superapp.model.marketing.CouponPreview
import online.alarabiya.superapp.model.marketing.CouponProgram
import online.alarabiya.superapp.model.marketing.CouponProgramStatus
import online.alarabiya.superapp.model.marketing.IssuedCouponPage
import online.alarabiya.superapp.model.marketing.MarketingCapabilities
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.marketing.MarketingSection
import online.alarabiya.superapp.model.marketing.PromotionDetail
import online.alarabiya.superapp.model.marketing.PromotionSummary

sealed interface MarketingDetailState<out T> {
    data object None : MarketingDetailState<Nothing>
    data object Loading : MarketingDetailState<Nothing>
    data class Content<T>(val value: T) : MarketingDetailState<T>
    data class Error(val message: String) : MarketingDetailState<Nothing>
}

sealed interface PendingMarketingAction {
    val key: String

    data class PromotionActive(val promotion: PromotionSummary, val active: Boolean) : PendingMarketingAction {
        override val key = "promotion:${promotion.id}:$active"
    }

    data class ProgramStatus(val program: CouponProgram, val status: CouponProgramStatus) : PendingMarketingAction {
        override val key = "program:${program.id}:${status.wire}"
    }

    data class IssueCoupons(val program: CouponProgram, val count: Int, val customerId: Long?) : PendingMarketingAction {
        override val key = "issue:${program.id}"
    }

    data class VoidCoupon(val couponId: Long) : PendingMarketingAction {
        override val key = "coupon:$couponId:void"
    }

    data class MarkIntentional(
        val anomaly: CatalogAnomaly,
        val justification: String,
        val excludeUntil: String?,
    ) : PendingMarketingAction {
        override val key = "anomaly:${anomaly.variantId}:${anomaly.code.wire}:intentional"
    }

    data class MarkIgnored(val anomaly: CatalogAnomaly, val justification: String) : PendingMarketingAction {
        override val key = "anomaly:${anomaly.variantId}:${anomaly.code.wire}:ignored"
    }

    data class ClearOverride(val anomaly: CatalogAnomaly) : PendingMarketingAction {
        override val key = "anomaly:${anomaly.variantId}:${anomaly.code.wire}:clear"
    }
}

data class MarketingUiState(
    val scope: MarketingScope,
    val capabilities: MarketingCapabilities,
    val section: MarketingSection = MarketingSection.Promotions,
    val query: String = "",
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val includeInactivePromotions: Boolean = false,
    val promotions: List<PromotionSummary> = emptyList(),
    val promotionsLoaded: Boolean = false,
    val selectedPromotionId: Long? = null,
    val promotionDetail: MarketingDetailState<PromotionDetail> = MarketingDetailState.None,
    val couponPrograms: List<CouponProgram> = emptyList(),
    val programsLoaded: Boolean = false,
    val selectedProgramId: Long? = null,
    val issuedCoupons: MarketingDetailState<IssuedCouponPage> = MarketingDetailState.None,
    val couponPreview: MarketingDetailState<CouponPreview> = MarketingDetailState.None,
    val includeOverriddenAnomalies: Boolean = false,
    val anomalyCode: AnomalyCode? = null,
    val anomalySeverity: AnomalySeverity? = null,
    val anomalies: CatalogAnomalyPage? = null,
    val anomaliesLoaded: Boolean = false,
    val selectedAnomalyKey: String? = null,
    val pendingAction: PendingMarketingAction? = null,
    val busyKey: String? = null,
    val error: String? = null,
    val notice: String? = null,
)

object MarketingStateFilter {
    fun promotions(state: MarketingUiState): List<PromotionSummary> {
        val query = state.query.trim()
        return if (query.isEmpty()) state.promotions else state.promotions.filter {
            it.name.contains(query, true) || it.description?.contains(query, true) == true
        }
    }

    fun programs(state: MarketingUiState): List<CouponProgram> {
        val query = state.query.trim()
        return if (query.isEmpty()) state.couponPrograms else state.couponPrograms.filter {
            it.name.contains(query, true) || it.codePrefix.contains(query, true)
        }
    }

    fun anomalies(state: MarketingUiState): List<CatalogAnomaly> {
        val query = state.query.trim()
        val rows = state.anomalies?.findings.orEmpty()
        return if (query.isEmpty()) rows else rows.filter {
            it.productName.contains(query, true) || it.sku.contains(query, true) || it.code.wire.contains(query, true)
        }
    }

    fun anomalyKey(value: CatalogAnomaly): String = "${value.variantId}:${value.code.wire}"
}

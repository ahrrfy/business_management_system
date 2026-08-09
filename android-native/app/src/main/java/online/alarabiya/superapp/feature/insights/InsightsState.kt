package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.InsightsFilter
import online.alarabiya.superapp.model.insights.InsightsSection
import online.alarabiya.superapp.model.insights.ReportInsights
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.insights.SearchInsight
import online.alarabiya.superapp.model.insights.StoreInsights
import online.alarabiya.superapp.model.insights.FinancialReportsInsight
import online.alarabiya.superapp.model.insights.HrReportsInsight

data class InsightsUiState(
    val section: InsightsSection,
    val filter: InsightsFilter = InsightsFilter(),
    val loadedSections: Set<InsightsSection> = emptySet(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val searching: Boolean = false,
    val reports: ReportInsights? = null,
    val store: StoreInsights? = null,
    val financial: FinancialReportsInsight? = null,
    val hrReports: HrReportsInsight? = null,
    val reportCatalog: ReportCatalogUiState = ReportCatalogUiState(),
    val searchQuery: String = "",
    val enabledScopes: Set<SearchEntityType> = emptySet(),
    val searchResults: List<SearchInsight> = emptyList(),
    val selectedTarget: InsightTarget? = null,
    val focusedAlertKey: String? = null,
    val error: String? = null,
    val notice: String? = null,
) {
    val selectedSearchResult: SearchInsight?
        get() = searchResults.firstOrNull { it.target == selectedTarget }

    fun select(target: InsightTarget?): InsightsUiState =
        if (target == null || searchResults.any { it.target == target }) copy(selectedTarget = target) else this

    fun loaded(section: InsightsSection): InsightsUiState = copy(
        loadedSections = loadedSections + section,
        loading = false,
        refreshing = false,
        error = null,
    )

    fun failed(message: String): InsightsUiState = copy(
        loading = false,
        refreshing = false,
        searching = false,
        error = message,
    )
}

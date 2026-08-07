package online.alarabiya.superapp.feature.insights

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.InsightsDataSource
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.InsightsAccessPolicy
import online.alarabiya.superapp.model.insights.InsightsFilter
import online.alarabiya.superapp.model.insights.InsightsSection
import online.alarabiya.superapp.model.insights.PeriodPreset
import online.alarabiya.superapp.model.insights.SearchEntityType

class InsightsViewModel(
    private val repository: InsightsDataSource,
    val accessPolicy: InsightsAccessPolicy,
) : ViewModel() {
    var state by mutableStateOf(
        InsightsUiState(
            section = accessPolicy.readableSections.firstOrNull() ?: InsightsSection.SEARCH,
            enabledScopes = accessPolicy.searchScopes,
        ),
    )
        private set

    init {
        if (state.section != InsightsSection.SEARCH && accessPolicy.canRead(state.section)) load(state.section)
    }

    fun setSection(section: InsightsSection) {
        if (!accessPolicy.canRead(section) || section == state.section) return
        state = state.copy(section = section, selectedTarget = null, error = null, notice = null)
        if (section != InsightsSection.SEARCH && section !in state.loadedSections) load(section)
    }

    fun refresh() {
        if (state.section == InsightsSection.SEARCH) submitSearch() else load(state.section, refresh = true)
    }

    fun setPreset(preset: PeriodPreset) {
        state = state.copy(
            filter = state.filter.copy(
                preset = preset,
                range = if (preset == PeriodPreset.CUSTOM) state.filter.range else InsightDateRange.forPreset(preset),
            ),
            error = null,
        )
    }

    fun setFrom(value: String) = updateFilter {
        copy(preset = PeriodPreset.CUSTOM, range = range.copy(from = value.take(10)))
    }

    fun setTo(value: String) = updateFilter {
        copy(preset = PeriodPreset.CUSTOM, range = range.copy(to = value.take(10)))
    }

    fun setBranch(value: String) {
        if (accessPolicy.canFilterBranch) updateFilter { copy(branchId = value.filter(Char::isDigit)) }
    }

    fun setRankBy(value: String) {
        if (value in setOf("revenue", "qty")) updateFilter { copy(rankBy = value) }
    }

    fun applyFilter() {
        if (state.section == InsightsSection.SEARCH) return
        val error = state.filter.validationError(forStore = state.section == InsightsSection.STORE)
        if (error != null) {
            state = state.copy(error = error)
            return
        }
        load(state.section, refresh = state.loadedSections.contains(state.section))
    }

    fun setSearchQuery(value: String) {
        state = state.copy(searchQuery = value.take(200), error = null)
    }

    fun toggleScope(scope: SearchEntityType) {
        if (scope !in accessPolicy.searchScopes || state.searching) return
        state = state.copy(
            enabledScopes = if (scope in state.enabledScopes) state.enabledScopes - scope else state.enabledScopes + scope,
            selectedTarget = null,
            error = null,
        )
    }

    fun submitSearch() {
        if (state.searching || !accessPolicy.canRead(InsightsSection.SEARCH)) return
        val clean = state.searchQuery.trim()
        when {
            clean.isEmpty() -> state = state.copy(error = "أدخل عبارة بحث")
            state.enabledScopes.isEmpty() -> state = state.copy(error = "اختر نوعاً واحداً على الأقل")
            else -> {
                state = state.copy(searching = true, error = null, notice = null, selectedTarget = null)
                viewModelScope.launch {
                    runCatching { repository.search(clean, state.enabledScopes) }
                        .onSuccess { rows ->
                            state = state.copy(
                                searching = false,
                                searchResults = rows,
                                notice = if (rows.isEmpty()) "لا توجد نتائج مطابقة" else null,
                            )
                        }
                        .onFailure { state = state.failed(it.userMessage()) }
                }
            }
        }
    }

    fun selectSearchResult(target: InsightTarget?) {
        state = state.select(target)
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private fun updateFilter(transform: InsightsFilter.() -> InsightsFilter) {
        if (!state.loading && !state.refreshing) state = state.copy(filter = state.filter.transform(), error = null)
    }

    private fun load(section: InsightsSection, refresh: Boolean = false) {
        if (!accessPolicy.canRead(section) || state.loading || state.refreshing) return
        val filter = state.filter
        val validation = filter.validationError(forStore = section == InsightsSection.STORE)
        if (validation != null) {
            state = state.copy(error = validation)
            return
        }
        state = state.copy(loading = !refresh, refreshing = refresh, error = null, notice = null)
        viewModelScope.launch {
            runCatching {
                when (section) {
                    InsightsSection.REPORTS -> {
                        val branch = if (accessPolicy.canFilterBranch) filter.branchId.toLongOrNull() else accessPolicy.branchId
                        state = state.copy(
                            reports = repository.loadReports(filter.range, branch, filter.rankBy),
                        )
                    }
                    InsightsSection.STORE -> state = state.copy(store = repository.loadStore(filter.range))
                    InsightsSection.SEARCH -> Unit
                }
            }.onSuccess {
                state = state.loaded(section)
                val requested = state.section.takeIf {
                    it != section && it != InsightsSection.SEARCH && it !in state.loadedSections && accessPolicy.canRead(it)
                }
                if (requested != null) load(requested)
            }.onFailure { state = state.failed(it.userMessage()) }
        }
    }
}

private fun Throwable.userMessage(): String = message?.takeIf(String::isNotBlank)
    ?: "تعذّر تحميل التحليلات"

class InsightsViewModelFactory(
    private val repository: InsightsDataSource,
    private val accessPolicy: InsightsAccessPolicy,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        InsightsViewModel(repository, accessPolicy) as T
}

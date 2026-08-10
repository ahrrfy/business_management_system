package online.alarabiya.superapp.feature.insights

import online.alarabiya.superapp.model.insights.CashOrphanCategory
import online.alarabiya.superapp.model.insights.ReportCatalogKind
import online.alarabiya.superapp.model.insights.ReportCatalogQuery
import online.alarabiya.superapp.model.insights.ReportCatalogResult

data class ReportCatalogUiState(
    val selected: ReportCatalogKind? = null,
    val search: String = "",
    val variantId: String = "",
    val orphanCategory: CashOrphanCategory = CashOrphanCategory.ALL,
    val page: Int = 0,
    val loading: Boolean = false,
    val loadingRequest: ReportCatalogQuery? = null,
    val loadedFingerprint: String? = null,
    val result: ReportCatalogResult? = null,
    val error: String? = null,
) {
    fun select(kind: ReportCatalogKind?): ReportCatalogUiState = copy(
        selected = kind,
        search = "",
        variantId = "",
        orphanCategory = CashOrphanCategory.ALL,
        page = 0,
        loading = false,
        loadingRequest = null,
        loadedFingerprint = null,
        result = null,
        error = null,
    )

    fun invalidate(): ReportCatalogUiState = copy(
        page = 0,
        loading = false,
        loadingRequest = null,
        loadedFingerprint = null,
        result = null,
        error = null,
    )

    fun loading(query: ReportCatalogQuery): ReportCatalogUiState = copy(
        page = query.page,
        loading = true,
        loadingRequest = query,
        result = result.takeIf { loadedFingerprint == query.fingerprint() },
        error = null,
    )

    fun loaded(query: ReportCatalogQuery, value: ReportCatalogResult): ReportCatalogUiState {
        if (loadingRequest != query || selected != value.kind) return this
        return copy(
            page = query.page,
            loading = false,
            loadingRequest = null,
            loadedFingerprint = query.fingerprint(),
            result = value,
            error = null,
        )
    }

    fun failed(query: ReportCatalogQuery, message: String): ReportCatalogUiState {
        if (loadingRequest != query) return this
        return copy(
            loading = false,
            loadingRequest = null,
            result = result.takeIf { loadedFingerprint == query.fingerprint() },
            error = message,
        )
    }
}

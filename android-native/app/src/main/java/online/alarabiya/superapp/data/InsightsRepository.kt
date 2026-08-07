package online.alarabiya.superapp.data

import java.time.LocalDate
import java.time.temporal.ChronoUnit
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.insights.AlertSeverity
import online.alarabiya.superapp.model.insights.CategoryProfitInsight
import online.alarabiya.superapp.model.insights.FunnelStep
import online.alarabiya.superapp.model.insights.GovernorateInsight
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightMoney
import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.ManagementAlert
import online.alarabiya.superapp.model.insights.PercentText
import online.alarabiya.superapp.model.insights.ReportInsights
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.insights.SearchInsight
import online.alarabiya.superapp.model.insights.SlowMoverInsight
import online.alarabiya.superapp.model.insights.StoreInsights
import online.alarabiya.superapp.model.insights.StoreKpis
import online.alarabiya.superapp.model.insights.StoreProductInsight
import online.alarabiya.superapp.model.insights.StoreTrendPoint
import online.alarabiya.superapp.model.insights.TopProductInsight
import org.json.JSONArray
import org.json.JSONObject

data class ManagementAlertPayload(
    val key: String,
    val severity: String,
    val title: String,
    val count: Int,
    val amount: String?,
    val actionLabel: String,
)

data class TopProductPayload(
    val productId: Long,
    val productName: String,
    val categoryName: String?,
    val qtySold: String,
    val revenue: String,
    val profit: String,
    val marginPct: String,
    val invoicesCount: Int,
)

data class CategoryProfitPayload(
    val categoryId: Long?,
    val categoryName: String,
    val revenue: String,
    val cost: String,
    val profit: String,
    val marginPct: String,
    val itemsCount: Int,
)

data class SearchPayload(
    val type: String,
    val id: Long,
    val title: String,
    val subtitle: String?,
    val meta: String?,
    val rank: Int,
)

object InsightsMapper {
    fun alert(payload: ManagementAlertPayload): ManagementAlert? {
        if (payload.key.isBlank()) return null
        val severity = when (payload.severity.lowercase()) {
            "critical" -> AlertSeverity.CRITICAL
            "warning" -> AlertSeverity.WARNING
            "info" -> AlertSeverity.INFO
            else -> return null
        }
        return ManagementAlert(
            key = payload.key,
            severity = severity,
            title = payload.title,
            count = payload.count.coerceAtLeast(0),
            amount = payload.amount?.let { InsightMoney.fromServer(it) },
            actionLabel = payload.actionLabel,
        )
    }

    fun topProduct(payload: TopProductPayload): TopProductInsight? {
        if (payload.productId <= 0) return null
        return TopProductInsight(
            productId = payload.productId,
            name = payload.productName,
            category = payload.categoryName,
            quantity = payload.qtySold,
            revenue = InsightMoney.fromServer(payload.revenue),
            profit = InsightMoney.fromServer(payload.profit),
            margin = PercentText.fromPercent(payload.marginPct),
            invoiceCount = payload.invoicesCount,
        )
    }

    fun category(payload: CategoryProfitPayload): CategoryProfitInsight = CategoryProfitInsight(
        categoryId = payload.categoryId,
        name = payload.categoryName,
        revenue = InsightMoney.fromServer(payload.revenue),
        cost = InsightMoney.fromServer(payload.cost),
        profit = InsightMoney.fromServer(payload.profit),
        margin = PercentText.fromPercent(payload.marginPct),
        itemCount = payload.itemsCount,
    )

    fun search(payload: SearchPayload, allowedScopes: Set<SearchEntityType>): SearchInsight? {
        val type = SearchEntityType.entries.firstOrNull { it.name == payload.type } ?: return null
        if (type !in allowedScopes || payload.id <= 0) return null
        return SearchInsight(
            target = InsightTarget(type, payload.id),
            title = payload.title,
            subtitle = payload.subtitle,
            meta = payload.meta,
            rank = payload.rank,
        )
    }
}

interface InsightsDataSource {
    suspend fun loadReports(range: InsightDateRange, branchId: Long?, rankBy: String): ReportInsights
    suspend fun loadStore(range: InsightDateRange): StoreInsights
    suspend fun search(query: String, scopes: Set<SearchEntityType>): List<SearchInsight>
}

/**
 * Native read facade for reports, store analytics and global search.
 *
 * Contract gaps (2026-08-06):
 * - none of these routers exposes a file export or signed download URL; native export is intentionally absent.
 * - report list endpoints are limit-based without a cursor/count contract. A full page is marked as possibly
 *   truncated instead of claiming completeness.
 * - global search has only a per-entity cap (max 20), no cursor, and returns desktop `route` strings. Those
 *   strings are ignored; navigation is derived only from validated entity type + numeric id.
 * - elevated global search always spans branches, and store analytics offers no branch input. The native UI
 *   does not present branch filters that the endpoint cannot enforce.
 * - no permission-scoped branch directory is exposed by these contracts; the optional administrator report
 *   filter accepts a validated numeric branch id until such a directory exists.
 * - bootstrap exposes effective module levels but not explicit-grant provenance required by reportViewerProcedure
 *   for nonstandard roles. Report screens therefore use the conservative standard-role policy.
 */
class InsightsRepository(private val api: TrpcClient) : InsightsDataSource {
    override suspend fun loadReports(
        range: InsightDateRange,
        branchId: Long?,
        rankBy: String,
    ): ReportInsights {
        require(range.validationError() == null) { range.validationError().orEmpty() }
        require(rankBy in setOf("revenue", "qty")) { "أسلوب الترتيب غير صالح" }
        val branch = JSONObject().apply { branchId?.let { put("branchId", it) } }
        val dated = JSONObject(branch.toString()).put("from", range.from).put("to", range.to)
        val topInput = JSONObject(dated.toString()).put("limit", REPORT_LIMIT).put("by", rankBy)
        val slowDays = (ChronoUnit.DAYS.between(LocalDate.parse(range.from), LocalDate.parse(range.to)) + 1)
            .coerceIn(1, 365)
        val slowInput = JSONObject(branch.toString()).put("sinceDays", slowDays).put("limit", REPORT_LIMIT)

        val alertJson = api.query("reports.managementAlerts", branch)
        val topJson = api.queryArray("reports.topProducts", topInput)
        val categoryJson = api.queryArray("reports.profitByCategory", dated)
        val slowJson = api.queryArray("reports.slowMovers", slowInput)

        val alerts = alertJson.optJSONArray("alerts").objects()
            .mapNotNull { InsightsMapper.alert(it.toAlertPayload()) }
        val top = topJson.objects().mapNotNull { InsightsMapper.topProduct(it.toTopPayload()) }
        val categories = categoryJson.objects().map { InsightsMapper.category(it.toCategoryPayload()) }
        val slow = slowJson.objects().mapNotNull(JSONObject::toSlowMover)
        return ReportInsights(
            alerts = alerts,
            generatedAt = alertJson.optString("generatedAt"),
            topProducts = top,
            categoryProfit = categories,
            slowMovers = slow,
            mayBeTruncated = top.size == REPORT_LIMIT || slow.size == REPORT_LIMIT,
        )
    }

    override suspend fun loadStore(range: InsightDateRange): StoreInsights {
        require(range.validationError(92) == null) { range.validationError(92).orEmpty() }
        val json = api.query(
            "storeAdmin.analytics.summary",
            JSONObject().put("fromYmd", range.from).put("toYmd", range.to),
        )
        val kpis = json.optJSONObject("kpis") ?: JSONObject()
        val funnel = json.optJSONObject("conversionFunnel") ?: JSONObject()
        return StoreInsights(
            from = json.optString("from", range.from),
            to = json.optString("to", range.to),
            kpis = StoreKpis(
                totalOrders = kpis.optInt("totalOrders"),
                activeOrders = kpis.optInt("activeOrders"),
                cancelledOrders = kpis.optInt("cancelledOrders"),
                deliveredOrders = kpis.optInt("deliveredOrders"),
                revenue = InsightMoney.fromServer(kpis.nullableText("revenue")),
                deliveredRevenue = InsightMoney.fromServer(kpis.nullableText("deliveredRevenue")),
                averageOrderValue = InsightMoney.fromServer(kpis.nullableText("aov")),
                fulfillmentRate = PercentText.fromFraction(kpis.nullableText("fulfillmentRate")),
                cancellationRate = PercentText.fromFraction(kpis.nullableText("cancellationRate")),
            ),
            trend = json.optJSONArray("trend").objects().map {
                StoreTrendPoint(
                    date = it.optString("ymd"),
                    orders = it.optInt("orders"),
                    revenue = InsightMoney.fromServer(it.nullableText("revenue")),
                )
            },
            statusBreakdown = json.optJSONObject("statusBreakdown").intMap(),
            topProducts = json.optJSONArray("topProducts").objects().mapNotNull(JSONObject::toStoreProduct),
            byGovernorate = json.optJSONArray("byGovernorate").objects().map {
                GovernorateInsight(
                    name = it.optString("governorate"),
                    orders = it.optInt("orders"),
                    revenue = InsightMoney.fromServer(it.nullableText("revenue")),
                )
            },
            funnel = listOf(
                FunnelStep("views", "مشاهدات المنتجات", funnel.optInt("productViews"), null),
                FunnelStep("cart", "الإضافة للسلة", funnel.optInt("cartAdds"), PercentText.fromFraction(funnel.nullableText("viewToCartRate"))),
                FunnelStep("checkout", "بدء الدفع", funnel.optInt("checkoutStarts"), PercentText.fromFraction(funnel.nullableText("cartToCheckoutRate"))),
                FunnelStep("orders", "طلبات مكتملة", funnel.optInt("completedOrders"), PercentText.fromFraction(funnel.nullableText("checkoutToOrderRate"))),
            ),
        )
    }

    override suspend fun search(query: String, scopes: Set<SearchEntityType>): List<SearchInsight> {
        val clean = query.trim()
        require(clean.isNotEmpty()) { "أدخل عبارة بحث" }
        require(clean.length <= 200) { "عبارة البحث طويلة جداً" }
        if (scopes.isEmpty()) return emptyList()
        val input = JSONObject()
            .put("query", clean)
            .put("scopes", JSONArray(scopes.map { it.name }))
            .put("perEntityLimit", SEARCH_LIMIT)
        return api.queryArray("globalSearch.search", input).objects()
            .mapNotNull { InsightsMapper.search(it.toSearchPayload(), scopes) }
            .sortedBy(SearchInsight::rank)
    }

    private companion object {
        const val REPORT_LIMIT = 50
        const val SEARCH_LIMIT = 8
    }
}

private fun JSONObject.toAlertPayload() = ManagementAlertPayload(
    key = optString("key"),
    severity = optString("severity"),
    title = optString("title"),
    count = optInt("count"),
    amount = nullableText("amount"),
    actionLabel = optString("actionLabel"),
)

private fun JSONObject.toTopPayload() = TopProductPayload(
    productId = optLong("productId"),
    productName = optString("productName"),
    categoryName = nullableText("categoryName"),
    qtySold = optString("qtySold", "0"),
    revenue = optString("revenue", "0"),
    profit = optString("profit", "0"),
    marginPct = optString("marginPct", "0"),
    invoicesCount = optInt("invoicesCount"),
)

private fun JSONObject.toCategoryPayload() = CategoryProfitPayload(
    categoryId = nullableLong("categoryId"),
    categoryName = optString("categoryName"),
    revenue = optString("revenue", "0"),
    cost = optString("cost", "0"),
    profit = optString("profit", "0"),
    marginPct = optString("marginPct", "0"),
    itemsCount = optInt("itemsCount"),
)

private fun JSONObject.toSlowMover(): SlowMoverInsight? {
    val id = optLong("productId").takeIf { it > 0 } ?: return null
    return SlowMoverInsight(
        productId = id,
        name = optString("productName"),
        category = nullableText("categoryName"),
        quantityInStock = optString("qtyInStock", "0"),
        lastSaleDate = nullableText("lastSaleDate"),
        daysSinceLastSale = nullableInt("daysSinceLastSale"),
    )
}

private fun JSONObject.toStoreProduct(): StoreProductInsight? {
    val id = optLong("productId").takeIf { it > 0 } ?: return null
    return StoreProductInsight(
        productId = id,
        name = optString("name"),
        quantity = optInt("qty"),
        revenue = InsightMoney.fromServer(nullableText("revenue")),
    )
}

private fun JSONObject.toSearchPayload() = SearchPayload(
    type = optString("type"),
    id = optLong("id"),
    title = optString("title"),
    subtitle = nullableText("subtitle"),
    meta = nullableText("meta"),
    rank = optInt("rank"),
)

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}

private fun JSONObject?.intMap(): Map<String, Int> = buildMap {
    if (this@intMap == null) return@buildMap
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        put(key, optInt(key))
    }
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it != 0L }

private fun JSONObject.nullableInt(key: String): Int? =
    if (!has(key) || isNull(key)) null else optInt(key)

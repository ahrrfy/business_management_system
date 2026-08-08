package online.alarabiya.superapp.feature.insights

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.TrendingUp
import androidx.compose.material.icons.rounded.Analytics
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Storefront
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.insights.AlertSeverity
import online.alarabiya.superapp.model.insights.CategoryProfitInsight
import online.alarabiya.superapp.model.insights.FunnelStep
import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.InsightsAccessPolicy
import online.alarabiya.superapp.model.insights.InsightsSection
import online.alarabiya.superapp.model.insights.ManagementAlert
import online.alarabiya.superapp.model.insights.PeriodPreset
import online.alarabiya.superapp.model.insights.ReportInsights
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.insights.SearchInsight
import online.alarabiya.superapp.model.insights.StoreInsights
import online.alarabiya.superapp.model.insights.TopProductInsight
import online.alarabiya.superapp.ui.ltrInputTextStyle

private val InsightNavy = Color(0xFF362087)
private val InsightBlue = Color(0xFF5B36D2)
private val InsightTeal = Color(0xFF7254DB)
private val InsightAmber = Color(0xFFEC2F86)

@Composable
fun InsightsRoute(
    viewModel: InsightsViewModel,
    onOpenTarget: (InsightTarget) -> Unit,
    canOpenTarget: (InsightTarget) -> Boolean = { true },
    modifier: Modifier = Modifier,
) {
    InsightsScreen(
        state = viewModel.state,
        policy = viewModel.accessPolicy,
        onSection = viewModel::setSection,
        onRefresh = viewModel::refresh,
        onPreset = viewModel::setPreset,
        onFrom = viewModel::setFrom,
        onTo = viewModel::setTo,
        onBranch = viewModel::setBranch,
        onRank = viewModel::setRankBy,
        onApply = viewModel::applyFilter,
        onSearchQuery = viewModel::setSearchQuery,
        onToggleScope = viewModel::toggleScope,
        onSearch = viewModel::submitSearch,
        onSelect = viewModel::selectSearchResult,
        onOpenTarget = onOpenTarget,
        canOpenTarget = canOpenTarget,
        onClearMessage = viewModel::clearMessage,
        modifier = modifier,
    )
}

@Composable
fun InsightsScreen(
    state: InsightsUiState,
    policy: InsightsAccessPolicy,
    onSection: (InsightsSection) -> Unit,
    onRefresh: () -> Unit,
    onPreset: (PeriodPreset) -> Unit,
    onFrom: (String) -> Unit,
    onTo: (String) -> Unit,
    onBranch: (String) -> Unit,
    onRank: (String) -> Unit,
    onApply: () -> Unit,
    onSearchQuery: (String) -> Unit,
    onToggleScope: (SearchEntityType) -> Unit,
    onSearch: () -> Unit,
    onSelect: (InsightTarget?) -> Unit,
    onOpenTarget: (InsightTarget) -> Unit,
    canOpenTarget: (InsightTarget) -> Boolean = { true },
    onClearMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(modifier.fillMaxSize()) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                InsightsHeader(state, onRefresh)
                InsightsTabs(policy.readableSections, state.section, onSection)
                AnimatedVisibility(state.notice != null) {
                    InsightMessage(state.notice.orEmpty(), false, onClearMessage)
                }
                AnimatedVisibility(state.error != null && !state.loading) {
                    InsightMessage(state.error.orEmpty(), true, onClearMessage)
                }
                if (state.section != InsightsSection.SEARCH) FilterPanel(
                    state = state,
                    policy = policy,
                    onPreset = onPreset,
                    onFrom = onFrom,
                    onTo = onTo,
                    onBranch = onBranch,
                    onRank = onRank,
                    onApply = onApply,
                )
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val wide = maxWidth >= 760.dp
                    when {
                        !policy.canRead(state.section) -> EmptyInsight("لا تملك صلاحية الوصول", Modifier.fillMaxSize())
                        state.loading -> LoadingInsight()
                        state.section == InsightsSection.REPORTS -> ReportsContent(state.reports, wide)
                        state.section == InsightsSection.STORE -> StoreContent(state.store, wide)
                        else -> SearchContent(
                            state = state,
                            policy = policy,
                            wide = wide,
                            onQuery = onSearchQuery,
                            onToggleScope = onToggleScope,
                            onSearch = onSearch,
                            onSelect = onSelect,
                            onOpenTarget = onOpenTarget,
                            canOpenTarget = canOpenTarget,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun InsightsHeader(state: InsightsUiState, onRefresh: () -> Unit) {
    Surface(
        color = InsightNavy,
        contentColor = Color.White,
        shape = RoundedCornerShape(bottomStart = 52.dp, bottomEnd = 18.dp),
        shadowElevation = 8.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(50.dp).background(Color.White.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Analytics, contentDescription = null)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("مركز الرؤية", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    "صورة مركّزة لأداء الأعمال وما يحتاج انتباهك",
                    color = Color.White.copy(alpha = .68f),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            IconButton(onClick = onRefresh, enabled = !state.refreshing && !state.searching) {
                if (state.refreshing || state.searching) CircularProgressIndicator(
                    Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White,
                ) else Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
            }
        }
    }
}

@Composable
private fun InsightsTabs(
    available: Set<InsightsSection>,
    selected: InsightsSection,
    onSection: (InsightsSection) -> Unit,
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(InsightsSection.entries.filter(available::contains)) { section ->
            FilterChip(
                selected = selected == section,
                onClick = { onSection(section) },
                label = { Text(section.label) },
                leadingIcon = { Icon(section.icon(), null, Modifier.size(18.dp)) },
            )
        }
    }
}

@Composable
private fun FilterPanel(
    state: InsightsUiState,
    policy: InsightsAccessPolicy,
    onPreset: (PeriodPreset) -> Unit,
    onFrom: (String) -> Unit,
    onTo: (String) -> Unit,
    onBranch: (String) -> Unit,
    onRank: (String) -> Unit,
    onApply: () -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
        shape = RoundedCornerShape(topStart = 24.dp, bottomEnd = 24.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(PeriodPreset.entries) { preset ->
                    FilterChip(state.filter.preset == preset, { onPreset(preset) }, { Text(preset.label) })
                }
            }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                if (maxWidth < 520.dp) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        InsightDateField(state.filter.range.from, onFrom, "من", Modifier.fillMaxWidth())
                        InsightDateField(state.filter.range.to, onTo, "إلى", Modifier.fillMaxWidth())
                        Button(
                            onClick = onApply,
                            enabled = !state.refreshing,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text("تطبيق") }
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        InsightDateField(state.filter.range.from, onFrom, "من", Modifier.weight(1f))
                        InsightDateField(state.filter.range.to, onTo, "إلى", Modifier.weight(1f))
                        Button(onClick = onApply, enabled = !state.refreshing, modifier = Modifier.heightIn(min = 48.dp)) { Text("تطبيق") }
                    }
                }
            }
            if (state.section == InsightsSection.REPORTS) {
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    if (maxWidth < 600.dp) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (policy.canFilterBranch) InsightBranchField(state.filter.branchId, onBranch, Modifier.fillMaxWidth())
                            LazyRow(
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 2.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                item { FilterChip(state.filter.rankBy == "revenue", { onRank("revenue") }, { Text("حسب الإيراد") }) }
                                item { FilterChip(state.filter.rankBy == "qty", { onRank("qty") }, { Text("حسب الكمية") }) }
                            }
                        }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (policy.canFilterBranch) InsightBranchField(state.filter.branchId, onBranch, Modifier.weight(1f))
                            FilterChip(state.filter.rankBy == "revenue", { onRank("revenue") }, { Text("حسب الإيراد") })
                            FilterChip(state.filter.rankBy == "qty", { onRank("qty") }, { Text("حسب الكمية") })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InsightDateField(value: String, onValue: (String) -> Unit, label: String, modifier: Modifier) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text(label) },
        singleLine = true,
        modifier = modifier,
        textStyle = ltrInputTextStyle(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
    )
}

@Composable
private fun InsightBranchField(value: String, onValue: (String) -> Unit, modifier: Modifier) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text("معرّف الفرع (اختياري)") },
        singleLine = true,
        modifier = modifier,
        textStyle = ltrInputTextStyle(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun ReportsContent(reports: ReportInsights?, wide: Boolean) {
    if (reports == null) {
        EmptyInsight("لا تتوفر مؤشرات للفترة الحالية", Modifier.fillMaxSize())
        return
    }
    if (wide) Row(
        Modifier.fillMaxSize().padding(18.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        AlertsPanel(reports.alerts, Modifier.weight(.38f).fillMaxHeight())
        ReportLists(reports, Modifier.weight(.62f).fillMaxHeight())
    } else LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item { SectionTitle("تحتاج المتابعة الآن", reports.alerts.size.toString()) }
        items(reports.alerts, key = ManagementAlert::key) { AlertCard(it) }
        item { SectionTitle("الأكثر مبيعاً", reports.topProducts.size.toString()) }
        items(reports.topProducts, key = TopProductInsight::productId) { ProductCard(it) }
        item { SectionTitle("ربحية الفئات", reports.categoryProfit.size.toString()) }
        items(reports.categoryProfit, key = { it.categoryId ?: it.name }) { CategoryCard(it) }
        item { SectionTitle("بطيئة الحركة", reports.slowMovers.size.toString()) }
        items(reports.slowMovers, key = { it.productId }) { mover -> SlowMoverCard(mover.name, mover.quantityInStock, mover.daysSinceLastSale) }
        if (reports.mayBeTruncated) item { TruncationNotice() }
    }
}

@Composable
private fun AlertsPanel(alerts: List<ManagementAlert>, modifier: Modifier) {
    Surface(modifier, shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        LazyColumn(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { SectionTitle("تحتاج المتابعة الآن", alerts.size.toString()) }
            if (alerts.isEmpty()) item { EmptyInsight("لا توجد تنبيهات نشطة", Modifier.fillMaxWidth().height(180.dp)) }
            items(alerts, key = ManagementAlert::key) { AlertCard(it) }
        }
    }
}

@Composable
private fun ReportLists(reports: ReportInsights, modifier: Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { SectionTitle("الأكثر مبيعاً", reports.topProducts.size.toString()) }
        items(reports.topProducts, key = TopProductInsight::productId) { ProductCard(it) }
        item { SectionTitle("ربحية الفئات", reports.categoryProfit.size.toString()) }
        items(reports.categoryProfit, key = { it.categoryId ?: it.name }) { CategoryCard(it) }
        item { SectionTitle("بطيئة الحركة", reports.slowMovers.size.toString()) }
        items(reports.slowMovers, key = { it.productId }) { mover -> SlowMoverCard(mover.name, mover.quantityInStock, mover.daysSinceLastSale) }
        if (reports.mayBeTruncated) item { TruncationNotice() }
    }
}

@Composable
private fun AlertCard(alert: ManagementAlert) {
    val color = when (alert.severity) {
        AlertSeverity.CRITICAL -> MaterialTheme.colorScheme.error
        AlertSeverity.WARNING -> InsightAmber
        AlertSeverity.INFO -> InsightBlue
    }
    Card(
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 10.dp, bottomStart = 10.dp, bottomEnd = 24.dp),
        colors = CardDefaults.cardColors(containerColor = color.copy(alpha = .08f)),
    ) {
        Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(color.copy(alpha = .12f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.WarningAmber, null, tint = color)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(alert.title, fontWeight = FontWeight.SemiBold)
                Text("لقطة حالية • ${alert.count} حالة", color = color, style = MaterialTheme.typography.labelMedium)
            }
            alert.amount?.let { Text("${it.value} د.ع", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun ProductCard(item: TopProductInsight) {
    MetricCard(
        icon = Icons.AutoMirrored.Rounded.TrendingUp,
        title = item.name,
        subtitle = listOfNotNull(item.category, "${item.quantity} وحدة", "${item.invoiceCount} فاتورة").joinToString(" • "),
        value = "${item.revenue.value} د.ع",
        foot = "ربح ${item.profit.value} • هامش ${item.margin.value}%",
        color = InsightTeal,
    )
}

@Composable
private fun CategoryCard(item: CategoryProfitInsight) {
    MetricCard(
        icon = Icons.Rounded.Category,
        title = item.name,
        subtitle = "${item.itemCount} بنداً • تكلفة ${item.cost.value}",
        value = "${item.profit.value} د.ع",
        foot = "هامش ${item.margin.value}% من إيراد ${item.revenue.value}",
        color = InsightBlue,
    )
}

@Composable
private fun SlowMoverCard(name: String, stock: String, days: Int?) {
    MetricCard(
        icon = Icons.Rounded.Inventory2,
        title = name,
        subtitle = "الرصيد $stock",
        value = days?.let { "$it يوم" } ?: "بلا بيع",
        foot = "ضمن نافذة التحليل الحالية",
        color = InsightAmber,
    )
}

@Composable
private fun MetricCard(
    icon: ImageVector,
    title: String,
    subtitle: String,
    value: String,
    foot: String,
    color: Color,
) {
    Card(shape = RoundedCornerShape(topStart = 24.dp, bottomEnd = 24.dp)) {
        Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(color.copy(alpha = .10f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = color)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(foot, color = color, style = MaterialTheme.typography.bodySmall)
            }
            Text(value, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun StoreContent(store: StoreInsights?, wide: Boolean) {
    if (store == null) {
        EmptyInsight("لا تتوفر تحليلات للمتجر في هذه الفترة", Modifier.fillMaxSize())
        return
    }
    if (wide) Row(
        Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        StoreOverview(store, Modifier.weight(.45f).fillMaxHeight())
        StoreDetails(store, Modifier.weight(.55f).fillMaxHeight())
    } else LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item { StoreKpiGrid(store) }
        item { StatusPanel(store) }
        item { FunnelPanel(store.funnel) }
        item { TrendPanel(store) }
        item { SectionTitle("أعلى منتجات المتجر", store.topProducts.size.toString()) }
        items(store.topProducts, key = { it.productId }) {
            MetricCard(Icons.Rounded.Storefront, it.name, "${it.quantity} وحدة", "${it.revenue.value} د.ع", "طلبات المتجر غير الملغاة", InsightTeal)
        }
        item { GovernoratesPanel(store) }
    }
}

@Composable
private fun StoreOverview(store: StoreInsights, modifier: Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { StoreKpiGrid(store) }
        item { StatusPanel(store) }
        item { FunnelPanel(store.funnel) }
        item { GovernoratesPanel(store) }
    }
}

@Composable
private fun StoreDetails(store: StoreInsights, modifier: Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { TrendPanel(store) }
        item { SectionTitle("أعلى منتجات المتجر", store.topProducts.size.toString()) }
        items(store.topProducts, key = { it.productId }) {
            MetricCard(Icons.Rounded.Storefront, it.name, "${it.quantity} وحدة", "${it.revenue.value} د.ع", "طلبات المتجر غير الملغاة", InsightTeal)
        }
    }
}

@Composable
private fun StoreKpiGrid(store: StoreInsights) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 30.dp, bottomEnd = 30.dp), color = InsightNavy) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("أداء المتجر", color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KpiTile("الإيراد", "${store.kpis.revenue.value} د.ع", Modifier.weight(1f))
                KpiTile("متوسط الطلب", "${store.kpis.averageOrderValue.value} د.ع", Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KpiTile("الطلبات", store.kpis.totalOrders.toString(), Modifier.weight(1f))
                KpiTile("التنفيذ", "${store.kpis.fulfillmentRate.value}%", Modifier.weight(1f))
                KpiTile("الإلغاء", "${store.kpis.cancellationRate.value}%", Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatusPanel(store: StoreInsights) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionTitle("حالات الطلبات", store.statusBreakdown.values.sum().toString())
            store.statusBreakdown.entries.sortedByDescending { it.value }.forEach { (status, count) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(storeStatusLabel(status), Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(count.toString(), fontWeight = FontWeight.Bold, maxLines = 1)
                }
            }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("إيراد الطلبات المسلّمة", Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${store.kpis.deliveredRevenue.value} د.ع", fontWeight = FontWeight.Bold, color = InsightTeal, maxLines = 1)
            }
        }
    }
}

@Composable
private fun KpiTile(label: String, value: String, modifier: Modifier) {
    Surface(modifier, shape = RoundedCornerShape(16.dp), color = Color.White.copy(alpha = .09f)) {
        Column(Modifier.padding(11.dp)) {
            Text(label, color = Color.White.copy(alpha = .65f), style = MaterialTheme.typography.bodySmall)
            Text(value, color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun FunnelPanel(steps: List<FunnelStep>) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val compact = maxWidth < 420.dp
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionTitle("مسار التحويل", null)
                val maximum = steps.maxOfOrNull(FunnelStep::count)?.coerceAtLeast(1) ?: 1
                steps.forEach { step ->
                    if (compact) {
                        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(step.label, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                FunnelBar(step.count, maximum, Modifier.weight(1f))
                                Spacer(Modifier.width(8.dp))
                                Text(step.count.toString(), fontWeight = FontWeight.Bold, maxLines = 1)
                                step.conversion?.let { Text("  ${it.value}%", color = InsightTeal, style = MaterialTheme.typography.bodySmall, maxLines = 1) }
                            }
                        }
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(step.label, Modifier.weight(.34f), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            FunnelBar(step.count, maximum, Modifier.weight(.66f))
                            Spacer(Modifier.width(8.dp))
                            Text(step.count.toString(), fontWeight = FontWeight.Bold, maxLines = 1)
                            step.conversion?.let { Text("  ${it.value}%", color = InsightTeal, style = MaterialTheme.typography.bodySmall, maxLines = 1) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FunnelBar(count: Int, maximum: Int, modifier: Modifier) {
    Box(modifier.height(9.dp).background(MaterialTheme.colorScheme.outlineVariant, CircleShape)) {
        Box(
            Modifier.fillMaxWidth((count.toFloat() / maximum).coerceIn(0f, 1f))
                .height(9.dp).background(InsightTeal, CircleShape),
        )
    }
}

@Composable
private fun TrendPanel(store: StoreInsights) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 28.dp, bottomEnd = 28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionTitle("الاتجاه اليومي", "${store.from} — ${store.to}")
            val visible = store.trend.takeLast(14)
            val maximum = visible.maxOfOrNull { it.orders }?.coerceAtLeast(1) ?: 1
            visible.forEach { point ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(point.date.takeLast(5), Modifier.width(48.dp), style = MaterialTheme.typography.bodySmall)
                    Box(Modifier.weight(1f).height(8.dp).background(MaterialTheme.colorScheme.outlineVariant, CircleShape)) {
                        Box(
                            Modifier.fillMaxWidth((point.orders.toFloat() / maximum).coerceIn(0f, 1f))
                                .height(8.dp).background(InsightBlue, CircleShape),
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text("${point.orders} • ${point.revenue.value}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun GovernoratesPanel(store: StoreInsights) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(16.dp)) {
            SectionTitle("التوزيع الجغرافي", store.byGovernorate.size.toString())
            store.byGovernorate.take(8).forEachIndexed { index, item ->
                if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(item.name, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${item.orders} طلب • ${item.revenue.value} د.ع", fontWeight = FontWeight.Medium, maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun SearchContent(
    state: InsightsUiState,
    policy: InsightsAccessPolicy,
    wide: Boolean,
    onQuery: (String) -> Unit,
    onToggleScope: (SearchEntityType) -> Unit,
    onSearch: () -> Unit,
    onSelect: (InsightTarget?) -> Unit,
    onOpenTarget: (InsightTarget) -> Unit,
    canOpenTarget: (InsightTarget) -> Boolean,
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 8.dp)) {
        OutlinedTextField(
            value = state.searchQuery,
            onValueChange = onQuery,
            label = { Text("ابحث بالاسم أو الرقم أو الباركود أو الهاتف") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            trailingIcon = {
                if (state.searching) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else IconButton(onClick = onSearch) { Icon(Icons.Rounded.Search, "بحث") }
            },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        LazyRow(
            contentPadding = PaddingValues(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(policy.searchScopes.toList()) { scope ->
                FilterChip(
                    selected = scope in state.enabledScopes,
                    onClick = { onToggleScope(scope) },
                    label = { Text(scope.label) },
                )
            }
        }
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            SearchList(state.searchResults, state.selectedTarget, onSelect, Modifier.weight(.44f).fillMaxHeight())
            Surface(
                Modifier.weight(.56f).fillMaxHeight(),
                shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLow,
            ) { SearchDetail(state.selectedSearchResult, onOpenTarget, canOpenTarget, Modifier.padding(24.dp)) }
        } else AnimatedContent(state.selectedSearchResult, label = "search-detail") { selected ->
            if (selected == null) SearchList(state.searchResults, state.selectedTarget, onSelect, Modifier.fillMaxSize())
            else Column(Modifier.fillMaxSize()) {
                TextButton(onClick = { onSelect(null) }) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, null); Spacer(Modifier.width(6.dp)); Text("النتائج")
                }
                Surface(
                    Modifier.fillMaxSize(),
                    shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                ) { SearchDetail(selected, onOpenTarget, canOpenTarget, Modifier.padding(22.dp)) }
            }
        }
    }
}

@Composable
private fun SearchList(
    rows: List<SearchInsight>,
    selected: InsightTarget?,
    onSelect: (InsightTarget?) -> Unit,
    modifier: Modifier,
) {
    if (rows.isEmpty()) {
        EmptyInsight("ابدأ البحث لعرض نتائج مسموحة حسب صلاحياتك", modifier)
        return
    }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        items(rows, key = { "${it.target.type}-${it.target.id}" }) { result ->
            Card(
                Modifier.fillMaxWidth().clickable { onSelect(result.target) },
                shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (selected == result.target) InsightBlue.copy(alpha = .1f) else MaterialTheme.colorScheme.surface,
                ),
            ) {
                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(40.dp).background(InsightBlue.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) {
                        Icon(result.target.type.icon(), null, tint = InsightBlue)
                    }
                    Spacer(Modifier.width(11.dp))
                    Column(Modifier.weight(1f)) {
                        Text(result.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(result.subtitle ?: result.meta.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Text(result.target.type.label, style = MaterialTheme.typography.bodySmall, color = InsightBlue)
                }
            }
        }
    }
}

@Composable
private fun SearchDetail(
    result: SearchInsight?,
    onOpen: (InsightTarget) -> Unit,
    canOpen: (InsightTarget) -> Boolean,
    modifier: Modifier,
) {
    if (result == null) {
        EmptyInsight("اختر نتيجة لعرضها", modifier.fillMaxSize())
        return
    }
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(58.dp).background(InsightBlue.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(result.target.type.icon(), null, tint = InsightBlue, modifier = Modifier.size(30.dp))
        }
        Text(result.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(result.target.type.label, color = InsightBlue)
        result.subtitle?.let { Text(it) }
        result.meta?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text("المعرّف ${result.target.id}", style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.weight(1f))
        Button(
            onClick = { onOpen(result.target) },
            enabled = canOpen(result.target),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("عرض التفاصيل")
        }
    }
}

@Composable
private fun SectionTitle(title: String, trailing: String?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        trailing?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium, maxLines = 2) }
    }
}

@Composable
private fun TruncationNotice() {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = InsightAmber.copy(alpha = .08f)) {
        Text(
            "بلغت النتائج حدّ العقد الحالي؛ قد توجد سجلات أخرى لا يوفّر لها الخادم مؤشّر صفحة تالية.",
            Modifier.padding(13.dp), color = InsightAmber,
        )
    }
}

@Composable
private fun InsightMessage(message: String, error: Boolean, onDismiss: () -> Unit) {
    val color = if (error) MaterialTheme.colorScheme.error else InsightTeal
    Surface(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), shape = RoundedCornerShape(14.dp), color = color.copy(alpha = .1f)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, Modifier.weight(1f), color = color)
            TextButton(onClick = onDismiss) { Text("إغلاق", color = color) }
        }
    }
}

@Composable private fun LoadingInsight() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
@Composable private fun EmptyInsight(message: String, modifier: Modifier) = Box(modifier, contentAlignment = Alignment.Center) { Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant) }

private fun InsightsSection.icon(): ImageVector = when (this) {
    InsightsSection.REPORTS -> Icons.Rounded.Analytics
    InsightsSection.STORE -> Icons.Rounded.Storefront
    InsightsSection.SEARCH -> Icons.Rounded.Search
}

private fun SearchEntityType.icon(): ImageVector = when (this) {
    SearchEntityType.PRODUCT -> Icons.Rounded.Inventory2
    SearchEntityType.INVOICE, SearchEntityType.QUOTATION, SearchEntityType.PURCHASE_ORDER,
    SearchEntityType.WORK_ORDER, SearchEntityType.EXPENSE -> Icons.Rounded.Analytics
    SearchEntityType.CUSTOMER, SearchEntityType.SUPPLIER, SearchEntityType.EMPLOYEE,
    SearchEntityType.USER -> Icons.Rounded.Search
}

private fun storeStatusLabel(raw: String): String = when (raw.uppercase()) {
    "PENDING" -> "بانتظار المراجعة"
    "CONFIRMED" -> "مؤكد"
    "PROCESSING" -> "قيد التجهيز"
    "SHIPPED" -> "قيد التوصيل"
    "DELIVERED" -> "مسلّم"
    "CANCELLED" -> "ملغي"
    else -> raw
}

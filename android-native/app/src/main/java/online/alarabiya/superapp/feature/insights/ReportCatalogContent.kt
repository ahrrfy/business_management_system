package online.alarabiya.superapp.feature.insights

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.ListAlt
import androidx.compose.material.icons.rounded.LockClock
import androidx.compose.material.icons.rounded.PrecisionManufacturing
import androidx.compose.material.icons.rounded.Print
import androidx.compose.material.icons.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.ShoppingCart
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.insights.CashOrphanCategory
import online.alarabiya.superapp.model.insights.CashOrphansReportInsight
import online.alarabiya.superapp.model.insights.DayCloseReportInsight
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightMoney
import online.alarabiya.superapp.model.insights.InventoryValuationReportInsight
import online.alarabiya.superapp.model.insights.ItemLedgerReportInsight
import online.alarabiya.superapp.model.insights.ProductionReportInsight
import online.alarabiya.superapp.model.insights.PurchaseRegisterReportInsight
import online.alarabiya.superapp.model.insights.ReportCatalogKind
import online.alarabiya.superapp.model.insights.ReportCatalogResult
import online.alarabiya.superapp.model.insights.ReportPageInfo
import online.alarabiya.superapp.model.insights.SalesRegisterReportInsight
import online.alarabiya.superapp.model.insights.WorkOrdersReportInsight
import online.alarabiya.superapp.ui.ltrInputTextStyle

private val CatalogInk = Color(0xFF362087)
private val CatalogAccent = Color(0xFF5B36D2)
private val CatalogPositive = Color(0xFF0E7564)
private val CatalogWarning = Color(0xFFD65A22)

@Composable
internal fun ReportCatalogContent(
    state: ReportCatalogUiState,
    range: InsightDateRange,
    wide: Boolean,
    onSelect: (ReportCatalogKind?) -> Unit,
    onSearch: (String) -> Unit,
    onVariantId: (String) -> Unit,
    onOrphanCategory: (CashOrphanCategory) -> Unit,
    onLoad: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
) {
    if (wide) {
        Row(
            Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            ReportCatalogList(
                selected = state.selected,
                onSelect = onSelect,
                modifier = Modifier.width(310.dp).fillMaxHeight(),
            )
            ReportCatalogDetail(
                state = state,
                range = range,
                onBack = { onSelect(null) },
                showBack = false,
                onSearch = onSearch,
                onVariantId = onVariantId,
                onOrphanCategory = onOrphanCategory,
                onLoad = onLoad,
                onPrevious = onPrevious,
                onNext = onNext,
                modifier = Modifier.weight(1f).fillMaxHeight(),
            )
        }
    } else if (state.selected == null) {
        ReportCatalogGrid(onSelect = onSelect, modifier = Modifier.fillMaxSize())
    } else {
        ReportCatalogDetail(
            state = state,
            range = range,
            onBack = { onSelect(null) },
            showBack = true,
            onSearch = onSearch,
            onVariantId = onVariantId,
            onOrphanCategory = onOrphanCategory,
            onLoad = onLoad,
            onPrevious = onPrevious,
            onNext = onNext,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun ReportCatalogGrid(onSelect: (ReportCatalogKind) -> Unit, modifier: Modifier) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(164.dp),
        modifier = modifier.padding(horizontal = 14.dp),
        contentPadding = PaddingValues(top = 8.dp, bottom = 28.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        gridItems(ReportCatalogKind.entries, key = ReportCatalogKind::name) { kind ->
            ReportCatalogCard(kind, selected = false) { onSelect(kind) }
        }
    }
}

@Composable
private fun ReportCatalogList(
    selected: ReportCatalogKind?,
    onSelect: (ReportCatalogKind) -> Unit,
    modifier: Modifier,
) {
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        items(ReportCatalogKind.entries, key = ReportCatalogKind::name) { kind ->
            ReportCatalogCard(kind, selected == kind) { onSelect(kind) }
        }
    }
}

@Composable
private fun ReportCatalogCard(kind: ReportCatalogKind, selected: Boolean, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 112.dp)
            .testTag("report-catalog-${kind.name.lowercase()}")
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(topStart = 26.dp, bottomEnd = 26.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) CatalogAccent else MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = if (selected) Color.White else MaterialTheme.colorScheme.onSurface,
        ),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(15.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier.size(38.dp).background(
                    if (selected) Color.White.copy(alpha = .14f) else CatalogAccent.copy(alpha = .10f),
                    CircleShape,
                ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(kind.icon(), null, tint = if (selected) Color.White else CatalogAccent)
            }
            Text(kind.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(
                kind.subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = if (selected) Color.White.copy(alpha = .76f) else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ReportCatalogDetail(
    state: ReportCatalogUiState,
    range: InsightDateRange,
    onBack: () -> Unit,
    showBack: Boolean,
    onSearch: (String) -> Unit,
    onVariantId: (String) -> Unit,
    onOrphanCategory: (CashOrphanCategory) -> Unit,
    onLoad: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier,
) {
    val kind = state.selected
    if (kind == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("اختر تقريراً", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(
        modifier = modifier.testTag("report-catalog-detail"),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (showBack) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "العودة إلى التقارير")
                    }
                }
                Box(
                    Modifier.size(46.dp).background(CatalogAccent.copy(alpha = .10f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Icon(kind.icon(), null, tint = CatalogAccent) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(kind.label, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(
                        if (kind == ReportCatalogKind.INVENTORY_VALUATION) "لقطة المخزون الحالية" else "${range.from} — ${range.to}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
        if (kind.supportsSearch) {
            item {
                OutlinedTextField(
                    value = state.search,
                    onValueChange = onSearch,
                    label = { Text("بحث") },
                    leadingIcon = { Icon(Icons.Rounded.Search, null) },
                    singleLine = true,
                    enabled = !state.loading,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (kind.requiresVariant) {
            item {
                OutlinedTextField(
                    value = state.variantId,
                    onValueChange = onVariantId,
                    label = { Text("معرّف متغيّر الصنف") },
                    singleLine = true,
                    enabled = !state.loading,
                    textStyle = ltrInputTextStyle(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (kind == ReportCatalogKind.CASH_ORPHANS) {
            item {
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(CashOrphanCategory.entries, key = CashOrphanCategory::name) { category ->
                        FilterChip(
                            selected = state.orphanCategory == category,
                            onClick = { onOrphanCategory(category) },
                            enabled = !state.loading,
                            label = { Text(category.label) },
                        )
                    }
                }
            }
        }
        item {
            Button(
                onClick = onLoad,
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp).testTag("report-catalog-load"),
            ) {
                if (state.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
                else Text("عرض التقرير")
            }
        }
        state.error?.let { message ->
            item {
                Surface(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.errorContainer,
                ) {
                    Row(
                        Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(message, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
                        TextButton(onClick = onLoad, enabled = !state.loading) { Text("إعادة المحاولة") }
                    }
                }
            }
        }
        when {
            state.loading && state.result == null -> item {
                Box(Modifier.fillMaxWidth().heightIn(min = 170.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.result == null -> item {
                Box(Modifier.fillMaxWidth().heightIn(min = 140.dp), contentAlignment = Alignment.Center) {
                    Text("لم يُحمّل التقرير", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            state.result.isEmpty -> item {
                Box(Modifier.fillMaxWidth().heightIn(min = 140.dp), contentAlignment = Alignment.Center) {
                    Text("لا توجد بيانات ضمن النطاق المحدد", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            else -> {
                item { ReportResultMetrics(state.result) }
                item { ReportResultRows(state.result) }
                state.result.pageInfo?.let { page ->
                    item { ReportPageControls(page, state.loading, onPrevious, onNext) }
                }
            }
        }
    }
}

@Composable
private fun ReportResultMetrics(result: ReportCatalogResult) {
    val metrics = when (result) {
        is DayCloseReportInsight -> listOf(
            "الورديات" to result.totals.shiftCount.toString(),
            "المتوقّع" to result.totals.expected.iqd(),
            "المعدود" to result.totals.counted.iqd(),
            "الفرق" to result.totals.drift.iqd(),
            "العجز" to result.shortCount.toString(),
            "الفائض" to result.overCount.toString(),
        )
        is CashOrphansReportInsight -> listOf(
            "العمليات" to result.count.toString(),
            "داخل" to result.totalIn.iqd(),
            "خارج" to result.totalOut.iqd(),
            "الصافي" to result.net.iqd(),
            "تحتاج فحصاً" to result.trueOrphanCount.toString(),
            "صافي الفحص" to result.trueOrphanNet.iqd(),
        )
        is SalesRegisterReportInsight -> listOf(
            "الإيراد" to result.revenue.iqd(),
            "التكلفة" to result.cost.iqd(),
            "الربح" to result.profit.iqd(),
            "الكمية" to result.quantity,
        )
        is InventoryValuationReportInsight -> listOf(
            "قيمة المخزون" to result.totals.value.iqd(),
            "الأصناف" to result.totals.items.toString(),
            "الكمية" to result.totals.quantity.toString(),
            "بضاعة الأمانة" to result.consignment.value.iqd(),
        )
        is ItemLedgerReportInsight -> listOf(
            "الافتتاحي" to result.openingBalance.toString(),
            "الختامي" to result.closingBalance.toString(),
            "الحركات" to result.pageInfo.total.toString(),
        )
        is PurchaseRegisterReportInsight -> listOf(
            "إجمالي المشتريات" to result.amount.iqd(),
            "البنود" to result.pageInfo.total.toString(),
        )
        is ProductionReportInsight -> listOf(
            "المستندات" to result.count.toString(),
            "المواد" to result.inputsCost.iqd(),
            "العمالة" to result.laborCost.iqd(),
            "الهدر" to result.wasteCost.iqd(),
            "إجمالي التكلفة" to result.totalCost.iqd(),
        )
        is WorkOrdersReportInsight -> listOf(
            "المسلّمة" to result.deliveredCount.toString(),
            "الإيراد" to result.revenue.iqd(),
            "المواد" to result.materials.iqd(),
            "العمالة" to result.labor.iqd(),
            "مجمل الربح" to result.grossProfit.iqd(),
        )
    }
    MetricGrid(metrics)
}

@Composable
private fun MetricGrid(metrics: List<Pair<String, String>>) {
    val largeText = LocalDensity.current.fontScale >= 1.5f
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = when {
            largeText -> 1
            maxWidth >= 700.dp -> 3
            else -> 2
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            metrics.chunked(columns).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (label, value) ->
                        Surface(
                            Modifier.weight(1f).heightIn(min = 82.dp),
                            shape = RoundedCornerShape(topStart = 20.dp, bottomEnd = 20.dp),
                            color = CatalogInk,
                        ) {
                            Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(label, color = Color.White.copy(alpha = .68f), style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    value,
                                    color = Color.White,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun ReportResultRows(result: ReportCatalogResult) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        when (result) {
            is DayCloseReportInsight -> {
                if (result.fundedDraftCount > 0) ReportRow(
                    "عرابين معلّقة",
                    "${result.fundedDraftCount} مسودة",
                    result.fundedDraftAmount.iqd(),
                    CatalogWarning,
                )
                result.shifts.forEach { row ->
                    ReportRow(
                        "وردية #${row.shiftId} — ${row.userName ?: "غير معروف"}",
                        listOfNotNull(row.branchName, row.status, row.openedAt.take(10)).joinToString(" • "),
                        "المتوقّع ${row.expected.iqd()} • الفرق ${row.drift?.iqd() ?: "—"}",
                        if (row.drift?.value == "0.00") CatalogPositive else CatalogWarning,
                    )
                }
                result.discounts.forEach { row ->
                    ReportRow(
                        "خصومات ${row.userName}",
                        "${row.invoiceCount} فاتورة • متوسط ${row.averageRate.value}%",
                        row.manualDiscount.iqd(),
                        CatalogAccent,
                    )
                }
            }
            is CashOrphansReportInsight -> result.rows.forEach { row ->
                ReportRow(
                    "إيصال #${row.receiptId} — ${if (row.direction == "IN") "داخل" else "خارج"}",
                    listOfNotNull(row.branchName, row.createdBy, row.createdAt.take(10)).joinToString(" • "),
                    row.amount.iqd(),
                    if (row.category == CashOrphanCategory.TRUE_ORPHAN) CatalogWarning else CatalogPositive,
                )
            }
            is SalesRegisterReportInsight -> result.rows.forEach { row ->
                ReportRow(
                    "${row.invoiceNumber} — ${row.productName}",
                    listOfNotNull(row.customerName, row.date, "الكمية ${row.quantity}").joinToString(" • "),
                    "${row.total.iqd()} • ربح ${row.profit.iqd()}",
                    CatalogPositive,
                )
            }
            is InventoryValuationReportInsight -> result.rows.forEach { row ->
                ReportRow(
                    row.categoryName,
                    "${row.items} صنف • ${row.quantity} وحدة",
                    row.value.iqd(),
                    CatalogAccent,
                )
            }
            is ItemLedgerReportInsight -> {
                result.variant?.let { variant ->
                    ReportRow(variant.label, variant.sku.ifBlank { "#${variant.id}" }, "#${variant.id}", CatalogAccent)
                }
                result.rows.forEach { row ->
                    ReportRow(
                        "${movementLabel(row.type)} — ${row.signedQuantity.withSign()}",
                        listOfNotNull(row.date, row.reference).joinToString(" • "),
                        "الرصيد ${row.balance}",
                        if (row.signedQuantity >= 0) CatalogPositive else CatalogWarning,
                    )
                }
            }
            is PurchaseRegisterReportInsight -> result.rows.forEach { row ->
                ReportRow(
                    "${row.purchaseOrderNumber ?: "#${row.purchaseOrderId}"} — ${row.productName ?: "صنف"}",
                    listOfNotNull(row.supplierName, row.date, "الكمية ${row.quantity}").joinToString(" • "),
                    row.total.iqd(),
                    CatalogAccent,
                )
            }
            is ProductionReportInsight -> result.rows.forEach { row ->
                ReportRow(
                    row.documentNumber ?: "مستند #${row.id}",
                    listOfNotNull(row.branchName, row.date).joinToString(" • "),
                    "${row.totalCost.iqd()} • هدر ${row.wasteCost.iqd()}",
                    if (row.wasteCost.value == "0.00") CatalogPositive else CatalogWarning,
                )
            }
            is WorkOrdersReportInsight -> {
                result.statusDistribution.forEach { row ->
                    ReportRow(row.label, "حالة أمر الشغل", row.count.toString(), CatalogAccent)
                }
                if (result.channelDistribution.isNotEmpty()) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                result.channelDistribution.forEach { row ->
                    ReportRow(row.label, "قناة الاستلام", row.count.toString(), CatalogPositive)
                }
            }
        }
    }
}

@Composable
private fun ReportRow(title: String, subtitle: String, trailing: String, accent: Color) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val stacked = maxWidth < 560.dp || LocalDensity.current.fontScale >= 1.5f
            if (stacked) {
                Column(
                    Modifier.fillMaxWidth().padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        Box(Modifier.size(10.dp).background(accent, CircleShape))
                        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    }
                    Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    Text(trailing, color = accent, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                }
            } else {
                Row(
                    Modifier.fillMaxWidth().padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(Modifier.size(10.dp).background(accent, CircleShape))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        trailing,
                        color = accent,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines = 3,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReportPageControls(
    page: ReportPageInfo,
    loading: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrevious, enabled = page.hasPrevious && !loading) {
                Icon(Icons.AutoMirrored.Rounded.ArrowForward, contentDescription = "الصفحة السابقة")
            }
            Text(
                if (page.serverWindowLimited) "أول ${page.pageSize} سجل" else "صفحة ${page.page + 1} • ${page.total} سجل",
                Modifier.weight(1f),
                fontWeight = FontWeight.SemiBold,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            IconButton(onClick = onNext, enabled = page.hasNext && !loading) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "الصفحة التالية")
            }
        }
    }
}

private fun InsightMoney.iqd(): String = "$value د.ع"

private fun Int.withSign(): String = if (this > 0) "+$this" else toString()

private fun movementLabel(raw: String): String = when (raw.uppercase()) {
    "IN" -> "إدخال"
    "OUT" -> "إخراج"
    "RETURN" -> "مرتجع"
    "TRANSFER_IN" -> "تحويل وارد"
    "TRANSFER_OUT" -> "تحويل صادر"
    "ADJUST" -> "تسوية"
    else -> raw
}

private fun ReportCatalogKind.icon(): ImageVector = when (this) {
    ReportCatalogKind.DAY_CLOSE -> Icons.Rounded.LockClock
    ReportCatalogKind.CASH_ORPHANS -> Icons.Rounded.AccountBalanceWallet
    ReportCatalogKind.SALES_REGISTER -> Icons.Rounded.ReceiptLong
    ReportCatalogKind.INVENTORY_VALUATION -> Icons.Rounded.Inventory2
    ReportCatalogKind.ITEM_LEDGER -> Icons.Rounded.ListAlt
    ReportCatalogKind.PURCHASE_REGISTER -> Icons.Rounded.ShoppingCart
    ReportCatalogKind.PRODUCTION -> Icons.Rounded.PrecisionManufacturing
    ReportCatalogKind.WORK_ORDERS -> Icons.Rounded.Print
}

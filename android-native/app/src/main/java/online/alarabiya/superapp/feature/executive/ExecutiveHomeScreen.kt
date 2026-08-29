package online.alarabiya.superapp.feature.executive

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.AutoGraph
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Today
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.ExecutiveCommandCenter
import online.alarabiya.superapp.model.ExecutiveDecision
import online.alarabiya.superapp.model.ExecutiveDestinationKey
import online.alarabiya.superapp.model.ExecutiveHealthStatus
import online.alarabiya.superapp.model.ExecutiveSeverity
import online.alarabiya.superapp.ui.rtlIsolate
import java.math.BigDecimal
import java.text.NumberFormat
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

sealed interface ExecutiveHomeState {
    data object Loading : ExecutiveHomeState
    data class Content(val center: ExecutiveCommandCenter) : ExecutiveHomeState
    data class Error(val message: String) : ExecutiveHomeState
}
data class ExecutiveManagementAction(val label: String, val icon: ImageVector)

@Composable
fun ExecutiveHomeScreen(
    state: ExecutiveHomeState,
    userName: String,
    roleLabel: String,
    tablet: Boolean,
    managementActions: List<ExecutiveManagementAction>,
    onRetry: () -> Unit,
    onManagementAction: (Int) -> Unit,
    onAllServices: () -> Unit,
    onOpen: (ExecutiveDestinationKey, Map<String, String>) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xFFF7F6FC))) {
        when (state) {
            ExecutiveHomeState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    CircularProgressIndicator()
                    Text("جارٍ تحديث مركز القيادة", style = MaterialTheme.typography.titleMedium)
                }
            }
            is ExecutiveHomeState.Error -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Surface(shape = RoundedCornerShape(28.dp), modifier = Modifier.padding(24.dp)) {
                    Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(38.dp))
                        Text("تعذر تحديث مركز القيادة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        Text(state.message, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onRetry) { Icon(Icons.Rounded.Refresh, null); Text("إعادة المحاولة") }
                    }
                }
            }
            is ExecutiveHomeState.Content -> ExecutiveContent(
                center = state.center,
                userName = userName,
                roleLabel = roleLabel,
                tablet = tablet || maxWidth >= 840.dp,
                managementActions = managementActions,
                onRetry = onRetry,
                onManagementAction = onManagementAction,
                onAllServices = onAllServices,
                onOpen = onOpen,
            )
        }
    }
}

private data class Kpi(val label: String, val value: String, val detail: String, val icon: ImageVector, val available: Boolean)

@Composable
private fun ExecutiveContent(
    center: ExecutiveCommandCenter,
    userName: String,
    roleLabel: String,
    tablet: Boolean,
    managementActions: List<ExecutiveManagementAction>,
    onRetry: () -> Unit,
    onManagementAction: (Int) -> Unit,
    onAllServices: () -> Unit,
    onOpen: (ExecutiveDestinationKey, Map<String, String>) -> Unit,
) {
    val failed = center.health.partialErrors.mapTo(mutableSetOf()) { it.section }
    val metricsAvailable = "metrics" !in failed
    val kpis = buildList {
        if (center.capabilities.sales) {
            val snapshot = center.operationalSnapshot.salesToday
            add(Kpi(
                "مبيعات اليوم",
                snapshot?.let { money(it.total.value) } ?: "غير متاح",
                snapshot?.let { "${it.invoiceCount} فاتورة • ${freshness(it.freshness.asOf)}" } ?: "المصدر غير متاح",
                Icons.Rounded.AutoGraph,
                snapshot != null && "salesToday" !in failed,
            ))
        }
        if (center.capabilities.financial) {
            add(Kpi("مبيعات أمس", money(center.metrics.salesPulse.yesterday.value), "متوسط 7 أيام ${money(center.metrics.salesPulse.average7Days.value)}", Icons.Rounded.AutoGraph, metricsAvailable))
            add(Kpi("الذمم المتأخرة", money(center.metrics.overdueReceivablesTotal.value), "${center.metrics.overdueReceivablesCount} معاملة", Icons.Rounded.AccountBalanceWallet, metricsAvailable))
        }
        if (center.capabilities.inventory) add(Kpi("المخزون المنخفض", center.metrics.lowStockCount.toString(), "صنف يحتاج متابعة", Icons.Rounded.Inventory2, metricsAvailable))
        if (center.capabilities.treasury) {
            val treasury = center.operationalSnapshot.treasury
            add(Kpi("رصيد الخزينة", treasury?.let { money(it.treasuryBalance.value) } ?: "غير متاح", treasury?.let { "الصندوق ${money(it.drawerBalance.value)}" } ?: "المصدر غير متاح", Icons.Rounded.AccountBalanceWallet, treasury != null && "treasurySnapshot" !in failed))
            add(Kpi("حركة اليوم", treasury?.let { money(it.todayReceipts.value) } ?: "غير متاح", treasury?.let { "مصروفات ${money(it.todayExpenses.value)} • ${it.openShiftsCount} وردية" } ?: "المصدر غير متاح", Icons.Rounded.Today, treasury != null && "treasurySnapshot" !in failed))
        }
    }
    val content: @Composable (Modifier) -> Unit = { modifier ->
        LazyColumn(
            modifier = modifier.testTag("executive-home-feed"),
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item { ExecutiveHero(userName, roleLabel, center.asOf, onRetry) }
            if (center.health.status == ExecutiveHealthStatus.DEGRADED) item {
                Surface(color = Color(0xFFFFF1E7), shape = RoundedCornerShape(18.dp)) {
                    Text("بعض المؤشرات غير متاحة مؤقتاً", Modifier.padding(16.dp), color = Color(0xFF944B13), fontWeight = FontWeight.SemiBold)
                }
            }
            if (kpis.isNotEmpty()) item { KpiGrid(kpis, tablet) }
            item { MorningBrief(center, metricsAvailable) }
            if (managementActions.isNotEmpty()) item {
                ManagementActions(managementActions, onManagementAction, onAllServices)
            }
            item { Text("قرارات تحتاج انتباهك", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            if ("alerts" in failed) item { UnavailableCard("تعذر تحديث القرارات") }
            else if (center.decisions.isEmpty()) item {
                Surface(shape = RoundedCornerShape(22.dp), color = Color.White) {
                    Text("لا توجد قرارات معلقة", Modifier.fillMaxWidth().padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else items(center.decisions, key = ExecutiveDecision::id) { decision -> DecisionCard(decision, onOpen) }
        }
    }
    if (tablet) content(Modifier.fillMaxSize()) else content(Modifier.fillMaxSize())
}

@Composable
private fun ManagementActions(actions: List<ExecutiveManagementAction>, onOpen: (Int) -> Unit, onAll: () -> Unit) {
    Surface(shape = RoundedCornerShape(28.dp), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("إجراءات الإدارة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            actions.take(6).forEachIndexed { index, action ->
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = Color(0xFFF4F0FF),
                    onClick = { onOpen(index) },
                    modifier = Modifier.testTag("executive-management-action-$index"),
                ) {
                    Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(action.icon, null, tint = Color(0xFF5C36D8))
                            Text(action.label, fontWeight = FontWeight.SemiBold)
                        }
                        Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, tint = Color(0xFF5C36D8))
                    }
                }
            }
            Button(onClick = onAll, modifier = Modifier.fillMaxWidth()) { Text("كل الخدمات") }
        }
    }
}

@Composable
private fun ExecutiveHero(userName: String, roleLabel: String, asOf: String, onRetry: () -> Unit) {
    Surface(shape = RoundedCornerShape(topStart = 42.dp, topEnd = 22.dp, bottomEnd = 42.dp, bottomStart = 22.dp)) {
        Box(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Color(0xFF26156B), Color(0xFF5C36D8)))).padding(22.dp)) {
            Column(Modifier.fillMaxWidth().padding(end = 48.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("مركز القيادة", style = MaterialTheme.typography.titleMedium, color = Color.White.copy(.75f))
                Text(userName, style = MaterialTheme.typography.headlineMedium, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(roleLabel, color = Color.White.copy(.72f))
                formatExecutiveTimestamp(asOf)?.let { formatted ->
                    Text("آخر تحديث ${rtlIsolate(formatted)}", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(.62f))
                }
            }
            IconButton(onClick = onRetry, modifier = Modifier.align(Alignment.TopEnd).background(Color.White.copy(.14f), CircleShape)) {
                Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White)
            }
        }
    }
}

@Composable
private fun KpiGrid(kpis: List<Kpi>, tablet: Boolean) {
    val largeText = LocalDensity.current.fontScale >= 1.3f
    val columns = if (tablet && !largeText) 3 else if (!largeText) 2 else 1
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        kpis.chunked(columns).forEach { rowKpis ->
            Row(
                modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Max),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                rowKpis.forEach { kpi ->
                    KpiCard(kpi, Modifier.weight(1f).fillMaxHeight())
                }
                repeat(columns - rowKpis.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable private fun KpiCard(kpi: Kpi, modifier: Modifier = Modifier) {
    Surface(modifier = modifier, shape = RoundedCornerShape(24.dp), color = Color.White) {
        Column(Modifier.fillMaxWidth().heightIn(min = 128.dp).padding(17.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Icon(kpi.icon, null, tint = Color(0xFF5C36D8))
            Text(kpi.label, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(if (kpi.available) kpi.value else "غير متاح", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            if (kpi.available) Text(kpi.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun MorningBrief(center: ExecutiveCommandCenter, available: Boolean) {
    val brief = center.metrics.morningBrief
    Surface(shape = RoundedCornerShape(28.dp), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Icon(Icons.Rounded.Today, null, tint = Color(0xFF5C36D8)); Text("موجز الصباح", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            }
            if (!available) Text("غير متاح مؤقتاً", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else listOf(
                "تذكيرات الذمم" to brief.receivableReminders,
                "وعود اليوم" to brief.promisedToday,
                "أوامر عمل متأخرة" to brief.overdueWorkOrders,
                "مهامي المفتوحة" to brief.myOpenTasks,
                "مهام متأخرة" to brief.overdueTasks,
            ).forEachIndexed { index, row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(row.first); Text(row.second.toString(), fontWeight = FontWeight.Bold) }
                if (index < 4) HorizontalDivider(color = Color(0xFFE9E5F5))
            }
        }
    }
}

@Composable private fun DecisionCard(decision: ExecutiveDecision, onOpen: (ExecutiveDestinationKey, Map<String, String>) -> Unit) {
    val accent = when (decision.severity) { ExecutiveSeverity.CRITICAL -> Color(0xFFC62828); ExecutiveSeverity.WARNING -> Color(0xFFC66900); ExecutiveSeverity.INFO -> Color(0xFF3157A4) }
    Surface(shape = RoundedCornerShape(24.dp), color = Color.White, onClick = { onOpen(decision.action.destination, decision.action.arguments) }) {
        Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(10.dp).background(accent, CircleShape))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(decision.title, fontWeight = FontWeight.Bold)
                Text(buildString { append(decision.count); decision.amount?.let { append(" • "); append(money(it.value)) } }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(decision.actionLabel, color = accent, fontWeight = FontWeight.SemiBold)
            }
            Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, tint = accent)
        }
    }
}

@Composable private fun UnavailableCard(message: String) = Surface(shape = RoundedCornerShape(22.dp), color = Color(0xFFFFF1E7)) {
    Text(message, Modifier.fillMaxWidth().padding(18.dp), color = Color(0xFF944B13))
}

private fun money(raw: String): String = runCatching {
    val value = BigDecimal(raw)
    "${NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ-u-nu-latn")).format(value)} د.ع"
}.getOrElse { "غير متاح" }

private fun freshness(raw: String): String = formatExecutiveTimestamp(raw)?.let(::rtlIsolate) ?: "محدث الآن"

internal fun formatExecutiveTimestamp(raw: String, zoneId: ZoneId = ZoneId.of("Asia/Baghdad")): String? {
    val instant = runCatching { Instant.parse(raw) }
        .recoverCatching { OffsetDateTime.parse(raw).toInstant() }
        .getOrNull() ?: return null
    val formatter = DateTimeFormatter.ofPattern("dd MMM yyyy، HH:mm", Locale.forLanguageTag("ar-IQ-u-nu-latn"))
        .withZone(zoneId)
    return formatter.format(instant)
}

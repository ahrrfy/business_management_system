package online.alarabiya.superapp.feature.collections

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CreditScore
import androidx.compose.material.icons.rounded.FilterAltOff
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.collections.CreditDecision
import online.alarabiya.superapp.model.collections.CreditDecisionStatus
import online.alarabiya.superapp.ui.rtlIsolate

private val Ink = Color(0xFF362087)
private val Indigo = Color(0xFF5B36D2)
private val Violet = Color(0xFF7254DB)
private val Ice = Color(0xFFF0ECFF)
private val Coral = Color(0xFFEC2F86)

@Composable
fun CollectionsRoute(viewModel: CollectionsViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    CollectionsScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = CollectionsActions(
            status = viewModel::status,
            customerIdFilter = viewModel::customerIdFilter,
            applyFilter = viewModel::applyFilter,
            clearFilter = viewModel::clearFilter,
            refresh = viewModel::refresh,
            loadMore = viewModel::loadMore,
            select = viewModel::select,
            cancelReason = viewModel::cancelReason,
            cancel = viewModel::cancelDecision,
            clearMessage = viewModel::clearMessage,
        ),
        modifier = modifier,
    )
}

data class CollectionsActions(
    val status: (CreditDecisionStatus) -> Unit,
    val customerIdFilter: (String) -> Unit,
    val applyFilter: () -> Unit,
    val clearFilter: () -> Unit,
    val refresh: () -> Unit,
    val loadMore: () -> Unit,
    val select: (Long?) -> Unit,
    val cancelReason: (String) -> Unit,
    val cancel: () -> Unit,
    val clearMessage: () -> Unit,
)

@Composable
fun CollectionsScreen(
    state: CollectionsUiState,
    capabilities: CollectionsCapabilities,
    actions: CollectionsActions,
    modifier: Modifier = Modifier,
) {
    var confirmCancel by remember { mutableStateOf(false) }
    Scaffold(modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.surface) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            CollectionsHeader(state.total, state.locked, actions.refresh)
            state.error?.let { Feedback(it, true, actions.clearMessage) }
            state.notice?.let { Feedback(it, false, actions.clearMessage) }
            if (!capabilities.canReadCreditDecisions) {
                EmptyState("لا تتوفر قرارات ائتمان لهذه الجلسة")
            } else if (state.busy == CollectionsBusy.INITIAL) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else {
                CreditWorkspace(state, capabilities, actions) { confirmCancel = true }
            }
        }
    }
    if (confirmCancel) {
        AlertDialog(
            onDismissRequest = { if (!state.locked) confirmCancel = false },
            icon = { Icon(Icons.Rounded.Block, null, tint = Coral) },
            title = { Text("إلغاء قرار الائتمان", fontWeight = FontWeight.ExtraBold) },
            text = { Text("سيصبح القرار غير قابل للاستخدام في أي فاتورة، وسيُحفظ السبب في السجل التدقيقي.") },
            confirmButton = {
                Button(
                    onClick = { confirmCancel = false; actions.cancel() },
                    enabled = !state.locked && state.cancelReason.trim().length >= 5,
                ) { Text("إلغاء القرار") }
            },
            dismissButton = { OutlinedButton({ confirmCancel = false }) { Text("رجوع") } },
        )
    }
}

@Composable
private fun CollectionsHeader(total: Int, locked: Boolean, refresh: () -> Unit) {
    Box(
        Modifier.fillMaxWidth()
            .background(
                Brush.horizontalGradient(listOf(Ink, Indigo, Violet)),
                RoundedCornerShape(bottomStart = 52.dp, bottomEnd = 16.dp),
            )
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        Box(Modifier.size(120.dp).align(Alignment.TopStart).background(Color.White.copy(alpha = .06f), CircleShape))
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("قرارات الائتمان", color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                Text("سجل الشركة • $total قراراً ضمن الفلتر", color = Color.White.copy(alpha = .76f))
            }
            Surface(color = Color.White.copy(alpha = .13f), shape = RoundedCornerShape(22.dp, 22.dp, 8.dp, 22.dp)) {
                IconButton(refresh, enabled = !locked) { Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White) }
            }
        }
    }
}

@Composable
private fun CreditWorkspace(
    state: CollectionsUiState,
    capabilities: CollectionsCapabilities,
    actions: CollectionsActions,
    confirmCancel: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        CreditFilters(state, actions)
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val wide = maxWidth >= 760.dp
            if (wide) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    CreditList(state, actions, Modifier.weight(.9f).fillMaxHeight())
                    CreditDetail(state.selected, state, capabilities, actions, confirmCancel, Modifier.weight(1.1f).fillMaxHeight())
                }
            } else if (state.selected != null) {
                CreditDetail(state.selected, state, capabilities, actions, confirmCancel, Modifier.fillMaxSize(), back = true)
            } else {
                CreditList(state, actions, Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
private fun CreditFilters(state: CollectionsUiState, actions: CollectionsActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            CreditDecisionStatus.entries.forEach { status ->
                FilterChip(
                    selected = state.status == status,
                    onClick = { actions.status(status) },
                    label = { Text(status.label()) },
                    leadingIcon = { Icon(status.icon(), null, Modifier.size(18.dp)) },
                    enabled = !state.locked,
                )
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = state.customerIdFilter,
                onValueChange = actions.customerIdFilter,
                modifier = Modifier.weight(1f),
                label = { Text("معرّف العميل") },
                singleLine = true,
                enabled = !state.locked,
                shape = RoundedCornerShape(18.dp),
            )
            IconButton(actions.applyFilter, enabled = !state.locked) { Icon(Icons.Rounded.Search, "تطبيق") }
            if (state.appliedCustomerId != null) {
                IconButton(actions.clearFilter, enabled = !state.locked) { Icon(Icons.Rounded.FilterAltOff, "مسح الفلتر") }
            }
        }
    }
}

@Composable
private fun CreditList(state: CollectionsUiState, actions: CollectionsActions, modifier: Modifier) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 30.dp, topEnd = 13.dp, bottomStart = 13.dp, bottomEnd = 30.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                Column { Text(state.status.label(), fontWeight = FontWeight.ExtraBold); Text("${state.rows.size} من ${state.total}", style = MaterialTheme.typography.bodySmall) }
                if (state.busy == CollectionsBusy.LIST || state.busy == CollectionsBusy.LOAD_MORE) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
            if (state.rows.isEmpty() && !state.locked) EmptyState("لا توجد قرارات ضمن هذا الفلتر")
            else LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.rows, key = { it.id }) { item ->
                    CreditDecisionCard(item, selected = item.id == state.selectedId) { actions.select(item.id) }
                }
                if (state.hasMore) item {
                    OutlinedButton(actions.loadMore, Modifier.fillMaxWidth(), enabled = !state.locked) { Text("تحميل المزيد") }
                }
            }
        }
    }
}

@Composable
private fun CreditDecisionCard(item: CreditDecision, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(22.dp, 9.dp, 22.dp, 9.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(if (selected) Ice else MaterialTheme.colorScheme.surfaceContainer)
            .border(if (selected) 1.dp else 0.dp, if (selected) Indigo else Color.Transparent, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(13.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Text(item.customerName, fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            StatusPill(item.status.label(), item.status == CreditDecisionStatus.ACTIVE)
        }
        Text("سقف ${item.maxAmount} • قرار #${item.id}", color = Indigo, fontWeight = FontWeight.Bold)
        Text(listOfNotNull(item.approvedByName, item.approvedAt).joinToString(" • "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CreditDetail(
    selected: CreditDecision?,
    state: CollectionsUiState,
    capabilities: CollectionsCapabilities,
    actions: CollectionsActions,
    confirmCancel: () -> Unit,
    modifier: Modifier,
    back: Boolean = false,
) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 13.dp, topEnd = 30.dp, bottomStart = 30.dp, bottomEnd = 13.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        if (selected == null) {
            EmptyState("اختر قراراً لمراجعة التفاصيل")
            return@Card
        }
        LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    if (back) IconButton({ actions.select(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
                    Box(Modifier.size(48.dp).background(Ice, RoundedCornerShape(19.dp, 19.dp, 7.dp, 19.dp)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.Person, null, tint = Indigo)
                    }
                    Spacer(Modifier.width(11.dp))
                    Column(Modifier.weight(1f)) {
                        Text(selected.customerName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                        Text("عميل #${selected.customerId} • قرار #${selected.id}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item {
                Surface(color = Ice, shape = RoundedCornerShape(26.dp, 10.dp, 26.dp, 10.dp)) {
                    Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("سقف القرار", style = MaterialTheme.typography.labelMedium)
                        Text(selected.maxAmount, color = Indigo, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold)
                        DetailLine("الحالة", selected.status.label())
                        DetailLine("المعتمِد", selected.approvedByName ?: "#${selected.approvedBy ?: "—"}")
                        DetailLine("وقت الاعتماد", selected.approvedAt ?: "—")
                        DetailLine("ينتهي", selected.expiresAt ?: "—")
                        selected.consumedByInvoiceId?.let { DetailLine("الفاتورة المستهلكة", "#$it") }
                    }
                }
            }
            selected.customerPhone?.let { item { DetailLine("هاتف العميل", it) } }
            selected.notes?.let { item { Text(it, Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(12.dp)) } }
            if (selected.status == CreditDecisionStatus.ACTIVE && capabilities.canCancelActiveDecision) {
                item {
                    Column(
                        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer.copy(alpha = .48f), RoundedCornerShape(24.dp, 10.dp, 24.dp, 10.dp)).padding(13.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("إلغاء القرار", fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.error)
                        OutlinedTextField(
                            value = state.cancelReason,
                            onValueChange = actions.cancelReason,
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("سبب موثق") },
                            minLines = 2,
                            enabled = !state.locked,
                            shape = RoundedCornerShape(16.dp),
                        )
                        Button(
                            onClick = confirmCancel,
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !state.locked && state.cancelReason.trim().length >= 5,
                        ) { Text("مراجعة الإلغاء") }
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp)).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.History, null, tint = Indigo)
                    Spacer(Modifier.width(8.dp))
                    Text("الحالة حسب تاريخ الاستحقاق.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(rtlIsolate(value), Modifier.weight(.58f), fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun StatusPill(label: String, positive: Boolean) {
    Text(
        label,
        Modifier.background(if (positive) Ice else MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 5.dp),
        color = if (positive) Indigo else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun Feedback(text: String, error: Boolean, close: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp)
            .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        color = if (error) MaterialTheme.colorScheme.errorContainer else Ice,
        shape = RoundedCornerShape(16.dp, 6.dp, 16.dp, 6.dp),
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.WarningAmber else Icons.Rounded.CheckCircle, null, tint = if (error) MaterialTheme.colorScheme.error else Indigo)
            Spacer(Modifier.width(8.dp))
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            IconButton(close) { Icon(Icons.Rounded.Close, "إغلاق") }
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Rounded.CreditScore, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline)
            Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun CreditDecisionStatus.label() = when (this) {
    CreditDecisionStatus.ACTIVE -> "نشطة"
    CreditDecisionStatus.EXPIRED -> "منتهية"
    CreditDecisionStatus.CONSUMED -> "مستهلكة"
    CreditDecisionStatus.CANCELLED -> "ملغاة"
}

private fun CreditDecisionStatus.icon() = when (this) {
    CreditDecisionStatus.ACTIVE -> Icons.Rounded.CheckCircle
    CreditDecisionStatus.EXPIRED -> Icons.Rounded.History
    CreditDecisionStatus.CONSUMED -> Icons.Rounded.CreditScore
    CreditDecisionStatus.CANCELLED -> Icons.Rounded.Block
}

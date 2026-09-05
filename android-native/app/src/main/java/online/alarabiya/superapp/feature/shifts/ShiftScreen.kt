package online.alarabiya.superapp.feature.shifts

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PointOfSale
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Store
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.shifts.CurrentShift
import online.alarabiya.superapp.model.shifts.ShiftFilters
import online.alarabiya.superapp.model.shifts.ShiftMoney
import online.alarabiya.superapp.model.shifts.ShiftPayment
import online.alarabiya.superapp.model.shifts.ShiftRecord
import online.alarabiya.superapp.model.shifts.ShiftReport
import online.alarabiya.superapp.model.shifts.ShiftStatus
import online.alarabiya.superapp.model.shifts.ShiftType
import online.alarabiya.superapp.model.shifts.ShiftVarianceState
import java.text.NumberFormat
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun ShiftScreen(viewModel: ShiftViewModel, modifier: Modifier = Modifier) {
    val state = viewModel.state
    ShiftScreenContent(
        state = state,
        onRefresh = viewModel::refresh,
        onUpdateFilters = viewModel::updateFilters,
        onApplyFilters = viewModel::applyFilters,
        onClearFilters = viewModel::clearFilters,
        onLoadMore = viewModel::loadMore,
        onSelectShift = viewModel::selectShift,
        onRetryDetail = viewModel::retryDetail,
        onRequestClose = viewModel::requestClose,
        onDismissMessage = viewModel::clearMessage,
        modifier = modifier,
    )
    state.closeDraft?.let {
        ShiftCloseDialog(
            state = state,
            onCounted = viewModel::updateCloseCounted,
            onConfirmation = viewModel::updateCloseConfirmation,
            onAcknowledged = viewModel::acknowledgeClose,
            onDismiss = viewModel::dismissClose,
            onConfirm = viewModel::confirmClose,
        )
    }
}

@Composable
internal fun ShiftScreenContent(
    state: ShiftUiState,
    onRefresh: () -> Unit,
    onUpdateFilters: ((ShiftFilters) -> ShiftFilters) -> Unit,
    onApplyFilters: () -> Unit,
    onClearFilters: () -> Unit,
    onLoadMore: () -> Unit,
    onSelectShift: (Long?) -> Unit,
    onRetryDetail: () -> Unit,
    onRequestClose: () -> Unit,
    onDismissMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val tablet = maxWidth >= 840.dp
        val phoneDetail = !tablet && state.selectedShiftId != null
        BackHandler(enabled = phoneDetail) { onSelectShift(null) }

        Column(Modifier.fillMaxSize()) {
            ShiftHeader(state, onRefresh)
            state.notice?.let { ShiftMessage(it, error = false, onDismissMessage) }
            state.error?.let { ShiftMessage(it, error = true, onDismissMessage) }

            when {
                !state.policy.canReadManagement -> AccessDenied(Modifier.weight(1f))
                state.loading && !state.loaded -> Loading(Modifier.weight(1f))
                !state.loaded -> InitialError(state.error, onRefresh, Modifier.weight(1f))
                tablet -> Row(
                    Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    ShiftListPane(
                        state, onUpdateFilters, onApplyFilters, onClearFilters, onLoadMore, onSelectShift,
                        Modifier.weight(.58f).fillMaxHeight(),
                    )
                    Surface(
                        Modifier.weight(.42f).fillMaxHeight(),
                        shape = MaterialTheme.shapes.extraLarge,
                        tonalElevation = 1.dp,
                    ) {
                        ShiftDetailPane(state, onSelectShift, onRetryDetail, onRequestClose, showListBack = false)
                    }
                }
                phoneDetail -> ShiftDetailPane(
                    state, onSelectShift, onRetryDetail, onRequestClose, showListBack = true,
                    modifier = Modifier.weight(1f),
                )
                else -> ShiftListPane(
                    state, onUpdateFilters, onApplyFilters, onClearFilters, onLoadMore, onSelectShift,
                    Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun ShiftHeader(state: ShiftUiState, onRefresh: () -> Unit) {
    val fontScale = LocalDensity.current.fontScale
    Surface(tonalElevation = 2.dp) {
        if (fontScale > 1.5f) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp)) {
                Text("دورة الورديات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                Text("التقارير والمطابقة النقدية", color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = onRefresh, enabled = !state.loading && !state.loadingMore && !state.closing) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(6.dp))
                    Text("تحديث")
                }
            }
        } else {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("دورة الورديات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                    Text("التقارير والمطابقة النقدية", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(
                    onClick = onRefresh,
                    enabled = !state.loading && !state.loadingMore && !state.closing,
                    modifier = Modifier.semantics { contentDescription = "تحديث سجل الورديات" },
                ) { Icon(Icons.Rounded.Refresh, null) }
            }
        }
        if (state.loading && state.loaded) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun ShiftListPane(
    state: ShiftUiState,
    onUpdateFilters: ((ShiftFilters) -> ShiftFilters) -> Unit,
    onApplyFilters: () -> Unit,
    onClearFilters: () -> Unit,
    onLoadMore: () -> Unit,
    onSelectShift: (Long?) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier.padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { ShiftFiltersCard(state, onUpdateFilters, onApplyFilters, onClearFilters) }
        if (state.currentChecked) item { CurrentShiftCard(state.currentShifts) }
        if (state.rows.isEmpty()) {
            item {
                EmptyState(
                    if (hasActiveFilters(state.filters)) "لا توجد ورديات تطابق الفلاتر" else "لا توجد ورديات مسجلة",
                    Modifier.fillMaxWidth().heightIn(min = 180.dp),
                )
            }
        } else {
            items(state.rows, key = ShiftRecord::id) { shift ->
                ShiftRowCard(shift, selected = shift.id == state.selectedShiftId) { onSelectShift(shift.id) }
            }
            item {
                if (state.loadingMore) {
                    Box(Modifier.fillMaxWidth().padding(18.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(28.dp))
                    }
                } else if (state.hasMore) {
                    OutlinedButton(onClick = onLoadMore, Modifier.fillMaxWidth()) { Text("تحميل المزيد") }
                }
            }
        }
        item { Spacer(Modifier.size(8.dp)) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ShiftFiltersCard(
    state: ShiftUiState,
    onUpdate: ((ShiftFilters) -> ShiftFilters) -> Unit,
    onApply: () -> Unit,
    onClear: () -> Unit,
) {
    val fontScale = LocalDensity.current.fontScale
    Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.FilterAlt, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text("التصفية", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            OutlinedTextField(
                value = state.filters.search,
                onValueChange = { value -> onUpdate { it.copy(search = value.take(100)) } },
                label = { Text("الموظف أو رقم الوردية") },
                leadingIcon = { Icon(Icons.Rounded.Search, null) },
                singleLine = fontScale <= 1.5f,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.filters.branchId,
                onValueChange = { value -> onUpdate { it.copy(branchId = value.filter(Char::isDigit).take(12)) } },
                label = { Text("معرّف الفرع") },
                enabled = state.policy.canSelectBranch,
                supportingText = if (!state.policy.canSelectBranch) ({ Text("فرع الحساب") }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            FilterRow("الحالة", ShiftStatus.entries.map { it to it.label }, state.filters.status) { value ->
                onUpdate { it.copy(status = value) }
            }
            FilterRow("النوع", ShiftType.entries.map { it to it.label }, state.filters.type) { value ->
                onUpdate { it.copy(type = value) }
            }
            FilterRow("المطابقة", ShiftVarianceState.entries.map { it to it.label }, state.filters.variance) { value ->
                onUpdate { it.copy(variance = value) }
            }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val wide = maxWidth >= 620.dp && fontScale <= 1.5f
                if (wide) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DateFilter("من تاريخ", state.filters.from, Modifier.weight(1f)) { value -> onUpdate { it.copy(from = value) } }
                        DateFilter("إلى تاريخ", state.filters.to, Modifier.weight(1f)) { value -> onUpdate { it.copy(to = value) } }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        DateFilter("من تاريخ", state.filters.from, Modifier.fillMaxWidth()) { value -> onUpdate { it.copy(from = value) } }
                        DateFilter("إلى تاريخ", state.filters.to, Modifier.fillMaxWidth()) { value -> onUpdate { it.copy(to = value) } }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onApply, modifier = Modifier.weight(1f), enabled = !state.loading && !state.loadingMore) {
                    Text("تطبيق")
                }
                OutlinedButton(onClick = onClear, modifier = Modifier.weight(1f), enabled = !state.loading && !state.loadingMore) {
                    Text("مسح")
                }
            }
        }
    }
}

@Composable
private fun <T : Any> FilterRow(label: String, options: List<Pair<T, String>>, selected: T?, onSelected: (T?) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item { FilterChip(selected = selected == null, onClick = { onSelected(null) }, label = { Text("الكل") }) }
            items(options) { (value, text) ->
                FilterChip(selected = selected == value, onClick = { onSelected(value) }, label = { Text(text) })
            }
        }
    }
}

@Composable
private fun DateFilter(label: String, value: String, modifier: Modifier, onValue: (String) -> Unit) {
    ArabicDatePicker(value = value, onValue = onValue, label = label, modifier = modifier)
}

@Composable
private fun CurrentShiftCard(current: List<CurrentShift>) {
    val tint = if (current.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = tint.copy(alpha = .08f)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.History, null, tint = tint)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("ورديات حسابك الحالية", fontWeight = FontWeight.Bold)
                if (current.isEmpty()) Text("لا توجد وردية مفتوحة في هذا النطاق", color = MaterialTheme.colorScheme.onSurfaceVariant)
                current.forEach { shift ->
                    Text("#${shift.id} • ${shift.type.label}")
                    Text(formatShiftTimestamp(shift.openedAt), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun ShiftRowCard(shift: ShiftRecord, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        shape = MaterialTheme.shapes.extraLarge,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(shift.userName ?: "الموظف #${shift.userId}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("وردية #${shift.id} • ${shift.type.label}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                AssistChip(onClick = onClick, label = { Text(shift.status.label) })
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Store, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Text(shift.branchName ?: "الفرع #${shift.branchId}")
            }
            Text("فُتحت ${formatShiftTimestamp(shift.openedAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            ShiftMoneySummary(shift.openingBalance, shift.expectedCash, shift.variance)
        }
    }
}

@Composable
private fun ShiftMoneySummary(opening: ShiftMoney, expected: ShiftMoney?, variance: ShiftMoney?) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val vertical = maxWidth < 460.dp || LocalDensity.current.fontScale > 1.4f
        val values = listOf(
            "الافتتاحي" to opening,
            "المتوقع" to expected,
            "الفرق" to variance,
        )
        if (vertical) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                values.forEach { (label, money) -> LabeledMoney(label, money, Modifier.fillMaxWidth()) }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                values.forEach { (label, money) -> LabeledMoney(label, money, Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun LabeledMoney(label: String, money: ShiftMoney?, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            money?.let(::formatMoney) ?: "—",
            fontWeight = FontWeight.Bold,
            color = if (label == "الفرق" && money != null) varianceColor(money) else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun ShiftDetailPane(
    state: ShiftUiState,
    onSelectShift: (Long?) -> Unit,
    onRetryDetail: () -> Unit,
    onRequestClose: () -> Unit,
    showListBack: Boolean,
    modifier: Modifier = Modifier,
) {
    when (val detail = state.detail) {
        ShiftDetailState.None -> EmptyState("اختر وردية لعرض تقريرها", modifier.fillMaxSize())
        ShiftDetailState.Loading -> Loading(modifier.fillMaxSize())
        is ShiftDetailState.Error -> InitialError(detail.message, onRetryDetail, modifier.fillMaxSize())
        is ShiftDetailState.Content -> ShiftReportContent(
            report = detail.report,
            canClose = state.policy.canClose(detail.report.shift) && !state.closing,
            showListBack = showListBack,
            onBack = { onSelectShift(null) },
            onRequestClose = onRequestClose,
            modifier = modifier,
        )
    }
}

@Composable
private fun ShiftReportContent(
    report: ShiftReport,
    canClose: Boolean,
    showListBack: Boolean,
    onBack: () -> Unit,
    onRequestClose: () -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            if (showListBack) {
                TextButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, null)
                    Spacer(Modifier.width(6.dp))
                    Text("العودة إلى الورديات")
                }
            }
            Column(Modifier.padding(top = 8.dp)) {
                Text("تقرير الوردية #${report.shift.id}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                Text(report.shift.userName ?: "الموظف #${report.shift.userId}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${report.shift.type.label} • ${report.shift.status.label}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        item {
            Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = .55f)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("المطابقة النقدية", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    ShiftMoneySummary(report.shift.openingBalance, report.expectedCash, report.shift.variance)
                    report.shift.countedCash?.let { counted -> LabeledMoney("المعدود", counted) }
                }
            }
        }
        item {
            ReportCounters(report)
        }
        item {
            Text("طرق الدفع", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        if (report.payments.isEmpty()) item {
            EmptyState("لا توجد حركات دفع في هذه الوردية", Modifier.fillMaxWidth().heightIn(min = 100.dp))
        } else itemsIndexed(report.payments) { index, payment ->
            PaymentRow(payment)
            if (index < report.payments.lastIndex) HorizontalDivider()
        }
        if (canClose) item {
            Button(onClick = onRequestClose, Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Icon(Icons.Rounded.Lock, null)
                Spacer(Modifier.width(8.dp))
                Text("إغلاق الوردية")
            }
        }
        item { Spacer(Modifier.size(18.dp)) }
    }
}

@Composable
private fun ReportCounters(report: ShiftReport) {
    Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ReportLine("الفواتير", report.invoiceCount.toString(), Icons.Rounded.PointOfSale)
            ReportLine("إجمالي المبيعات", formatMoney(report.salesTotal), Icons.Rounded.AccountBalanceWallet)
            if (report.workOrderInvoiceCount > 0) {
                ReportLine("فواتير أوامر الشغل", "${report.workOrderInvoiceCount} • ${formatMoney(report.workOrderInvoiceTotal)}", Icons.Rounded.PointOfSale)
            }
            if (report.heldDepositsCount > 0) {
                ReportLine("عرابين معلقة", "${report.heldDepositsCount} • ${formatMoney(report.heldDepositsTotal)}", Icons.Rounded.History)
            }
            if (report.lateSyncedCount > 0) {
                ReportLine("مبيعات تمت مزامنتها لاحقاً", "${report.lateSyncedCount} • ${formatMoney(report.lateSyncedTotal)}", Icons.Rounded.Refresh)
            }
        }
    }
}

@Composable
private fun ReportLine(label: String, value: String, icon: androidx.compose.ui.graphics.vector.ImageVector) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stacked = maxWidth < 380.dp || LocalDensity.current.fontScale > 1.5f
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(8.dp))
                    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(value, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 28.dp))
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(value, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun PaymentRow(payment: ShiftPayment) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        val stacked = maxWidth < 360.dp || LocalDensity.current.fontScale > 1.5f
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(paymentMethodLabel(payment.method), fontWeight = FontWeight.Bold)
                Text(if (payment.direction == "IN") "وارد • ${payment.count} حركة" else "صادر • ${payment.count} حركة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(formatMoney(payment.total), fontWeight = FontWeight.Bold)
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(paymentMethodLabel(payment.method), fontWeight = FontWeight.Bold)
                    Text(if (payment.direction == "IN") "وارد • ${payment.count} حركة" else "صادر • ${payment.count} حركة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(formatMoney(payment.total), fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun ShiftCloseDialog(
    state: ShiftUiState,
    onCounted: (String) -> Unit,
    onConfirmation: (String) -> Unit,
    onAcknowledged: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val draft = state.closeDraft ?: return
    val report = (state.detail as? ShiftDetailState.Content)?.report?.takeIf { it.shift.id == draft.shiftId }
    val variance = report?.let { ShiftStatePolicy.variance(it, draft.countedCash) }
    val validation = ShiftStatePolicy.closeValidation(state)
    AlertDialog(
        onDismissRequest = { if (!state.closing) onDismiss() },
        icon = { Icon(Icons.Rounded.Lock, null) },
        title = { Text("تأكيد إغلاق الوردية #${draft.shiftId}") },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (report != null) {
                    item { DialogSummaryLine("النقد المتوقع", formatMoney(report.expectedCash)) }
                    item { DialogSummaryLine("إجمالي المبيعات", formatMoney(report.salesTotal)) }
                    item { DialogSummaryLine("عدد الفواتير", report.invoiceCount.toString()) }
                }
                item {
                    OutlinedTextField(
                        value = draft.countedCash,
                        onValueChange = onCounted,
                        label = { Text("النقد المعدود") },
                        suffix = { Text("د.ع") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = draft.countedCashConfirmation,
                        onValueChange = onConfirmation,
                        label = { Text("أعد إدخال النقد المعدود") },
                        suffix = { Text("د.ع") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                variance?.let { value -> item { DialogSummaryLine("الفرق", formatMoney(value), varianceColor(value)) } }
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(draft.acknowledged, onAcknowledged, enabled = !state.closing)
                        Text("راجعت النقد المتوقع والمعدود وملخص الفروقات")
                    }
                }
                if (validation != null) item {
                    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.errorContainer) {
                        Text(validation, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                    }
                }
                state.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = validation == null && !state.closing) {
                if (state.closing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (ShiftMoney.parseUnsigned(draft.countedCash)?.isPositive() == true) "إغلاق وترحيل النقد للخزينة" else "إغلاق وتثبيت المطابقة")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !state.closing) { Text("رجوع") } },
    )
}

@Composable
private fun DialogSummaryLine(label: String, value: String, color: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, color = color, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun ShiftMessage(message: String, error: Boolean, onDismiss: () -> Unit) {
    val color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp),
        shape = MaterialTheme.shapes.large,
        color = color.copy(alpha = .1f),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle, null, tint = color)
            Spacer(Modifier.width(8.dp))
            Text(message, Modifier.weight(1f), color = color)
            TextButton(onClick = onDismiss) { Text("إغلاق", color = color) }
        }
    }
}

@Composable
private fun InitialError(message: String?, onRetry: () -> Unit, modifier: Modifier) {
    Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                Text("تعذر تحميل الورديات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                message?.takeIf(String::isNotBlank)?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Button(onClick = onRetry, Modifier.fillMaxWidth()) { Text("إعادة المحاولة") }
            }
        }
    }
}

@Composable
private fun AccessDenied(modifier: Modifier) = EmptyState("لا تملك صلاحية إدارة الورديات", modifier)

@Composable
private fun Loading(modifier: Modifier) = Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
private fun EmptyState(message: String, modifier: Modifier) {
    Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun varianceColor(value: ShiftMoney): Color = when {
    value.isPositive() -> Color(0xFF8A5B00)
    value.isNegative() -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.primary
}

internal fun formatShiftTimestamp(raw: String, zoneId: ZoneId = ZoneId.of("Asia/Baghdad")): String {
    val instant = runCatching { Instant.parse(raw) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull()
        ?: return raw
    val formatter = DateTimeFormatter.ofPattern("dd MMM yyyy، HH:mm", Locale.forLanguageTag("ar-IQ-u-nu-latn"))
        .withZone(zoneId)
    return ltrIsolate(formatter.format(instant))
}

private fun formatMoney(value: ShiftMoney): String {
    val formatter = NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ-u-nu-latn")).apply {
        minimumFractionDigits = 0
        maximumFractionDigits = 2
        isGroupingUsed = true
    }
    return ltrIsolate("${formatter.format(value.decimal)} د.ع")
}

private fun ltrIsolate(value: String): String = "\u2066$value\u2069"

private fun hasActiveFilters(filters: ShiftFilters): Boolean =
    filters.status != null || filters.type != null || filters.variance != null ||
        filters.from.isNotBlank() || filters.to.isNotBlank() || filters.search.isNotBlank()

private fun paymentMethodLabel(value: String): String = when (value.uppercase()) {
    "CASH" -> "نقد"
    "CARD" -> "بطاقة"
    "TRANSFER" -> "تحويل"
    "WALLET" -> "محفظة"
    "CHEQUE", "CHECK" -> "شيك"
    else -> value
}

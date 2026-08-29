package online.alarabiya.superapp.feature.operations

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Payments
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.NumberFormat
import java.util.Locale
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteDetail
import online.alarabiya.superapp.model.operations.ConsignmentNoteSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteType
import online.alarabiya.superapp.model.operations.ConsignorProduct
import online.alarabiya.superapp.model.operations.MyCommissionStatus
import online.alarabiya.superapp.model.operations.OperationsPolicy
import online.alarabiya.superapp.model.operations.OperationsSection
import online.alarabiya.superapp.model.operations.OperationsValidation
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.scanner.NativeScannerAction
import online.alarabiya.superapp.ui.rtlIsolate
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.Stroke

@Composable
fun OperationsScreen(
    viewModel: OperationsViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = viewModel.state
    var maintenanceDialog by rememberSaveable { mutableStateOf(false) }
    BoxWithConstraints(
        modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        val tablet = maxWidth >= 840.dp
        Column(Modifier.fillMaxSize()) {
            OperationsHeader(
                title = state.section.label,
                onBack = when {
                    !tablet && (state.assetOverlay != null || state.pendingAction != null ||
                        state.selectedAssetId != null || state.selectedNoteId != null) ->
                        ({ if (!viewModel.handleNestedBack()) onBack() })
                    else -> onBack
                },
                onRefresh = viewModel::refresh,
                refreshing = state.loading,
            )
            SectionStrip(viewModel.availableSections(), state.section, viewModel::setSection)
            MessageStrip(state.error, state.notice, viewModel::clearMessage)
            when (state.section) {
                OperationsSection.MyCommission -> CommissionPane(state, viewModel)
                OperationsSection.Assets,
                OperationsSection.Custody,
                -> if (tablet) {
                    Row(
                        Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        AssetListPane(state, viewModel, Modifier.width(390.dp).fillMaxHeight())
                        AssetDetailPane(
                            state,
                            viewModel,
                            onStartMaintenance = { maintenanceDialog = true },
                            Modifier.weight(1f).fillMaxHeight(),
                        )
                    }
                } else if (state.selectedAssetId == null) {
                    AssetListPane(state, viewModel, Modifier.fillMaxSize().padding(14.dp))
                } else {
                    AssetDetailPane(
                        state,
                        viewModel,
                        onStartMaintenance = { maintenanceDialog = true },
                        Modifier.fillMaxSize().padding(12.dp),
                    )
                }
                OperationsSection.Consignment -> if (tablet) {
                    Row(
                        Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        NoteListPane(state, viewModel, Modifier.width(390.dp).fillMaxHeight())
                        NoteDetailPane(state, viewModel, Modifier.weight(1f).fillMaxHeight())
                    }
                } else if (state.selectedNoteId == null) {
                    NoteListPane(state, viewModel, Modifier.fillMaxSize().padding(14.dp))
                } else {
                    NoteDetailPane(state, viewModel, Modifier.fillMaxSize().padding(12.dp))
                }
            }
        }
    }

    if (maintenanceDialog) {
        MaintenanceDialog(
            onDismiss = { maintenanceDialog = false },
            onSubmit = { type, vendor, note, date ->
                maintenanceDialog = false
                viewModel.requestStartMaintenance(type, vendor, note, date)
            },
        )
    }
    state.quickNoteTarget?.let {
        QuickConsignmentDialog(state, viewModel)
    }
    state.pendingAction?.let { action ->
        ActionConfirmation(action, viewModel::dismissConfirmation, viewModel::confirmPendingAction)
    }
    AssetLifecycleOverlays(state, viewModel)
}

@Composable
private fun OperationsHeader(title: String, onBack: () -> Unit, onRefresh: () -> Unit, refreshing: Boolean) {
    Row(
        Modifier.fillMaxWidth().background(EmeraldDark).padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع", tint = Color.White) }
        Column(Modifier.weight(1f)) {
            Text("العمليات المتخصصة", color = Color.White.copy(alpha = .72f), style = MaterialTheme.typography.labelMedium)
            Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White)
        }
    }
}

@Composable
private fun SectionStrip(
    sections: List<OperationsSection>,
    selected: OperationsSection,
    onSelect: (OperationsSection) -> Unit,
) {
    LazyRow(
        Modifier.fillMaxWidth().background(Color.White),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(sections) { section ->
            FilterChip(selected = selected == section, onClick = { onSelect(section) }, label = { Text(section.label) })
        }
    }
}

@Composable
private fun MessageStrip(error: String?, notice: String?, onClear: () -> Unit) {
    val message = error ?: notice ?: return
    val isError = error != null
    Row(
        Modifier.fillMaxWidth()
            .background(if (isError) Color(0xFFFFEDEA) else Mint)
            .clickable(role = Role.Button, onClick = onClear)
            .semantics { liveRegion = if (isError) LiveRegionMode.Assertive else LiveRegionMode.Polite }
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (isError) Icons.Rounded.WarningAmber else Icons.Rounded.CheckCircle, null, tint = if (isError) Orange else Emerald)
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AssetListPane(state: OperationsUiState, viewModel: OperationsViewModel, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(11.dp)) {
        AssetRegisterActions(state, viewModel)
        SearchField(state.query, viewModel::setQuery, "بحث بالرمز أو الأصل أو صاحب العهدة", NativeScanField.SKU_OR_BARCODE)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                FilterChip(state.assetStatus == null, { viewModel.setAssetStatus(null) }, label = { Text("الكل") })
            }
            items(AssetStatus.filterable) { status ->
                FilterChip(state.assetStatus == status, { viewModel.setAssetStatus(status) }, label = { Text(status.label) })
            }
        }
        when {
            state.loading -> LoadingPane("جارٍ تحميل الأصول")
            state.error != null && state.assets.isEmpty() -> RetryPane(viewModel::refresh)
            else -> AssetRows(state, viewModel)
        }
    }
}

@Composable
private fun ColumnScope.AssetRows(state: OperationsUiState, viewModel: OperationsViewModel) {
    val rows = OperationsStateFilter.assets(state)
    if (rows.isEmpty()) {
        EmptyPane(if (state.section == OperationsSection.Custody) "لا توجد عُهد مسندة" else "لا توجد أصول")
        return
    }
    LazyColumn(
        Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(9.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(rows, key = { it.id }) { asset ->
            AssetRow(asset, state.selectedAssetId == asset.id) { viewModel.selectAsset(asset.id) }
        }
    }
}

@Composable
private fun AssetRow(asset: AssetSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
    ) {
        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(asset.code, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = EmeraldDark)
                StatusPill(asset.status.label, statusColor(asset.status))
            }
            Text(asset.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(asset.custodianName ?: asset.location ?: "بلا عهدة مسندة", color = MutedInk, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(asset.category.label, color = MutedInk, style = MaterialTheme.typography.bodySmall)
                Text(formatMoney(asset.bookValue), color = EmeraldDark, style = MaterialTheme.typography.titleSmall)
            }
        }
    }
}

@Composable
private fun AssetDetailPane(
    state: OperationsUiState,
    viewModel: OperationsViewModel,
    onStartMaintenance: () -> Unit,
    modifier: Modifier,
) {
    Surface(modifier, color = Color.White, shape = RoundedCornerShape(28.dp)) {
        Box(Modifier.fillMaxSize()) {
            when (val detail = state.assetDetail) {
                OperationsDetailState.None -> EmptyPane("اختر أصلاً لعرض التفاصيل")
                OperationsDetailState.Loading -> LoadingPane()
                is OperationsDetailState.Error -> RetryPane { state.selectedAssetId?.let(viewModel::selectAsset) }
                is OperationsDetailState.Content -> AssetDetailContent(detail.value, state, viewModel, onStartMaintenance)
            }
        }
    }
}

@Composable
private fun AssetDetailContent(
    detail: AssetDetail,
    state: OperationsUiState,
    viewModel: OperationsViewModel,
    onStartMaintenance: () -> Unit,
) {
    val asset = detail.summary
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(22.dp),
        verticalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(asset.code, color = Emerald, style = MaterialTheme.typography.labelLarge)
                    Text(asset.name, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                }
                StatusPill(asset.status.label, statusColor(asset.status))
            }
        }
        item {
            DetailCard("بيانات الأصل", Icons.Rounded.Inventory2) {
                ValueLine("الفئة", asset.category.label)
                ValueLine("الفرع", asset.branchName ?: "—")
                ValueLine("الموقع", asset.location ?: "—")
                ValueLine("الحالة الفنية", asset.condition ?: "—")
                ValueLine("تاريخ الشراء", asset.purchaseDate ?: "—")
                ValueLine("انتهاء الكفالة", asset.warrantyEnd ?: "—")
            }
        }
        item {
            DetailCard("القيمة والعهدة", Icons.Rounded.Person) {
                ValueLine("صاحب العهدة", asset.custodianName ?: "غير مسند")
                ValueLine("قيمة الشراء", formatMoney(asset.purchaseValue))
                ValueLine("القيمة الدفترية", formatMoney(asset.bookValue))
                ValueLine("نسبة الإهلاك", "${asset.depreciationPct}%")
            }
        }
        if (detail.limitedToScopedSummary) {
            item { ScopeNotice("بيانات الأصل الحالية ضمن نطاق فرعك.") }
        } else {
            if (detail.maintenance.isNotEmpty()) {
                item {
                    DetailCard("سجل الصيانة", Icons.Rounded.Build) {
                        detail.maintenance.take(8).forEachIndexed { index, record ->
                            Text(record.type, style = MaterialTheme.typography.titleMedium)
                            Text(listOfNotNull(record.date, record.vendor).joinToString(" · "), color = MutedInk)
                            record.note?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            if (index < detail.maintenance.take(8).lastIndex) HorizontalDivider(color = Stroke)
                        }
                    }
                }
            }
            if (detail.custody.isNotEmpty()) {
                item {
                    DetailCard("سجل العهدة", Icons.Rounded.Person) {
                        detail.custody.take(8).forEachIndexed { index, record ->
                            Text(record.employeeName ?: "موظف", style = MaterialTheme.typography.titleMedium)
                            Text("${record.fromDate ?: "—"} — ${record.toDate ?: "مستمرة"}", color = MutedInk)
                            if (index < detail.custody.take(8).lastIndex) HorizontalDivider(color = Stroke)
                        }
                    }
                }
            }
        }
        assetLifecycleItems(detail, state, viewModel, onStartMaintenance)
    }
}

@Composable
private fun CommissionPane(state: OperationsUiState, viewModel: OperationsViewModel) {
    var draftPeriod by rememberSaveable(state.commissionPeriod) { mutableStateOf(state.commissionPeriod) }
    val valid = remember(draftPeriod) { Regex("^\\d{4}-(0[1-9]|1[0-2])$").matches(draftPeriod) }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draftPeriod,
                onValueChange = { draftPeriod = it.take(7) },
                modifier = Modifier.weight(1f).testTag("commission_period"),
                label = { Text("الشهر") },
                placeholder = { Text("YYYY-MM") },
                singleLine = true,
                isError = !valid,
            )
            Button(
                onClick = { viewModel.setCommissionPeriod(draftPeriod) },
                enabled = valid && !state.loading,
                modifier = Modifier.height(56.dp),
            ) { Text("عرض") }
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            when (val commission = state.commission) {
                OperationsDetailState.None,
                OperationsDetailState.Loading,
                -> LoadingPane()
                is OperationsDetailState.Error -> RetryPane(viewModel::refresh)
                is OperationsDetailState.Content -> {
                    val value = commission.value
                    if (value == null) EmptyPane("لا توجد خطة أو هدف مرتبط بحسابك لهذا الشهر")
                    else CommissionContent(value)
                }
            }
        }
    }
}

@Composable
private fun BoxScope.CommissionContent(status: MyCommissionStatus) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = EmeraldDark), shape = RoundedCornerShape(26.dp)) {
                Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(status.employeeName, color = Color.White, style = MaterialTheme.typography.titleLarge)
                    Text(status.planName ?: "بدون خطة عمولة", color = Color.White.copy(alpha = .72f))
                    Text(formatMoney(status.projectedCommission), color = Color.White, style = MaterialTheme.typography.headlineMedium)
                    Text("عمولة تقديرية — الصرف من التشغيلة المعتمدة فقط", color = Color.White.copy(alpha = .72f))
                }
            }
        }
        item {
            DetailCard("إنجازي الشهري", Icons.Rounded.Payments) {
                ValueLine("المبيعات", formatMoney(status.sales))
                ValueLine("المرتجعات", formatMoney(status.returns))
                ValueLine("استبعاد حصة الأمانة", formatMoney(status.consignmentDeduction))
                ValueLine("الوعاء الفعلي", formatMoney(status.effectiveBase))
                ValueLine("الهدف", status.target?.let(::formatMoney) ?: "غير محدد")
                ValueLine("الإنجاز", status.achievementPct?.let { "$it%" } ?: "—")
            }
        }
        status.settledAmount?.let { settled ->
            item {
                DetailCard("التشغيلة", Icons.Rounded.CheckCircle) {
                    ValueLine("المبلغ", formatMoney(settled))
                    ValueLine("الحالة", if (status.settledApproved) "معتمدة" else "مسودة")
                }
            }
        }
        if (status.history.isNotEmpty()) {
            item {
                DetailCard("السجل الشخصي", Icons.Rounded.Payments) {
                    status.history.forEachIndexed { index, row ->
                        ValueLine(row.period, formatMoney(row.commissionAmount))
                        Text(if (row.approved) "معتمدة" else "مسودة", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                        if (index < status.history.lastIndex) HorizontalDivider(color = Stroke)
                    }
                }
            }
        }
    }
}

@Composable
private fun NoteListPane(state: OperationsUiState, viewModel: OperationsViewModel, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(11.dp)) {
        SearchField(state.query, viewModel::setQuery, "بحث برقم السند أو المودع", NativeScanField.DOCUMENT_REFERENCE)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { FilterChip(state.consignmentType == null, { viewModel.setConsignmentType(null) }, label = { Text("الكل") }) }
            items(ConsignmentNoteType.filterable) { type ->
                FilterChip(state.consignmentType == type, { viewModel.setConsignmentType(type) }, label = { Text(type.label) })
            }
        }
        when {
            state.loading -> LoadingPane("جارٍ تحميل سندات الأمانة")
            state.error != null && state.notes.isEmpty() -> RetryPane(viewModel::refresh)
            else -> NoteRows(state, viewModel)
        }
    }
}

@Composable
private fun ColumnScope.NoteRows(state: OperationsUiState, viewModel: OperationsViewModel) {
    val rows = OperationsStateFilter.notes(state)
    if (rows.isEmpty()) {
        EmptyPane("لا توجد سندات أمانة")
        return
    }
    LazyColumn(
        Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(9.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(rows, key = { it.id }) { note ->
            NoteRow(note, state.selectedNoteId == note.id) { viewModel.selectNote(note.id) }
        }
        if (state.notes.size < state.notesTotal) {
            item {
                OutlinedButton(
                    onClick = viewModel::loadMoreNotes,
                    enabled = !state.loadingMore,
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) {
                    if (state.loadingMore) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Text("تحميل المزيد")
                }
            }
        }
    }
}

@Composable
private fun NoteRow(note: ConsignmentNoteSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
    ) {
        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(note.noteNumber, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                StatusPill(note.type.label, noteTypeColor(note.type))
            }
            Text(note.consignorName, style = MaterialTheme.typography.bodyLarge)
            Text(note.createdAt ?: "—", color = MutedInk, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun NoteDetailPane(state: OperationsUiState, viewModel: OperationsViewModel, modifier: Modifier) {
    Surface(modifier, color = Color.White, shape = RoundedCornerShape(28.dp)) {
        Box(Modifier.fillMaxSize()) {
            when (val detail = state.noteDetail) {
                OperationsDetailState.None -> EmptyPane("اختر سنداً لعرض التفاصيل")
                OperationsDetailState.Loading -> LoadingPane()
                is OperationsDetailState.Error -> RetryPane { state.selectedNoteId?.let(viewModel::selectNote) }
                is OperationsDetailState.Content -> NoteDetailContent(detail.value, state, viewModel)
            }
        }
    }
}

@Composable
private fun NoteDetailContent(
    detail: ConsignmentNoteDetail,
    state: OperationsUiState,
    viewModel: OperationsViewModel,
) {
    val note = detail.summary
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(22.dp),
        verticalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(note.type.label, color = Emerald, style = MaterialTheme.typography.labelLarge)
                    Text(note.noteNumber, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                }
                StatusPill(note.type.label, noteTypeColor(note.type))
            }
        }
        item {
            DetailCard("المودع والسند", Icons.Rounded.Person) {
                ValueLine("المودع", note.consignorName)
                ValueLine("الفرع", note.branchId.toString())
                ValueLine("التاريخ", note.createdAt ?: "—")
                ValueLine("المرفق", if (detail.hasAttachment) "موجود" else "لا يوجد")
                detail.notes?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
        }
        if (detail.limitedToScopedSummary) {
            item { ScopeNotice("بيانات السند الأساسية ضمن نطاق صلاحيتك.") }
        } else if (detail.lines.isNotEmpty()) {
            item {
                DetailCard("الحركات", Icons.Rounded.Inventory2) {
                    detail.lines.forEachIndexed { index, line ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(line.productName, style = MaterialTheme.typography.titleMedium)
                                Text(line.sku ?: "—", color = MutedInk)
                            }
                            StatusPill(if (line.directionIn) "داخل" else "خارج", if (line.directionIn) Emerald else Orange)
                        }
                        ValueLine("الكمية", line.quantity)
                        if (index < detail.lines.lastIndex) HorizontalDivider(color = Stroke)
                    }
                }
            }
        }
        if (OperationsPolicy.canCreateFollowUpNote(note, state.capabilities, state.scope)) {
            item {
                Button(onClick = viewModel::openQuickNote, enabled = state.busyKey == null, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text("سند جديد لنفس المودع")
                }
            }
        }
    }
}

@Composable
private fun MaintenanceDialog(
    onDismiss: () -> Unit,
    onSubmit: (String, String?, String?, String?) -> Unit,
) {
    var type by rememberSaveable { mutableStateOf("") }
    var vendor by rememberSaveable { mutableStateOf("") }
    var date by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    val dateValid = date.isBlank() || Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(date)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("صيانة دون مصروف", modifier = Modifier.semantics { heading() }) },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 560.dp)
                    .verticalScroll(rememberScrollState())
                    .imePadding(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("تغيّر حالة الأصل فقط. الصيانة المدفوعة تُنفّذ من المسار المالي المعتمد.", color = MutedInk)
                OutlinedTextField(type, { type = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("نوع الصيانة") })
                OutlinedTextField(vendor, { vendor = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("الجهة المنفذة — اختياري") })
                ArabicDatePicker(date, { date = it }, "التاريخ — اختياري")
                OutlinedTextField(note, { note = it.take(500) }, Modifier.fillMaxWidth(), label = { Text("ملاحظة") }, minLines = 2)
            }
        },
        confirmButton = {
            Button(onClick = { onSubmit(type, vendor.ifBlank { null }, note.ifBlank { null }, date.ifBlank { null }) }, enabled = type.isNotBlank() && dateValid) {
                Text("متابعة")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } },
    )
}

@Composable
private fun QuickConsignmentDialog(state: OperationsUiState, viewModel: OperationsViewModel) {
    var type by rememberSaveable { mutableStateOf(ConsignmentNoteType.Deposit) }
    var selectedProduct by rememberSaveable { mutableStateOf<Long?>(null) }
    var quantity by rememberSaveable { mutableStateOf("") }
    var notes by rememberSaveable { mutableStateOf("") }
    val products = when (val value = state.quickProducts) {
        is OperationsDetailState.Content -> value.value
        else -> emptyList()
    }
    val quantityValid = OperationsValidation.isPositiveQuantity(quantity)
    AlertDialog(
        onDismissRequest = viewModel::dismissQuickNote,
        title = { Text("سند سريع لنفس المودع", modifier = Modifier.semantics { heading() }) },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 560.dp)
                    .verticalScroll(rememberScrollState())
                    .imePadding(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(ConsignmentNoteType.Deposit, ConsignmentNoteType.Withdraw).forEach { option ->
                        FilterChip(type == option, { type = option }, label = { Text(option.label) })
                    }
                }
                when (val value = state.quickProducts) {
                    OperationsDetailState.None,
                    OperationsDetailState.Loading,
                    -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                    is OperationsDetailState.Error -> Text(value.message, color = MaterialTheme.colorScheme.error)
                    is OperationsDetailState.Content -> if (value.value.isEmpty()) {
                        Text("لا توجد أصناف أمانة فعالة لهذا المودع", color = MutedInk)
                    } else {
                        LazyColumn(Modifier.height(180.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            items(value.value, key = { it.variantId }) { product ->
                                FilterChip(
                                    selected = selectedProduct == product.variantId,
                                    onClick = { selectedProduct = product.variantId },
                                    label = { Text(productLabel(product), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                }
                OutlinedTextField(
                    quantity,
                    { quantity = it.take(16) },
                    Modifier.fillMaxWidth().testTag("quick_consignment_quantity"),
                    label = { Text("الكمية") },
                    isError = quantity.isNotBlank() && !quantityValid,
                    singleLine = true,
                )
                OutlinedTextField(notes, { notes = it.take(500) }, Modifier.fillMaxWidth(), label = { Text("ملاحظة") })
            }
        },
        confirmButton = {
            val product = products.firstOrNull { it.variantId == selectedProduct }
            Button(
                onClick = { product?.let { viewModel.requestQuickNote(type, it, quantity, notes.ifBlank { null }) } },
                enabled = product != null && quantityValid && state.busyKey == null,
            ) { Text("مراجعة") }
        },
        dismissButton = { TextButton(onClick = viewModel::dismissQuickNote) { Text("رجوع") } },
    )
}

@Composable
private fun ActionConfirmation(
    action: PendingOperationsAction,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val (title, description) = when (action) {
        is PendingOperationsAction.ReturnAsset -> "إعادة الأصل" to "تأكيد إعادة ${action.asset.name} إلى الخدمة؟"
        is PendingOperationsAction.StartMaintenance -> "تسجيل الصيانة" to "تسجيل صيانة صفرية وتحويل ${action.asset.name} إلى حالة الصيانة؟"
        is PendingOperationsAction.CreateAsset -> "إنشاء أصل" to
            "إنشاء «${action.input.name}» بقيمة ${formatMoney(action.input.purchaseValue)} وترحيل قيد الاقتناء؟"
        is PendingOperationsAction.UpdateAsset -> "تعديل الأصل" to
            "حفظ تعديلات ${action.asset.name}؟ قد يعيد الخادم قيد الاقتناء ويصحح الإهلاك عند تغير البيانات المالية."
        is PendingOperationsAction.HandoverAsset -> "تسليم العهدة" to
            "نقل عهدة ${action.asset.name} إلى ${action.employeeName}؟"
        is PendingOperationsAction.ReleaseAssetCustody -> "استرجاع العهدة" to
            "إغلاق عهدة ${action.asset.name} الحالية وإعادته إلى الشركة بلا موظف مسؤول؟"
        is PendingOperationsAction.DisposeAsset -> if (action.input.status == AssetStatus.Disposed) {
            "استبعاد الأصل" to "استبعاد ${action.asset.name} وترحيل النقد والربح أو الخسارة؟ لا يمكن التراجع."
        } else {
            "إخراج الأصل" to "إخراج ${action.asset.name} من الخدمة وشطب قيمته المتبقية؟ لا يمكن التراجع."
        }
        is PendingOperationsAction.AddAssetDocument -> "رفع مستند" to
            "إرفاق «${action.title}» بالأصل ${action.asset.name}؟"
        is PendingOperationsAction.DeleteAssetDocument -> "حذف المستند" to
            "حذف «${action.document.title}» نهائياً من ${action.asset.name}؟"
        is PendingOperationsAction.PostDepreciation -> "ترحيل الإهلاك" to
            "ترحيل إهلاك ${action.year}-${action.month.toString().padStart(2, '0')} للأصول ضمن نطاق الفرع؟"
        is PendingOperationsAction.CreateConsignment -> "إنشاء سند ${action.type.label}" to
            "${action.product.productName} — كمية ${action.quantity}. ستُسجّل حركة مخزون فعلية."
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, modifier = Modifier.semantics { heading() }) },
        text = { Text(description) },
        confirmButton = { Button(onClick = onConfirm, modifier = Modifier.testTag("confirm_operations_action")) { Text("تأكيد") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } },
    )
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit, label: String, scanField: NativeScanField? = null) {
    OutlinedTextField(
        value,
        onValueChange,
        Modifier.fillMaxWidth().testTag("operations_search"),
        leadingIcon = { Icon(Icons.Rounded.Search, null) },
        trailingIcon = { scanField?.let { NativeScannerAction(it, onValueChange) } },
        label = { Text(label) },
        singleLine = true,
        shape = RoundedCornerShape(18.dp),
    )
}

@Composable
private fun DetailCard(title: String, icon: ImageVector, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Canvas), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(icon, null, tint = Emerald)
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            }
            content()
        }
    }
}

@Composable
private fun ValueLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MutedInk, style = MaterialTheme.typography.bodyMedium)
        Text(rtlIsolate(value), Modifier.weight(.58f), fontWeight = FontWeight.Bold, textAlign = TextAlign.End, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ScopeNotice(message: String) {
    Card(colors = CardDefaults.cardColors(containerColor = Mint), shape = RoundedCornerShape(18.dp)) {
        Text(message, Modifier.fillMaxWidth().padding(14.dp), color = EmeraldDark, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun StatusPill(label: String, color: Color) {
    Text(
        label,
        Modifier.clip(CircleShape).background(color.copy(alpha = .12f)).padding(horizontal = 10.dp, vertical = 5.dp),
        color = color,
        style = MaterialTheme.typography.labelMedium,
    )
}

@Composable
private fun ColumnScope.LoadingPane(description: String = "جارٍ التحميل") {
    Box(
        Modifier.fillMaxWidth().weight(1f).semantics {
            contentDescription = description
            liveRegion = LiveRegionMode.Polite
        },
        contentAlignment = Alignment.Center,
    ) { CircularProgressIndicator(color = Emerald) }
}

@Composable
private fun ColumnScope.EmptyPane(message: String) {
    Box(Modifier.fillMaxWidth().weight(1f).padding(24.dp), contentAlignment = Alignment.Center) {
        EmptyContent(message)
    }
}

@Composable
private fun ColumnScope.RetryPane(onRetry: () -> Unit) {
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) { RetryButton(onRetry) }
}

@Composable
private fun BoxScope.LoadingPane() {
    CircularProgressIndicator(Modifier.align(Alignment.Center), color = Emerald)
}

@Composable
private fun BoxScope.EmptyPane(message: String) {
    Box(Modifier.align(Alignment.Center).padding(24.dp)) { EmptyContent(message) }
}

@Composable
private fun BoxScope.RetryPane(onRetry: () -> Unit) {
    Box(Modifier.align(Alignment.Center)) { RetryButton(onRetry) }
}

@Composable
private fun EmptyContent(message: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Icon(Icons.Rounded.Inventory2, null, tint = MutedInk, modifier = Modifier.size(42.dp))
        Text(message, color = MutedInk, textAlign = TextAlign.Center)
    }
}

@Composable
private fun RetryButton(onRetry: () -> Unit) {
    Button(onClick = onRetry, modifier = Modifier.height(52.dp)) {
        Icon(Icons.Rounded.Refresh, null)
        Spacer(Modifier.width(7.dp))
        Text("إعادة المحاولة")
    }
}

private fun statusColor(status: AssetStatus): Color = when (status) {
    AssetStatus.Active -> Emerald
    AssetStatus.Maintenance -> Orange
    AssetStatus.Retired -> MutedInk
    AssetStatus.Disposed,
    AssetStatus.Unknown,
    -> Color(0xFFB3261E)
}

private fun noteTypeColor(type: ConsignmentNoteType): Color = when (type) {
    ConsignmentNoteType.Deposit -> Emerald
    ConsignmentNoteType.Withdraw -> Orange
    ConsignmentNoteType.Exchange -> Color(0xFF4054B2)
    ConsignmentNoteType.Unknown -> Color(0xFFB3261E)
}

private fun productLabel(product: ConsignorProduct): String = listOfNotNull(
    product.productName,
    product.color,
    product.sku,
    product.unitName,
).joinToString(" · ")

private fun formatMoney(value: String): String {
    val amount = value.toDoubleOrNull() ?: return "$value د.ع"
    return "${NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ")).format(amount)} د.ع"
}

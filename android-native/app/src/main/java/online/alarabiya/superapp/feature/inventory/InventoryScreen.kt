package online.alarabiya.superapp.feature.inventory

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.CompareArrows
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.Inventory
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.LocalShipping
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.SyncAlt
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.inventory.AdjustmentDraft
import online.alarabiya.superapp.model.inventory.AdjustmentRequest
import online.alarabiya.superapp.model.inventory.AdjustmentStatus
import online.alarabiya.superapp.model.inventory.CountAssignment
import online.alarabiya.superapp.model.inventory.CountSession
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.inventory.InventoryMovement
import online.alarabiya.superapp.model.inventory.InventorySection
import online.alarabiya.superapp.model.inventory.MovementType
import online.alarabiya.superapp.model.inventory.ReceiveDraft
import online.alarabiya.superapp.model.inventory.StockBalance
import online.alarabiya.superapp.model.inventory.StocktakeDetail
import online.alarabiya.superapp.model.inventory.StocktakeDraft
import online.alarabiya.superapp.model.inventory.StocktakeStatus
import online.alarabiya.superapp.model.inventory.StocktakeSummary
import online.alarabiya.superapp.model.inventory.TransferDetail
import online.alarabiya.superapp.model.inventory.TransferDraft
import online.alarabiya.superapp.model.inventory.TransferStatus
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

private val Positive = Color(0xFF0A7A63)
private val Warning = Color(0xFFC45C16)
private val TransferReasons = listOf("REBALANCE", "STOCKOUT", "BRANCH_REQ", "SEASONAL", "RETURN_HQ", "OTHER")

data class InventoryActions(
    val selectSection: (InventorySection) -> Unit,
    val refresh: () -> Unit,
    val clearFeedback: () -> Unit,
    val setBalanceQuery: (String) -> Unit,
    val searchBalances: () -> Unit,
    val toggleLowOnly: () -> Unit,
    val beginTransfer: (StockBalance) -> Unit,
    val beginAdjustment: (StockBalance) -> Unit,
    val setMovementQuery: (String) -> Unit,
    val searchMovements: () -> Unit,
    val setMovementType: (MovementType?) -> Unit,
    val loadMoreMovements: () -> Unit,
    val setTransferQuery: (String) -> Unit,
    val searchTransfers: () -> Unit,
    val setTransferStatus: (TransferStatus?) -> Unit,
    val loadMoreTransfers: () -> Unit,
    val selectTransfer: (Long) -> Unit,
    val closeTransferDetail: () -> Unit,
    val updateTransferDraft: (TransferDraft) -> Unit,
    val closeTransferDraft: () -> Unit,
    val saveTransfer: () -> Unit,
    val beginReceive: () -> Unit,
    val updateReceiveDraft: (ReceiveDraft) -> Unit,
    val closeReceiveDraft: () -> Unit,
    val saveReceive: () -> Unit,
    val cancelTransfer: () -> Unit,
    val setAdjustmentStatus: (AdjustmentStatus) -> Unit,
    val updateAdjustmentDraft: (AdjustmentDraft) -> Unit,
    val closeAdjustmentDraft: () -> Unit,
    val saveAdjustment: () -> Unit,
    val approveAdjustment: (Long) -> Unit,
    val beginRejectAdjustment: (Long) -> Unit,
    val setRejectionReason: (String) -> Unit,
    val closeRejectAdjustment: () -> Unit,
    val confirmRejectAdjustment: () -> Unit,
    val setStocktakeStatus: (StocktakeStatus?) -> Unit,
    val selectStocktake: (Long) -> Unit,
    val closeStocktakeDetail: () -> Unit,
    val beginStocktake: () -> Unit,
    val updateStocktakeDraft: (StocktakeDraft) -> Unit,
    val closeStocktakeDraft: () -> Unit,
    val saveStocktake: () -> Unit,
    val beginRecount: (Long) -> Unit,
    val setRecountReason: (String) -> Unit,
    val closeRecount: () -> Unit,
    val confirmRecount: () -> Unit,
    val forceReview: () -> Unit,
    val firstSign: () -> Unit,
    val approveStocktake: () -> Unit,
    val setCancelStocktakeReason: (String) -> Unit,
    val cancelStocktake: () -> Unit,
    val refreshCountAssignments: () -> Unit,
    val selectCount: (String) -> Unit,
    val closeCount: () -> Unit,
    val setCountQuery: (String) -> Unit,
    val submitCount: (Long, String) -> Unit,
    val finishCount: () -> Unit,
)

@Composable
fun InventoryRoute(viewModel: InventoryViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    InventoryScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = InventoryActions(
            viewModel::selectSection, viewModel::initialize, viewModel::clearFeedback,
            viewModel::setBalanceQuery, viewModel::searchBalances, viewModel::toggleLowOnly,
            viewModel::beginTransfer, viewModel::beginAdjustment,
            viewModel::setMovementQuery, viewModel::searchMovements, viewModel::setMovementType,
            viewModel::loadMoreMovements, viewModel::setTransferQuery, viewModel::searchTransfers,
            viewModel::setTransferStatus, viewModel::loadMoreTransfers, viewModel::selectTransfer,
            viewModel::closeTransferDetail, viewModel::updateTransferDraft, viewModel::closeTransferDraft,
            viewModel::saveTransfer, viewModel::beginReceive, viewModel::updateReceiveDraft,
            viewModel::closeReceiveDraft, viewModel::saveReceive, viewModel::cancelTransfer,
            viewModel::setAdjustmentStatus, viewModel::updateAdjustmentDraft, viewModel::closeAdjustmentDraft,
            viewModel::saveAdjustment, viewModel::approveAdjustment, viewModel::beginRejectAdjustment,
            viewModel::setRejectionReason, viewModel::closeRejectAdjustment, viewModel::confirmRejectAdjustment,
            viewModel::setStocktakeStatus, viewModel::selectStocktake, viewModel::closeStocktakeDetail,
            viewModel::beginStocktake, viewModel::updateStocktakeDraft, viewModel::closeStocktakeDraft,
            viewModel::saveStocktake, viewModel::beginRecount, viewModel::setRecountReason,
            viewModel::closeRecount, viewModel::confirmRecount, viewModel::forceReview,
            viewModel::firstSign, viewModel::approveStocktake, viewModel::setCancelStocktakeReason,
            viewModel::cancelStocktake, viewModel::refreshCountAssignments, viewModel::selectCount,
            viewModel::closeCount, viewModel::setCountQuery, viewModel::submitCount, viewModel::finishCount,
        ),
        modifier = modifier,
    )
}

@Composable
fun InventoryScreen(
    state: InventoryUiState,
    capabilities: InventoryCapabilities,
    actions: InventoryActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        InventoryHeader(capabilities, state, actions.refresh)
        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(capabilities.visibleSections) { section ->
                FilterChip(
                    selected = state.section == section,
                    onClick = { actions.selectSection(section) },
                    label = { Text(section.label()) },
                    leadingIcon = { Icon(section.icon(), null) },
                )
            }
        }
        state.message?.let { FeedbackBar(it, false, actions.clearFeedback) }
        state.error?.let { FeedbackBar(it, true, actions.clearFeedback) }
        if (state.initializing) LinearProgressIndicator(Modifier.fillMaxWidth())
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val tablet = maxWidth >= 840.dp
            when (state.section) {
                InventorySection.BALANCES -> BalancesPane(state, capabilities, actions, tablet)
                InventorySection.MOVEMENTS -> MovementsPane(state, actions)
                InventorySection.TRANSFERS -> TransfersPane(state, capabilities, actions, tablet)
                InventorySection.ADJUSTMENTS -> AdjustmentsPane(state, capabilities, actions)
                InventorySection.STOCKTAKES -> StocktakesPane(state, capabilities, actions, tablet)
                InventorySection.MY_COUNTS -> CountPane(state, actions, tablet)
            }
            state.busyKey?.let {
                Surface(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(18.dp),
                    color = MaterialTheme.colorScheme.inverseSurface,
                    shape = RoundedCornerShape(24.dp),
                    shadowElevation = 8.dp,
                ) {
                    Row(Modifier.padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(10.dp)); Text("جارٍ مزامنة البيانات", color = MaterialTheme.colorScheme.inverseOnSurface)
                    }
                }
            }
        }
    }
}

@Composable
private fun InventoryHeader(capabilities: InventoryCapabilities, state: InventoryUiState, refresh: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(bottomStart = 38.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(start = 18.dp, end = 22.dp, top = 20.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("المخزون والعمليات", style = MaterialTheme.typography.headlineMedium, color = Color.White, fontWeight = FontWeight.Bold)
                Text(
                    capabilities.branchId?.let { "نطاق الفرع المرتبط بالجلسة · ${if (capabilities.canWrite) "تشغيل كامل" else "عرض"}" }
                        ?: "لا يوجد فرع تشغيلي مرتبط",
                    color = Color.White.copy(alpha = .76f),
                )
            }
            IconButton(onClick = refresh, enabled = !state.initializing && state.busyKey == null) {
                Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White)
            }
        }
    }
}

@Composable
private fun BalancesPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions, tablet: Boolean) {
    val low = state.balances.count { it.isLow }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SummaryStrip(
                listOf("الأصناف" to state.balances.size.toString(), "منخفض" to low.toString(), "الصلاحية" to if (capabilities.canWrite) "كاملة" else "قراءة"),
                tablet,
            )
        }
        item {
            SearchField(state.balanceQuery, actions.setBalanceQuery, actions.searchBalances, "اسم الصنف أو SKU", NativeScanField.SKU_OR_BARCODE)
            Spacer(Modifier.height(8.dp))
            FilterChip(selected = state.lowOnly, onClick = actions.toggleLowOnly, label = { Text("دون حد إعادة الطلب") }, leadingIcon = { Icon(Icons.Rounded.FilterAlt, null) })
        }
        if (state.balances.isEmpty()) item { EmptyCard("لا توجد أرصدة مطابقة") }
        items(state.balances, key = { it.variantId }) { balance -> BalanceCard(balance, capabilities.canWrite, actions) }
    }
}

@Composable
private fun BalanceCard(item: StockBalance, writable: Boolean, actions: InventoryActions) {
    OperationalCard(accent = if (item.isLow) Warning else Positive) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(item.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(item.sku, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            MetricPill(item.quantity.toString(), if (item.isLow) "منخفض" else "متاح", item.isLow)
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            SmallMetric("الحد الأدنى", item.minimum.toString())
            SmallMetric("إعادة الطلب", item.reorderPoint.toString())
            SmallMetric("آخر جرد", compactDate(item.lastCountedAt))
        }
        if (writable) {
            Spacer(Modifier.height(12.dp)); HorizontalDivider()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { actions.beginAdjustment(item) }) { Icon(Icons.Rounded.EditNote, null); Spacer(Modifier.width(6.dp)); Text("طلب تسوية") }
                Button(onClick = { actions.beginTransfer(item) }) { Icon(Icons.Rounded.SyncAlt, null); Spacer(Modifier.width(6.dp)); Text("تحويل") }
            }
        }
    }
}

@Composable
private fun MovementsPane(state: InventoryUiState, actions: InventoryActions) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { SearchField(state.movementQuery, actions.setMovementQuery, actions.searchMovements, "صنف، SKU أو مرجع", NativeScanField.SKU_OR_BARCODE) }
        item { EnumFilters(listOf(null, MovementType.IN, MovementType.OUT, MovementType.TRANSFER_IN, MovementType.TRANSFER_OUT, MovementType.ADJUST), state.movementType, actions.setMovementType) { it?.movementLabel() ?: "الكل" } }
        if (state.movements.rows.isEmpty()) item { EmptyCard("لا توجد حركات مطابقة") }
        items(state.movements.rows, key = { it.id }) { MovementCard(it) }
        if (state.movements.hasMore) item { FullWidthOutline("عرض المزيد", actions.loadMoreMovements) }
    }
}

@Composable
private fun MovementCard(item: InventoryMovement) {
    OperationalCard(accent = if (item.quantity >= 0) Positive else Warning) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) { Text(item.productName, fontWeight = FontWeight.Bold); Text("${item.sku} · ${item.type.movementLabel()}", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(if (item.quantity > 0) "+${item.quantity}" else item.quantity.toString(), style = MaterialTheme.typography.titleLarge, color = if (item.quantity >= 0) Positive else Warning, fontWeight = FontWeight.Bold)
        }
        item.relatedBranchName?.let { Text("الفرع المرتبط: $it", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(compactDate(item.at)); Text(item.createdByName ?: "عملية نظام") }
    }
}

@Composable
private fun TransfersPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions, tablet: Boolean) {
    val detail: @Composable () -> Unit = {
        when {
            state.transferDraft != null -> TransferEditor(state, capabilities, actions)
            state.selectedTransfer != null -> TransferDetailPane(state, capabilities, actions)
            else -> EmptyCard("اختر سنداً لعرض تفاصيله")
        }
    }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.weight(.9f).fillMaxHeight()) { TransferList(state, actions) }
        Box(Modifier.weight(1.1f).fillMaxHeight()) { detail() }
    } else if (state.selectedTransfer != null || state.transferDraft != null) {
        Box(Modifier.fillMaxSize().padding(18.dp)) { detail() }
    } else Box(Modifier.fillMaxSize()) { TransferList(state, actions) }
}

@Composable
private fun TransferList(state: InventoryUiState, actions: InventoryActions) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { SearchField(state.transferQuery, actions.setTransferQuery, actions.searchTransfers, "رقم السند أو الفرع", NativeScanField.DOCUMENT_REFERENCE) }
        item { EnumFilters(listOf(null, TransferStatus.IN_TRANSIT, TransferStatus.RECEIVED, TransferStatus.CANCELLED), state.transferStatus, actions.setTransferStatus) { it?.transferLabel() ?: "الكل" } }
        if (state.transfers.rows.isEmpty()) item { EmptyCard("لا توجد تحويلات مطابقة") }
        items(state.transfers.rows, key = { it.id }) { transfer ->
            OperationalCard(accent = statusColor(transfer.status)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(transfer.number, fontWeight = FontWeight.Bold); StatusPill(transfer.status.transferLabel(), statusColor(transfer.status)) }
                Text("${transfer.fromBranchName} ← ${transfer.toBranchName}")
                Text("${transfer.linesCount} أصناف · ${transfer.sent} وحدة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { actions.selectTransfer(transfer.id) }, modifier = Modifier.align(Alignment.End)) { Text("التفاصيل") }
            }
        }
        if (state.transfers.nextCursor != null) item { FullWidthOutline("عرض المزيد", actions.loadMoreTransfers) }
    }
}

@Composable
private fun TransferEditor(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    val draft = requireNotNull(state.transferDraft)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle("تحويل جديد", actions.closeTransferDraft) }
        item { ReadOnlyField("الصنف", draft.itemLabel) }
        item {
            Text("الفرع المستلم", fontWeight = FontWeight.SemiBold)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.branches.filter { it.id != capabilities.branchId }, key = { it.id }) { branch ->
                    FilterChip(selected = draft.toBranchId == branch.id, onClick = { actions.updateTransferDraft(draft.copy(toBranchId = branch.id)) }, label = { Text(branch.name) })
                }
            }
        }
        item { FormField("الكمية", draft.quantity) { actions.updateTransferDraft(draft.copy(quantity = it)) } }
        item {
            Text("سبب التحويل", fontWeight = FontWeight.SemiBold)
            EnumFilters(TransferReasons, draft.reason, { actions.updateTransferDraft(draft.copy(reason = it)) }, ::transferReasonLabel)
        }
        item { FormField("ملاحظات", draft.notes, 3) { actions.updateTransferDraft(draft.copy(notes = it)) } }
        item { Button(onClick = actions.saveTransfer, modifier = Modifier.fillMaxWidth()) { Text("إنشاء سند التحويل") } }
    }
}

@Composable
private fun TransferDetailPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    val detail = requireNotNull(state.selectedTransfer)
    val receive = state.receiveDraft
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle(detail.number, actions.closeTransferDetail) }
        item {
            OperationalCard(statusColor(detail.status)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("${detail.fromBranchName} ← ${detail.toBranchName}", fontWeight = FontWeight.Bold); StatusPill(detail.status.transferLabel(), statusColor(detail.status)) }
                Text("أنشأه ${detail.createdByName ?: "—"} · ${compactDate(detail.createdAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        items(detail.lines, key = { it.id }) { line ->
            OperationalCard(MaterialTheme.colorScheme.primary) {
                Text(line.label, fontWeight = FontWeight.Bold)
                val lineDraft = receive?.lines?.firstOrNull { it.lineId == line.id }
                if (lineDraft == null) Text("المرسل ${line.quantitySent} · المستلم ${line.quantityReceived ?: "—"}")
                else {
                    FormField("الكمية المستلمة من ${line.quantitySent}", lineDraft.quantity) { value -> actions.updateReceiveDraft(receive.copy(lines = receive.lines.map { if (it.lineId == line.id) it.copy(quantity = value) else it })) }
                    FormField("ملاحظة الفرق", lineDraft.note) { value -> actions.updateReceiveDraft(receive.copy(lines = receive.lines.map { if (it.lineId == line.id) it.copy(note = value) else it })) }
                }
            }
        }
        item {
            if (receive != null) {
                FormField("ملاحظات الاستلام", receive.notes, 2) { actions.updateReceiveDraft(receive.copy(notes = it)) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = actions.closeReceiveDraft, modifier = Modifier.weight(1f)) { Text("إلغاء") }
                    Button(onClick = actions.saveReceive, modifier = Modifier.weight(1f)) { Text("تأكيد الاستلام") }
                }
            } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (capabilities.canCancel(detail)) OutlinedButton(onClick = actions.cancelTransfer, modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("إلغاء السند") }
                if (capabilities.canReceive(detail)) Button(onClick = actions.beginReceive, modifier = Modifier.weight(1f)) { Text("استلام") }
            }
        }
    }
}

@Composable
private fun AdjustmentsPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    val draft = state.adjustmentDraft
    if (draft != null) LazyColumn(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle("طلب تسوية", actions.closeAdjustmentDraft) }
        item { ReadOnlyField("الصنف", draft.itemLabel) }
        item { FormField("الرصيد المستهدف", draft.targetQuantity) { actions.updateAdjustmentDraft(draft.copy(targetQuantity = it)) } }
        item { FormField("سبب التسوية", draft.notes, 3) { actions.updateAdjustmentDraft(draft.copy(notes = it)) } }
        item { Button(onClick = actions.saveAdjustment, modifier = Modifier.fillMaxWidth()) { Text("إرسال للاعتماد") } }
    } else LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { EnumFilters(listOf(AdjustmentStatus.PENDING_APPROVAL, AdjustmentStatus.APPROVED, AdjustmentStatus.REJECTED), state.adjustmentStatus, actions.setAdjustmentStatus) { it.adjustmentLabel() } }
        if (state.adjustments.isEmpty()) item { EmptyCard("لا توجد طلبات في هذه الحالة") }
        items(state.adjustments, key = { it.id }) { request -> AdjustmentCard(request, state, capabilities, actions) }
    }
}

@Composable
private fun AdjustmentCard(request: AdjustmentRequest, state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    OperationalCard(statusColor(request.status)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(request.productName, fontWeight = FontWeight.Bold); StatusPill(request.status.adjustmentLabel(), statusColor(request.status)) }
        Text("${request.sku} · من ${request.currentQuantity} إلى ${request.targetQuantity}")
        Text("بواسطة ${request.createdByName ?: "—"}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.rejectingAdjustmentId == request.id) {
            FormField("سبب الرفض", state.rejectionReason, 2, actions.setRejectionReason)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton(actions.closeRejectAdjustment, Modifier.weight(1f)) { Text("رجوع") }; Button(actions.confirmRejectAdjustment, Modifier.weight(1f)) { Text("تأكيد الرفض") } }
        } else if (capabilities.canManage && request.status == AdjustmentStatus.PENDING_APPROVAL) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton({ actions.beginRejectAdjustment(request.id) }, Modifier.weight(1f)) { Text("رفض") }; Button({ actions.approveAdjustment(request.id) }, Modifier.weight(1f)) { Text("اعتماد") } }
        }
    }
}

@Composable
private fun StocktakesPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions, tablet: Boolean) {
    val detail: @Composable () -> Unit = { when { state.stocktakeDraft != null -> StocktakeEditor(state.stocktakeDraft, actions); state.selectedStocktake != null -> StocktakeDetailPane(state, capabilities, actions); else -> EmptyCard("اختر جلسة لعرض سير الجرد") } }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) { Box(Modifier.weight(.9f)) { StocktakeList(state, capabilities, actions) }; Box(Modifier.weight(1.1f)) { detail() } }
    else if (state.stocktakeDraft != null || state.selectedStocktake != null) Box(Modifier.fillMaxSize().padding(18.dp)) { detail() }
    else Box(Modifier.fillMaxSize()) { StocktakeList(state, capabilities, actions) }
}

@Composable
private fun StocktakeList(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                EnumFilters(listOf(null, StocktakeStatus.COUNTING, StocktakeStatus.REVIEW, StocktakeStatus.APPROVED), state.stocktakeStatus, actions.setStocktakeStatus) { it?.stocktakeLabel() ?: "الكل" }
                if (capabilities.canCreateStocktake) IconButton(actions.beginStocktake) { Icon(Icons.Rounded.Add, "جلسة جرد") }
            }
        }
        if (state.stocktakes.isEmpty()) item { EmptyCard("لا توجد جلسات جرد") }
        items(state.stocktakes, key = { it.id }) { item ->
            OperationalCard(statusColor(item.status)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(item.name, fontWeight = FontWeight.Bold); StatusPill(item.status.stocktakeLabel(), statusColor(item.status)) }
                Text("${item.code} · ${item.scopeLabel}")
                ProgressLine(item.countedCount, item.itemCount)
                TextButton(onClick = { actions.selectStocktake(item.id) }, modifier = Modifier.align(Alignment.End)) { Text("متابعة") }
            }
        }
    }
}

@Composable
private fun StocktakeEditor(draft: StocktakeDraft?, actions: InventoryActions) {
    requireNotNull(draft)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle("جلسة جرد جديدة", actions.closeStocktakeDraft) }
        item { FormField("اسم الجلسة", draft.name) { actions.updateStocktakeDraft(draft.copy(name = it)) } }
        item { EnumFilters(listOf("FULL", "MOVING"), draft.scopeType, { actions.updateStocktakeDraft(draft.copy(scopeType = it)) }) { if (it == "FULL") "شامل" else "أصناف متحركة" } }
        if (draft.scopeType == "MOVING") item { FormField("عدد أيام الحركة", draft.movingDays) { actions.updateStocktakeDraft(draft.copy(movingDays = it)) } }
        item { FormField("ملاحظات", draft.notes, 3) { actions.updateStocktakeDraft(draft.copy(notes = it)) } }
        item { InfoCard("الجلسة عمياء؛ لا تظهر الأرصدة المتوقعة للعادّ، وسيتم تكليف حسابك الحالي فقط.") }
        item { Button(actions.saveStocktake, Modifier.fillMaxWidth()) { Text("إنشاء الجلسة") } }
    }
}

@Composable
private fun StocktakeDetailPane(state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    val detail = requireNotNull(state.selectedStocktake)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle(detail.summary.name, actions.closeStocktakeDetail) }
        item { OperationalCard(statusColor(detail.summary.status)) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(detail.summary.code, fontWeight = FontWeight.Bold); StatusPill(detail.summary.status.stocktakeLabel(), statusColor(detail.summary.status)) }; Text("${detail.summary.branchName} · ${detail.summary.scopeLabel}"); ProgressLine(detail.counted, detail.total) } }
        items(detail.assignments, key = { it.id }) { assignment -> OperationalCard(MaterialTheme.colorScheme.primary) { Text(assignment.name, fontWeight = FontWeight.Bold); Text("${assignment.status} · ${assignment.counted} معدود") } }
        if (detail.recentCounts.isNotEmpty()) item { SectionLabel("آخر عمليات العد") }
        items(detail.recentCounts, key = { "${it.variantId}:${it.at}" }) { count ->
            OperationalCard(Positive) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(count.productName, Modifier.weight(1f), fontWeight = FontWeight.Bold); Text(count.quantity.toString(), style = MaterialTheme.typography.titleLarge) }
                Text("${count.byName ?: "—"} · ${compactDate(count.at)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (capabilities.canManage && detail.summary.status == StocktakeStatus.COUNTING) TextButton(onClick = { actions.beginRecount(count.variantId) }, modifier = Modifier.align(Alignment.End)) { Text("إعادة عد") }
            }
        }
        if (state.recountVariantId != null) item { FormField("سبب إعادة العد", state.recountReason, 2, actions.setRecountReason); Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton(actions.closeRecount, Modifier.weight(1f)) { Text("إلغاء") }; Button(actions.confirmRecount, Modifier.weight(1f)) { Text("إرسال") } } }
        item { StocktakeActions(detail, state, capabilities, actions) }
    }
}

@Composable
private fun StocktakeActions(detail: StocktakeDetail, state: InventoryUiState, capabilities: InventoryCapabilities, actions: InventoryActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (capabilities.canManage && detail.summary.status == StocktakeStatus.COUNTING) Button(actions.forceReview, Modifier.fillMaxWidth()) { Text("نقل للمراجعة") }
        if (capabilities.canManage && detail.summary.status == StocktakeStatus.REVIEW) {
            OutlinedButton(actions.firstSign, Modifier.fillMaxWidth()) { Text("التوقيع الأول") }
            Button(actions.approveStocktake, Modifier.fillMaxWidth()) { Text("اعتماد الجرد") }
        }
        if (capabilities.canCancelStocktake && detail.summary.status !in setOf(StocktakeStatus.APPROVED, StocktakeStatus.CANCELLED)) {
            FormField("سبب الإلغاء (اختياري)", state.cancelStocktakeReason, 2, actions.setCancelStocktakeReason)
            TextButton(actions.cancelStocktake, Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("إلغاء الجلسة") }
        }
    }
}

@Composable
private fun CountPane(state: InventoryUiState, actions: InventoryActions, tablet: Boolean) {
    val session = state.selectedCount
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.weight(.8f)) { CountAssignments(state.countAssignments, actions) }
        Box(Modifier.weight(1.2f)) { if (session == null) EmptyCard("اختر تكليف عد") else CountSessionPane(session, state, actions) }
    } else if (session == null) CountAssignments(state.countAssignments, actions) else Box(Modifier.fillMaxSize().padding(18.dp)) { CountSessionPane(session, state, actions) }
}

@Composable
private fun CountAssignments(items: List<CountAssignment>, actions: InventoryActions) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { SectionLabel("تكليفاتي"); IconButton(actions.refreshCountAssignments) { Icon(Icons.Rounded.Refresh, "تحديث") } } }
        if (items.isEmpty()) item { EmptyCard("لا توجد جلسات عد مسندة إليك") }
        items(items, key = { it.assignmentId }) { item -> OperationalCard(Positive) { Text(item.sessionName, fontWeight = FontWeight.Bold); Text("${item.sessionCode} · ${item.zone ?: "كل النطاق"}"); TextButton(onClick = { actions.selectCount(item.sessionCode) }, modifier = Modifier.align(Alignment.End)) { Text("بدء العد") } } }
    }
}

@Composable
private fun CountSessionPane(session: CountSession, state: InventoryUiState, actions: InventoryActions) {
    val filtered = remember(session.items, state.countQuery) { session.items.filter { state.countQuery.isBlank() || it.label.contains(state.countQuery, true) } }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { PaneTitle(session.name, actions.closeCount); Text("${session.branchName} · ${session.assignmentName}", color = MaterialTheme.colorScheme.onSurfaceVariant); ProgressLine(session.counted, session.total); Spacer(Modifier.height(8.dp)); SearchField(state.countQuery, actions.setCountQuery, {}, "اسم الصنف أو SKU", NativeScanField.SKU_OR_BARCODE) }
        items(filtered, key = { it.variantId }) { item ->
            var quantity by remember(item.variantId, item.myQuantity) { mutableStateOf(item.myQuantity?.toString().orEmpty()) }
            OperationalCard(if (item.recountReason != null) Warning else if (item.counted) Positive else MaterialTheme.colorScheme.outline) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(item.label, Modifier.weight(1f), fontWeight = FontWeight.Bold); if (item.counted) Icon(Icons.Rounded.CheckCircle, "معدود", tint = Positive) }
                item.recountReason?.let { Text("إعادة عد: $it", color = Warning) }
                FormField("الكمية الفعلية", quantity) { quantity = it }
                Button(onClick = { actions.submitCount(item.variantId, quantity) }, modifier = Modifier.align(Alignment.End)) { Text(if (item.counted) "تحديث العد" else "حفظ العد") }
            }
        }
        item { Button(actions.finishCount, Modifier.fillMaxWidth(), enabled = session.counted >= session.total && session.total > 0) { Icon(Icons.Rounded.TaskAlt, null); Spacer(Modifier.width(6.dp)); Text("تسليم العد") } }
    }
}

@Composable
private fun SearchField(value: String, change: (String) -> Unit, search: () -> Unit, label: String, scanField: NativeScanField? = null) {
    OutlinedTextField(
        value = value, onValueChange = change, modifier = Modifier.fillMaxWidth(), singleLine = true,
        label = { Text(label) },
        trailingIcon = {
            Row {
                scanField?.let { field -> NativeScannerAction(field, { scanned -> change(scanned); search() }) }
                IconButton(search) { Icon(Icons.Rounded.Search, "بحث") }
            }
        },
        shape = RoundedCornerShape(18.dp),
    )
}

@Composable
private fun FormField(label: String, value: String, lines: Int = 1, change: (String) -> Unit) {
    OutlinedTextField(value, change, Modifier.fillMaxWidth(), label = { Text(label) }, minLines = lines, maxLines = lines.coerceAtLeast(1), shape = RoundedCornerShape(16.dp))
}

@Composable
private fun ReadOnlyField(label: String, value: String) { Column { Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) } }

@Composable
private fun <T> EnumFilters(values: List<T>, selected: T, choose: (T) -> Unit, label: (T) -> String) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(values) { value -> FilterChip(selected = selected == value, onClick = { choose(value) }, label = { Text(label(value)) }) } }
}

@Composable
private fun OperationalCard(accent: Color, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 26.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 26.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), elevation = CardDefaults.cardElevation(1.dp)) {
        Box(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp), content = content)
            Box(Modifier.matchParentSize()) {
                Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(4.dp).background(accent))
            }
        }
    }
}

@Composable
private fun SummaryStrip(values: List<Pair<String, String>>, tablet: Boolean) {
    if (tablet) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) { values.forEach { (label, value) -> SummaryCard(label, value, Modifier.weight(1f)) } }
    else LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) { items(values) { (label, value) -> SummaryCard(label, value, Modifier.width(132.dp)) } }
}

@Composable private fun SummaryCard(label: String, value: String, modifier: Modifier) { Surface(modifier, color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(22.dp)) { Column(Modifier.padding(16.dp)) { Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary); Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun MetricPill(value: String, label: String, warning: Boolean) { Surface(color = (if (warning) Warning else Positive).copy(alpha = .1f), shape = RoundedCornerShape(18.dp)) { Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) { Text(value, fontWeight = FontWeight.Bold, color = if (warning) Warning else Positive); Text(label, style = MaterialTheme.typography.labelMedium) } } }
@Composable private fun SmallMetric(label: String, value: String) { Column { Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, fontWeight = FontWeight.SemiBold) } }
@Composable private fun StatusPill(text: String, color: Color) { Surface(color = color.copy(alpha = .12f), shape = RoundedCornerShape(14.dp)) { Text(text, Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold) } }
@Composable private fun ProgressLine(value: Int, total: Int) { Column { LinearProgressIndicator(progress = { if (total <= 0) 0f else (value.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth()); Text("$value من $total", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable private fun PaneTitle(title: String, back: () -> Unit) { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { IconButton(back) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع") }; Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) } }
@Composable private fun SectionLabel(text: String) { Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
@Composable private fun FullWidthOutline(text: String, action: () -> Unit) { OutlinedButton(action, Modifier.fillMaxWidth()) { Text(text) } }
@Composable private fun EmptyCard(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .55f), shape = RoundedCornerShape(24.dp)) { Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Rounded.Inventory2, null, tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.height(8.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun InfoCard(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(18.dp)) { Text(text, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onPrimaryContainer) } }

@Composable
private fun FeedbackBar(text: String, error: Boolean, dismiss: () -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle, null, tint = if (error) MaterialTheme.colorScheme.error else Positive)
            Spacer(Modifier.width(8.dp)); Text(text, Modifier.weight(1f)); IconButton(dismiss) { Icon(Icons.Rounded.Close, "إغلاق") }
        }
    }
}

private fun InventorySection.label() = when (this) { InventorySection.BALANCES -> "الأرصدة"; InventorySection.MOVEMENTS -> "الحركات"; InventorySection.TRANSFERS -> "التحويلات"; InventorySection.ADJUSTMENTS -> "التسويات"; InventorySection.STOCKTAKES -> "الجرد"; InventorySection.MY_COUNTS -> "تكليفاتي" }
private fun InventorySection.icon(): ImageVector = when (this) { InventorySection.BALANCES -> Icons.Rounded.Inventory2; InventorySection.MOVEMENTS -> Icons.AutoMirrored.Rounded.CompareArrows; InventorySection.TRANSFERS -> Icons.Rounded.LocalShipping; InventorySection.ADJUSTMENTS -> Icons.Rounded.EditNote; InventorySection.STOCKTAKES -> Icons.Rounded.Inventory; InventorySection.MY_COUNTS -> Icons.Rounded.TaskAlt }
private fun MovementType.movementLabel() = when (this) { MovementType.IN -> "إدخال"; MovementType.OUT -> "إخراج"; MovementType.ADJUST -> "تسوية"; MovementType.RETURN -> "مرتجع"; MovementType.TRANSFER_IN -> "تحويل وارد"; MovementType.TRANSFER_OUT -> "تحويل صادر"; MovementType.UNKNOWN -> "غير مصنف" }
private fun TransferStatus.transferLabel() = when (this) { TransferStatus.IN_TRANSIT -> "قيد النقل"; TransferStatus.RECEIVED -> "مستلم"; TransferStatus.CANCELLED -> "ملغي"; TransferStatus.UNKNOWN -> "غير معروف" }
private fun AdjustmentStatus.adjustmentLabel() = when (this) { AdjustmentStatus.PENDING_APPROVAL -> "بانتظار الاعتماد"; AdjustmentStatus.APPROVED -> "معتمد"; AdjustmentStatus.REJECTED -> "مرفوض"; AdjustmentStatus.UNKNOWN -> "غير معروف" }
private fun StocktakeStatus.stocktakeLabel() = when (this) { StocktakeStatus.COUNTING -> "قيد العد"; StocktakeStatus.REVIEW -> "مراجعة"; StocktakeStatus.APPROVED -> "معتمد"; StocktakeStatus.CANCELLED -> "ملغي"; StocktakeStatus.UNKNOWN -> "غير معروف" }
private fun transferReasonLabel(reason: String) = when (reason) { "REBALANCE" -> "إعادة توزيع"; "STOCKOUT" -> "نفاد"; "BRANCH_REQ" -> "طلب فرع"; "SEASONAL" -> "موسمي"; "RETURN_HQ" -> "إرجاع للرئيسي"; else -> "أخرى" }
private fun statusColor(status: TransferStatus) = when (status) { TransferStatus.IN_TRANSIT -> Warning; TransferStatus.RECEIVED -> Positive; else -> Color(0xFF77727D) }
private fun statusColor(status: AdjustmentStatus) = when (status) { AdjustmentStatus.PENDING_APPROVAL -> Warning; AdjustmentStatus.APPROVED -> Positive; AdjustmentStatus.REJECTED -> Color(0xFFB3261E); else -> Color(0xFF77727D) }
private fun statusColor(status: StocktakeStatus) = when (status) { StocktakeStatus.COUNTING -> Warning; StocktakeStatus.REVIEW -> Color(0xFF4968A5); StocktakeStatus.APPROVED -> Positive; else -> Color(0xFF77727D) }
private fun compactDate(value: String?): String = value?.replace('T', ' ')?.take(16) ?: "—"

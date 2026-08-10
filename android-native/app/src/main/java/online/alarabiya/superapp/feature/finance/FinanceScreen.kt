package online.alarabiya.superapp.feature.finance

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.AccountBalance
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CreditCard
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Wallet
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.finance.AccountSummary
import online.alarabiya.superapp.model.finance.CardMovement
import online.alarabiya.superapp.model.finance.CashTransferSummary
import online.alarabiya.superapp.model.finance.ExpenseSummary
import online.alarabiya.superapp.model.finance.FinanceAccessPolicy
import online.alarabiya.superapp.model.finance.FinanceItemKey
import online.alarabiya.superapp.model.finance.FinanceSection
import online.alarabiya.superapp.model.finance.MoneyText
import online.alarabiya.superapp.model.finance.VoucherSummary

private val FinanceInk = Color(0xFF362087)
private val FinanceMint = Color(0xFF5B36D2)
private val FinanceOrange = Color(0xFFEC2F86)

@Composable
fun FinanceRoute(viewModel: FinanceViewModel, modifier: Modifier = Modifier) {
    FinanceScreen(
        state = viewModel.state,
        policy = viewModel.accessPolicy,
        onSection = viewModel::setSection,
        onRefresh = viewModel::refresh,
        onLoadMore = viewModel::loadMore,
        onSelect = viewModel::select,
        onOpenComposer = viewModel::openComposer,
        onUpdateComposer = viewModel::updateComposer,
        onCloseComposer = viewModel::closeComposer,
        onRequestCreate = viewModel::requestCreate,
        onCancelConfirmation = viewModel::cancelConfirmation,
        onConfirmCreate = viewModel::confirmCreate,
        onRequestTransferAction = viewModel::requestTransferAction,
        onUpdateTransferReason = viewModel::updateTransferReason,
        onConfirmTransferAction = viewModel::confirmTransferAction,
        onClearMessage = viewModel::clearMessage,
        modifier = modifier,
    )
}

@Composable
fun FinanceScreen(
    state: FinanceUiState,
    policy: FinanceAccessPolicy,
    onSection: (FinanceSection) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onSelect: (FinanceItemKey?) -> Unit,
    onOpenComposer: (FinanceComposerKind) -> Unit,
    onUpdateComposer: ((FinanceDraft) -> FinanceDraft) -> Unit,
    onCloseComposer: () -> Unit,
    onRequestCreate: () -> Unit,
    onCancelConfirmation: () -> Unit,
    onConfirmCreate: () -> Unit,
    onRequestTransferAction: (FinanceItemKey, TransferAction) -> Unit,
    onUpdateTransferReason: (String) -> Unit,
    onConfirmTransferAction: () -> Unit,
    onClearMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(
            modifier = modifier.fillMaxSize(),
            floatingActionButton = {
                composerFor(state.section, policy)?.takeIf { state.canWrite(state.section) }?.let { kind ->
                    FloatingActionButton(
                        onClick = { onOpenComposer(kind) },
                        containerColor = FinanceOrange,
                        contentColor = Color.White,
                    ) { Icon(Icons.Rounded.Add, contentDescription = "إضافة") }
                }
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                FinanceHeader(state, onRefresh, policy.canFundTreasury && state.canWrite(FinanceSection.OVERVIEW)) {
                    onOpenComposer(FinanceComposerKind.FUNDING)
                }
                FinanceTabs(policy.readableSections, state.section, onSection)
                AnimatedVisibility(state.notice != null) {
                    MessageBar(state.notice.orEmpty(), false, onClearMessage)
                }
                AnimatedVisibility(state.error != null && !state.loading) {
                    MessageBar(state.error.orEmpty(), true, onClearMessage)
                }
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val wide = maxWidth >= 760.dp
                    when {
                        !policy.canRead(state.section) -> AccessDenied()
                        state.loading -> LoadingState()
                        wide -> WideFinanceContent(
                            state, policy, onSelect, onRequestTransferAction, onLoadMore,
                            Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
                        )
                        else -> CompactFinanceContent(
                            state, policy, onSelect, onRequestTransferAction, onLoadMore,
                            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }

        state.composer?.let { draft ->
            FinanceComposerDialog(
                draft = draft,
                canSelectBranch = policy.canSelectBranch || policy.branchId == null,
                error = state.error,
                onUpdate = onUpdateComposer,
                onDismiss = onCloseComposer,
                onContinue = onRequestCreate,
            )
        }
        state.createConfirmation?.let {
            CreateConfirmationDialog(it, state.submitting, onCancelConfirmation, onConfirmCreate)
        }
        state.transferConfirmation?.let {
            TransferActionDialog(
                pending = it,
                submitting = state.submitting,
                onReason = onUpdateTransferReason,
                onDismiss = onCancelConfirmation,
                onConfirm = onConfirmTransferAction,
            )
        }
    }
}

@Composable
private fun FinanceHeader(
    state: FinanceUiState,
    onRefresh: () -> Unit,
    canFund: Boolean,
    onFund: () -> Unit,
) {
    Surface(
        color = FinanceInk,
        contentColor = Color.White,
        shape = RoundedCornerShape(bottomStart = 52.dp, bottomEnd = 18.dp),
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 18.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(50.dp).background(Color.White.copy(alpha = .1f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.AccountBalance, contentDescription = null) }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text("المركز المالي", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(
                        "الخزينة والحركة النقدية في سياق واحد",
                        color = Color.White.copy(alpha = .68f),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (canFund) TextButton(onClick = onFund) { Text("تمويل", color = Color.White) }
                IconButton(onClick = onRefresh, enabled = !state.refreshing) {
                    if (state.refreshing) CircularProgressIndicator(
                        Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White,
                    ) else Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
                }
            }
            state.overview?.let { overview ->
                Spacer(Modifier.height(18.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    item { HeaderMetric("مقبوضات اليوم", overview.todayReceipts, true, Modifier.width(158.dp)) }
                    item { HeaderMetric("مصروفات اليوم", overview.todayExpenses, false, Modifier.width(158.dp)) }
                    item { HeaderCount("وارد معلّق", overview.pendingIncomingTransfers, Modifier.width(120.dp)) }
                }
            }
        }
    }
}

@Composable
private fun HeaderMetric(label: String, value: MoneyText, positive: Boolean, modifier: Modifier) {
    Surface(modifier, shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp), color = Color.White.copy(alpha = .08f)) {
        Column(Modifier.padding(12.dp)) {
            Text(label, color = Color.White.copy(alpha = .62f), style = MaterialTheme.typography.bodySmall)
            Text("${value.value} د.ع", fontWeight = FontWeight.Bold, color = if (positive) Color(0xFF65D6B9) else Color(0xFFFFB37A))
        }
    }
}

@Composable
private fun HeaderCount(label: String, value: Int, modifier: Modifier) {
    Surface(modifier, shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp), color = Color.White.copy(alpha = .08f)) {
        Column(Modifier.padding(12.dp)) {
            Text(label, color = Color.White.copy(alpha = .62f), style = MaterialTheme.typography.bodySmall)
            Text(value.toString(), fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun FinanceTabs(available: Set<FinanceSection>, selected: FinanceSection, onSection: (FinanceSection) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(FinanceSection.entries.filter(available::contains)) { section ->
            FilterChip(
                selected = selected == section,
                onClick = { onSection(section) },
                label = { Text(section.label) },
                leadingIcon = { Icon(section.icon(), contentDescription = null, Modifier.size(18.dp)) },
            )
        }
    }
}

@Composable
private fun WideFinanceContent(
    state: FinanceUiState,
    policy: FinanceAccessPolicy,
    onSelect: (FinanceItemKey?) -> Unit,
    onAction: (FinanceItemKey, TransferAction) -> Unit,
    onLoadMore: () -> Unit,
    modifier: Modifier,
) {
    if (state.section == FinanceSection.OVERVIEW) {
        OverviewContent(state, modifier)
        return
    }
    Row(modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        FinanceList(state, onSelect, onLoadMore, Modifier.weight(.44f).fillMaxHeight())
        Surface(
            modifier = Modifier.weight(.56f).fillMaxHeight(),
            shape = RoundedCornerShape(topStart = 36.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 36.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            FinanceDetail(state, policy, onAction, Modifier.padding(24.dp))
        }
    }
}

@Composable
private fun CompactFinanceContent(
    state: FinanceUiState,
    policy: FinanceAccessPolicy,
    onSelect: (FinanceItemKey?) -> Unit,
    onAction: (FinanceItemKey, TransferAction) -> Unit,
    onLoadMore: () -> Unit,
    modifier: Modifier,
) {
    if (state.section == FinanceSection.OVERVIEW) {
        OverviewContent(state, modifier)
        return
    }
    AnimatedContent(state.selectedKey, label = "finance-detail") { selected ->
        if (selected == null) FinanceList(state, onSelect, onLoadMore, modifier.fillMaxSize())
        else Column(modifier.fillMaxSize()) {
            TextButton(onClick = { onSelect(null) }) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("العودة إلى القائمة")
            }
            Surface(
                Modifier.fillMaxSize(),
                shape = RoundedCornerShape(topStart = 36.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 36.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLow,
            ) { FinanceDetail(state, policy, onAction, Modifier.padding(22.dp)) }
        }
    }
}

@Composable
private fun OverviewContent(state: FinanceUiState, modifier: Modifier) {
    val overview = state.overview
    if (overview == null) {
        EmptyState("لا تتوفر بيانات خزينة حالياً", modifier)
        return
    }
    LazyColumn(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("أرصدة الفروع", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("القيم المعروضة آتية مباشرة من حالة الصناديق والخزائن", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(overview.branches, key = { it.branchId }) { branch ->
            Card(
                shape = RoundedCornerShape(topStart = 30.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 30.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            ) {
                Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(52.dp).background(FinanceMint.copy(alpha = .11f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Rounded.Wallet, null, tint = FinanceMint) }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(branch.branchName, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                        Text("${branch.openShifts} ورديات مفتوحة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("الصندوق ${branch.drawerBalance.value} د.ع", fontWeight = FontWeight.SemiBold)
                        branch.treasuryBalance?.let { Text("الخزينة ${it.value} د.ع", color = FinanceMint) }
                    }
                }
            }
        }
    }
}

@Composable
private fun FinanceList(
    state: FinanceUiState,
    onSelect: (FinanceItemKey?) -> Unit,
    onLoadMore: () -> Unit,
    modifier: Modifier,
) {
    val entries = financeRows(state)
    Column(modifier) {
        if (state.section == FinanceSection.EXPENSES) {
            Surface(
                Modifier.fillMaxWidth().padding(bottom = 10.dp),
                shape = RoundedCornerShape(18.dp),
                color = FinanceOrange.copy(alpha = .09f),
            ) {
                Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${state.expenseCount} مصروفاً نشطاً")
                    Text("${state.expenseTotal.value} د.ع", color = FinanceOrange, fontWeight = FontWeight.Bold)
                }
            }
        }
        if (state.section == FinanceSection.CARD_ACCOUNT) state.cardSummary?.let {
            Surface(
                Modifier.fillMaxWidth().padding(bottom = 10.dp),
                shape = RoundedCornerShape(topStart = 24.dp, bottomEnd = 24.dp),
                color = FinanceMint.copy(alpha = .09f),
            ) {
                Column(Modifier.padding(14.dp)) {
                    Text("رصيد البطاقة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("${it.balance.value} د.ع", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text("اليوم +${it.todayIn.value}  •  -${it.todayOut.value}", color = FinanceMint)
                }
            }
        }
        if (entries.isEmpty()) EmptyState("لا توجد سجلات في هذا القسم", Modifier.fillMaxSize())
        else LazyColumn(
            verticalArrangement = Arrangement.spacedBy(9.dp),
            contentPadding = PaddingValues(bottom = 92.dp),
        ) {
            items(entries, key = { "${it.key.kind}-${it.key.id}" }) { row ->
                FinanceRowCard(row, row.key == state.selectedKey) { onSelect(row.key) }
            }
            if (state.section in state.hasMoreSections) item {
                TextButton(onClick = onLoadMore, enabled = !state.refreshing, modifier = Modifier.fillMaxWidth()) {
                    if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Text("عرض المزيد")
                }
            }
        }
    }
}

private data class DisplayRow(
    val key: FinanceItemKey,
    val title: String,
    val subtitle: String,
    val amount: String?,
    val status: String,
    val incoming: Boolean?,
)

private fun financeRows(state: FinanceUiState): List<DisplayRow> = when (state.section) {
    FinanceSection.MOVEMENTS -> state.movements.map {
        DisplayRow(it.key, it.reference ?: it.sourceLabel, it.description ?: it.paymentMethod, it.amount.value, it.createdAt, it.direction == "IN")
    }
    FinanceSection.VOUCHERS -> state.vouchers.map {
        DisplayRow(it.key, it.number, it.counterparty ?: it.description.orEmpty(), it.amount.value, it.approvalStatus.ifBlank { it.status }, it.direction == "IN")
    }
    FinanceSection.EXPENSES -> state.expenses.map {
        DisplayRow(it.key, it.category, it.description.orEmpty(), it.amount.value, it.status, false)
    }
    FinanceSection.TRANSFERS -> state.transfers.map {
        DisplayRow(it.key, it.number, "${it.fromBranchName} ← ${it.toBranchName}", it.amount.value, it.status, null)
    }
    FinanceSection.CARD_ACCOUNT -> state.cardMovements.map {
        DisplayRow(it.key, it.reference ?: it.partyName ?: it.source, it.description.orEmpty(), it.amount.value, if (it.reversed) "REVERSED" else it.createdAt, it.direction == "IN")
    }
    FinanceSection.ACCOUNTS -> state.accounts.map {
        DisplayRow(it.key, "${it.code} — ${it.name}", it.type, null, if (it.active) "ACTIVE" else "INACTIVE", null)
    }
    FinanceSection.OVERVIEW -> emptyList()
}

@Composable
private fun FinanceRowCard(row: DisplayRow, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 12.dp, bottomStart = 12.dp, bottomEnd = 24.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) FinanceMint.copy(alpha = .10f) else MaterialTheme.colorScheme.surface,
        ),
    ) {
        Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            val tint = when (row.incoming) { true -> FinanceMint; false -> FinanceOrange; null -> MaterialTheme.colorScheme.primary }
            Box(Modifier.size(42.dp).background(tint.copy(alpha = .10f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(if (row.incoming == false) Icons.Rounded.ArrowUpward else Icons.Rounded.ArrowDownward, null, tint = tint)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(row.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(row.subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(statusLabel(row.status), style = MaterialTheme.typography.bodySmall, color = tint)
            }
            row.amount?.let { Text("$it د.ع", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun FinanceDetail(
    state: FinanceUiState,
    policy: FinanceAccessPolicy,
    onAction: (FinanceItemKey, TransferAction) -> Unit,
    modifier: Modifier,
) {
    val key = state.selectedKey
    if (key == null) {
        EmptyState("اختر سجلاً لعرض تفاصيله", modifier.fillMaxSize())
        return
    }
    LazyColumn(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("تفاصيل العملية", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
        if (state.detailLoadingKey == key) item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("جارٍ تحديث التفاصيل…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        when (state.section) {
            FinanceSection.MOVEMENTS -> state.movements.firstOrNull { it.key == key }?.let { movement ->
                item { DetailHero(movement.sourceLabel, movement.amount, movement.direction == "IN") }
                item { DetailFields(listOf("طريقة الدفع" to movement.paymentMethod, "الفرع" to movement.branchName, "المرجع" to movement.reference, "الوصف" to movement.description, "الوقت" to movement.createdAt)) }
            }
            FinanceSection.VOUCHERS -> state.vouchers.firstOrNull { it.key == key }?.let { voucher ->
                item { DetailHero(voucher.number, voucher.amount, voucher.direction == "IN") }
                item { VoucherFields(voucher) }
                item { SoDBanner() }
            }
            FinanceSection.EXPENSES -> state.expenses.firstOrNull { it.key == key }?.let { expense ->
                item { DetailHero(expense.category, expense.amount, false) }
                item { ExpenseFields(expense) }
            }
            FinanceSection.TRANSFERS -> state.transfers.firstOrNull { it.key == key }?.let { transfer ->
                item { DetailHero(transfer.number, transfer.amount, null) }
                item { TransferFields(transfer) }
                if (policy.canReceive(transfer) || policy.canCancel(transfer)) item {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (policy.canReceive(transfer))
                            Button(onClick = { onAction(key, TransferAction.RECEIVE) }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Rounded.CheckCircle, null); Spacer(Modifier.width(6.dp)); Text("استلام")
                            }
                        if (policy.canCancel(transfer))
                            OutlinedButton(onClick = { onAction(key, TransferAction.CANCEL) }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Rounded.Cancel, null); Spacer(Modifier.width(6.dp)); Text("إلغاء")
                            }
                    }
                }
            }
            FinanceSection.CARD_ACCOUNT -> state.cardMovements.firstOrNull { it.key == key }?.let { card ->
                item { DetailHero(card.reference ?: card.source, card.amount, card.direction == "IN") }
                item { CardFields(card) }
            }
            FinanceSection.ACCOUNTS -> state.accounts.firstOrNull { it.key == key }?.let { account ->
                item { AccountFields(account) }
            }
            FinanceSection.OVERVIEW -> Unit
        }
    }
}

@Composable
private fun DetailHero(title: String, amount: MoneyText, incoming: Boolean?) {
    val color = when (incoming) { true -> FinanceMint; false -> FinanceOrange; null -> MaterialTheme.colorScheme.primary }
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 30.dp, bottomEnd = 30.dp), color = color.copy(alpha = .1f)) {
        Column(Modifier.padding(20.dp)) {
            Text(title, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("${amount.value} د.ع", style = MaterialTheme.typography.headlineMedium, color = color, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable private fun VoucherFields(value: VoucherSummary) = DetailFields(listOf(
    "الحالة" to statusLabel(value.status), "الاعتماد" to statusLabel(value.approvalStatus),
    "طريقة الدفع" to value.paymentMethod, "الطرف" to value.counterparty,
    "الفئة" to value.categoryName, "المرجع" to value.referenceNumber,
    "الفاتورة المرتبطة" to value.invoiceNumber, "أنشأه" to value.createdByName,
    "اعتمده" to value.approvedByName, "الوصف" to value.description,
    "تاريخ السند" to value.voucherDate, "وقت الإنشاء" to value.createdAt,
))

@Composable private fun ExpenseFields(value: ExpenseSummary) = DetailFields(listOf(
    "الحالة" to statusLabel(value.status), "المصدر" to value.source,
    "طريقة الدفع" to value.paymentMethod, "الفرع" to value.branchName,
    "المرجع" to value.reference, "الوصف" to value.description, "التاريخ" to value.expenseDate,
))

@Composable private fun TransferFields(value: CashTransferSummary) = DetailFields(listOf(
    "الحالة" to statusLabel(value.status), "من" to value.fromBranchName, "إلى" to value.toBranchName,
    "الملاحظات" to value.notes, "سبب الإلغاء" to value.cancellationReason, "وقت الإرسال" to value.sentAt,
))

@Composable private fun CardFields(value: CardMovement) = DetailFields(listOf(
    "الاتجاه" to statusLabel(value.direction), "الفرع" to value.branchName,
    "الطرف" to value.partyName, "آخر أرقام البطاقة" to value.cardLastFour,
    "الرصيد بعد الحركة" to value.runningBalance?.value, "الوصف" to value.description,
    "المصدر" to value.source, "وقت الحركة" to value.createdAt,
))

@Composable private fun AccountFields(value: AccountSummary) {
    Text(value.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    DetailFields(listOf("الرمز" to value.code, "النوع" to value.type, "الدور النظامي" to value.systemRole, "الحالة" to if (value.active) "نشط" else "غير نشط"))
}

@Composable
private fun DetailFields(fields: List<Pair<String, String?>>) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(18.dp)) {
            fields.filter { !it.second.isNullOrBlank() }.forEachIndexed { index, (label, value) ->
                if (index > 0) HorizontalDivider(Modifier.padding(vertical = 10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(value.orEmpty(), fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 12.dp))
                }
            }
        }
    }
}

@Composable
private fun SoDBanner() {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = FinanceOrange.copy(alpha = .08f)) {
        Text(
            "اعتماد السندات منفصل عن الإنشاء ويُنفّذ من مركز الاعتمادات وفق فصل المهام.",
            Modifier.padding(14.dp), color = FinanceOrange,
        )
    }
}

@Composable
private fun FinanceComposerDialog(
    draft: FinanceDraft,
    canSelectBranch: Boolean,
    error: String?,
    onUpdate: ((FinanceDraft) -> FinanceDraft) -> Unit,
    onDismiss: () -> Unit,
    onContinue: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(composerTitle(draft.kind), fontWeight = FontWeight.Bold) },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item {
                    OutlinedTextField(
                        value = draft.branchId,
                        onValueChange = { value -> onUpdate { it.copy(branchId = value.filter(Char::isDigit)) } },
                        label = { Text("معرّف الفرع") },
                        enabled = canSelectBranch,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (draft.kind == FinanceComposerKind.TRANSFER) item {
                    OutlinedTextField(
                        value = draft.targetBranchId,
                        onValueChange = { value -> onUpdate { it.copy(targetBranchId = value.filter(Char::isDigit)) } },
                        label = { Text("معرّف الفرع المستلم") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = draft.amount,
                        onValueChange = { value -> onUpdate { it.copy(amount = value.filter { ch -> ch.isDigit() || ch == '.' }) } },
                        label = { Text("المبلغ") },
                        suffix = { Text("د.ع") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (draft.kind == FinanceComposerKind.VOUCHER) {
                    item { ChoiceRow("نوع السند", listOf("RECEIPT" to "قبض", "PAYMENT" to "صرف"), draft.voucherType) { value -> onUpdate { it.copy(voucherType = value) } } }
                    item { ChoiceRow("طريقة الدفع", listOf("CASH" to "نقد", "CARD" to "بطاقة", "TRANSFER" to "تحويل", "WALLET" to "محفظة"), draft.paymentMethod) { value -> onUpdate { it.copy(paymentMethod = value) } } }
                }
                if (draft.kind == FinanceComposerKind.EXPENSE) item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ChoiceRow("الفئة", listOf(
                            "RENT" to "إيجار", "UTILITIES" to "خدمات", "SUPPLIES" to "مستلزمات",
                            "SALARY" to "رواتب", "TRANSPORT" to "نقل", "MAINTENANCE" to "صيانة",
                            "MARKETING" to "تسويق", "OTHER" to "أخرى",
                        ), draft.secondaryText) { value -> onUpdate { it.copy(secondaryText = value) } }
                        ChoiceRow("طريقة الدفع", listOf("CASH" to "نقد", "CARD" to "بطاقة", "TRANSFER" to "تحويل", "WALLET" to "محفظة", "CHECK" to "شيك"), draft.paymentMethod) { value -> onUpdate { it.copy(paymentMethod = value) } }
                    }
                }
                if (draft.kind != FinanceComposerKind.TRANSFER) item {
                    OutlinedTextField(
                        value = draft.description,
                        onValueChange = { value -> onUpdate { it.copy(description = value.take(500)) } },
                        label = { Text(if (draft.kind == FinanceComposerKind.FUNDING) "مبرر التمويل" else "الوصف") },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (draft.kind != FinanceComposerKind.EXPENSE) item {
                    OutlinedTextField(
                        value = draft.secondaryText,
                        onValueChange = { value -> onUpdate { it.copy(secondaryText = value.take(500)) } },
                        label = { Text(secondaryLabel(draft.kind)) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (draft.kind == FinanceComposerKind.TRANSFER) item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(draft.confirmNegative, { value -> onUpdate { it.copy(confirmNegative = value) } })
                        Text("أؤكد المتابعة إذا أصبح رصيد المصدر سالباً")
                    }
                }
                if (!error.isNullOrBlank()) item { Text(error, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { Button(onClick = onContinue) { Text("مراجعة") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun ChoiceRow(label: String, choices: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(choices) { (value, text) ->
                FilterChip(selected == value, { onSelect(value) }, { Text(text) })
            }
        }
    }
}

@Composable
private fun CreateConfirmationDialog(
    draft: FinanceDraft,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        icon = { Icon(Icons.Rounded.Payments, null, tint = FinanceOrange) },
        title = { Text("تأكيد العملية المالية") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(composerTitle(draft.kind), fontWeight = FontWeight.Bold)
                Text("${MoneyText.parseUnsigned(draft.amount)?.value ?: draft.amount} د.ع")
                Text("الفرع ${draft.branchId}${if (draft.targetBranchId.isNotBlank()) " ← ${draft.targetBranchId}" else ""}")
                Text("سيُرسل الطلب مرة واحدة بمفتاح آمن لمنع التكرار.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = !submitting) {
                if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("تأكيد")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !submitting) { Text("رجوع") } },
    )
}

@Composable
private fun TransferActionDialog(
    pending: PendingTransferAction,
    submitting: Boolean,
    onReason: (String) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        title = { Text(if (pending.action == TransferAction.RECEIVE) "تأكيد استلام التحويل" else "تأكيد إلغاء التحويل") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("ستُحدّث هذه العملية الحالة المالية الفعلية ولا يمكن تنفيذها من شاشة النظام المكتبي.")
                if (pending.action == TransferAction.CANCEL) OutlinedTextField(
                    value = pending.reason,
                    onValueChange = onReason,
                    label = { Text("سبب الإلغاء") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = { Button(onClick = onConfirm, enabled = !submitting) { Text("تأكيد") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !submitting) { Text("رجوع") } },
    )
}

@Composable
private fun MessageBar(message: String, error: Boolean, onDismiss: () -> Unit) {
    val color = if (error) MaterialTheme.colorScheme.error else FinanceMint
    Surface(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), shape = RoundedCornerShape(14.dp), color = color.copy(alpha = .1f)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, Modifier.weight(1f), color = color)
            TextButton(onClick = onDismiss) { Text("إغلاق", color = color) }
        }
    }
}

@Composable private fun LoadingState() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
@Composable private fun AccessDenied() = EmptyState("لا تملك صلاحية الوصول إلى هذا القسم", Modifier.fillMaxSize())
@Composable private fun EmptyState(message: String, modifier: Modifier) = Box(modifier, contentAlignment = Alignment.Center) { Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant) }

private fun FinanceSection.icon(): ImageVector = when (this) {
    FinanceSection.OVERVIEW -> Icons.Rounded.AccountBalance
    FinanceSection.MOVEMENTS -> Icons.Rounded.Payments
    FinanceSection.VOUCHERS -> Icons.AutoMirrored.Rounded.ReceiptLong
    FinanceSection.EXPENSES -> Icons.Rounded.Wallet
    FinanceSection.TRANSFERS -> Icons.Rounded.SwapHoriz
    FinanceSection.CARD_ACCOUNT -> Icons.Rounded.CreditCard
    FinanceSection.ACCOUNTS -> Icons.Rounded.AccountTree
}

private fun composerFor(section: FinanceSection, policy: FinanceAccessPolicy): FinanceComposerKind? = when {
    section == FinanceSection.VOUCHERS && policy.canWrite(section) -> FinanceComposerKind.VOUCHER
    section == FinanceSection.EXPENSES && policy.canWrite(section) -> FinanceComposerKind.EXPENSE
    section == FinanceSection.TRANSFERS && policy.canWrite(section) -> FinanceComposerKind.TRANSFER
    else -> null
}

private fun composerTitle(kind: FinanceComposerKind) = when (kind) {
    FinanceComposerKind.VOUCHER -> "سند مالي جديد"
    FinanceComposerKind.EXPENSE -> "مصروف جديد"
    FinanceComposerKind.TRANSFER -> "تحويل نقدي جديد"
    FinanceComposerKind.FUNDING -> "تمويل الخزينة"
}

private fun secondaryLabel(kind: FinanceComposerKind) = when (kind) {
    FinanceComposerKind.VOUCHER -> "اسم الطرف (اختياري)"
    FinanceComposerKind.EXPENSE -> "الفئة"
    FinanceComposerKind.TRANSFER -> "ملاحظات (اختياري)"
    FinanceComposerKind.FUNDING -> "ملاحظات (اختياري)"
}

private fun statusLabel(raw: String): String = when (raw.uppercase()) {
    "IN" -> "وارد"
    "OUT" -> "صادر"
    "ACTIVE" -> "نشط"
    "INACTIVE" -> "غير نشط"
    "IN_TRANSIT" -> "قيد النقل"
    "RECEIVED" -> "مستلم"
    "CANCELLED", "CANCELED" -> "ملغي"
    "PENDING" -> "بانتظار الاعتماد"
    "APPROVED" -> "معتمد"
    "REJECTED" -> "مرفوض"
    "REVERSED" -> "معكوسة"
    else -> raw
}

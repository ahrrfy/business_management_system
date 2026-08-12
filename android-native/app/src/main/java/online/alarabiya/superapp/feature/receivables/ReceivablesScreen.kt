package online.alarabiya.superapp.feature.receivables

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.AccountBalance
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.CreditCard
import androidx.compose.material.icons.rounded.EventRepeat
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import online.alarabiya.superapp.model.receivables.AccountGroup
import online.alarabiya.superapp.model.receivables.CardDirection
import online.alarabiya.superapp.model.receivables.CardFilters
import online.alarabiya.superapp.model.receivables.CardMovement
import online.alarabiya.superapp.model.receivables.CardReconciliation
import online.alarabiya.superapp.model.receivables.CardSource
import online.alarabiya.superapp.model.receivables.CardSummary
import online.alarabiya.superapp.model.receivables.DueInstallment
import online.alarabiya.superapp.model.receivables.InstallmentFilters
import online.alarabiya.superapp.model.receivables.InstallmentKind
import online.alarabiya.superapp.model.receivables.InstallmentLine
import online.alarabiya.superapp.model.receivables.InstallmentLineStatus
import online.alarabiya.superapp.model.receivables.InstallmentPaymentMethod
import online.alarabiya.superapp.model.receivables.InstallmentPlanDetail
import online.alarabiya.superapp.model.receivables.InstallmentPlanSummary
import online.alarabiya.superapp.model.receivables.InstallmentStatus
import online.alarabiya.superapp.model.receivables.NewInstallmentLine
import online.alarabiya.superapp.model.receivables.NewInstallmentPlan
import online.alarabiya.superapp.model.receivables.ReceivablesAccessPolicy
import online.alarabiya.superapp.model.receivables.ReceivablesSection
import online.alarabiya.superapp.model.receivables.ReconciliationDraft
import online.alarabiya.superapp.model.receivables.ReminderActionDraft
import online.alarabiya.superapp.model.receivables.ReminderFilter
import online.alarabiya.superapp.model.receivables.ReminderHistoryItem
import online.alarabiya.superapp.model.receivables.ReminderLedger
import online.alarabiya.superapp.model.receivables.ReminderQueueItem
import online.alarabiya.superapp.ui.ltrInputTextStyle
import online.alarabiya.superapp.ui.rtlIsolate

private val ReceivableInk = Color(0xFF362087)
private val ReceivableBlue = Color(0xFF5B36D2)
private val ReceivableMint = Color(0xFF7254DB)
private val ReceivableGold = Color(0xFFEC2F86)

@Composable
fun ReceivablesRoute(
    viewModel: ReceivablesViewModel,
    modifier: Modifier = Modifier,
) {
    ReceivablesScreen(
        state = viewModel.state,
        policy = viewModel.accessPolicy,
        onSection = viewModel::setSection,
        onRefresh = viewModel::refresh,
        onLoadMore = viewModel::loadMore,
        onInstallmentFilters = viewModel::updateInstallmentFilters,
        onApplyInstallments = viewModel::applyInstallmentFilters,
        onSelectPlan = viewModel::selectPlan,
        onOpenNewPlan = viewModel::openNewPlan,
        onUpdateNewPlan = viewModel::updateNewPlan,
        onAddPlanLine = viewModel::addPlanLine,
        onRemovePlanLine = viewModel::removePlanLine,
        onUpdatePlanLine = viewModel::updatePlanLine,
        onRequestCreatePlan = viewModel::requestCreatePlan,
        onRequestPay = viewModel::requestPay,
        onRequestCancelPlan = viewModel::requestCancelPlan,
        onRequestBounce = viewModel::requestBounce,
        onReminderFilter = viewModel::updateReminderFilter,
        onApplyReminders = viewModel::applyReminderFilter,
        onReminderMode = viewModel::setReminderHistoryMode,
        onSelectReminder = viewModel::selectReminder,
        onRequestReminder = viewModel::requestReminder,
        onCardFilters = viewModel::updateCardFilters,
        onApplyCard = viewModel::applyCardFilters,
        onOpenReconciliation = viewModel::openReconciliation,
        onUpdatePending = viewModel::updatePendingAction,
        onConfirm = viewModel::confirmAction,
        onCloseOverlay = viewModel::closeOverlay,
        onClearMessage = viewModel::clearMessage,
        modifier = modifier,
    )
}

@Composable
fun ReceivablesScreen(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    onSection: (ReceivablesSection) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onInstallmentFilters: (InstallmentFilters.() -> InstallmentFilters) -> Unit,
    onApplyInstallments: () -> Unit,
    onSelectPlan: (Long?) -> Unit,
    onOpenNewPlan: () -> Unit,
    onUpdateNewPlan: (NewInstallmentPlan.() -> NewInstallmentPlan) -> Unit,
    onAddPlanLine: () -> Unit,
    onRemovePlanLine: (Int) -> Unit,
    onUpdatePlanLine: (Int, NewInstallmentLine.() -> NewInstallmentLine) -> Unit,
    onRequestCreatePlan: () -> Unit,
    onRequestPay: (InstallmentLine) -> Unit,
    onRequestCancelPlan: () -> Unit,
    onRequestBounce: (InstallmentLine) -> Unit,
    onReminderFilter: (ReminderFilter) -> Unit,
    onApplyReminders: () -> Unit,
    onReminderMode: (Boolean) -> Unit,
    onSelectReminder: (Long?) -> Unit,
    onRequestReminder: (ReminderQueueItem, ReminderActionDraft.Kind) -> Unit,
    onCardFilters: (CardFilters.() -> CardFilters) -> Unit,
    onApplyCard: () -> Unit,
    onOpenReconciliation: () -> Unit,
    onUpdatePending: (ReceivablesPendingAction.() -> ReceivablesPendingAction) -> Unit,
    onConfirm: () -> Unit,
    onCloseOverlay: () -> Unit,
    onClearMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(modifier.fillMaxSize()) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                ReceivablesHeader(state, onRefresh)
                SectionTabs(policy, state.section, onSection)
                AnimatedVisibility(state.notice != null) { MessageStrip(state.notice.orEmpty(), false, onClearMessage) }
                AnimatedVisibility(state.error != null && !state.loading) { MessageStrip(state.error.orEmpty(), true, onClearMessage) }
                when (state.section) {
                    ReceivablesSection.INSTALLMENTS -> InstallmentFilterPanel(
                        state.installmentFilters, policy, onInstallmentFilters, onApplyInstallments,
                    )
                    ReceivablesSection.CUSTOMER_REMINDERS,
                    ReceivablesSection.SUPPLIER_REMINDERS -> ReminderFilterPanel(
                        state, policy, onReminderFilter, onApplyReminders, onReminderMode,
                    )
                    ReceivablesSection.CARD_ACCOUNT -> CardFilterPanel(state.cardFilters, policy, onCardFilters, onApplyCard)
                    ReceivablesSection.ACCOUNTS -> Unit
                }
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val wide = maxWidth >= 780.dp
                    when {
                        !policy.canRead(state.section) -> EmptyState("لا تملك صلاحية الوصول", Modifier.fillMaxSize())
                        state.loading -> LoadingState()
                        !state.isFresh(state.section) -> ReceivablesLoadGate(
                            section = state.section,
                            wasLoaded = state.section in state.loadedSections,
                            retryEnabled = !state.refreshing && !state.loadingMore && !state.submitting && !state.detailLoading,
                            retry = onRefresh,
                        )
                        state.section == ReceivablesSection.INSTALLMENTS -> InstallmentsContent(
                            state, policy, wide, onSelectPlan, onOpenNewPlan, onRequestPay,
                            onRequestCancelPlan, onRequestBounce, onLoadMore,
                        )
                        state.section in setOf(
                            ReceivablesSection.CUSTOMER_REMINDERS,
                            ReceivablesSection.SUPPLIER_REMINDERS,
                        ) -> RemindersContent(state, policy, wide, onSelectReminder, onRequestReminder)
                        state.section == ReceivablesSection.CARD_ACCOUNT -> CardContent(
                            state, policy, wide, onOpenReconciliation, onLoadMore,
                        )
                        else -> AccountsContent(state.accountGroups)
                    }
                }
            }
        }
        state.newPlan?.takeIf {
            state.isFresh(ReceivablesSection.INSTALLMENTS) &&
                state.pendingAction !is ReceivablesPendingAction.CreatePlan
        }?.let { draft ->
            NewPlanDialog(
                draft, state.submitting, onUpdateNewPlan, onAddPlanLine, onRemovePlanLine,
                onUpdatePlanLine, onRequestCreatePlan, onCloseOverlay,
            )
        }
        state.pendingAction?.takeIf { state.isFresh(it.destinationSection()) }?.let { action ->
            ActionDialog(action, state.submitting, onUpdatePending, onConfirm, onCloseOverlay)
        }
    }
}

@Composable
private fun ReceivablesHeader(state: ReceivablesUiState, onRefresh: () -> Unit) {
    Surface(
        color = ReceivableInk,
        contentColor = Color.White,
        shape = RoundedCornerShape(bottomStart = 54.dp, bottomEnd = 18.dp),
        shadowElevation = 8.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 19.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(50.dp).background(Color.White.copy(alpha = .10f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Payments, null)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("مركز الالتزامات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("الأقساط والتحصيل والمطابقة", color = Color.White.copy(alpha = .68f))
            }
            IconButton(onClick = onRefresh, enabled = !state.refreshing && !state.submitting) {
                if (state.refreshing) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                else Icon(Icons.Rounded.Refresh, "تحديث")
            }
        }
    }
}

@Composable
private fun SectionTabs(policy: ReceivablesAccessPolicy, selected: ReceivablesSection, onSection: (ReceivablesSection) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        items(ReceivablesSection.entries.filter(policy::canRead)) { section ->
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
private fun InstallmentFilterPanel(
    filter: InstallmentFilters,
    policy: ReceivablesAccessPolicy,
    onChange: (InstallmentFilters.() -> InstallmentFilters) -> Unit,
    onApply: () -> Unit,
) {
    FilterSurface {
        OutlinedTextField(
            filter.query, { value -> onChange { copy(query = value.take(120)) } },
            Modifier.fillMaxWidth(), label = { Text("بحث بالخطة أو العميل") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) }, singleLine = true,
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item { FilterChip(filter.status == null, { onChange { copy(status = null) } }, { Text("الكل") }) }
            items(InstallmentStatus.entries) { status ->
                FilterChip(filter.status == status, { onChange { copy(status = status) } }, { Text(status.label) })
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 600.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ReceivableCodeField(filter.customerId, { value -> onChange { copy(customerId = value.filter(Char::isDigit)) } }, "معرّف العميل", Modifier.fillMaxWidth(), KeyboardType.Number)
                    if (policy.canFilterBranch) ReceivableCodeField(filter.branchId, { value -> onChange { copy(branchId = value) } }, "الفرع", Modifier.fillMaxWidth(), KeyboardType.Number)
                    ReceivableCodeField(filter.from, { value -> onChange { copy(from = value.take(10)) } }, "من YYYY-MM-DD", Modifier.fillMaxWidth(), KeyboardType.Ascii)
                    ReceivableCodeField(filter.to, { value -> onChange { copy(to = value.take(10)) } }, "إلى YYYY-MM-DD", Modifier.fillMaxWidth(), KeyboardType.Ascii)
                    Button(onClick = onApply, modifier = Modifier.fillMaxWidth()) { Text("تطبيق") }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        ReceivableCodeField(filter.customerId, { value -> onChange { copy(customerId = value.filter(Char::isDigit)) } }, "معرّف العميل", Modifier.weight(1f), KeyboardType.Number)
                        if (policy.canFilterBranch) ReceivableCodeField(filter.branchId, { value -> onChange { copy(branchId = value) } }, "الفرع", Modifier.weight(1f), KeyboardType.Number)
                        Button(onClick = onApply) { Text("تطبيق") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ReceivableCodeField(filter.from, { value -> onChange { copy(from = value.take(10)) } }, "من YYYY-MM-DD", Modifier.weight(1f), KeyboardType.Ascii)
                        ReceivableCodeField(filter.to, { value -> onChange { copy(to = value.take(10)) } }, "إلى YYYY-MM-DD", Modifier.weight(1f), KeyboardType.Ascii)
                    }
                }
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(listOf(0, 7, 30, 90)) { days ->
                FilterChip(
                    filter.dueDays == days,
                    { onChange { copy(dueDays = days) } },
                    { Text(if (days == 0) "المتأخر فقط" else "خلال $days يوم") },
                )
            }
        }
    }
}

@Composable
private fun ReminderFilterPanel(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    onFilter: (ReminderFilter) -> Unit,
    onApply: () -> Unit,
    onMode: (Boolean) -> Unit,
) {
    val isAr = state.section == ReceivablesSection.CUSTOMER_REMINDERS
    val aggregateAllowed = if (isAr) policy.canReadOpeningReceivables else policy.canReadAllPayables
    FilterSurface {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 520.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (policy.canFilterBranch) ReceivableCodeField(
                        state.reminderFilter.branchId,
                        { onFilter(state.reminderFilter.copy(branchId = it)) },
                        "معرّف الفرع",
                        Modifier.fillMaxWidth(),
                        KeyboardType.Number,
                    )
                    if (aggregateAllowed) FilterChip(
                        state.reminderFilter.aggregate,
                        { onFilter(state.reminderFilter.copy(aggregate = !state.reminderFilter.aggregate)) },
                        { Text(if (isAr) "أرصدة افتتاحية" else "كل الفروع") },
                    )
                    Button(onClick = onApply, modifier = Modifier.fillMaxWidth()) { Text("تطبيق") }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (policy.canFilterBranch) ReceivableCodeField(
                        state.reminderFilter.branchId,
                        { onFilter(state.reminderFilter.copy(branchId = it)) },
                        "معرّف الفرع",
                        Modifier.weight(1f),
                        KeyboardType.Number,
                    ) else Spacer(Modifier.weight(1f))
                    if (aggregateAllowed) FilterChip(
                        state.reminderFilter.aggregate,
                        { onFilter(state.reminderFilter.copy(aggregate = !state.reminderFilter.aggregate)) },
                        { Text(if (isAr) "أرصدة افتتاحية" else "كل الفروع") },
                    )
                    Button(onClick = onApply) { Text("تطبيق") }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            FilterChip(!state.reminderHistoryMode, { onMode(false) }, { Text("قائمة اليوم") })
            FilterChip(state.reminderHistoryMode, { onMode(true) }, { Text("السجل") }, leadingIcon = { Icon(Icons.Rounded.History, null) })
        }
        if (!isAr && state.reminderFilter.aggregate) Text(
            "العرض المجمّع للمراجعة فقط؛ يلزم نطاق فرع مثبت قبل أي إجراء.",
            color = ReceivableGold,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
private fun CardFilterPanel(
    filter: CardFilters,
    policy: ReceivablesAccessPolicy,
    onChange: (CardFilters.() -> CardFilters) -> Unit,
    onApply: () -> Unit,
) {
    FilterSurface {
        OutlinedTextField(
            filter.query, { value -> onChange { copy(query = value.take(200)) } }, Modifier.fillMaxWidth(),
            label = { Text("مرجع أو سند أو طرف أو آخر 4 أرقام") }, leadingIcon = { Icon(Icons.Rounded.Search, null) }, singleLine = true,
        )
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 600.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (policy.canFilterBranch) ReceivableCodeField(filter.branchId, { value -> onChange { copy(branchId = value) } }, "الفرع", Modifier.fillMaxWidth(), KeyboardType.Number)
                    ReceivableCodeField(filter.from, { value -> onChange { copy(from = value.take(10)) } }, "من", Modifier.fillMaxWidth(), KeyboardType.Ascii)
                    ReceivableCodeField(filter.to, { value -> onChange { copy(to = value.take(10)) } }, "إلى", Modifier.fillMaxWidth(), KeyboardType.Ascii)
                    Button(onClick = onApply, modifier = Modifier.fillMaxWidth()) { Text("تطبيق") }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (policy.canFilterBranch) ReceivableCodeField(filter.branchId, { value -> onChange { copy(branchId = value) } }, "الفرع", Modifier.weight(1f), KeyboardType.Number)
                    ReceivableCodeField(filter.from, { value -> onChange { copy(from = value.take(10)) } }, "من", Modifier.weight(1f), KeyboardType.Ascii)
                    ReceivableCodeField(filter.to, { value -> onChange { copy(to = value.take(10)) } }, "إلى", Modifier.weight(1f), KeyboardType.Ascii)
                    Button(onClick = onApply) { Text("تطبيق") }
                }
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item { FilterChip(filter.direction == null, { onChange { copy(direction = null) } }, { Text("كل الحركات") }) }
            items(CardDirection.entries) { direction ->
                FilterChip(
                    filter.direction == direction,
                    { onChange { copy(direction = direction) } },
                    { Text(if (direction == CardDirection.IN) "داخل" else "خارج") },
                )
            }
            items(CardSource.entries) { source ->
                FilterChip(filter.source == source, { onChange { copy(source = if (filter.source == source) null else source) } }, { Text(source.label()) })
            }
        }
    }
}

@Composable
private fun ReceivableCodeField(
    value: String,
    onValue: (String) -> Unit,
    label: String,
    modifier: Modifier,
    keyboardType: KeyboardType,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        modifier = modifier,
        label = { Text(label) },
        singleLine = true,
        textStyle = ltrInputTextStyle(),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
    )
}

@Composable
private fun FilterSurface(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
        shape = RoundedCornerShape(topStart = 24.dp, bottomEnd = 24.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
    }
}

@Composable
private fun InstallmentsContent(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    wide: Boolean,
    onSelect: (Long?) -> Unit,
    onNew: () -> Unit,
    onPay: (InstallmentLine) -> Unit,
    onCancel: () -> Unit,
    onBounce: (InstallmentLine) -> Unit,
    onLoadMore: () -> Unit,
) {
    if (wide) Row(Modifier.fillMaxSize().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        InstallmentMaster(state, policy, onSelect, onNew, onLoadMore, Modifier.weight(.43f).fillMaxHeight())
        Surface(
            Modifier.weight(.57f).fillMaxHeight(),
            shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            PlanDetail(state.selectedPlan, state.detailLoading, policy, onPay, onCancel, onBounce, Modifier.padding(18.dp))
        }
    } else AnimatedContent(state.selectedPlanId, label = "installment-detail") { selected ->
        if (selected == null) InstallmentMaster(state, policy, onSelect, onNew, onLoadMore, Modifier.fillMaxSize().padding(horizontal = 14.dp))
        else Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
            TextButton(onClick = { onSelect(null) }) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null); Spacer(Modifier.width(6.dp)); Text("الخطط")
            }
            PlanDetail(state.selectedPlan, state.detailLoading, policy, onPay, onCancel, onBounce, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun InstallmentMaster(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    onSelect: (Long?) -> Unit,
    onNew: () -> Unit,
    onLoadMore: () -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 28.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("قريبة الاستحقاق", state.dueInstallments.size.toString())
                if (policy.canWrite(ReceivablesSection.INSTALLMENTS)) Button(onClick = onNew) {
                    Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(5.dp)); Text("خطة")
                }
            }
        }
        if (state.dueInstallments.isEmpty()) item { CompactEmpty("لا أقساط ضمن نافذة الاستحقاق") }
        items(state.dueInstallments.take(5), key = DueInstallment::lineId) { DueCard(it) }
        if (state.dueInstallments.size >= 200) item { ContractLimitNotice("بلغ طابور الاستحقاق حدّ 200 صف بلا مؤشر صفحة تالية.") }
        item { SectionTitle("خطط الأقساط", state.installmentPlans.size.toString()) }
        if (state.installmentPlans.isEmpty()) item { CompactEmpty("لا توجد خطط مطابقة") }
        items(state.installmentPlans, key = InstallmentPlanSummary::id) { plan ->
            PlanCard(plan, state.selectedPlanId == plan.id) { onSelect(plan.id) }
        }
        if (state.installmentHasMore) item {
            OutlinedButton(onClick = onLoadMore, enabled = !state.loadingMore, modifier = Modifier.fillMaxWidth()) {
                if (state.loadingMore) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("تحميل المزيد")
            }
        }
    }
}

@Composable
private fun DueCard(item: DueInstallment) {
    Card(colors = CardDefaults.cardColors(containerColor = ReceivableGold.copy(alpha = .08f)), shape = RoundedCornerShape(18.dp)) {
        Row(Modifier.fillMaxWidth().padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).background(ReceivableGold.copy(alpha = .12f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Schedule, null, tint = ReceivableGold)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(item.customerName, fontWeight = FontWeight.SemiBold)
                Text("الخطة #${item.planId} • القسط ${item.sequence} • ${item.dueDate}", style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("${item.amount.value} د.ع", fontWeight = FontWeight.Bold)
                Text(if (item.daysOverdue > 0) "متأخر ${item.daysOverdue} يوم" else "قريب", color = ReceivableGold, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun PlanCard(plan: InstallmentPlanSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 24.dp, bottomEnd = 24.dp),
        colors = CardDefaults.cardColors(containerColor = if (selected) ReceivableBlue.copy(alpha = .10f) else MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(plan.customerName, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                StatusPill(plan.status.label, plan.status.color())
            }
            Text("الخطة #${plan.id} • الفرع ${plan.branchId}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${plan.totalAmount.value} د.ع", fontWeight = FontWeight.Bold)
                Text("${plan.paidLines}/${plan.totalLines} أقساط", color = ReceivableMint)
            }
            plan.nextDueDate?.let { Text("الاستحقاق التالي $it", style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun PlanDetail(
    detail: InstallmentPlanDetail?,
    loading: Boolean,
    policy: ReceivablesAccessPolicy,
    onPay: (InstallmentLine) -> Unit,
    onCancel: () -> Unit,
    onBounce: (InstallmentLine) -> Unit,
    modifier: Modifier,
) {
    when {
        loading -> Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        detail == null -> EmptyState("اختر خطة لعرض جدولها", modifier)
        else -> LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column {
                        Text(detail.summary.customerName, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Text("خطة #${detail.summary.id} • ${detail.summary.totalAmount.value} د.ع")
                    }
                    if (policy.canWrite(ReceivablesSection.INSTALLMENTS) && detail.summary.status == InstallmentStatus.ACTIVE) {
                        TextButton(onClick = onCancel) { Icon(Icons.Rounded.Cancel, null); Spacer(Modifier.width(4.dp)); Text("إلغاء") }
                    }
                }
            }
            detail.summary.invoiceId?.let { invoice -> item { InfoLine("الفاتورة المرتبطة", "#$invoice") } }
            item { InfoLine("الدفعة الأولى", "${detail.summary.downPayment.value} د.ع") }
            item { InfoLine("المسدّد", "${detail.summary.paidAmount.value} د.ع") }
            detail.summary.notes?.let { item { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            item { HorizontalDivider(); SectionTitle("جدول الأقساط", detail.lines.size.toString()) }
            items(detail.lines, key = InstallmentLine::id) { line ->
                InstallmentLineCard(line, policy.canWrite(ReceivablesSection.INSTALLMENTS), onPay, onBounce)
            }
        }
    }
}

@Composable
private fun InstallmentLineCard(
    line: InstallmentLine,
    writable: Boolean,
    onPay: (InstallmentLine) -> Unit,
    onBounce: (InstallmentLine) -> Unit,
) {
    Card(shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("القسط ${line.sequence} • ${line.dueDate}", fontWeight = FontWeight.SemiBold)
                StatusPill(line.status.label, line.status.color())
            }
            Text("${line.amount.value} د.ع", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (line.kind == InstallmentKind.CHECK) Text(
                "شيك قديم ${line.checkNumber.orEmpty()} ${line.bankName.orEmpty()}",
                color = ReceivableGold,
                style = MaterialTheme.typography.labelMedium,
            )
            line.receiptId?.let { Text("سند #$it", style = MaterialTheme.typography.bodySmall) }
            if (writable) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (line.status in setOf(InstallmentLineStatus.PENDING, InstallmentLineStatus.BOUNCED)) {
                    Button(onClick = { onPay(line) }) { Text("تسجيل سداد") }
                }
                if (line.kind == InstallmentKind.CHECK && line.status in setOf(InstallmentLineStatus.PENDING, InstallmentLineStatus.PAID)) {
                    OutlinedButton(onClick = { onBounce(line) }) { Text("ارتجاع الشيك") }
                }
            }
        }
    }
}

@Composable
private fun RemindersContent(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    wide: Boolean,
    onSelect: (Long?) -> Unit,
    onRequest: (ReminderQueueItem, ReminderActionDraft.Kind) -> Unit,
) {
    if (state.reminderHistoryMode) {
        ReminderHistoryList(state.reminderHistory, Modifier.fillMaxSize().padding(14.dp))
        return
    }
    val canWrite = policy.canWrite(state.section)
    val visibleQueue = state.visibleReminderQueue
    if (wide) Row(Modifier.fillMaxSize().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        ReminderQueueList(state, onSelect, Modifier.weight(.45f).fillMaxHeight())
        Surface(
            Modifier.weight(.55f).fillMaxHeight(), shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            ReminderDetail(state.selectedReminder, canWrite, state.reminderFilter, onRequest, Modifier.padding(22.dp))
        }
    } else LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item { SectionTitle(state.executiveView?.label ?: "قائمة اليوم", visibleQueue.size.toString()) }
        if (visibleQueue.isEmpty()) item { CompactEmpty("لا توجد متابعة مستحقة اليوم") }
        items(visibleQueue, key = { "${it.subject.ledger}-${it.subject.id}" }) { item ->
            ReminderCard(item, canWrite && reminderScopeWritable(item, state.reminderFilter), onRequest)
        }
    }
}

@Composable
private fun ReminderQueueList(state: ReceivablesUiState, onSelect: (Long?) -> Unit, modifier: Modifier) {
    val visibleQueue = state.visibleReminderQueue
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { SectionTitle(state.executiveView?.label ?: "قائمة اليوم", visibleQueue.size.toString()) }
        if (visibleQueue.isEmpty()) item { CompactEmpty("لا توجد متابعة مستحقة اليوم") }
        items(visibleQueue, key = { "${it.subject.ledger}-${it.subject.id}" }) { item ->
            Card(
                Modifier.fillMaxWidth().clickable { onSelect(item.subject.id) },
                shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (state.selectedReminderId == item.subject.id) ReceivableBlue.copy(alpha = .1f) else MaterialTheme.colorScheme.surface,
                ),
            ) { ReminderCardBody(item) }
        }
    }
}

@Composable
private fun ReceivablesLoadGate(
    section: ReceivablesSection,
    wasLoaded: Boolean,
    retryEnabled: Boolean,
    retry: () -> Unit,
) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .74f),
            shape = RoundedCornerShape(28.dp),
        ) {
            Column(
                Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(Icons.Rounded.WarningAmber, null, tint = ReceivableGold)
                Text(
                    if (wasLoaded) "تحتاج البيانات إلى تحديث" else "تعذر تحميل ${section.label}",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text("لا يمكن تنفيذ إجراء على قائمة أو تفاصيل غير محدثة.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = retry, enabled = retryEnabled) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(8.dp))
                    Text("إعادة المحاولة")
                }
            }
        }
    }
}

private val ExecutiveReceivablesView.label: String
    get() = when (this) {
        ExecutiveReceivablesView.AR_30 -> "ذمم 31–60 يوماً"
        ExecutiveReceivablesView.AR_60 -> "ذمم 61–90 يوماً"
        ExecutiveReceivablesView.AR_90 -> "ذمم أكثر من 90 يوماً"
        ExecutiveReceivablesView.CREDIT_EXPOSURE -> "التعرض الائتماني"
    }

@Composable
private fun ReminderCard(
    item: ReminderQueueItem,
    writable: Boolean,
    onRequest: (ReminderQueueItem, ReminderActionDraft.Kind) -> Unit,
) {
    Card(shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp)) {
        Column {
            ReminderCardBody(item)
            if (writable) {
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onRequest(item, ReminderActionDraft.Kind.SEND_API) }, modifier = Modifier.weight(1f)) {
                        Icon(Icons.AutoMirrored.Rounded.Send, null); Spacer(Modifier.width(4.dp)); Text("إرسال")
                    }
                    OutlinedButton(onClick = { onRequest(item, ReminderActionDraft.Kind.SKIP) }, modifier = Modifier.weight(1f)) { Text("تأجيل") }
                }
            }
        }
    }
}

@Composable
private fun ReminderCardBody(item: ReminderQueueItem) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(44.dp).background((if (item.isPromiseDue) ReceivableGold else ReceivableBlue).copy(alpha = .1f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(if (item.isPromiseDue) Icons.Rounded.EventRepeat else Icons.Rounded.Schedule, null, tint = if (item.isPromiseDue) ReceivableGold else ReceivableBlue) }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(item.subject.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("منذ ${item.daysOverdue} يوم • ${item.oldestDocumentDate}", style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (item.isPromiseDue) Text("وعد مستحق", color = ReceivableGold, style = MaterialTheme.typography.bodySmall)
                if (item.isOpeningBalance) Text("رصيد افتتاحي", color = ReceivableBlue, style = MaterialTheme.typography.bodySmall)
            }
        }
        Text("${item.totalUnpaid.value} د.ع", fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ReminderDetail(
    item: ReminderQueueItem?,
    writable: Boolean,
    filter: ReminderFilter,
    onRequest: (ReminderQueueItem, ReminderActionDraft.Kind) -> Unit,
    modifier: Modifier,
) {
    if (item == null) {
        EmptyState("اختر اسماً لمراجعة الاستحقاق", modifier.fillMaxSize())
        return
    }
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(item.subject.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(item.subject.ledger.label, color = ReceivableBlue)
        InfoLine("المبلغ المثبت", "${item.totalUnpaid.value} د.ع")
        InfoLine("أقدم استحقاق", item.oldestDocumentDate)
        InfoLine("التأخير", "${item.daysOverdue} يوم")
        item.subject.phone?.let { InfoLine("رقم التواصل", it) }
        item.promisedDate?.let { InfoLine("موعد المتابعة", it) }
        Spacer(Modifier.weight(1f))
        if (writable && reminderScopeWritable(item, filter)) {
            Button(onClick = { onRequest(item, ReminderActionDraft.Kind.SEND_API) }, Modifier.fillMaxWidth()) { Text("مراجعة الإرسال") }
            OutlinedButton(onClick = { onRequest(item, ReminderActionDraft.Kind.SKIP) }, Modifier.fillMaxWidth()) { Text("تأجيل المتابعة") }
        } else Text("هذا النطاق للقراءة فقط", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ReminderHistoryList(rows: List<ReminderHistoryItem>, modifier: Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 28.dp)) {
        item { SectionTitle("آخر 30 يوماً", rows.size.toString()) }
        if (rows.isEmpty()) item { CompactEmpty("لا يوجد سجل ضمن النطاق") }
        items(rows, key = ReminderHistoryItem::id) { item ->
            MetricCard(
                icon = if (item.status.name == "SENT") Icons.AutoMirrored.Rounded.Send else Icons.Rounded.History,
                title = item.subject.name,
                subtitle = item.createdAt,
                value = "${item.totalUnpaid.value} د.ع",
                foot = item.skipReason ?: if (item.status.name == "SENT") "تم الإرسال" else "تم التأجيل",
                color = if (item.status.name == "SENT") ReceivableMint else ReceivableGold,
            )
        }
        if (rows.size >= 200) item { ContractLimitNotice("بلغ السجل حدّ العرض؛ لا يوفر العقد مؤشّر صفحة تالية.") }
    }
}

@Composable
private fun CardContent(
    state: ReceivablesUiState,
    policy: ReceivablesAccessPolicy,
    wide: Boolean,
    onReconcile: () -> Unit,
    onLoadMore: () -> Unit,
) {
    if (wide) Row(Modifier.fillMaxSize().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        CardOverview(state.cardSummary, state.reconciliations, policy, onReconcile, Modifier.weight(.42f).fillMaxHeight())
        CardMovementList(state, onLoadMore, Modifier.weight(.58f).fillMaxHeight())
    } else LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(11.dp),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item { CardSummaryPanel(state.cardSummary) }
        if (policy.canCreateReconciliation) item { OutlinedButton(onClick = onReconcile, Modifier.fillMaxWidth()) { Text("مطابقة كشف البنك") } }
        item { SectionTitle("الحركات", "${state.cardMovementCount}") }
        items(state.cardMovements, key = CardMovement::receiptId) { CardMovementCard(it) }
        if (state.cardHasMore) item { LoadMoreButton(state.loadingMore, onLoadMore) }
        item { SectionTitle("سجل المطابقة", state.reconciliations.size.toString()) }
        items(state.reconciliations, key = CardReconciliation::id) { ReconciliationCard(it) }
        if (state.reconciliations.size >= 100) item { ContractLimitNotice("سجل المطابقة محدود بأحدث 100 لقطة دون مؤشر صفحة تالية.") }
    }
}

@Composable
private fun CardOverview(
    summary: CardSummary?,
    reconciliations: List<CardReconciliation>,
    policy: ReceivablesAccessPolicy,
    onReconcile: () -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(11.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { CardSummaryPanel(summary) }
        if (policy.canCreateReconciliation) item { OutlinedButton(onClick = onReconcile, Modifier.fillMaxWidth()) { Text("مطابقة كشف البنك") } }
        item { SectionTitle("سجل المطابقة", reconciliations.size.toString()) }
        items(reconciliations, key = CardReconciliation::id) { ReconciliationCard(it) }
        if (reconciliations.size >= 100) item { ContractLimitNotice("سجل المطابقة محدود بأحدث 100 لقطة دون مؤشر صفحة تالية.") }
    }
}

@Composable
private fun CardSummaryPanel(summary: CardSummary?) {
    if (summary == null) {
        CompactEmpty("لا يتوفر ملخص للحساب")
        return
    }
    Surface(Modifier.fillMaxWidth(), color = ReceivableInk, shape = RoundedCornerShape(topStart = 30.dp, bottomEnd = 30.dp)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("الرصيد المشتق", color = Color.White.copy(alpha = .7f))
            Text("${summary.balance.value} د.ع", color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DarkMetric("داخل اليوم", summary.todayIn.value, Modifier.weight(1f))
                DarkMetric("خارج اليوم", summary.todayOut.value, Modifier.weight(1f))
                DarkMetric("الحركات", summary.movementCount.toString(), Modifier.weight(1f))
            }
            summary.lastReconciliation?.let { Text("آخر مطابقة ${it.asOfDate} • الفرق ${it.difference.value}", color = Color.White.copy(alpha = .72f)) }
        }
    }
}

@Composable
private fun DarkMetric(label: String, value: String, modifier: Modifier) {
    Surface(modifier, color = Color.White.copy(alpha = .09f), shape = RoundedCornerShape(15.dp)) {
        Column(Modifier.padding(10.dp)) {
            Text(label, color = Color.White.copy(alpha = .72f), style = MaterialTheme.typography.bodySmall)
            Text(value, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 1)
        }
    }
}

@Composable
private fun CardMovementList(state: ReceivablesUiState, onLoadMore: () -> Unit, modifier: Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { SectionTitle("الحركات", "${state.cardMovementCount}") }
        if (state.cardMovements.isEmpty()) item { CompactEmpty("لا توجد حركات مطابقة") }
        items(state.cardMovements, key = CardMovement::receiptId) { CardMovementCard(it) }
        if (state.cardHasMore) item { LoadMoreButton(state.loadingMore, onLoadMore) }
    }
}

@Composable
private fun CardMovementCard(item: CardMovement) {
    val color = if (item.direction == CardDirection.IN) ReceivableMint else MaterialTheme.colorScheme.error
    Card(shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(color.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(if (item.direction == CardDirection.IN) Icons.Rounded.ArrowDownward else Icons.Rounded.ArrowUpward, null, tint = color)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(item.partyName ?: item.description ?: item.source.label(), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(item.voucherNumber ?: item.reference ?: "إيصال #${item.receiptId}", style = MaterialTheme.typography.labelMedium)
                Text(item.createdAt.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("${item.amount.value} د.ع", color = color, fontWeight = FontWeight.Bold)
                item.runningBalance?.let { Text("الرصيد ${it.value}", style = MaterialTheme.typography.bodySmall) }
                if (item.reversed) Text("معكوس", color = ReceivableGold, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun ReconciliationCard(item: CardReconciliation) {
    MetricCard(
        Icons.Rounded.AccountBalance,
        item.statementLabel ?: "مطابقة ${item.asOfDate}",
        item.branchName ?: "الفرع ${item.branchId}",
        "${item.difference.value} د.ع",
        "النظام ${item.systemBalance.value} • الكشف ${item.statementBalance.value}",
        if (item.difference.value == "0.00") ReceivableMint else ReceivableGold,
    )
}

@Composable
private fun AccountsContent(groups: List<AccountGroup>) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        if (groups.isEmpty()) item { CompactEmpty("دليل الحسابات غير متاح") }
        groups.forEach { group ->
            item(group.type.name) { SectionTitle(group.label, group.rows.size.toString()) }
            items(group.rows, key = { "${group.type}-${it.id}" }) { account ->
                Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = if (account.parentId == null) 14.dp else 34.dp, end = 14.dp, top = 12.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(account.code, color = ReceivableBlue, fontWeight = FontWeight.Bold, modifier = Modifier.width(80.dp))
                        Text(account.name, Modifier.weight(1f), fontWeight = if (account.parentId == null) FontWeight.Bold else FontWeight.Normal)
                        if (!account.active) StatusPill("غير نشط", MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun NewPlanDialog(
    draft: NewInstallmentPlan,
    submitting: Boolean,
    onUpdate: (NewInstallmentPlan.() -> NewInstallmentPlan) -> Unit,
    onAddLine: () -> Unit,
    onRemoveLine: (Int) -> Unit,
    onUpdateLine: (Int, NewInstallmentLine.() -> NewInstallmentLine) -> Unit,
    onReview: () -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(.94f).fillMaxHeight(.9f).imePadding(),
            shape = RoundedCornerShape(topStart = 34.dp, bottomEnd = 34.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.fillMaxSize().padding(18.dp)) {
                Text("خطة أقساط جديدة", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("تُطابق خطة الأقساط مع الذمّة قبل الحفظ.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                LazyColumn(
                    Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 12.dp),
                ) {
                    item { PlanIdentityFields(draft, onUpdate) }
                    item { PlanAmountFields(draft, onUpdate) }
                    item { OutlinedTextField(draft.notes, { value -> onUpdate { copy(notes = value.take(1000)) } }, Modifier.fillMaxWidth(), label = { Text("ملاحظات") }, minLines = 2) }
                    item { SectionTitle("جدول الأقساط", draft.lines.size.toString()) }
                    itemsIndexed(draft.lines) { index, line ->
                        PlanLineEditor(index, line, draft.lines.size > 1, onRemoveLine, onUpdateLine)
                    }
                    item { OutlinedButton(onClick = onAddLine, enabled = draft.lines.size < 60, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Add, null); Text("إضافة قسط") } }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onDismiss, enabled = !submitting, modifier = Modifier.weight(1f)) { Text("إلغاء") }
                    Button(onClick = onReview, enabled = !submitting, modifier = Modifier.weight(1f)) { Text("مراجعة") }
                }
            }
        }
    }
}

@Composable
private fun PlanIdentityFields(
    draft: NewInstallmentPlan,
    onUpdate: (NewInstallmentPlan.() -> NewInstallmentPlan) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth < 520.dp) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ReceivableCodeField(draft.customerId, { value -> onUpdate { copy(customerId = value.filter(Char::isDigit)) } }, "معرّف العميل", Modifier.fillMaxWidth(), KeyboardType.Number)
                ReceivableCodeField(draft.invoiceId, { value -> onUpdate { copy(invoiceId = value.filter(Char::isDigit)) } }, "الفاتورة (اختياري)", Modifier.fillMaxWidth(), KeyboardType.Number)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ReceivableCodeField(draft.customerId, { value -> onUpdate { copy(customerId = value.filter(Char::isDigit)) } }, "معرّف العميل", Modifier.weight(1f), KeyboardType.Number)
                ReceivableCodeField(draft.invoiceId, { value -> onUpdate { copy(invoiceId = value.filter(Char::isDigit)) } }, "الفاتورة (اختياري)", Modifier.weight(1f), KeyboardType.Number)
            }
        }
    }
}

@Composable
private fun PlanAmountFields(
    draft: NewInstallmentPlan,
    onUpdate: (NewInstallmentPlan.() -> NewInstallmentPlan) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth < 620.dp) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ReceivableCodeField(draft.branchId, { value -> onUpdate { copy(branchId = value.filter(Char::isDigit)) } }, "الفرع", Modifier.fillMaxWidth(), KeyboardType.Number)
                ReceivableCodeField(draft.totalAmount, { value -> onUpdate { copy(totalAmount = value) } }, "إجمالي الخطة", Modifier.fillMaxWidth(), KeyboardType.Decimal)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ReceivableCodeField(draft.branchId, { value -> onUpdate { copy(branchId = value.filter(Char::isDigit)) } }, "الفرع", Modifier.weight(1f), KeyboardType.Number)
                ReceivableCodeField(draft.totalAmount, { value -> onUpdate { copy(totalAmount = value) } }, "إجمالي الخطة", Modifier.weight(1f), KeyboardType.Decimal)
            }
        }
    }
}

@Composable
private fun PlanLineEditor(
    index: Int,
    line: NewInstallmentLine,
    removable: Boolean,
    onRemoveLine: (Int) -> Unit,
    onUpdateLine: (Int, NewInstallmentLine.() -> NewInstallmentLine) -> Unit,
) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 520.dp) {
                Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("${index + 1}", Modifier.weight(1f), fontWeight = FontWeight.Bold)
                        IconButton(onClick = { onRemoveLine(index) }, enabled = removable) { Icon(Icons.Rounded.Cancel, "حذف") }
                    }
                    ReceivableCodeField(line.dueDate, { value -> onUpdateLine(index) { copy(dueDate = value.take(10)) } }, "تاريخ الاستحقاق", Modifier.fillMaxWidth(), KeyboardType.Ascii)
                    ReceivableCodeField(line.amount, { value -> onUpdateLine(index) { copy(amount = value) } }, "المبلغ", Modifier.fillMaxWidth(), KeyboardType.Decimal)
                }
            } else {
                Row(Modifier.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${index + 1}", fontWeight = FontWeight.Bold)
                    ReceivableCodeField(line.dueDate, { value -> onUpdateLine(index) { copy(dueDate = value.take(10)) } }, "تاريخ الاستحقاق", Modifier.weight(1f), KeyboardType.Ascii)
                    ReceivableCodeField(line.amount, { value -> onUpdateLine(index) { copy(amount = value) } }, "المبلغ", Modifier.weight(1f), KeyboardType.Decimal)
                    IconButton(onClick = { onRemoveLine(index) }, enabled = removable) { Icon(Icons.Rounded.Cancel, "حذف") }
                }
            }
        }
    }
}

@Composable
private fun ActionDialog(
    action: ReceivablesPendingAction,
    submitting: Boolean,
    onUpdate: (ReceivablesPendingAction.() -> ReceivablesPendingAction) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val title = when (action) {
        is ReceivablesPendingAction.CreatePlan -> "تأكيد إنشاء الخطة"
        is ReceivablesPendingAction.PayLine -> "تأكيد سداد القسط"
        is ReceivablesPendingAction.CancelPlan -> "تأكيد إلغاء الخطة"
        is ReceivablesPendingAction.BounceCheck -> "تأكيد ارتجاع الشيك"
        is ReceivablesPendingAction.Reminder -> if (action.draft.kind == ReminderActionDraft.Kind.SEND_API) "تأكيد إرسال التذكير" else "تأجيل المتابعة"
        is ReceivablesPendingAction.Reconcile -> "مطابقة كشف البنك"
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                when (action) {
                    is ReceivablesPendingAction.CreatePlan -> {
                        Text("تُطابَق أقساط الخطة مع الذمّة قبل الإنشاء. لدفعةٍ أولى: سجّلها سندَ قبضٍ نقديٍّ أولاً ثم أنشئ الخطة على المتبقّي.")
                        InfoLine("العميل", "#${action.draft.customerId}")
                        InfoLine("الإجمالي المدخل", "${action.draft.totalAmount} د.ع")
                        InfoLine("عدد الأقساط", action.draft.lines.size.toString())
                    }
                    is ReceivablesPendingAction.PayLine -> {
                        Text("قد يتطلب السداد اعتماد مستخدم آخر.")
                        InfoLine("القسط", "#${action.line.id} • ${action.line.amount.value} د.ع")
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            items(InstallmentPaymentMethod.entries) { method ->
                                FilterChip(action.method == method, { onUpdate { ReceivablesPendingAction.PayLine(action.line, method, action.note) } }, { Text(method.label) })
                            }
                        }
                        OutlinedTextField(action.note, { value -> onUpdate { action.copy(note = value.take(255)) } }, Modifier.fillMaxWidth(), label = { Text("ملاحظة اختيارية") })
                    }
                    is ReceivablesPendingAction.CancelPlan -> {
                        Text("لا يمكن الإلغاء مع وجود قسط مسدّد أو سند تحصيل معتمد.")
                        OutlinedTextField(action.reason, { value -> onUpdate { action.copy(reason = value.take(500)) } }, Modifier.fillMaxWidth(), label = { Text("سبب الإلغاء") }, minLines = 2)
                    }
                    is ReceivablesPendingAction.BounceCheck -> {
                        Text("هذا الإجراء مخصص حصراً لشيك قديم موجود في السجل. إذا كان محصلاً، ينفذ الخادم العكس المالي الموثق.")
                        OutlinedTextField(action.note, { value -> onUpdate { action.copy(note = value.take(255)) } }, Modifier.fillMaxWidth(), label = { Text("ملاحظة") })
                    }
                    is ReceivablesPendingAction.Reminder -> {
                        val draft = action.draft
                        InfoLine(draft.item.subject.ledger.label, draft.item.subject.name)
                        InfoLine("المبلغ المثبت", "${draft.item.totalUnpaid.value} د.ع")
                        if (draft.kind == ReminderActionDraft.Kind.SEND_API) {
                            Text("يتطلب الإرسال قالباً وتكاملاً وموافقة صالحة. اضغط تأكيد مرة واحدة.")
                        } else {
                            OutlinedTextField(draft.reason, { value -> onUpdate { action.copy(draft = draft.copy(reason = value.take(255))) } }, Modifier.fillMaxWidth(), label = { Text("سبب التأجيل أو التخطّي") })
                            OutlinedTextField(draft.promisedDate, { value -> onUpdate { action.copy(draft = draft.copy(promisedDate = value.take(10))) } }, Modifier.fillMaxWidth(), label = { Text("موعد متابعة YYYY-MM-DD (اختياري)") })
                        }
                    }
                    is ReceivablesPendingAction.Reconcile -> ReconciliationFields(action.draft) { draft -> onUpdate { action.copy(draft = draft) } }
                }
            }
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = !submitting) {
                if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("تأكيد")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !submitting) { Text("رجوع") } },
    )
}

@Composable
private fun ReconciliationFields(draft: ReconciliationDraft, onChange: (ReconciliationDraft) -> Unit) {
    Text("أدخل قيمة كشف البنك لحساب الفرق.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(draft.branchId, { onChange(draft.copy(branchId = it.filter(Char::isDigit))) }, Modifier.weight(1f), label = { Text("الفرع") })
        OutlinedTextField(draft.asOfDate, { onChange(draft.copy(asOfDate = it.take(10))) }, Modifier.weight(1f), label = { Text("التاريخ") })
    }
    OutlinedTextField(draft.statementBalance, { onChange(draft.copy(statementBalance = it)) }, Modifier.fillMaxWidth(), label = { Text("رصيد كشف البنك") })
    OutlinedTextField(draft.statementLabel, { onChange(draft.copy(statementLabel = it.take(120))) }, Modifier.fillMaxWidth(), label = { Text("اسم الكشف (اختياري)") })
    OutlinedTextField(draft.note, { onChange(draft.copy(note = it.take(1000))) }, Modifier.fillMaxWidth(), label = { Text("ملاحظة") }, minLines = 2)
}

@Composable
private fun MetricCard(icon: ImageVector, title: String, subtitle: String, value: String, foot: String, color: Color) {
    Card(shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(color.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) { Icon(icon, null, tint = color) }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Text(foot, color = color, style = MaterialTheme.typography.bodySmall, maxLines = 1)
            }
            Text(value, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(rtlIsolate(value), Modifier.weight(.58f), fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SectionTitle(title: String, trailing: String?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        trailing?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun StatusPill(text: String, color: Color) {
    Surface(color = color.copy(alpha = .10f), shape = CircleShape) {
        Text(text, Modifier.padding(horizontal = 9.dp, vertical = 4.dp), color = color, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun MessageStrip(message: String, error: Boolean, onDismiss: () -> Unit) {
    val color = if (error) MaterialTheme.colorScheme.error else ReceivableMint
    Surface(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 3.dp), color = color.copy(alpha = .09f), shape = RoundedCornerShape(14.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, Modifier.weight(1f), color = color)
            TextButton(onClick = onDismiss) { Text("إغلاق", color = color) }
        }
    }
}

@Composable
private fun ContractLimitNotice(message: String) {
    Surface(Modifier.fillMaxWidth(), color = ReceivableGold.copy(alpha = .08f), shape = RoundedCornerShape(15.dp)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.WarningAmber, null, tint = ReceivableGold)
            Spacer(Modifier.width(8.dp)); Text(message, color = ReceivableGold)
        }
    }
}

@Composable
private fun LoadMoreButton(loading: Boolean, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = !loading, modifier = Modifier.fillMaxWidth()) {
        if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("تحميل المزيد")
    }
}

@Composable
private fun CompactEmpty(message: String) {
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(18.dp)) {
        Text(message, Modifier.padding(18.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun LoadingState() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
@Composable private fun EmptyState(message: String, modifier: Modifier) = Box(modifier, contentAlignment = Alignment.Center) { Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant) }

private fun reminderScopeWritable(item: ReminderQueueItem, filter: ReminderFilter): Boolean =
    filter.branchIdOrNull() != null && !(item.subject.ledger == ReminderLedger.PAYABLE && filter.aggregate)

private fun ReceivablesSection.icon(): ImageVector = when (this) {
    ReceivablesSection.INSTALLMENTS -> Icons.Rounded.CalendarMonth
    ReceivablesSection.CUSTOMER_REMINDERS -> Icons.AutoMirrored.Rounded.Send
    ReceivablesSection.SUPPLIER_REMINDERS -> Icons.Rounded.EventRepeat
    ReceivablesSection.CARD_ACCOUNT -> Icons.Rounded.CreditCard
    ReceivablesSection.ACCOUNTS -> Icons.Rounded.AccountBalance
}

private fun InstallmentStatus.color(): Color = when (this) {
    InstallmentStatus.ACTIVE -> ReceivableBlue
    InstallmentStatus.COMPLETED -> ReceivableMint
    InstallmentStatus.CANCELLED -> Color(0xFF8A6464)
}

@Composable
private fun InstallmentLineStatus.color(): Color = when (this) {
    InstallmentLineStatus.PENDING -> ReceivableGold
    InstallmentLineStatus.PAID -> ReceivableMint
    InstallmentLineStatus.BOUNCED -> MaterialTheme.colorScheme.error
    InstallmentLineStatus.CANCELLED -> Color(0xFF8A6464)
}

private fun CardSource.label(): String = when (this) {
    CardSource.VOUCHER -> "سند"
    CardSource.INVOICE_PAYMENT -> "فاتورة"
    CardSource.WORK_ORDER -> "أمر شغل"
    CardSource.OTHER -> "أخرى"
}

private fun ReceivablesPendingAction.destinationSection(): ReceivablesSection = when (this) {
    is ReceivablesPendingAction.CreatePlan,
    is ReceivablesPendingAction.PayLine,
    is ReceivablesPendingAction.CancelPlan,
    is ReceivablesPendingAction.BounceCheck -> ReceivablesSection.INSTALLMENTS
    is ReceivablesPendingAction.Reminder -> if (draft.item.subject.ledger == ReminderLedger.RECEIVABLE) {
        ReceivablesSection.CUSTOMER_REMINDERS
    } else {
        ReceivablesSection.SUPPLIER_REMINDERS
    }
    is ReceivablesPendingAction.Reconcile -> ReceivablesSection.CARD_ACCOUNT
}

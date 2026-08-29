package online.alarabiya.superapp.feature.accountingControls

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.FactCheck
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.AccountBalance
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.LocalShipping
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.PeopleAlt
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Storefront
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.accountingControls.AccountGroup
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import online.alarabiya.superapp.model.accountingControls.AccountingControlsSection
import online.alarabiya.superapp.model.accountingControls.ExchangeCurrency
import online.alarabiya.superapp.model.accountingControls.ExchangeDraft
import online.alarabiya.superapp.model.accountingControls.ExchangeOperationKind
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationAxis
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationReport
import online.alarabiya.superapp.model.accountingControls.FinancialReconciliationSection
import online.alarabiya.superapp.model.accountingControls.PendingExchangeDeposit
import online.alarabiya.superapp.model.accountingControls.ReconciliationCommand
import online.alarabiya.superapp.ui.rtlIsolate

private val ControlNavy = Color(0xFF362087)
private val ControlBlue = Color(0xFF5B36D2)
private val ControlMint = Color(0xFFF0ECFF)
private val ControlAmber = Color(0xFFEC2F86)

internal enum class PeriodWorkspaceLayout { SPLIT, STACKED }

internal fun periodWorkspaceLayout(widthDp: Float, fontScale: Float): PeriodWorkspaceLayout =
    if (widthDp >= 760f && fontScale < 1.8f) PeriodWorkspaceLayout.SPLIT else PeriodWorkspaceLayout.STACKED

@Composable
fun AccountingControlsRoute(viewModel: AccountingControlsViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    AccountingControlsScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = AccountingControlsActions(
            section = viewModel::section,
            accountQuery = viewModel::accountQuery,
            exchangeQuery = viewModel::exchangeQuery,
            searchExchange = viewModel::searchExchange,
            selectExchange = viewModel::selectExchangeHouse,
            exchangeDraft = viewModel::exchangeDraft,
            submitExchange = viewModel::submitExchange,
            approveDeposit = viewModel::approveDeposit,
            reconciliationDraft = viewModel::reconciliationDraft,
            reconcile = viewModel::reconcile,
            refreshFinancialReconciliation = viewModel::refreshFinancialReconciliation,
            lockDate = viewModel::lockDate,
            lockNotes = viewModel::lockNotes,
            lockPeriod = viewModel::lockPeriod,
            unlockReason = viewModel::unlockReason,
            unlockPassword = viewModel::unlockPassword,
            unlockPeriod = viewModel::unlockPeriod,
            closeYearText = viewModel::closeYearText,
            closeCompanyWide = viewModel::closeCompanyWide,
            closeYear = viewModel::closeYear,
            retryCurrentSection = viewModel::retryCurrentSection,
            clearMessage = viewModel::clearMessage,
        ),
        modifier = modifier,
    )
}

data class AccountingControlsActions(
    val section: (AccountingControlsSection) -> Unit,
    val accountQuery: (String) -> Unit,
    val exchangeQuery: (String) -> Unit,
    val searchExchange: () -> Unit,
    val selectExchange: (Long?) -> Unit,
    val exchangeDraft: (ExchangeDraft) -> Unit,
    val submitExchange: () -> Unit,
    val approveDeposit: (Long) -> Unit,
    val reconciliationDraft: (ReconciliationCommand) -> Unit,
    val reconcile: () -> Unit,
    val refreshFinancialReconciliation: () -> Unit,
    val lockDate: (String) -> Unit,
    val lockNotes: (String) -> Unit,
    val lockPeriod: () -> Unit,
    val unlockReason: (String) -> Unit,
    val unlockPassword: (String) -> Unit,
    val unlockPeriod: () -> Unit,
    val closeYearText: (String) -> Unit,
    val closeCompanyWide: (Boolean) -> Unit,
    val closeYear: () -> Unit,
    val retryCurrentSection: () -> Unit,
    val clearMessage: () -> Unit,
)

private data class Confirmation(val title: String, val body: String, val action: () -> Unit)

@Composable
fun AccountingControlsScreen(
    state: AccountingControlsUiState,
    capabilities: AccountingControlsCapabilities,
    actions: AccountingControlsActions,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        var confirmation by remember { mutableStateOf<Confirmation?>(null) }
        val sections = buildList {
            if (capabilities.canReadAccounts) add(AccountingControlsSection.ACCOUNTS)
            if (capabilities.canReadFinancialReconciliation) {
                add(AccountingControlsSection.FINANCIAL_RECONCILIATION)
            }
            if (capabilities.canReadExchange) add(AccountingControlsSection.EXCHANGE)
            if (capabilities.canGovernPeriods) {
                add(AccountingControlsSection.PERIODS)
                add(AccountingControlsSection.YEAR_END)
            }
        }
        Scaffold(modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.surface) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                ControlsHeader()
                if (sections.size > 1) ScrollableTabRow(
                    selectedTabIndex = sections.indexOf(state.section).coerceAtLeast(0),
                    edgePadding = 14.dp,
                ) {
                    sections.forEach { section ->
                        Tab(
                            selected = state.section == section,
                            onClick = { actions.section(section) },
                            enabled = !state.locked,
                            text = { Text(section.label()) },
                            icon = { Icon(section.icon(), null) },
                        )
                    }
                }
                if (sections.isEmpty()) {
                    EmptyState("لا توجد صلاحية للضوابط المحاسبية")
                } else if (!state.currentSectionLoaded && (state.busy != null || state.error == null)) {
                    SectionLoading()
                } else if (!state.currentSectionLoaded && state.error != null) {
                    SectionLoadFailure(state.error, state.notice, actions.retryCurrentSection)
                } else when (state.section) {
                    AccountingControlsSection.ACCOUNTS -> WorkspaceWithFeedback(state, actions) {
                        AccountsWorkspace(state, actions)
                    }
                    AccountingControlsSection.FINANCIAL_RECONCILIATION -> WorkspaceWithFeedback(state, actions) {
                        FinancialReconciliationWorkspace(state, actions)
                    }
                    AccountingControlsSection.EXCHANGE -> WorkspaceWithFeedback(state, actions) {
                        ExchangeWorkspace(state, capabilities, actions) { confirmation = it }
                    }
                    AccountingControlsSection.PERIODS -> WorkspaceWithFeedback(state, actions) {
                        PeriodsWorkspace(state, actions) { confirmation = it }
                    }
                    AccountingControlsSection.YEAR_END -> WorkspaceWithFeedback(state, actions) {
                        YearEndWorkspace(state, capabilities, actions) { confirmation = it }
                    }
                }
            }
        }
        confirmation?.let { request ->
            AlertDialog(
                onDismissRequest = { if (!state.locked) confirmation = null },
                title = { Text(request.title, fontWeight = FontWeight.ExtraBold) },
                text = { Text(request.body) },
                confirmButton = { Button({ confirmation = null; request.action() }) { Text("تأكيد") } },
                dismissButton = { OutlinedButton({ confirmation = null }) { Text("رجوع") } },
            )
        }
    }
}

@Composable
private fun WorkspaceWithFeedback(
    state: AccountingControlsUiState,
    actions: AccountingControlsActions,
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        state.error?.let { Feedback(it, true, actions.clearMessage) }
        state.notice?.let { Feedback(it, false, actions.clearMessage) }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}

@Composable
private fun SectionLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator()
            Text("جارٍ تحميل البيانات", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SectionLoadFailure(error: String, notice: String?, retry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().background(
                MaterialTheme.colorScheme.errorContainer,
                RoundedCornerShape(28.dp, 12.dp, 28.dp, 12.dp),
            ).padding(22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Rounded.WarningAmber, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.error)
            Text("تعذر تحميل مساحة العمل", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
            notice?.let { Text(it, color = ControlBlue, fontWeight = FontWeight.Bold) }
            Text(error, color = MaterialTheme.colorScheme.onErrorContainer)
            Button(onClick = retry) {
                Icon(Icons.Rounded.Refresh, null)
                Spacer(Modifier.width(8.dp))
                Text("إعادة المحاولة")
            }
        }
    }
}

@Composable
private fun ControlsHeader() {
    Box(
        Modifier.fillMaxWidth().background(
            Brush.horizontalGradient(listOf(ControlNavy, ControlBlue)),
            RoundedCornerShape(bottomStart = 46.dp, bottomEnd = 14.dp),
        ).padding(20.dp),
    ) {
        Box(Modifier.size(110.dp).align(Alignment.TopStart).background(Color.White.copy(alpha = .06f), CircleShape))
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("الضوابط المحاسبية", color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                Text("الحسابات، التوافق، الصيرفة والإقفال", color = Color.White.copy(alpha = .76f))
            }
            Surface(color = Color.White.copy(alpha = .13f), shape = RoundedCornerShape(22.dp, 22.dp, 8.dp, 22.dp)) {
                Icon(Icons.Rounded.AccountBalance, null, tint = Color.White, modifier = Modifier.padding(13.dp).size(29.dp))
            }
        }
    }
}

@Composable
private fun AccountsWorkspace(state: AccountingControlsUiState, actions: AccountingControlsActions) {
    ControlsCard(Modifier.fillMaxSize().padding(14.dp)) {
        SectionTitle("شجرة الحسابات", "مرجع قراءة فقط من محرك الدفتر", Icons.Rounded.AccountTree)
        OutlinedTextField(
            state.accountQuery,
            actions.accountQuery,
            Modifier.fillMaxWidth(),
            label = { Text("بحث بالكود أو الاسم") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
        )
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.filteredAccountGroups.forEach { group ->
                item(key = "group:${group.type}") { AccountGroupHeader(group) }
                items(group.rows, key = { it.id }) { account ->
                    Row(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(account.code, color = ControlBlue, fontWeight = FontWeight.ExtraBold)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(account.name, fontWeight = FontWeight.SemiBold)
                            account.systemRole?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        StatusPill(if (account.active) "نشط" else "متوقف", account.active)
                    }
                }
            }
        }
    }
}

@Composable
private fun AccountGroupHeader(group: AccountGroup) {
    Row(Modifier.fillMaxWidth().background(ControlMint, RoundedCornerShape(18.dp, 7.dp, 18.dp, 7.dp)).padding(10.dp), Arrangement.SpaceBetween) {
        Text(group.label, fontWeight = FontWeight.ExtraBold, color = ControlNavy)
        Text("${group.rows.size} حساب", color = ControlBlue)
    }
}

@Composable
private fun FinancialReconciliationWorkspace(
    state: AccountingControlsUiState,
    actions: AccountingControlsActions,
) {
    val report = state.financialReconciliation
    if (report == null) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.AutoMirrored.Rounded.FactCheck, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline)
                Text("لا توجد نتيجة مطابقة", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton(actions.refreshFinancialReconciliation) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(8.dp))
                    Text("إعادة الفحص")
                }
            }
        }
        return
    }
    val refreshing = state.busy == AccountingControlsBusy.FINANCIAL_RECONCILIATION
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = periodWorkspaceLayout(maxWidth.value, LocalDensity.current.fontScale) == PeriodWorkspaceLayout.SPLIT
        if (wide) {
            Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                FinancialReconciliationSummary(
                    report = report,
                    refreshing = refreshing,
                    refresh = actions.refreshFinancialReconciliation,
                    modifier = Modifier.weight(.78f),
                )
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    modifier = Modifier.weight(1.22f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    gridItems(report.sections, key = { it.axis }) { section ->
                        FinancialReconciliationSectionCard(section, Modifier.fillMaxWidth())
                    }
                }
            }
        } else {
            LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    FinancialReconciliationSummary(
                        report = report,
                        refreshing = refreshing,
                        refresh = actions.refreshFinancialReconciliation,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                items(report.sections, key = { it.axis }) { section ->
                    FinancialReconciliationSectionCard(section, Modifier.fillMaxWidth())
                }
            }
        }
    }
}

@Composable
private fun FinancialReconciliationSummary(
    report: FinancialReconciliationReport,
    refreshing: Boolean,
    refresh: () -> Unit,
    modifier: Modifier,
) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 34.dp),
        elevation = CardDefaults.cardElevation(3.dp),
    ) {
        Column(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(ControlNavy, ControlBlue))).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(Modifier.size(52.dp).background(Color.White.copy(alpha = .14f), RoundedCornerShape(20.dp, 20.dp, 8.dp, 20.dp)), contentAlignment = Alignment.Center) {
                Icon(if (report.balanced) Icons.Rounded.CheckCircle else Icons.Rounded.WarningAmber, null, tint = Color.White)
            }
            Column {
                Text("المطابقة المالية الشاملة", color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                Text("الذمم والعهد والمخزون والدفتر", color = Color.White.copy(alpha = .76f))
            }
            Text(
                if (report.balanced) "متوازن" else rtlIsolate("${report.totalIssueCount} انحراف"),
                color = Color.White,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Black,
            )
            Text(
                "آخر فحص  ${rtlIsolate(formatReconciliationRunAt(report.runAt))}",
                color = Color.White.copy(alpha = .78f),
                style = MaterialTheme.typography.bodySmall,
            )
            Button(
                onClick = refresh,
                enabled = !refreshing,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = ControlNavy),
            ) {
                if (refreshing) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = ControlNavy)
                } else {
                    Icon(Icons.Rounded.Refresh, null)
                }
                Spacer(Modifier.width(8.dp))
                Text(if (refreshing) "جارٍ الفحص" else "إعادة الفحص")
            }
        }
    }
}

@Composable
private fun FinancialReconciliationSectionCard(
    section: FinancialReconciliationSection,
    modifier: Modifier,
) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 10.dp, bottomStart = 10.dp, bottomEnd = 26.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(1.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(48.dp).background(
                    if (section.balanced) ControlMint else MaterialTheme.colorScheme.errorContainer,
                    RoundedCornerShape(19.dp, 19.dp, 7.dp, 19.dp),
                ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    section.axis.icon(),
                    null,
                    tint = if (section.balanced) ControlBlue else MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(section.axis.label(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                Text(
                    if (section.balanced) "متوازن" else "يتطلب مراجعة",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            StatusPill(
                if (section.balanced) "0" else rtlIsolate(section.issueCount.toString()),
                section.balanced,
            )
        }
    }
}

@Composable
private fun ExchangeWorkspace(state: AccountingControlsUiState, capabilities: AccountingControlsCapabilities, actions: AccountingControlsActions, confirm: (Confirmation) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ExchangeHouseList(state, actions, Modifier.weight(.78f).fillMaxHeight())
            ExchangeDetail(state, capabilities, actions, confirm, Modifier.weight(1.22f).fillMaxHeight())
        } else if (state.selectedExchangeHouse != null) {
            ExchangeDetail(state, capabilities, actions, confirm, Modifier.fillMaxSize(), true)
        } else ExchangeHouseList(state, actions, Modifier.fillMaxSize())
    }
}

@Composable
private fun ExchangeHouseList(state: AccountingControlsUiState, actions: AccountingControlsActions, modifier: Modifier) {
    ControlsCard(modifier) {
        SectionTitle("جهات الصيرفة", "الأرصدة والحركات", Icons.Rounded.Payments)
        OutlinedTextField(
            state.exchangeQuery,
            actions.exchangeQuery,
            Modifier.fillMaxWidth(),
            label = { Text("اسم أو هاتف أو رمز") },
            trailingIcon = { IconButton(actions.searchExchange, enabled = !state.locked) { Icon(Icons.Rounded.Search, "بحث") } },
            singleLine = true,
            enabled = !state.locked,
            shape = RoundedCornerShape(18.dp),
        )
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.exchangeHouses, key = { it.id }) { house ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp, 9.dp, 22.dp, 9.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .clickable(enabled = !state.locked, role = Role.Button) { actions.selectExchange(house.id) }
                        .padding(13.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) { Text(house.name, fontWeight = FontWeight.ExtraBold); StatusPill(if (house.active) "نشطة" else "متوقفة", house.active) }
                    Text("IQD ${house.balanceIqd} • USD ${house.balanceUsd}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("متوسط الكلفة ${house.usdCostRate}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ExchangeDetail(
    state: AccountingControlsUiState,
    capabilities: AccountingControlsCapabilities,
    actions: AccountingControlsActions,
    confirm: (Confirmation) -> Unit,
    modifier: Modifier,
    back: Boolean = false,
) {
    val house = state.selectedExchangeHouse
    ControlsCard(modifier) {
        if (house == null) { EmptyState("اختر جهة صيرفة لفتح كشفها"); return@ControlsCard }
        val housePendingDeposits = state.pendingDeposits.filter { it.houseId == house.id }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (back) IconButton({ actions.selectExchange(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
            Column(Modifier.weight(1f)) { Text(house.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold); Text("الكشف والأوامر", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            StatusPill(if (house.active) "نشطة" else "متوقفة", house.active)
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.exchangeStatement?.let { statement ->
                item {
                    Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                        MoneyTile("دينار", statement.summary.currentIqd, Modifier.weight(1f))
                        MoneyTile("دولار", statement.summary.currentUsd, Modifier.weight(1f))
                        MoneyTile("فرق صرف", statement.summary.fxDifference, Modifier.weight(1f))
                    }
                }
            }
            if (capabilities.canWriteExchange) item { ExchangeOperationForm(state, actions, confirm) }
            item { ReconciliationForm(state, actions) }
            if (housePendingDeposits.isNotEmpty()) {
                item { Subheading("بانتظار اعتماد ثانٍ", "${housePendingDeposits.size} إيداعات دولار بلا أثر حتى الاعتماد") }
                items(housePendingDeposits, key = { "pending:${it.id}" }) { pending ->
                    PendingDepositCard(pending, capabilities.canWriteExchange, state.locked, actions, confirm)
                }
            }
            item { Subheading("الحركات", "المبالغ والأرصدة") }
            items(state.exchangeStatement?.transactions.orEmpty().reversed(), key = { it.id }) { transaction ->
                Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(11.dp)) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) { Text(transaction.transactionNumber, fontWeight = FontWeight.Bold); StatusPill(transaction.status, transaction.status == "ACTIVE") }
                    Text("${transaction.type} • ${transaction.currency.name} • ${if (transaction.currency == ExchangeCurrency.USD) transaction.usdAmount else transaction.iqdAmount}")
                    Text(listOfNotNull(transaction.branchName, transaction.createdByName, transaction.createdAt).joinToString(" • "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun ExchangeOperationForm(state: AccountingControlsUiState, actions: AccountingControlsActions, confirm: (Confirmation) -> Unit) {
    val draft = state.exchangeDraft
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(24.dp, 10.dp, 24.dp, 10.dp)).padding(13.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Subheading("حركة جديدة", "يرسل مفتاح منع تكرار ثابت حتى تتأكد النتيجة")
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            ExchangeOperationKind.entries.forEach { kind -> FilterChip(draft.kind == kind, { actions.exchangeDraft(draft.copy(kind = kind, currency = if (kind == ExchangeOperationKind.BUY_USD) ExchangeCurrency.USD else draft.currency)) }, label = { Text(kind.label()) }, enabled = !state.locked) }
        }
        if (draft.kind != ExchangeOperationKind.BUY_USD) Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(7.dp)) {
            ExchangeCurrency.entries.forEach { currency -> FilterChip(draft.currency == currency, { actions.exchangeDraft(draft.copy(currency = currency)) }, label = { Text(currency.name) }, enabled = !state.locked) }
        }
        OutlinedTextField(draft.amount, { actions.exchangeDraft(draft.copy(amount = it)) }, Modifier.fillMaxWidth(), label = { Text(if (draft.kind == ExchangeOperationKind.BUY_USD) "مبلغ الدولار" else "المبلغ") }, singleLine = true, enabled = !state.locked)
        if (draft.kind == ExchangeOperationKind.BUY_USD || draft.kind == ExchangeOperationKind.DEPOSIT && draft.currency == ExchangeCurrency.USD) {
            OutlinedTextField(draft.exchangeRate, { actions.exchangeDraft(draft.copy(exchangeRate = it)) }, Modifier.fillMaxWidth(), label = { Text("سعر الصرف IQD/USD") }, singleLine = true, enabled = !state.locked)
        }
        OutlinedTextField(draft.notes, { actions.exchangeDraft(draft.copy(notes = it)) }, Modifier.fillMaxWidth(), label = { Text("ملاحظات") }, enabled = !state.locked)
        if (draft.kind != ExchangeOperationKind.DEPOSIT) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(draft.confirmNegative, { actions.exchangeDraft(draft.copy(confirmNegative = it)) }, enabled = !state.locked)
            Text("أوافق على تجاوز تحذير الرصيد السالب إذا أعاده الخادم", style = MaterialTheme.typography.bodySmall)
        }
        Button(
            onClick = { confirm(Confirmation("تأكيد حركة الصيرفة", "لا يحسب التطبيق أي أثر محلياً. الخادم سيتحقق من الرصيد والفترة ثم يسجل الحركة ذرياً.", actions.submitExchange)) },
            modifier = Modifier.fillMaxWidth(), enabled = !state.locked && draft.amount.isNotBlank(),
        ) { Text("مراجعة وتنفيذ") }
    }
}

@Composable
private fun ReconciliationForm(state: AccountingControlsUiState, actions: AccountingControlsActions) {
    val draft = state.reconciliationDraft
    Column(Modifier.fillMaxWidth().background(ControlMint, RoundedCornerShape(20.dp, 8.dp, 20.dp, 8.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Subheading("مطابقة كشف الصيرفة", "رصيد جهة واحدة؛ لا تنشئ تسوية")
        Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(7.dp)) {
            OutlinedTextField(draft.statedIqd, { actions.reconciliationDraft(draft.copy(statedIqd = it)) }, Modifier.weight(1f), label = { Text("رصيد IQD") }, singleLine = true, enabled = !state.locked)
            OutlinedTextField(draft.statedUsd, { actions.reconciliationDraft(draft.copy(statedUsd = it)) }, Modifier.weight(1f), label = { Text("رصيد USD") }, singleLine = true, enabled = !state.locked)
        }
        ArabicDatePicker(draft.asOfDate, { actions.reconciliationDraft(draft.copy(asOfDate = it)) }, "تاريخ قطع اختياري", enabled = !state.locked)
        OutlinedButton(actions.reconcile, Modifier.fillMaxWidth(), enabled = !state.locked && draft.statedIqd.isNotBlank() && draft.statedUsd.isNotBlank()) { Text("مطابقة كشف الصيرفة") }
        state.reconciliation?.let { result ->
            Text(if (result.matched) "متطابق" else "فرق IQD ${result.differenceIqd} • USD ${result.differenceUsd}", color = if (result.matched) ControlBlue else MaterialTheme.colorScheme.error, fontWeight = FontWeight.ExtraBold)
            if (result.pendingCount > 0) Text("${result.pendingCount} حركات بعد تاريخ القطع تفسّر فروق التوقيت", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun PendingDepositCard(pending: PendingExchangeDeposit, canApprove: Boolean, locked: Boolean, actions: AccountingControlsActions, confirm: (Confirmation) -> Unit) {
    Row(Modifier.fillMaxWidth().border(1.dp, ControlAmber, RoundedCornerShape(16.dp)).padding(11.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(pending.transactionNumber, fontWeight = FontWeight.Bold)
            Text("${pending.usdAmount}$ بسعر ${pending.exchangeRate} • فرع ${pending.branchId ?: "—"}", style = MaterialTheme.typography.bodySmall)
        }
        if (canApprove) OutlinedButton(
            { confirm(Confirmation("اعتماد إيداع الدولار", "سيطبق الخادم فصل المهام، ثم يرفع الرصيد ويحدّث متوسط الكلفة.") { actions.approveDeposit(pending.id) }) },
            enabled = !locked,
        ) { Text("اعتماد") }
    }
}

@Composable
private fun PeriodsWorkspace(state: AccountingControlsUiState, actions: AccountingControlsActions, confirm: (Confirmation) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = periodWorkspaceLayout(maxWidth.value, LocalDensity.current.fontScale) == PeriodWorkspaceLayout.SPLIT
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            PeriodControl(state, actions, confirm, Modifier.weight(.85f).fillMaxHeight(), bounded = true)
            PeriodHistory(state, Modifier.weight(1.15f).fillMaxHeight(), bounded = true)
        } else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item { PeriodControl(state, actions, confirm, Modifier.fillMaxWidth(), bounded = false) }
            item { PeriodHistory(state, Modifier.fillMaxWidth(), bounded = false) }
        }
    }
}

@Composable
private fun PeriodControl(
    state: AccountingControlsUiState,
    actions: AccountingControlsActions,
    confirm: (Confirmation) -> Unit,
    modifier: Modifier,
    bounded: Boolean,
) {
    ControlsCard(modifier, fillContent = bounded, scrollContent = bounded) {
        SectionTitle("حالة الفترة", "القفل يمنع القيود بتاريخ يساوي القطع أو يسبقه", Icons.Rounded.Lock)
        state.activeLock?.let { lock ->
            Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(20.dp, 8.dp, 20.dp, 8.dp)) {
                Column(Modifier.padding(13.dp)) { Text("مقفلة حتى ${lock.cutoffDate}", fontWeight = FontWeight.ExtraBold); Text(lock.notes ?: "بلا ملاحظات") }
            }
            OutlinedTextField(state.unlockReason, actions.unlockReason, Modifier.fillMaxWidth(), label = { Text("سبب الفتح — 10 أحرف على الأقل") }, enabled = !state.locked)
            OutlinedTextField(state.unlockPassword, actions.unlockPassword, Modifier.fillMaxWidth(), label = { Text("كلمة مرور المدير") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !state.locked)
            Button(
                { confirm(Confirmation("فتح الفترة", "سيُؤرشف القفل مع اسم المنفذ والسبب. فتح الفترة يسمح بقيود رجعية.", actions.unlockPeriod)) },
                Modifier.fillMaxWidth(), enabled = !state.locked && state.unlockReason.length >= 10 && state.unlockPassword.isNotBlank(),
            ) { Text("فتح مع توثيق السبب") }
        } ?: run {
            Surface(color = ControlMint, shape = RoundedCornerShape(20.dp, 8.dp, 20.dp, 8.dp)) { Text("لا يوجد قفل مالي نشط", Modifier.padding(13.dp), color = ControlBlue, fontWeight = FontWeight.Bold) }
            ArabicDatePicker(state.lockDate, actions.lockDate, "تاريخ القطع", enabled = !state.locked)
            OutlinedTextField(state.lockNotes, actions.lockNotes, Modifier.fillMaxWidth(), label = { Text("ملاحظات الإقفال") }, enabled = !state.locked)
            Button(
                { confirm(Confirmation("إقفال الفترة", "بعد الإقفال سيرفض محرك الدفتر كل قيد بتاريخ يساوي ${state.lockDate} أو يسبقه.", actions.lockPeriod)) },
                Modifier.fillMaxWidth(), enabled = !state.locked && state.lockDate.length == 10,
            ) { Text("إقفال") }
        }
    }
}

@Composable
private fun PeriodHistory(state: AccountingControlsUiState, modifier: Modifier, bounded: Boolean) {
    ControlsCard(modifier, fillContent = bounded) {
        SectionTitle("الأثر التدقيقي", "قفل وفتح محفوظان من سجل التدقيق", Icons.Rounded.History)
        if (bounded) {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.periodHistory, key = { it.id }) { event -> PeriodHistoryRow(event) }
            }
        } else {
            state.periodHistory.forEach { event -> PeriodHistoryRow(event) }
        }
    }
}

@Composable
private fun PeriodHistoryRow(event: online.alarabiya.superapp.model.accountingControls.PeriodHistoryEvent) {
    Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(11.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
            Text(if (event.action == "period.lock") "إقفال" else "فتح", fontWeight = FontWeight.Bold)
            Text(event.cutoffDate ?: "—", color = ControlBlue)
        }
        Text(listOfNotNull(event.userName, event.createdAt).joinToString(" • "), style = MaterialTheme.typography.bodySmall)
        (event.reason ?: event.notes)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun YearEndWorkspace(state: AccountingControlsUiState, capabilities: AccountingControlsCapabilities, actions: AccountingControlsActions, confirm: (Confirmation) -> Unit) {
    ControlsCard(Modifier.fillMaxSize().padding(14.dp)) {
        SectionTitle("الإقفال السنوي", "النتائج والفترات والأرباح المحتجزة", Icons.Rounded.AccountBalance)
        Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp), Alignment.CenterVertically) {
            OutlinedTextField(state.closeYearText, actions.closeYearText, Modifier.weight(1f), label = { Text("السنة المنتهية") }, singleLine = true, enabled = !state.locked)
            Column(horizontalAlignment = Alignment.CenterHorizontally) { Text("الشركة كاملة", style = MaterialTheme.typography.bodySmall); Switch(state.closeCompanyWide, actions.closeCompanyWide, enabled = !state.locked && capabilities.branchId != null) }
            Button(
                { confirm(Confirmation("إقفال سنة ${state.closeYearText}", if (state.closeCompanyWide) "سيُقفل الخادم السنة على مستوى الشركة، وينشر ترحيل الأرباح المحتجزة. لا توجد معاينة مسبقة في العقد الحالي." else "سيُقفل الخادم السنة للفرع ${capabilities.branchId}. لا يجوز خلط الإقفال الفرعي وإقفال الشركة.", actions.closeYear)) },
                enabled = !state.locked && state.closeYearText.length == 4,
            ) { Text("إقفال") }
        }
        Text("لا يحسب التطبيق الإيراد أو الربح محلياً؛ الأرقام أدناه لقطات خادمية ثابتة.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(state.yearSnapshots, key = { it.id }) { snapshot ->
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(22.dp, 9.dp, 22.dp, 9.dp)).padding(13.dp)) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) { Text(snapshot.year.toString(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold); StatusPill(if (snapshot.branchId == null) "الشركة" else "فرع ${snapshot.branchId}", true) }
                    Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                        MoneyTile("الإيراد", snapshot.totalRevenue, Modifier.weight(1f))
                        MoneyTile("المصروف", snapshot.totalExpenses, Modifier.weight(1f))
                        MoneyTile("الصافي", snapshot.netProfit, Modifier.weight(1f))
                    }
                    val retainedEntry = snapshot.retainedEarningsEntryId?.let { rtlIsolate(it.toString()) } ?: "لا قيد صفري"
                    Text(
                        "لقطة ${rtlIsolate("#${snapshot.id}")} • الأرباح المحتجزة $retainedEntry",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun ControlsCard(
    modifier: Modifier,
    fillContent: Boolean = true,
    scrollContent: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 30.dp, topEnd = 13.dp, bottomStart = 13.dp, bottomEnd = 30.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(2.dp),
    ) {
        val base = if (fillContent) Modifier.fillMaxSize() else Modifier.fillMaxWidth()
        val contentModifier = if (scrollContent) base.verticalScroll(rememberScrollState()) else base
        Column(contentModifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(11.dp), content = content)
    }
}

@Composable
private fun SectionTitle(title: String, subtitle: String, icon: ImageVector) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(46.dp).background(ControlMint, RoundedCornerShape(18.dp, 18.dp, 7.dp, 18.dp)), contentAlignment = Alignment.Center) { Icon(icon, null, tint = ControlBlue) }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) { Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun Subheading(title: String, subtitle: String) {
    Column { Text(title, fontWeight = FontWeight.ExtraBold); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun MoneyTile(label: String, value: String, modifier: Modifier) {
    Column(modifier.background(ControlMint, RoundedCornerShape(16.dp, 7.dp, 16.dp, 7.dp)).padding(9.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall)
        Text(value, fontWeight = FontWeight.ExtraBold, color = ControlBlue, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun StatusPill(label: String, positive: Boolean) {
    Text(label, Modifier.background(if (positive) ControlMint else MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 5.dp), color = if (positive) ControlBlue else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
}

@Composable
private fun Feedback(text: String, error: Boolean, close: () -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp), color = if (error) MaterialTheme.colorScheme.errorContainer else ControlMint, shape = RoundedCornerShape(16.dp, 6.dp, 16.dp, 6.dp)) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.WarningAmber else Icons.Rounded.CheckCircle, null, tint = if (error) MaterialTheme.colorScheme.error else ControlBlue)
            Spacer(Modifier.width(8.dp)); Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall); IconButton(close) { Icon(Icons.Rounded.Close, "إغلاق") }
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Rounded.AccountBalance, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline); Spacer(Modifier.height(8.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
}

private fun AccountingControlsSection.label() = when (this) {
    AccountingControlsSection.ACCOUNTS -> "الحسابات"
    AccountingControlsSection.FINANCIAL_RECONCILIATION -> "التوافق الشامل"
    AccountingControlsSection.EXCHANGE -> "الصيرفة"
    AccountingControlsSection.PERIODS -> "الفترات"
    AccountingControlsSection.YEAR_END -> "الإقفال السنوي"
}

private fun AccountingControlsSection.icon(): ImageVector = when (this) {
    AccountingControlsSection.ACCOUNTS -> Icons.Rounded.AccountTree
    AccountingControlsSection.FINANCIAL_RECONCILIATION -> Icons.AutoMirrored.Rounded.FactCheck
    AccountingControlsSection.EXCHANGE -> Icons.Rounded.Payments
    AccountingControlsSection.PERIODS -> Icons.Rounded.Lock
    AccountingControlsSection.YEAR_END -> Icons.Rounded.AccountBalance
}

private fun FinancialReconciliationAxis.label() = when (this) {
    FinancialReconciliationAxis.CUSTOMERS -> "ذمم العملاء"
    FinancialReconciliationAxis.SUPPLIERS -> "ذمم الموردين"
    FinancialReconciliationAxis.DELIVERY -> "عهدة التوصيل"
    FinancialReconciliationAxis.INVENTORY -> "أرصدة المخزون"
    FinancialReconciliationAxis.LEDGER -> "قيود الدفتر"
    FinancialReconciliationAxis.ONLINE_ORDERS -> "طلبات المتجر × الإرساليات"
    FinancialReconciliationAxis.JOURNAL_ORPHANS -> "أيتام قيود الدفتر"
}

private fun FinancialReconciliationAxis.icon(): ImageVector = when (this) {
    FinancialReconciliationAxis.CUSTOMERS -> Icons.Rounded.PeopleAlt
    FinancialReconciliationAxis.SUPPLIERS -> Icons.Rounded.Storefront
    FinancialReconciliationAxis.DELIVERY -> Icons.Rounded.LocalShipping
    FinancialReconciliationAxis.INVENTORY -> Icons.Rounded.Inventory2
    FinancialReconciliationAxis.LEDGER -> Icons.AutoMirrored.Rounded.ReceiptLong
    FinancialReconciliationAxis.ONLINE_ORDERS -> Icons.Rounded.Storefront
    FinancialReconciliationAxis.JOURNAL_ORPHANS -> Icons.AutoMirrored.Rounded.ReceiptLong
}

private fun formatReconciliationRunAt(raw: String): String = runCatching {
    val instant = runCatching { Instant.parse(raw) }
        .getOrElse { OffsetDateTime.parse(raw).toInstant() }
    DateTimeFormatter.ofPattern("dd MMM yyyy، HH:mm", Locale.forLanguageTag("ar-IQ-u-nu-latn"))
        .withZone(ZoneId.of("Asia/Baghdad"))
        .format(instant)
}.getOrDefault(raw)

private fun ExchangeOperationKind.label() = when (this) {
    ExchangeOperationKind.DEPOSIT -> "إيداع"
    ExchangeOperationKind.WITHDRAW -> "سحب"
    ExchangeOperationKind.BUY_USD -> "شراء دولار"
}

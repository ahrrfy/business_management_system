package online.alarabiya.superapp.feature.marketing

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.FactCheck
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ConfirmationNumber
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.marketing.AnomalyCode
import online.alarabiya.superapp.model.marketing.AnomalySeverity
import online.alarabiya.superapp.model.marketing.CatalogAnomaly
import online.alarabiya.superapp.model.marketing.CouponPreviewLineInput
import online.alarabiya.superapp.model.marketing.CouponPreviewRequest
import online.alarabiya.superapp.model.marketing.CouponProgram
import online.alarabiya.superapp.model.marketing.CouponProgramDraft
import online.alarabiya.superapp.model.marketing.CouponProgramStatus
import online.alarabiya.superapp.model.marketing.CustomerTier
import online.alarabiya.superapp.model.marketing.MarketingPolicy
import online.alarabiya.superapp.model.marketing.MarketingSection
import online.alarabiya.superapp.model.marketing.MarketingValidation
import online.alarabiya.superapp.model.marketing.PromotionChannel
import online.alarabiya.superapp.model.marketing.PromotionDraft
import online.alarabiya.superapp.model.marketing.PromotionMode
import online.alarabiya.superapp.model.marketing.PromotionScope
import online.alarabiya.superapp.model.marketing.PromotionSummary
import online.alarabiya.superapp.model.marketing.PromotionType
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.Stroke

@Composable
fun MarketingScreen(viewModel: MarketingViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state = viewModel.state
    var promotionForm by rememberSaveable { mutableStateOf(false) }
    var editingPromotionId by rememberSaveable { mutableStateOf<Long?>(null) }
    var programForm by rememberSaveable { mutableStateOf(false) }
    var issueProgramId by rememberSaveable { mutableStateOf<Long?>(null) }
    var previewProgramId by rememberSaveable { mutableStateOf<Long?>(null) }
    var anomalyActionKey by rememberSaveable { mutableStateOf<String?>(null) }

    BoxWithConstraints(modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing)) {
        val tablet = maxWidth >= 840.dp
        Column(Modifier.fillMaxSize()) {
            Header(
                title = state.section.label,
                onBack = when {
                    !tablet && state.selectedPromotionId != null -> ({ viewModel.selectPromotion(null) })
                    !tablet && state.selectedProgramId != null -> ({ viewModel.selectProgram(null) })
                    !tablet && state.selectedAnomalyKey != null -> ({ viewModel.selectAnomaly(null) })
                    else -> onBack
                },
                onRefresh = viewModel::refresh,
                refreshing = state.loading,
            )
            SectionStrip(viewModel.availableSections(), state.section, viewModel::setSection)
            MessageStrip(state.error, state.notice, viewModel::clearMessage)
            when (state.section) {
                MarketingSection.Promotions -> MasterDetail(
                    tablet = tablet,
                    hasSelection = state.selectedPromotionId != null,
                    master = {
                        PromotionList(state, viewModel, onCreate = { editingPromotionId = null; promotionForm = true }, Modifier.fillMaxSize())
                    },
                    detail = {
                        PromotionDetailPane(
                            state,
                            viewModel,
                            onEdit = { editingPromotionId = state.selectedPromotionId; promotionForm = true },
                            Modifier.fillMaxSize(),
                        )
                    },
                )
                MarketingSection.Coupons -> MasterDetail(
                    tablet = tablet,
                    hasSelection = state.selectedProgramId != null,
                    master = { ProgramList(state, viewModel, onCreate = { programForm = true }, Modifier.fillMaxSize()) },
                    detail = {
                        ProgramDetailPane(
                            state,
                            viewModel,
                            onIssue = { issueProgramId = it.id },
                            onPreview = { previewProgramId = it.id },
                            Modifier.fillMaxSize(),
                        )
                    },
                )
                MarketingSection.CatalogQuality -> MasterDetail(
                    tablet = tablet,
                    hasSelection = state.selectedAnomalyKey != null,
                    master = { AnomalyList(state, viewModel, Modifier.fillMaxSize()) },
                    detail = {
                        AnomalyDetailPane(
                            state,
                            viewModel,
                            onAction = { anomalyActionKey = MarketingStateFilter.anomalyKey(it) },
                            Modifier.fillMaxSize(),
                        )
                    },
                )
            }
        }
    }

    if (promotionForm) {
        val editing = (state.promotionDetail as? MarketingDetailState.Content)?.value?.promotion
            ?.takeIf { it.id == editingPromotionId }
        PromotionFormDialog(
            initial = editing,
            branchId = state.scope.branchId,
            busy = state.busyKey != null,
            onDismiss = { promotionForm = false },
            onSubmit = { draft -> promotionForm = false; viewModel.savePromotion(editing?.id, draft) },
        )
    }
    if (programForm) {
        ProgramFormDialog(
            branchId = state.scope.branchId,
            busy = state.busyKey != null,
            onDismiss = { programForm = false },
            onSubmit = { programForm = false; viewModel.saveCouponProgram(it) },
        )
    }
    issueProgramId?.let { id ->
        state.couponPrograms.firstOrNull { it.id == id }?.let { program ->
            IssueCouponsDialog(program, { issueProgramId = null }) { count, customerId ->
                issueProgramId = null
                viewModel.requestIssueCoupons(program, count, customerId)
            }
        }
    }
    previewProgramId?.let { id ->
        state.couponPrograms.firstOrNull { it.id == id }?.let { program ->
            CouponPreviewDialog(
                program = program,
                defaultBranch = state.scope.effectiveBranch(program.branchId),
                preview = state.couponPreview,
                busy = state.busyKey != null,
                onDismiss = { previewProgramId = null },
                onPreview = viewModel::previewCoupon,
            )
        }
    }
    anomalyActionKey?.let { key ->
        state.anomalies?.findings?.firstOrNull { MarketingStateFilter.anomalyKey(it) == key }?.let { anomaly ->
            AnomalyActionDialog(anomaly, { anomalyActionKey = null }, viewModel)
        }
    }
    state.pendingAction?.let { action ->
        ConfirmationDialog(action, state.busyKey != null, viewModel::dismissConfirmation, viewModel::confirmPendingAction)
    }
}

@Composable
private fun Header(title: String, onBack: () -> Unit, onRefresh: () -> Unit, refreshing: Boolean) {
    Row(
        Modifier.fillMaxWidth().background(EmeraldDark).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع", tint = Color.White) }
        Column(Modifier.weight(1f)) {
            Text("مركز النمو التجاري", color = Color.White.copy(alpha = .7f), style = MaterialTheme.typography.labelMedium)
            Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White)
        }
    }
}

@Composable
private fun SectionStrip(sections: List<MarketingSection>, selected: MarketingSection, onSelect: (MarketingSection) -> Unit) {
    val icons = mapOf(
        MarketingSection.Promotions to Icons.Rounded.Campaign,
        MarketingSection.Coupons to Icons.Rounded.ConfirmationNumber,
        MarketingSection.CatalogQuality to Icons.AutoMirrored.Rounded.FactCheck,
    )
    LazyRow(
        Modifier.fillMaxWidth().background(Color.White),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(sections) { section ->
            FilterChip(
                selected = selected == section,
                onClick = { onSelect(section) },
                label = { Text(section.label) },
                leadingIcon = { Icon(icons.getValue(section), null, Modifier.size(18.dp)) },
            )
        }
    }
}

@Composable
private fun MessageStrip(error: String?, notice: String?, onClear: () -> Unit) {
    val message = error ?: notice ?: return
    val color = if (error != null) Color(0xFFB42318) else Emerald
    Surface(
        color = color.copy(alpha = .09f),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClick = onClear).semantics {
            liveRegion = if (error != null) LiveRegionMode.Assertive else LiveRegionMode.Polite
        },
    ) {
        Text(message, color = color, modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp))
    }
}

@Composable
private fun MasterDetail(tablet: Boolean, hasSelection: Boolean, master: @Composable () -> Unit, detail: @Composable () -> Unit) {
    if (tablet) {
        Row(
            Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Box(Modifier.width(380.dp).fillMaxHeight()) { master() }
            Box(Modifier.weight(1f).fillMaxHeight()) { detail() }
        }
    } else {
        Box(Modifier.fillMaxSize().padding(12.dp)) { if (hasSelection) detail() else master() }
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit, placeholder: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        leadingIcon = { Icon(Icons.Rounded.Search, null) },
        placeholder = { Text(placeholder) },
    )
}

@Composable
private fun PromotionList(state: MarketingUiState, viewModel: MarketingViewModel, onCreate: () -> Unit, modifier: Modifier) {
    val rows = MarketingStateFilter.promotions(state)
    Column(modifier) {
        SearchField(state.query, viewModel::setQuery, "ابحث في العروض")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(state.includeInactivePromotions, viewModel::setIncludeInactive)
            Text("إظهار المعطلة", modifier = Modifier.weight(1f))
            if (state.capabilities.canManageCampaigns) {
                Button(onClick = onCreate, enabled = state.busyKey == null) { Icon(Icons.Rounded.Add, null); Text("عرض") }
            }
        }
        if (state.loading && rows.isEmpty()) LoadingPane(Modifier.fillMaxSize())
        else if (state.promotionsLoaded && rows.isEmpty()) EmptyPane("لا توجد عروض مطابقة", Modifier.fillMaxSize())
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(rows, key = { it.id }) { promotion ->
                SelectableCard(selected = state.selectedPromotionId == promotion.id, onClick = { viewModel.selectPromotion(promotion.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(promotion.name, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text("${promotion.type.label} · ${promotion.scope.label} · ${promotion.channel.label}", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                            Text("${promotion.effectiveFrom} — ${promotion.effectiveTo ?: "مفتوح"}", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                        }
                        StatusPill(if (promotion.isActive) "نشط" else "معطل", promotion.isActive)
                    }
                }
            }
        }
    }
}

@Composable
private fun PromotionDetailPane(state: MarketingUiState, viewModel: MarketingViewModel, onEdit: () -> Unit, modifier: Modifier) {
    when (val detail = state.promotionDetail) {
        MarketingDetailState.None -> EmptyPane("اختر عرضًا لعرض تفاصيله", modifier)
        MarketingDetailState.Loading -> LoadingPane(modifier)
        is MarketingDetailState.Error -> EmptyPane(detail.message, modifier)
        is MarketingDetailState.Content -> {
            val p = detail.value.promotion
            LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    HeroCard(Icons.Rounded.Campaign, p.name, if (p.type == PromotionType.Percent) "${p.discountPercent}%" else p.discountAmount) {
                        StatusPill(if (p.isActive) "نشط" else "معطل", p.isActive)
                    }
                }
                item { InfoGrid(listOf("القناة" to p.channel.label, "التطبيق" to p.mode.label, "النطاق" to p.scope.label, "الأولوية" to p.priority.toString())) }
                item { InfoGrid(listOf("البداية" to p.effectiveFrom, "النهاية" to (p.effectiveTo ?: "مفتوح"), "الفئة" to (p.customerTier?.label ?: "الكل"), "الحد الأدنى" to p.minLineAmount)) }
                if (detail.value.targets.isNotEmpty()) item {
                    ContentCard("الأهداف") {
                        detail.value.targets.forEach { target ->
                            Text("فئة ${target.categoryId ?: "—"} · منتج ${target.productId ?: "—"} · متغير ${target.variantId ?: "—"}")
                        }
                    }
                }
                if (state.capabilities.canManageCampaigns) item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = onEdit, enabled = state.busyKey == null) { Icon(Icons.Rounded.Edit, null); Text("تعديل") }
                        Button(
                            onClick = { viewModel.requestPromotionActive(p, !p.isActive) },
                            enabled = state.busyKey == null,
                        ) { Icon(Icons.Rounded.PowerSettingsNew, null); Text(if (p.isActive) "تعطيل" else "إعادة التفعيل") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProgramList(state: MarketingUiState, viewModel: MarketingViewModel, onCreate: () -> Unit, modifier: Modifier) {
    val rows = MarketingStateFilter.programs(state)
    Column(modifier) {
        SearchField(state.query, viewModel::setQuery, "ابحث في برامج الكوبونات")
        if (state.capabilities.canManageCampaigns) {
            Button(onClick = onCreate, enabled = state.busyKey == null, modifier = Modifier.padding(vertical = 8.dp).align(Alignment.End)) {
                Icon(Icons.Rounded.Add, null); Text("برنامج")
            }
        }
        if (state.loading && rows.isEmpty()) LoadingPane(Modifier.fillMaxSize())
        else if (state.programsLoaded && rows.isEmpty()) EmptyPane("لا توجد برامج كوبونات", Modifier.fillMaxSize())
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(rows, key = { it.id }) { program ->
                SelectableCard(state.selectedProgramId == program.id, { viewModel.selectProgram(program.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(program.name, fontWeight = FontWeight.Bold)
                            Text("${program.codePrefix} · ${program.issued} إصدار · ${program.redeemed} استخدام", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                            Text("${program.validFrom} — ${program.validTo ?: "مفتوح"}", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                        }
                        StatusPill(program.status.label, program.status == CouponProgramStatus.Active)
                    }
                }
            }
        }
    }
}

@Composable
private fun ProgramDetailPane(
    state: MarketingUiState,
    viewModel: MarketingViewModel,
    onIssue: (CouponProgram) -> Unit,
    onPreview: (CouponProgram) -> Unit,
    modifier: Modifier,
) {
    val program = state.couponPrograms.firstOrNull { it.id == state.selectedProgramId }
    if (program == null) return EmptyPane("اختر برنامجًا لعرض تفاصيله", modifier)
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            HeroCard(Icons.Rounded.ConfirmationNumber, program.name, program.status.label) {
                Text("عرض #${program.promotionId}", color = Color.White.copy(alpha = .8f))
            }
        }
        item { InfoGrid(listOf("الإصدارات" to program.issued.toString(), "المستخدمة" to program.redeemed.toString(), "لكل كوبون" to program.perCouponLimit.toString(), "لكل عميل" to program.perCustomerLimit.toString())) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onPreview(program) }, enabled = state.busyKey == null) { Text("معاينة سعر خادمية") }
                if (MarketingPolicy.canManageProgram(program, state.scope, state.capabilities) && program.status != CouponProgramStatus.Ended) {
                    Button(onClick = { onIssue(program) }, enabled = state.busyKey == null) { Text("إصدار") }
                }
            }
        }
        if (MarketingPolicy.canManageProgram(program, state.scope, state.capabilities)) item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(MarketingPolicy.allowedProgramTransitions(program.status).toList()) { status ->
                    OutlinedButton(onClick = { viewModel.requestProgramStatus(program, status) }, enabled = state.busyKey == null) { Text(status.label) }
                }
            }
        }
        item { Text("الكوبونات الصادرة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
        when (val issued = state.issuedCoupons) {
            MarketingDetailState.None, MarketingDetailState.Loading -> item { LoadingPane(Modifier.fillMaxWidth().height(120.dp)) }
            is MarketingDetailState.Error -> item { EmptyPane(issued.message, Modifier.fillMaxWidth().height(120.dp)) }
            is MarketingDetailState.Content -> {
                if (issued.value.rows.isEmpty()) item { EmptyPane("لم تصدر كوبونات بعد", Modifier.fillMaxWidth().height(120.dp)) }
                items(issued.value.rows, key = { it.id }) { coupon ->
                    ContentCard(coupon.code) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${coupon.status.label} · ${coupon.redemptionCount} استخدام", color = MutedInk, modifier = Modifier.weight(1f))
                            if (coupon.status.wire == "ACTIVE" && state.capabilities.canManageCampaigns) {
                                TextButton(onClick = { viewModel.requestVoidCoupon(coupon.id) }, enabled = state.busyKey == null) { Text("إلغاء") }
                            }
                        }
                    }
                }
                if (issued.value.hasMore) item {
                    OutlinedButton(onClick = viewModel::loadMoreCoupons, enabled = !state.loadingMore, modifier = Modifier.fillMaxWidth()) {
                        Text(if (state.loadingMore) "جار التحميل…" else "تحميل المزيد")
                    }
                }
            }
        }
    }
}

@Composable
private fun AnomalyList(state: MarketingUiState, viewModel: MarketingViewModel, modifier: Modifier) {
    val rows = MarketingStateFilter.anomalies(state)
    Column(modifier) {
        SearchField(state.query, viewModel::setQuery, "منتج، SKU أو عدسة")
        LazyRow(contentPadding = PaddingValues(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            item { FilterChip(state.anomalySeverity == null, { viewModel.setAnomalyFilters(state.anomalyCode, null, state.includeOverriddenAnomalies) }, { Text("كل الحدة") }) }
            items(AnomalySeverity.entries.filterNot { it == AnomalySeverity.Unknown }) { severity ->
                FilterChip(state.anomalySeverity == severity, { viewModel.setAnomalyFilters(state.anomalyCode, severity, state.includeOverriddenAnomalies) }, { Text(severity.label) })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(state.includeOverriddenAnomalies, { viewModel.setAnomalyFilters(state.anomalyCode, state.anomalySeverity, it) })
            Text("إظهار الاستثناءات")
        }
        state.anomalies?.let { page ->
            InfoGrid(listOf("حرج" to page.blockerCount.toString(), "تحذير" to page.warningCount.toString(), "معلومة" to page.infoCount.toString(), "الإجمالي" to page.total.toString()))
        }
        if (state.loading && rows.isEmpty()) LoadingPane(Modifier.fillMaxSize())
        else if (state.anomaliesLoaded && rows.isEmpty()) EmptyPane("لا توجد نتائج تدقيق مطابقة", Modifier.fillMaxSize())
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(rows, key = MarketingStateFilter::anomalyKey) { anomaly ->
                SelectableCard(state.selectedAnomalyKey == MarketingStateFilter.anomalyKey(anomaly), { viewModel.selectAnomaly(anomaly) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(anomaly.productName, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text("${anomaly.sku} · ${anomaly.code.label}", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                        }
                        StatusPill(anomaly.severity.label, anomaly.severity != AnomalySeverity.Blocker)
                    }
                }
            }
            if (state.anomalies?.hasMore == true) item {
                OutlinedButton(onClick = viewModel::loadMoreAnomalies, enabled = !state.loadingMore, modifier = Modifier.fillMaxWidth()) {
                    Text(if (state.loadingMore) "جار التحميل…" else "تحميل المزيد")
                }
            }
        }
    }
}

@Composable
private fun AnomalyDetailPane(state: MarketingUiState, viewModel: MarketingViewModel, onAction: (CatalogAnomaly) -> Unit, modifier: Modifier) {
    val anomaly = state.anomalies?.findings?.firstOrNull { MarketingStateFilter.anomalyKey(it) == state.selectedAnomalyKey }
        ?: return EmptyPane("اختر نتيجة تدقيق لعرض تفاصيلها", modifier)
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { HeroCard(Icons.Rounded.WarningAmber, anomaly.productName, anomaly.code.wire) { StatusPill(anomaly.severity.label, anomaly.severity != AnomalySeverity.Blocker) } }
        item { ContentCard("ملاحظة الكاشف") { Text(anomaly.note.ifBlank { anomaly.code.label }) } }
        item {
            ContentCard("القياسات") {
                anomaly.metrics.forEach { (key, value) ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(key, color = MutedInk); Text(value, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
        anomaly.overrideKind?.let { kind -> item { ContentCard("الاستثناء الحالي") { Text("$kind · حتى ${anomaly.overrideUntil ?: "دائم"}") } } }
        if (state.capabilities.canManageCatalogQuality) item {
            if (anomaly.overrideKind == null) Button(onClick = { onAction(anomaly) }, enabled = state.busyKey == null) { Text("إدارة النتيجة") }
            else OutlinedButton(onClick = { viewModel.requestClearOverride(anomaly) }, enabled = state.busyKey == null) { Text("إلغاء الاستثناء") }
        }
    }
}

@Composable
private fun PromotionFormDialog(
    initial: PromotionSummary?,
    branchId: Long?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (PromotionDraft) -> Unit,
) {
    var name by rememberSaveable(initial?.id) { mutableStateOf(initial?.name.orEmpty()) }
    var value by rememberSaveable(initial?.id) { mutableStateOf(if (initial?.type == PromotionType.Amount) initial.discountAmount else initial?.discountPercent ?: "10") }
    var from by rememberSaveable(initial?.id) { mutableStateOf(initial?.effectiveFrom.orEmpty()) }
    var to by rememberSaveable(initial?.id) { mutableStateOf(initial?.effectiveTo.orEmpty()) }
    var description by rememberSaveable(initial?.id) { mutableStateOf(initial?.description.orEmpty()) }
    var type by remember(initial?.id) { mutableStateOf(initial?.type ?: PromotionType.Percent) }
    var scope by remember(initial?.id) { mutableStateOf(initial?.scope ?: PromotionScope.All) }
    var mode by remember(initial?.id) { mutableStateOf(initial?.mode ?: PromotionMode.Auto) }
    var channel by remember(initial?.id) { mutableStateOf(initial?.channel ?: PromotionChannel.Pos) }
    var tier by remember(initial?.id) { mutableStateOf(initial?.customerTier) }
    var minLine by rememberSaveable(initial?.id) { mutableStateOf(initial?.minLineAmount ?: "0") }
    var priority by rememberSaveable(initial?.id) { mutableStateOf(initial?.priority?.toString() ?: "0") }
    var campaign by rememberSaveable(initial?.id) { mutableStateOf(initial?.campaignId?.toString().orEmpty()) }
    var branch by rememberSaveable(initial?.id) { mutableStateOf((initial?.branchId ?: branchId)?.toString().orEmpty()) }
    var targetId by rememberSaveable(initial?.id) { mutableStateOf("") }
    var error by rememberSaveable(initial?.id) { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (initial == null) "عرض جديد" else "تعديل العرض") },
        text = {
            LazyColumn(Modifier.heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                item { OutlinedTextField(name, { name = it.take(255) }, label = { Text("الاسم") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(description, { description = it.take(2000) }, label = { Text("الوصف") }, modifier = Modifier.fillMaxWidth()) }
                item { ChoiceRow(PromotionType.entries.filterNot { it == PromotionType.Unknown }, type, { type = it }, { it.label }, enabled = initial == null) }
                item { OutlinedTextField(value, { value = it }, label = { Text("قيمة الخصم") }, modifier = Modifier.fillMaxWidth()) }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { ArabicDatePicker(from, { from = it }, "من", modifier = Modifier.weight(1f)); ArabicDatePicker(to, { to = it }, "إلى", modifier = Modifier.weight(1f)) } }
                item { ChoiceRow(PromotionMode.entries, mode, { mode = it }, { it.label }) }
                item { ChoiceRow(PromotionChannel.entries, channel, { channel = it }, { it.label }) }
                item {
                    ChoiceRow<CustomerTier?>(
                        listOf(null) + CustomerTier.entries,
                        tier,
                        { tier = it },
                        { it?.label ?: "كل العملاء" },
                    )
                }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(minLine, { minLine = it }, label = { Text("حد السطر") }, modifier = Modifier.weight(1f)); OutlinedTextField(priority, { priority = it.filter(Char::isDigit).take(3) }, label = { Text("الأولوية") }, modifier = Modifier.weight(1f)) } }
                if (initial == null) {
                    item { ChoiceRow(PromotionScope.entries.filterNot { it == PromotionScope.Unknown }, scope, { scope = it }, { it.label }) }
                    item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(campaign, { campaign = it.filter(Char::isDigit) }, label = { Text("الحملة — اختياري") }, modifier = Modifier.weight(1f)); OutlinedTextField(branch, { branch = it.filter(Char::isDigit) }, label = { Text("الفرع — فارغ للعامة") }, modifier = Modifier.weight(1f)) } }
                    if (scope != PromotionScope.All) item { OutlinedTextField(targetId, { targetId = it.filter(Char::isDigit) }, label = { Text(if (scope == PromotionScope.Categories) "معرّف الفئة" else "معرّف المنتج") }, modifier = Modifier.fillMaxWidth()) }
                }
                error?.let { item { Text(it, color = Color(0xFFB42318)) } }
            }
        },
        confirmButton = {
            Button(onClick = {
                val id = targetId.toLongOrNull()
                val targets = if (initial == null && scope != PromotionScope.All && id != null) listOf(
                    online.alarabiya.superapp.model.marketing.PromotionTarget(
                        categoryId = id.takeIf { scope == PromotionScope.Categories },
                        productId = id.takeIf { scope == PromotionScope.Products },
                    ),
                ) else emptyList()
                val draft = PromotionDraft(
                    name = name,
                    description = description,
                    type = type,
                    discountValue = value,
                    scope = scope,
                    effectiveFrom = from,
                    effectiveTo = to.ifBlank { null },
                    customerTier = tier,
                    branchId = initial?.branchId ?: branch.toLongOrNull(),
                    minLineAmount = minLine,
                    priority = priority.toIntOrNull() ?: 0,
                    mode = mode,
                    channel = channel,
                    campaignId = initial?.campaignId ?: campaign.toLongOrNull(),
                    targets = targets,
                )
                error = MarketingValidation.promotion(draft, initial != null)
                if (error == null) onSubmit(draft)
            }, enabled = !busy) { Text("حفظ") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("إلغاء") } },
    )
}

@Composable
private fun ProgramFormDialog(branchId: Long?, busy: Boolean, onDismiss: () -> Unit, onSubmit: (CouponProgramDraft) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var promotionId by rememberSaveable { mutableStateOf("") }
    var branch by rememberSaveable { mutableStateOf(branchId?.toString().orEmpty()) }
    var campaign by rememberSaveable { mutableStateOf("") }
    var from by rememberSaveable { mutableStateOf("") }
    var to by rememberSaveable { mutableStateOf("") }
    var prefix by rememberSaveable { mutableStateOf("CRM") }
    var couponLimit by rememberSaveable { mutableStateOf("1") }
    var customerLimit by rememberSaveable { mutableStateOf("1") }
    var title by rememberSaveable { mutableStateOf("") }
    var subtitle by rememberSaveable { mutableStateOf("") }
    var terms by rememberSaveable { mutableStateOf("") }
    var color by rememberSaveable { mutableStateOf("#0F766E") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("برنامج كوبونات جديد") },
        text = {
            LazyColumn(Modifier.heightIn(max = 540.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { OutlinedTextField(name, { name = it.take(255) }, label = { Text("اسم البرنامج") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(promotionId, { promotionId = it.filter(Char::isDigit) }, label = { Text("معرّف عرض من نوع كوبون") }, modifier = Modifier.fillMaxWidth()) }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(branch, { branch = it.filter(Char::isDigit) }, label = { Text("الفرع") }, modifier = Modifier.weight(1f)); OutlinedTextField(campaign, { campaign = it.filter(Char::isDigit) }, label = { Text("الحملة") }, modifier = Modifier.weight(1f)) } }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(from, { from = it.take(10) }, label = { Text("من") }, modifier = Modifier.weight(1f)); OutlinedTextField(to, { to = it.take(10) }, label = { Text("إلى") }, modifier = Modifier.weight(1f)) } }
                item { OutlinedTextField(prefix, { prefix = it.take(12) }, label = { Text("بادئة الرمز") }, modifier = Modifier.fillMaxWidth()) }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(couponLimit, { couponLimit = it.filter(Char::isDigit).take(4) }, label = { Text("حد الكوبون") }, modifier = Modifier.weight(1f)); OutlinedTextField(customerLimit, { customerLimit = it.filter(Char::isDigit).take(4) }, label = { Text("حد العميل") }, modifier = Modifier.weight(1f)) } }
                item { OutlinedTextField(title, { title = it.take(80) }, label = { Text("عنوان البطاقة") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(subtitle, { subtitle = it.take(140) }, label = { Text("النص المساند") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(terms, { terms = it.take(500) }, label = { Text("الشروط") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(color, { color = it.take(7) }, label = { Text("لون البطاقة #RRGGBB") }, modifier = Modifier.fillMaxWidth()) }
                error?.let { item { Text(it, color = Color(0xFFB42318)) } }
            }
        },
        confirmButton = {
            Button(onClick = {
                val draft = CouponProgramDraft(
                    promotionId = promotionId.toLongOrNull() ?: 0,
                    name = name,
                    branchId = branch.toLongOrNull(),
                    validFrom = from,
                    validTo = to.ifBlank { null },
                    perCouponLimit = couponLimit.toIntOrNull() ?: 0,
                    perCustomerLimit = customerLimit.toIntOrNull() ?: 0,
                    codePrefix = prefix,
                    campaignId = campaign.toLongOrNull(),
                    title = title,
                    subtitle = subtitle,
                    terms = terms,
                    color = color,
                )
                error = MarketingValidation.couponProgram(draft)
                if (error == null) onSubmit(draft)
            }, enabled = !busy) { Text("إنشاء") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("إلغاء") } },
    )
}

@Composable
private fun IssueCouponsDialog(program: CouponProgram, onDismiss: () -> Unit, onSubmit: (Int, Long?) -> Unit) {
    var count by rememberSaveable { mutableStateOf("1") }
    var customer by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إصدار كوبونات") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(program.name, color = MutedInk)
                OutlinedTextField(count, { count = it.filter(Char::isDigit).take(3) }, label = { Text("العدد 1–500") })
                OutlinedTextField(customer, { customer = it.filter(Char::isDigit) }, label = { Text("معرّف العميل — اختياري") })
                Text("الإصدار عملية غير قابلة للإعادة التلقائية؛ سيُرسل الطلب مرة واحدة بعد التأكيد.", style = MaterialTheme.typography.bodySmall, color = MutedInk)
            }
        },
        confirmButton = { Button(onClick = { onSubmit(count.toIntOrNull() ?: 0, customer.toLongOrNull()) }, enabled = count.toIntOrNull() in 1..500) { Text("متابعة") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun CouponPreviewDialog(
    program: CouponProgram,
    defaultBranch: Long?,
    preview: MarketingDetailState<online.alarabiya.superapp.model.marketing.CouponPreview>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onPreview: (CouponPreviewRequest) -> Unit,
) {
    var code by rememberSaveable(program.id) { mutableStateOf("") }
    var branch by rememberSaveable(program.id) { mutableStateOf(defaultBranch?.toString().orEmpty()) }
    var product by rememberSaveable(program.id) { mutableStateOf("") }
    var variant by rememberSaveable(program.id) { mutableStateOf("") }
    var unit by rememberSaveable(program.id) { mutableStateOf("") }
    var price by rememberSaveable(program.id) { mutableStateOf("") }
    var quantity by rememberSaveable(program.id) { mutableStateOf("1") }
    var error by rememberSaveable(program.id) { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("معاينة الأثر السعري") },
        text = {
            LazyColumn(Modifier.heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { OutlinedTextField(code, { code = it.take(64) }, label = { Text("رمز الكوبون") }, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(branch, { branch = it.filter(Char::isDigit) }, label = { Text("الفرع") }, modifier = Modifier.fillMaxWidth()) }
                item { Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { OutlinedTextField(product, { product = it.filter(Char::isDigit) }, label = { Text("المنتج") }, modifier = Modifier.weight(1f)); OutlinedTextField(variant, { variant = it.filter(Char::isDigit) }, label = { Text("المتغير") }, modifier = Modifier.weight(1f)); OutlinedTextField(unit, { unit = it.filter(Char::isDigit) }, label = { Text("الوحدة") }, modifier = Modifier.weight(1f)) } }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(price, { price = it }, label = { Text("سعر الوحدة") }, modifier = Modifier.weight(1f)); OutlinedTextField(quantity, { quantity = it.filter(Char::isDigit) }, label = { Text("الكمية") }, modifier = Modifier.weight(1f)) } }
                error?.let { item { Text(it, color = Color(0xFFB42318)) } }
                when (preview) {
                    MarketingDetailState.None -> Unit
                    MarketingDetailState.Loading -> item { CircularProgressIndicator(Modifier.size(24.dp)) }
                    is MarketingDetailState.Error -> item { Text(preview.message, color = Color(0xFFB42318)) }
                    is MarketingDetailState.Content -> items(preview.value.lines) { line ->
                        ContentCard(line.promotionName) { Text("السعر الفعلي ${line.effectivePrice} · الخصم للوحدة ${line.discountPerUnit}", color = Emerald) }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val request = CouponPreviewRequest(
                    code = code,
                    branchId = branch.toLongOrNull() ?: 0,
                    customerId = null,
                    customerTier = CustomerTier.Retail,
                    lines = listOf(CouponPreviewLineInput(product.toLongOrNull() ?: 0, variant.toLongOrNull() ?: 0, unit.toLongOrNull() ?: 0, price, quantity.toIntOrNull() ?: 0)),
                )
                error = MarketingValidation.couponPreview(request)
                if (error == null) onPreview(request)
            }, enabled = !busy) { Text("تحقق") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("إغلاق") } },
    )
}

@Composable
private fun AnomalyActionDialog(anomaly: CatalogAnomaly, onDismiss: () -> Unit, viewModel: MarketingViewModel) {
    var justification by rememberSaveable(anomaly.variantId, anomaly.code.wire) { mutableStateOf("") }
    var until by rememberSaveable(anomaly.variantId, anomaly.code.wire) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إدارة نتيجة التدقيق") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(anomaly.productName, fontWeight = FontWeight.Bold)
                OutlinedTextField(justification, { justification = it.take(500) }, label = { Text("تبرير إداري — 10 أحرف على الأقل") }, modifier = Modifier.fillMaxWidth())
                ArabicDatePicker(until, { until = it }, "استثناء حتى — اختياري")
            }
        },
        confirmButton = {
            Row {
                TextButton(onClick = { onDismiss(); viewModel.requestMarkIgnored(anomaly, justification) }, enabled = justification.trim().length >= 10) { Text("تجاهل دائم") }
                Button(onClick = { onDismiss(); viewModel.requestMarkIntentional(anomaly, justification, until.ifBlank { null }) }, enabled = justification.trim().length >= 10) { Text("مقصود") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun ConfirmationDialog(action: PendingMarketingAction, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val (title, body) = when (action) {
        is PendingMarketingAction.PromotionActive -> (if (action.active) "إعادة تفعيل العرض" else "تعطيل العرض") to action.promotion.name
        is PendingMarketingAction.ProgramStatus -> "تغيير حالة البرنامج" to "${action.program.name} ← ${action.status.label}"
        is PendingMarketingAction.IssueCoupons -> "تأكيد الإصدار" to "إصدار ${action.count} كوبون من ${action.program.name}"
        is PendingMarketingAction.VoidCoupon -> "إلغاء الكوبون" to "لن يمكن استخدام الكوبون بعد الإلغاء."
        is PendingMarketingAction.MarkIntentional -> "اعتماد الاستثناء" to action.justification
        is PendingMarketingAction.MarkIgnored -> "تجاهل النتيجة" to action.justification
        is PendingMarketingAction.ClearOverride -> "إلغاء الاستثناء" to action.anomaly.productName
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = { Button(onClick = onConfirm, enabled = !busy, modifier = Modifier.testTag("marketing_confirm")) { Text(if (busy) "جار التنفيذ…" else "تأكيد") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("تراجع") } },
    )
}

@Composable
private fun <T> ChoiceRow(values: List<T>, selected: T, onSelect: (T) -> Unit, label: (T) -> String, enabled: Boolean = true) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        items(values) { value -> FilterChip(selected == value, { onSelect(value) }, { Text(label(value)) }, enabled = enabled) }
    }
}

@Composable
private fun HeroCard(icon: ImageVector, title: String, value: String, trailing: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = EmeraldDark), shape = RoundedCornerShape(28.dp)) {
        Row(Modifier.fillMaxWidth().padding(22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Surface(color = Color.White.copy(alpha = .12f), shape = RoundedCornerShape(18.dp)) { Icon(icon, null, tint = Color.White, modifier = Modifier.padding(13.dp).size(28.dp)) }
            Column(Modifier.weight(1f)) { Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(value, color = Color.White.copy(alpha = .74f)) }
            trailing()
        }
    }
}

@Composable
private fun ContentCard(title: String, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), border = CardDefaults.outlinedCardBorder(), shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, fontWeight = FontWeight.Bold); HorizontalDivider(color = Stroke); content() }
    }
}

@Composable
private fun SelectableCard(selected: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
        border = CardDefaults.outlinedCardBorder(),
        shape = RoundedCornerShape(18.dp),
    ) { Box(Modifier.fillMaxWidth().padding(15.dp)) { content() } }
}

@Composable
private fun InfoGrid(values: List<Pair<String, String>>) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(18.dp)) {
        LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(14.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
            items(values) { (label, value) -> Column { Text(label, color = MutedInk, style = MaterialTheme.typography.bodySmall); Text(value, fontWeight = FontWeight.Bold) } }
        }
    }
}

@Composable
private fun StatusPill(label: String, positive: Boolean) {
    Surface(color = (if (positive) Emerald else Orange).copy(alpha = .12f), shape = RoundedCornerShape(100.dp)) {
        Text(label, color = if (positive) Emerald else Orange, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp))
    }
}

@Composable
private fun LoadingPane(modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Emerald) }
}

@Composable
private fun EmptyPane(message: String, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) { Text(message, color = MutedInk) }
}

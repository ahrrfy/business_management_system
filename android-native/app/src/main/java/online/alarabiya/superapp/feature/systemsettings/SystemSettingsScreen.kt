package online.alarabiya.superapp.feature.systemsettings

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Business
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Gavel
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.Warning
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.systemsettings.AdminBranch
import online.alarabiya.superapp.model.systemsettings.BranchDraft
import online.alarabiya.superapp.model.systemsettings.BranchType
import online.alarabiya.superapp.model.systemsettings.ChannelIntegration
import online.alarabiya.superapp.model.systemsettings.IntegrationChannel
import online.alarabiya.superapp.model.systemsettings.IntegrationMetadataDraft
import online.alarabiya.superapp.model.systemsettings.IntegrationStatus
import online.alarabiya.superapp.model.systemsettings.NativeSystemSettingsBoundaries
import online.alarabiya.superapp.model.systemsettings.OpeningMode
import online.alarabiya.superapp.model.systemsettings.SystemSettingsCapabilities
import online.alarabiya.superapp.model.systemsettings.TaxSettings
import online.alarabiya.superapp.model.systemsettings.TemplateStatus
import online.alarabiya.superapp.model.systemsettings.TriageMode
import online.alarabiya.superapp.model.systemsettings.WhatsAppHubSettings

private val AdminNavy = Color(0xFF362087)
private val AdminBlue = Color(0xFF5B36D2)
private val AdminMint = Color(0xFFF0ECFF)
private val AdminCanvas = Color(0xFFF8F7FC)
private val AdminWarning = Color(0xFFEC2F86)

@Composable
fun SystemSettingsRoute(
    viewModel: SystemSettingsViewModel,
    capabilities: SystemSettingsCapabilities,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel, capabilities) { viewModel.initialize(capabilities) }
    SystemSettingsScreen(viewModel.state, capabilities, viewModel, modifier)
}

@Composable
fun SystemSettingsScreen(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
    modifier: Modifier = Modifier,
) {
    val sections = capabilities.readableSections()
    BoxWithConstraints(modifier.fillMaxSize().background(AdminCanvas)) {
        if (maxWidth >= 840.dp) {
            Row(Modifier.fillMaxSize().padding(24.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                Surface(Modifier.width(284.dp).fillMaxHeight(), shape = RoundedCornerShape(30.dp), color = Color.White) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Header(compact = true, loading = state.loading, onRefresh = { actions.refresh(capabilities) })
                        Spacer(Modifier.height(12.dp))
                        sections.forEach { section ->
                            FilterChip(
                                selected = state.section == section,
                                onClick = { actions.select(section, capabilities) },
                                label = { Text(section.label, modifier = Modifier.fillMaxWidth()) },
                                leadingIcon = { Icon(section.icon, null) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        SecurityBoundary()
                    }
                }
                Content(state, capabilities, actions, Modifier.weight(1f).fillMaxHeight())
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                Header(compact = false, loading = state.loading, onRefresh = { actions.refresh(capabilities) })
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(sections) { section ->
                        FilterChip(
                            selected = state.section == section,
                            onClick = { actions.select(section, capabilities) },
                            label = { Text(section.label) },
                            leadingIcon = { Icon(section.icon, null) },
                        )
                    }
                }
                Content(state, capabilities, actions, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Header(compact: Boolean, loading: Boolean, onRefresh: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(if (compact) Color.Transparent else Color.White)
            .padding(horizontal = if (compact) 0.dp else 20.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text("مركز إدارة النظام", style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = AdminNavy)
            Text("التشغيل والتكاملات والحوكمة", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = onRefresh, enabled = !loading) {
            if (loading) CircularProgressIndicator(Modifier.width(22.dp), strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تحديث")
        }
    }
}

@Composable
private fun Content(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
    modifier: Modifier,
) {
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        state.message?.let { item { Notice(it, error = false) } }
        state.error?.let { item { Notice(it, error = true) } }
        when (state.section) {
            SystemSettingsSection.Overview -> overviewItems(state)
            SystemSettingsSection.Branches -> branchItems(state, capabilities, actions)
            SystemSettingsSection.Integrations -> integrationItems(state, capabilities, actions)
            SystemSettingsSection.WhatsApp -> whatsAppItems(state, capabilities, actions)
            SystemSettingsSection.Governance -> governanceItems(state, capabilities, actions)
        }
        item { Spacer(Modifier.height(20.dp)) }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.overviewItems(state: SystemSettingsUiState) {
    item {
        HeroCard("الحالة التشغيلية", if (state.health?.ok == true) "الخدمات الأساسية متاحة" else "تعذر تأكيد الحالة", Icons.Rounded.CloudDone)
    }
    state.systemInfo?.let { info ->
        item {
            AdminCard("مؤشرات المنصة", Icons.Rounded.Settings) {
                MetricGrid(
                    listOf(
                        "الفروع" to info.counts.branches.toString(), "المستخدمون" to info.counts.users.toString(),
                        "المنتجات" to info.counts.products.toString(), "العملاء" to info.counts.customers.toString(),
                        "الفواتير" to info.counts.invoices.toString(), "النسخ" to info.backups.count.toString(),
                    ),
                )
            }
        }
        item {
            AdminCard("البنية التشغيلية", Icons.Rounded.Security) {
                ValueLine("الطابعة", if (info.printer.enabled) "مفعّلة" else "غير مفعّلة")
                ValueLine("النسخ اليومي", info.schedule.dailyAt ?: "غير محدد")
                ValueLine("نسخ خارج الموقع", if (info.schedule.offsiteConfigured) "مهيأ" else "غير مهيأ")
                ValueLine("آخر نسخة", info.backups.latest ?: "لا توجد")
                BoundaryText(NativeSystemSettingsBoundaries.MAINTENANCE)
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.branchItems(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
) {
    item { BranchEditor(capabilities, actions) }
    items(state.branches, key = { it.id }) { branch -> BranchRow(branch, capabilities, state.busyKey, actions) }
}

@Composable
private fun BranchEditor(capabilities: SystemSettingsCapabilities, actions: SystemSettingsViewModel) {
    var open by rememberSaveable { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }, enabled = capabilities.canManageBranches, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("إضافة فرع")
    }
    if (open) BranchDialog(null, onDismiss = { open = false }) { actions.saveBranch(it, capabilities); open = false }
}

@Composable
private fun BranchRow(branch: AdminBranch, capabilities: SystemSettingsCapabilities, busyKey: String?, actions: SystemSettingsViewModel) {
    var edit by remember { mutableStateOf(false) }
    var confirmActive by remember { mutableStateOf<Boolean?>(null) }
    AdminCard(branch.name, Icons.Rounded.Business) {
        ValueLine("الرمز", branch.code)
        ValueLine("النوع", if (branch.type == BranchType.MAIN) "رئيسي" else "مبيعات")
        ValueLine("الحالة", if (branch.active) "نشط" else "معطل")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { edit = true }, enabled = capabilities.canManageBranches && busyKey == null) { Icon(Icons.Rounded.Edit, null); Text("تعديل") }
            OutlinedButton(onClick = { confirmActive = !branch.active }, enabled = capabilities.canManageBranches && busyKey == null) {
                Icon(Icons.Rounded.PowerSettingsNew, null); Text(if (branch.active) "تعطيل" else "تفعيل")
            }
        }
    }
    if (edit) BranchDialog(branch, onDismiss = { edit = false }) { actions.saveBranch(it, capabilities); edit = false }
    confirmActive?.let { active ->
        ConfirmDialog(
            title = if (active) "تفعيل الفرع؟" else "تعطيل الفرع؟",
            body = if (active) "سيعود الفرع إلى العمليات المتاحة." else "سيتحقق الخادم من المخزون ومن بقاء فرع نشط قبل التعطيل.",
            onDismiss = { confirmActive = null },
            onConfirm = { actions.setBranchActive(branch, active, capabilities); confirmActive = null },
        )
    }
}

@Composable
private fun BranchDialog(branch: AdminBranch?, onDismiss: () -> Unit, onSave: (BranchDraft) -> Unit) {
    var name by rememberSaveable(branch?.id) { mutableStateOf(branch?.name.orEmpty()) }
    var code by rememberSaveable(branch?.id) { mutableStateOf(branch?.code.orEmpty()) }
    var address by rememberSaveable(branch?.id) { mutableStateOf(branch?.address.orEmpty()) }
    var phone by rememberSaveable(branch?.id) { mutableStateOf(branch?.phone.orEmpty()) }
    var type by rememberSaveable(branch?.id) { mutableStateOf(branch?.type ?: BranchType.SALES) }
    val draft = BranchDraft(branch?.id, name, code, type, address, phone)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (branch == null) "فرع جديد" else "تعديل الفرع") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("الاسم") }, singleLine = true)
            OutlinedTextField(code, { code = it.uppercase() }, label = { Text("الرمز") }, singleLine = true)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(BranchType.entries) { item -> FilterChip(type == item, { type = item }, { Text(if (item == BranchType.MAIN) "رئيسي" else "مبيعات") }) } }
            OutlinedTextField(address, { address = it }, label = { Text("العنوان") })
            OutlinedTextField(phone, { phone = it }, label = { Text("الهاتف") }, singleLine = true)
            draft.validate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { Button(onClick = { onSave(draft) }, enabled = draft.validate() == null) { Text("حفظ") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

private fun androidx.compose.foundation.lazy.LazyListScope.integrationItems(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
) {
    item {
        Notice(
            if (state.crypto?.ready == true) "خزنة تشفير التكاملات جاهزة" else "خزنة تشفير التكاملات غير جاهزة؛ التعديل متوقف حتى يجهزها التشغيل",
            error = state.crypto?.ready != true,
        )
    }
    item { NewIntegration(state, capabilities, actions) }
    items(state.integrations, key = { it.id }) { integration -> IntegrationRow(integration, state, capabilities, actions) }
    item { BoundaryText(NativeSystemSettingsBoundaries.SECRET_ROTATION) }
    item { BoundaryText(NativeSystemSettingsBoundaries.PERMANENT_DELETE) }
}

@Composable
private fun NewIntegration(state: SystemSettingsUiState, capabilities: SystemSettingsCapabilities, actions: SystemSettingsViewModel) {
    var open by rememberSaveable { mutableStateOf(false) }
    OutlinedButton(
        onClick = { open = true },
        enabled = capabilities.canManageIntegrations && state.crypto?.ready == true && state.branches.any { it.active },
        modifier = Modifier.fillMaxWidth(),
    ) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("تهيئة قناة جديدة") }
    if (open) NewIntegrationDialog(state.branches.filter { it.active }, { open = false }) {
        actions.saveIntegration(it, capabilities); open = false
    }
}

@Composable
private fun NewIntegrationDialog(branches: List<AdminBranch>, onDismiss: () -> Unit, onSave: (IntegrationMetadataDraft) -> Unit) {
    var branchId by rememberSaveable { mutableLongStateOf(branches.firstOrNull()?.id ?: 0L) }
    var channel by rememberSaveable { mutableStateOf(IntegrationChannel.WHATSAPP) }
    var displayName by rememberSaveable { mutableStateOf("") }
    val draft = IntegrationMetadataDraft(branchId, channel, displayName)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تهيئة قناة جديدة") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("ينشئ هذا بيانات القناة العامة فقط. المفاتيح تضاف عبر قناة التشغيل الآمنة.", color = AdminWarning)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(branches) { branch -> FilterChip(branchId == branch.id, { branchId = branch.id }, { Text(branch.name) }) } }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(IntegrationChannel.entries) { item -> FilterChip(channel == item, { channel = item }, { Text(item.name) }) } }
            OutlinedTextField(displayName, { displayName = it }, label = { Text("اسم العرض") })
            draft.validate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { Button({ onSave(draft) }, enabled = draft.validate() == null) { Text("إنشاء") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun IntegrationRow(integration: ChannelIntegration, state: SystemSettingsUiState, capabilities: SystemSettingsCapabilities, actions: SystemSettingsViewModel) {
    var edit by remember { mutableStateOf(false) }
    var confirmation by remember { mutableStateOf<String?>(null) }
    AdminCard(integration.displayName ?: integration.channel.name, Icons.Rounded.Hub) {
        ValueLine("الفرع", integration.branchName)
        ValueLine("الحالة", integration.status.name)
        ValueLine("رمز التحقق", if (integration.hasVerifyToken) "مهيأ" else "غير مهيأ")
        ValueLine("مفتاح التطبيق", if (integration.hasAppSecret) "مهيأ" else "غير مهيأ")
        ValueLine("رمز الوصول", if (integration.hasAccessToken) "مهيأ" else "غير مهيأ")
        integration.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { edit = true }, enabled = capabilities.canManageIntegrations && state.crypto?.ready == true && state.busyKey == null) { Text("البيانات العامة") }
            OutlinedButton(onClick = { confirmation = "verify" }, enabled = capabilities.canManageIntegrations && state.busyKey == null) { Text("اختبار") }
            OutlinedButton(onClick = { confirmation = "enabled" }, enabled = capabilities.canManageIntegrations && state.busyKey == null) {
                Text(if (integration.status == IntegrationStatus.DISABLED) "تفعيل" else "تعطيل")
            }
        }
    }
    if (edit) IntegrationDialog(integration, onDismiss = { edit = false }) { actions.saveIntegration(it, capabilities); edit = false }
    confirmation?.let { op ->
        val verifying = op == "verify"
        val enable = integration.status == IntegrationStatus.DISABLED
        ConfirmDialog(
            title = if (verifying) "اختبار الاتصال الخارجي؟" else if (enable) "تفعيل التكامل؟" else "تعطيل التكامل؟",
            body = if (verifying) "سيتحقق الخادم من الاتصال بالمزوّد ويسجل النتيجة." else "سيتم تغيير حالة التكامل مع الاحتفاظ بسجل التدقيق.",
            onDismiss = { confirmation = null },
            onConfirm = {
                if (verifying) actions.verifyIntegration(integration, capabilities) else actions.setIntegrationEnabled(integration, enable, capabilities)
                confirmation = null
            },
        )
    }
}

@Composable
private fun IntegrationDialog(integration: ChannelIntegration, onDismiss: () -> Unit, onSave: (IntegrationMetadataDraft) -> Unit) {
    var displayName by rememberSaveable { mutableStateOf(integration.displayName.orEmpty()) }
    var phoneId by rememberSaveable { mutableStateOf(integration.phoneNumberId.orEmpty()) }
    var wabaId by rememberSaveable { mutableStateOf(integration.wabaId.orEmpty()) }
    val draft = IntegrationMetadataDraft(integration.branchId, integration.channel, displayName, phoneId, wabaId)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("البيانات العامة للتكامل") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text("لا تعرض هذه النافذة مفاتيح أو كلمات مرور.", color = AdminWarning)
            OutlinedTextField(displayName, { displayName = it }, label = { Text("اسم العرض") })
            OutlinedTextField(phoneId, { phoneId = it }, label = { Text("معرّف الهاتف") })
            OutlinedTextField(wabaId, { wabaId = it }, label = { Text("WABA ID") })
            draft.validate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { Button({ onSave(draft) }, enabled = draft.validate() == null) { Text("حفظ") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

private fun androidx.compose.foundation.lazy.LazyListScope.whatsAppItems(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
) {
    state.whatsAppHub?.let { hub -> item { WhatsAppHubEditor(hub, capabilities, state.busyKey, actions) } }
    if (capabilities.canSyncTemplates) item { TemplateSync(state, capabilities, actions) }
    state.lastTemplateSync?.let { result -> item { Notice("تمت مزامنة ${result.synced} قالب؛ المعتمد ${result.approved}", false) } }
    items(state.templates, key = { it.id }) { template ->
        AdminCard(template.name, Icons.AutoMirrored.Rounded.Chat) {
            ValueLine("اللغة", template.language)
            ValueLine("الفئة", template.category.name)
            ValueLine("الحالة", template.status.name)
            template.body?.let { Text(it, maxLines = 3, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (template.status != TemplateStatus.APPROVED) Text("غير متاح للإرسال الإنتاجي", color = AdminWarning)
        }
    }
}

@Composable
private fun WhatsAppHubEditor(settings: WhatsAppHubSettings, capabilities: SystemSettingsCapabilities, busyKey: String?, actions: SystemSettingsViewModel) {
    var draft by remember(settings) { mutableStateOf(settings) }
    var confirm by remember { mutableStateOf(false) }
    AdminCard("ضوابط مركز WhatsApp", Icons.AutoMirrored.Rounded.Chat) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(TriageMode.entries) { mode -> FilterChip(draft.triageMode == mode, { draft = draft.copy(triageMode = mode) }, { Text(mode.label) }) }
        }
        ToggleLine("إنشاء مهمة تلقائياً", draft.autoTaskEnabled) { draft = draft.copy(autoTaskEnabled = it) }
        ToggleLine("رد الترحيب", draft.autoReplyWelcome) { draft = draft.copy(autoReplyWelcome = it) }
        ToggleLine("رد خارج الدوام", draft.autoReplyAfterHours) { draft = draft.copy(autoReplyAfterHours = it) }
        ToggleLine("تذكير الذمم", draft.flowArReminder) { draft = draft.copy(flowArReminder = it) }
        ToggleLine("جاهزية الطلب", draft.flowOrderReady) { draft = draft.copy(flowOrderReady = it) }
        ToggleLine("شكر الشراء", draft.flowPurchaseThanks) { draft = draft.copy(flowPurchaseThanks = it) }
        ToggleLine("سحب الأمانات", draft.flowConsignmentWithdraw) { draft = draft.copy(flowConsignmentWithdraw = it) }
        ToggleLine("استبيان الرضا عند الحل", draft.csatOnResolve) { draft = draft.copy(csatOnResolve = it) }
        ToggleLine("إيقاف الأتمتة بالكامل", draft.killSwitch) { draft = draft.copy(killSwitch = it) }
        OutlinedTextField(draft.throttlePerMinute.toString(), { draft = draft.copy(throttlePerMinute = it.toIntOrNull() ?: 0) }, label = { Text("الحد في الدقيقة") })
        OutlinedTextField(draft.campaignApprovalThreshold.toString(), { draft = draft.copy(campaignApprovalThreshold = it.toIntOrNull() ?: -1) }, label = { Text("حد اعتماد الحملة") })
        OutlinedTextField(draft.welcomeReply.orEmpty(), { draft = draft.copy(welcomeReply = it) }, label = { Text("رسالة الترحيب") })
        OutlinedTextField(draft.afterHoursReply.orEmpty(), { draft = draft.copy(afterHoursReply = it) }, label = { Text("رسالة خارج الدوام") })
        OutlinedTextField(draft.optOutKeywords.orEmpty(), { draft = draft.copy(optOutKeywords = it) }, label = { Text("كلمات إلغاء الاشتراك") })
        draft.validate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        BoundaryText(NativeSystemSettingsBoundaries.BUSINESS_HOURS)
        Button(onClick = { confirm = true }, enabled = capabilities.canUpdateWhatsAppHub && busyKey == null && draft.validate() == null, modifier = Modifier.fillMaxWidth()) { Text("حفظ الضوابط") }
    }
    if (confirm) ConfirmDialog(
        "اعتماد ضوابط WhatsApp؟",
        if (draft.killSwitch) "سيتوقف الرد والتدفقات الآلية فوراً." else "ستصبح الضوابط الجديدة فعّالة على مركز المحادثات.",
        { confirm = false },
        { actions.updateWhatsAppHub(draft, capabilities); confirm = false },
    )
}

@Composable
private fun TemplateSync(state: SystemSettingsUiState, capabilities: SystemSettingsCapabilities, actions: SystemSettingsViewModel) {
    var branchId by rememberSaveable { mutableStateOf<Long?>(null) }
    var confirm by remember { mutableStateOf(false) }
    AdminCard("مزامنة قوالب Meta", Icons.Rounded.Sync) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.branches.filter { it.active }) { branch -> FilterChip(branchId == branch.id, { branchId = branch.id }, { Text(branch.name) }) }
        }
        Button(onClick = { confirm = true }, enabled = branchId != null && state.busyKey == null, modifier = Modifier.fillMaxWidth()) { Text("مزامنة") }
    }
    if (confirm) ConfirmDialog("مزامنة القوالب؟", "ستتم مزامنة قوالب Meta للفرع المحدد.", { confirm = false }) {
        actions.syncTemplates(requireNotNull(branchId), capabilities); confirm = false
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.governanceItems(
    state: SystemSettingsUiState,
    capabilities: SystemSettingsCapabilities,
    actions: SystemSettingsViewModel,
) {
    state.tax?.let { item { TaxEditor(it, capabilities, state.busyKey, actions) } }
    state.opening?.let { item { OpeningEditor(it, capabilities, state.busyKey, actions) } }
    if (state.openingProgress.isNotEmpty()) item {
        AdminCard("تقدم الافتتاح", Icons.Rounded.CheckCircle) {
            state.openingProgress.forEach { ValueLine(it.branchName, "${it.openedVariants} / ${it.totalVariants}") }
        }
    }
}

@Composable
private fun TaxEditor(settings: TaxSettings, capabilities: SystemSettingsCapabilities, busyKey: String?, actions: SystemSettingsViewModel) {
    var enabled by remember(settings) { mutableStateOf(settings.enabledByDefault) }
    var rate by remember(settings) { mutableStateOf(settings.defaultTaxRatePercent) }
    var number by remember(settings) { mutableStateOf(settings.taxRegistrationNumber.orEmpty()) }
    var confirm by remember { mutableStateOf(false) }
    val draft = settings.copy(enabledByDefault = enabled, defaultTaxRatePercent = rate, taxRegistrationNumber = number)
    AdminCard("إعدادات الضريبة", Icons.Rounded.Gavel) {
        ToggleLine("مفعلة افتراضياً", enabled) { enabled = it }
        OutlinedTextField(rate, { rate = it }, label = { Text("النسبة %") })
        OutlinedTextField(number, { number = it }, label = { Text("الرقم الضريبي") })
        draft.validate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button({ confirm = true }, enabled = capabilities.canUpdateGovernance && busyKey == null && draft.validate() == null, modifier = Modifier.fillMaxWidth()) { Text("حفظ الضريبة") }
    }
    if (confirm) ConfirmDialog("اعتماد الضريبة؟", "سيطبق هذا الإعداد افتراضياً على العمليات الجديدة.", { confirm = false }) { actions.updateTax(draft, capabilities); confirm = false }
}

@Composable
private fun OpeningEditor(mode: OpeningMode, capabilities: SystemSettingsCapabilities, busyKey: String?, actions: SystemSettingsViewModel) {
    var enabled by remember(mode) { mutableStateOf(mode.enabled) }
    var end by remember(mode) { mutableStateOf(mode.endsAtYmd.orEmpty()) }
    var maxNegative by remember(mode) { mutableStateOf(mode.maxNegativeQtyPerLine.toString()) }
    var confirm by remember { mutableStateOf(false) }
    val draft = mode.copy(enabled = enabled, endsAtYmd = end.takeIf(String::isNotBlank), maxNegativeQtyPerLine = maxNegative.toIntOrNull() ?: 0)
    AdminCard("فترة الافتتاح", Icons.Rounded.Security) {
        ToggleLine("تفعيل الفترة", enabled) { enabled = it }
        OutlinedTextField(end, { end = it }, label = { Text("ينتهي في YYYY-MM-DD") }, enabled = enabled)
        OutlinedTextField(maxNegative, { maxNegative = it }, label = { Text("الحد السالب لكل سطر") })
        Text(if (mode.active) "الفترة نشطة حالياً" else "الفترة غير نشطة", color = if (mode.active) AdminBlue else MaterialTheme.colorScheme.onSurfaceVariant)
        draft.validateForUpdate()?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button({ confirm = true }, enabled = capabilities.canUpdateGovernance && busyKey == null && draft.validateForUpdate() == null, modifier = Modifier.fillMaxWidth()) { Text("تطبيق حالة الفترة") }
    }
    if (confirm) ConfirmDialog("تغيير فترة الافتتاح؟", "هذا فعل حوكمة يؤثر في قبول الكميات السالبة وسيُسجل في التدقيق.", { confirm = false }) { actions.updateOpening(draft, capabilities); confirm = false }
}

@Composable
private fun HeroCard(title: String, subtitle: String, icon: ImageVector) {
    Card(colors = CardDefaults.cardColors(containerColor = AdminNavy), shape = RoundedCornerShape(30.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(Modifier.clip(CircleShape).background(Color.White.copy(alpha = .12f)).padding(14.dp)) { Icon(icon, null, tint = Color.White) }
            Column { Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(subtitle, color = Color.White.copy(alpha = .76f)) }
        }
    }
}

@Composable
private fun AdminCard(title: String, icon: ImageVector, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.clip(RoundedCornerShape(12.dp)).background(AdminMint).padding(9.dp)) { Icon(icon, null, tint = AdminNavy) }
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = AdminNavy)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            content()
        }
    }
}

@Composable private fun ValueLine(label: String, value: String) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, fontWeight = FontWeight.SemiBold)
}

@Composable private fun MetricGrid(metrics: List<Pair<String, String>>) {
    metrics.chunked(2).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        row.forEach { metric -> Surface(Modifier.weight(1f), color = AdminCanvas, shape = RoundedCornerShape(16.dp)) { Column(Modifier.padding(14.dp)) { Text(metric.second, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AdminBlue); Text(metric.first, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
        if (row.size == 1) Spacer(Modifier.weight(1f))
    } }
}

@Composable private fun ToggleLine(label: String, checked: Boolean, onChange: (Boolean) -> Unit) =
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text(label); Switch(checked, onChange) }

@Composable private fun Notice(text: String, error: Boolean) {
    Surface(color = if (error) MaterialTheme.colorScheme.errorContainer else AdminMint, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.Warning else Icons.Rounded.CheckCircle, null, tint = if (error) MaterialTheme.colorScheme.error else AdminNavy)
            Text(text, modifier = Modifier.weight(1f), color = if (error) MaterialTheme.colorScheme.onErrorContainer else AdminNavy)
        }
    }
}

@Composable private fun BoundaryText(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable private fun SecurityBoundary() = Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Icon(Icons.Rounded.Security, null, tint = AdminBlue)
    Text("حماية بيانات التكامل", fontWeight = FontWeight.Bold, color = AdminNavy)
    Text("تدار بيانات الاعتماد من الخادم.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable private fun ConfirmDialog(title: String, body: String, onDismiss: () -> Unit, onConfirm: () -> Unit) = AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(title) }, text = { Text(body) },
    confirmButton = { Button(onClick = onConfirm) { Text("تأكيد") } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
)

private val SystemSettingsSection.label: String get() = when (this) {
    SystemSettingsSection.Overview -> "الحالة"
    SystemSettingsSection.Branches -> "الفروع"
    SystemSettingsSection.Integrations -> "التكاملات"
    SystemSettingsSection.WhatsApp -> "WhatsApp"
    SystemSettingsSection.Governance -> "الحوكمة"
}
private val SystemSettingsSection.icon: ImageVector get() = when (this) {
    SystemSettingsSection.Overview -> Icons.Rounded.Settings
    SystemSettingsSection.Branches -> Icons.Rounded.Business
    SystemSettingsSection.Integrations -> Icons.Rounded.Hub
    SystemSettingsSection.WhatsApp -> Icons.AutoMirrored.Rounded.Chat
    SystemSettingsSection.Governance -> Icons.Rounded.Gavel
}
private val TriageMode.label: String get() = when (this) { TriageMode.AUTO_ALL -> "تلقائي"; TriageMode.KEYWORD_ONLY -> "كلمات"; TriageMode.MANUAL -> "يدوي" }

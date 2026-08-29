package online.alarabiya.superapp.feature.announcements

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.announcements.AnnouncementAudienceType
import online.alarabiya.superapp.model.announcements.AnnouncementDetail
import online.alarabiya.superapp.model.announcements.AnnouncementPriority
import online.alarabiya.superapp.model.announcements.AnnouncementReader
import online.alarabiya.superapp.model.announcements.AnnouncementSummary
import online.alarabiya.superapp.model.announcements.AnnouncementsCapabilities
import online.alarabiya.superapp.model.announcements.CreateAnnouncementCommand
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun AnnouncementsAdminRoute(viewModel: AnnouncementsAdminViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.refresh() }
    AnnouncementsAdminScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        onRefresh = viewModel::refresh,
        onSelect = viewModel::select,
        onToggleActive = viewModel::toggleActive,
        onOpenEditor = viewModel::openEditor,
        onCloseEditor = viewModel::closeEditor,
        onCreate = viewModel::create,
        onIncludeInactive = viewModel::setIncludeInactive,
        modifier = modifier,
    )
}

@Composable
fun AnnouncementsAdminScreen(
    state: AnnouncementsAdminUiState,
    capabilities: AnnouncementsCapabilities,
    onRefresh: () -> Unit,
    onSelect: (Long?) -> Unit,
    onToggleActive: (Long, Boolean) -> Unit,
    onOpenEditor: () -> Unit,
    onCloseEditor: () -> Unit,
    onCreate: (CreateAnnouncementCommand) -> Unit,
    onIncludeInactive: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(modifier = modifier.fillMaxSize().testTag("native-route-announcements-admin")) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                AnnouncementsHeader(
                    count = state.items.size,
                    canManage = capabilities.canManage,
                    refreshing = state.loading,
                    onRefresh = onRefresh,
                    onCreate = onOpenEditor,
                )
                AnimatedVisibility(state.message != null) { NoticeBanner(state.message.orEmpty()) }
                AnimatedVisibility(state.error != null && state.items.isNotEmpty()) {
                    InlineError(state.error.orEmpty(), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                }
                FilterRow(state.includeInactive, onIncludeInactive)
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val wide = maxWidth >= 760.dp
                    when {
                        state.loading && state.items.isEmpty() -> LoadingState()
                        state.error != null && state.items.isEmpty() -> ErrorState(state.error, onRefresh)
                        wide -> WideLayout(state, capabilities.canManage, onSelect, onToggleActive)
                        else -> CompactLayout(state, capabilities.canManage, onSelect, onToggleActive)
                    }
                }
            }
        }
        if (state.editorOpen) {
            AnnouncementEditorDialog(
                capabilities = capabilities,
                submitting = state.locked,
                errorText = state.error,
                onDismiss = onCloseEditor,
                onCreate = onCreate,
            )
        }
    }
}

@Composable
private fun AnnouncementsHeader(
    count: Int,
    canManage: Boolean,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onCreate: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = RoundedCornerShape(bottomStart = 42.dp, bottomEnd = 16.dp),
        tonalElevation = 5.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 20.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(50.dp)
                        .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = .12f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.Campaign, contentDescription = null)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text("إدارة الإعلانات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(
                        if (count == 0) "لا إعلانات بعد" else "$count إعلاناً منشوراً",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .76f),
                    )
                }
                IconButton(onClick = onRefresh, enabled = !refreshing) {
                    if (refreshing) CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    ) else Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
                }
            }
            if (canManage) {
                Spacer(Modifier.height(14.dp))
                Button(
                    onClick = onCreate,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.onPrimary.copy(alpha = .16f),
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                ) {
                    Icon(Icons.Rounded.Add, contentDescription = null)
                    Spacer(Modifier.width(7.dp))
                    Text("إعلان جديد")
                }
            }
        }
    }
}

@Composable
private fun FilterRow(includeInactive: Boolean, onIncludeInactive: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(
            selected = includeInactive,
            onClick = { onIncludeInactive(!includeInactive) },
            label = { Text("تشمل المعطّلة") },
        )
    }
}

@Composable
private fun WideLayout(
    state: AnnouncementsAdminUiState,
    canManage: Boolean,
    onSelect: (Long?) -> Unit,
    onToggleActive: (Long, Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        AnnouncementList(state, canManage, onSelect, onToggleActive, Modifier.weight(.44f))
        Surface(
            modifier = Modifier.weight(.56f).fillMaxSize(),
            shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 34.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            tonalElevation = 2.dp,
        ) {
            val selected = state.selected
            if (selected == null) SelectionHint()
            else AnnouncementDetailPane(selected, state.detail?.takeIf { it.summary.id == selected.id }, Modifier.padding(24.dp))
        }
    }
}

@Composable
private fun CompactLayout(
    state: AnnouncementsAdminUiState,
    canManage: Boolean,
    onSelect: (Long?) -> Unit,
    onToggleActive: (Long, Boolean) -> Unit,
) {
    AnimatedContent(targetState = state.selected, label = "announcement-navigation") { selected ->
        if (selected == null) {
            AnnouncementList(
                state,
                canManage,
                onSelect,
                onToggleActive,
                Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 14.dp),
            )
        } else {
            Column(Modifier.fillMaxSize().padding(18.dp)) {
                TextButton(onClick = { onSelect(null) }) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("كل الإعلانات")
                }
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    shape = RoundedCornerShape(topStart = 34.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 34.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                ) {
                    AnnouncementDetailPane(selected, state.detail?.takeIf { it.summary.id == selected.id }, Modifier.padding(22.dp))
                }
            }
        }
    }
}

@Composable
private fun AnnouncementList(
    state: AnnouncementsAdminUiState,
    canManage: Boolean,
    onSelect: (Long?) -> Unit,
    onToggleActive: (Long, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state.items.isEmpty()) {
        EmptyState(modifier.fillMaxSize())
        return
    }
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        items(state.items, key = { it.id }) { item ->
            AnnouncementListCard(
                item = item,
                selected = item.id == state.selectedId,
                pending = state.busyKey == "active-${item.id}",
                canManage = canManage,
                onClick = { onSelect(item.id) },
                onToggleActive = onToggleActive,
            )
        }
    }
}

@Composable
private fun AnnouncementListCard(
    item: AnnouncementSummary,
    selected: Boolean,
    pending: Boolean,
    canManage: Boolean,
    onClick: () -> Unit,
    onToggleActive: (Long, Boolean) -> Unit,
) {
    val accent = priorityColors(item.priority).first
    Card(
        modifier = Modifier.fillMaxWidth().clickable(enabled = !pending, role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 12.dp, bottomStart = 12.dp, bottomEnd = 24.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) accent.copy(alpha = .10f) else MaterialTheme.colorScheme.surface,
        ),
        border = CardDefaults.outlinedCardBorder().takeIf { selected },
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    modifier = Modifier.weight(1f),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                PriorityChip(item.priority)
            }
            Text(item.audienceText(), style = MaterialTheme.typography.labelMedium, color = accent)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(formatDate(item.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("قرأه ${item.readCount}", style = MaterialTheme.typography.bodySmall)
                    if (item.requiresAck) Text("أقرّ ${item.ackCount}", style = MaterialTheme.typography.bodySmall, color = accent)
                }
            }
            if (canManage) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (item.isActive) "نشط" else "معطّل",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (item.isActive) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (pending) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    else Switch(checked = item.isActive, onCheckedChange = { onToggleActive(item.id, it) })
                }
            }
        }
    }
}

@Composable
private fun AnnouncementDetailPane(
    summary: AnnouncementSummary,
    detail: AnnouncementDetail?,
    modifier: Modifier = Modifier,
) {
    val (accent, container) = priorityColors(summary.priority)
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(58.dp).background(container, RoundedCornerShape(20.dp)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.Campaign, contentDescription = null, tint = accent) }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(summary.priority.label, style = MaterialTheme.typography.labelLarge, color = accent)
                    Text(summary.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(summary.audienceText(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                StatusPill(if (summary.isActive) "نشط" else "معطّل", summary.isActive)
            }
        }
        item { HorizontalDivider() }
        item { DetailLine("النص", summary.body) }
        item { DetailLine("الجمهور", summary.audienceText()) }
        item { DetailLine("النشر", formatDate(summary.createdAt)) }
        summary.expiresAt?.let { expiry -> item { DetailLine("ينتهي", formatDate(expiry)) } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                MetricTile("قرأه", summary.readCount.toString(), Modifier.weight(1f))
                if (summary.requiresAck) MetricTile("أقرّ", summary.ackCount.toString(), Modifier.weight(1f))
            }
        }
        item { Text("القُرّاء", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
        when {
            detail == null -> item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("يجري تحميل القُرّاء…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            detail.readers.isEmpty() -> item {
                Text("لا قُرّاء بعد", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> items(detail.readers, key = { it.userId }) { reader -> ReaderRow(reader) }
        }
    }
}

@Composable
private fun ReaderRow(reader: AnnouncementReader) {
    Row(
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Person, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(reader.userName, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("قراءة ${formatDate(reader.readAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (reader.acknowledgedAt != null) StatusPill("أقرّ", true)
    }
}

@Composable
private fun AnnouncementEditorDialog(
    capabilities: AnnouncementsCapabilities,
    submitting: Boolean,
    errorText: String?,
    onDismiss: () -> Unit,
    onCreate: (CreateAnnouncementCommand) -> Unit,
) {
    val forceBranch = !capabilities.canCrossBranches
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf(AnnouncementPriority.NORMAL) }
    var audienceType by remember {
        mutableStateOf(if (forceBranch) AnnouncementAudienceType.BRANCH else AnnouncementAudienceType.ALL)
    }
    var branchIdText by remember { mutableStateOf(capabilities.branchId?.toString().orEmpty()) }
    var roleText by remember { mutableStateOf("") }
    var requiresAck by remember { mutableStateOf(false) }
    var expiresAt by remember { mutableStateOf("") }

    val branchId = branchIdText.trim().toLongOrNull()
    val audienceValid = when (audienceType) {
        AnnouncementAudienceType.ALL -> true
        AnnouncementAudienceType.BRANCH -> branchId != null && branchId > 0
        AnnouncementAudienceType.ROLE -> roleText.isNotBlank()
    }
    val canSubmit = title.isNotBlank() && body.isNotBlank() && audienceValid && !submitting

    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        title = { Text("إعلان جديد", fontWeight = FontWeight.Bold) },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 560.dp).verticalScroll(rememberScrollState()).imePadding(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { if (it.length <= 200) title = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("العنوان") },
                    singleLine = true,
                    enabled = !submitting,
                    supportingText = { Text("${title.length}/200") },
                )
                OutlinedTextField(
                    value = body,
                    onValueChange = { if (it.length <= 5000) body = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("النص") },
                    minLines = 4,
                    enabled = !submitting,
                    supportingText = { Text("${body.length}/5000") },
                )
                Text("الأولوية", fontWeight = FontWeight.SemiBold)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    AnnouncementPriority.entries.forEach { option ->
                        FilterChip(
                            selected = priority == option,
                            onClick = { priority = option },
                            label = { Text(option.label) },
                            enabled = !submitting,
                        )
                    }
                }
                Text("الجمهور", fontWeight = FontWeight.SemiBold)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    AnnouncementAudienceType.entries.forEach { option ->
                        FilterChip(
                            selected = audienceType == option,
                            onClick = { audienceType = option },
                            label = { Text(option.label) },
                            enabled = !submitting && (!forceBranch || option == AnnouncementAudienceType.BRANCH),
                        )
                    }
                }
                if (forceBranch) Text(
                    "مقصورٌ على فرعك بحكم الصلاحية",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                when (audienceType) {
                    AnnouncementAudienceType.BRANCH -> OutlinedTextField(
                        value = branchIdText,
                        onValueChange = { if (!forceBranch) branchIdText = it.filter(Char::isDigit).take(9) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("رقم الفرع") },
                        singleLine = true,
                        enabled = !submitting && !forceBranch,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        supportingText = { Text(if (forceBranch) "فرعك" else "معرّف الفرع المستهدَف") },
                    )
                    AnnouncementAudienceType.ROLE -> OutlinedTextField(
                        value = roleText,
                        onValueChange = { roleText = it.take(64) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("مفتاح الدور") },
                        singleLine = true,
                        enabled = !submitting,
                    )
                    AnnouncementAudienceType.ALL -> Unit
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = requiresAck, onCheckedChange = { requiresAck = it }, enabled = !submitting)
                    Spacer(Modifier.width(6.dp))
                    Text("يتطلّب إقراراً", Modifier.weight(1f))
                }
                ArabicDatePicker(
                    value = expiresAt,
                    onValue = { expiresAt = it },
                    label = "ينتهي (اختياري)",
                    enabled = !submitting,
                )
                errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onCreate(
                        CreateAnnouncementCommand(
                            title = title.trim(),
                            body = body.trim(),
                            priority = priority,
                            audienceType = audienceType,
                            audienceBranchId = if (audienceType == AnnouncementAudienceType.BRANCH) branchId else null,
                            audienceRole = if (audienceType == AnnouncementAudienceType.ROLE) roleText.trim() else null,
                            requiresAck = requiresAck,
                            expiresAt = expiresAt.trim().takeIf { it.isNotBlank() },
                        ),
                    )
                },
                enabled = canSubmit,
                modifier = Modifier.testTag("announcement_create_submit"),
            ) {
                if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("نشر الإعلان")
            }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss, enabled = !submitting) { Text("إلغاء") } },
    )
}

@Composable
private fun PriorityChip(priority: AnnouncementPriority) {
    val (accent, container) = priorityColors(priority)
    Text(
        priority.label,
        modifier = Modifier.background(container, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 4.dp),
        color = accent,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun StatusPill(label: String, positive: Boolean) {
    Text(
        label,
        modifier = Modifier
            .background(
                if (positive) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer,
                RoundedCornerShape(50),
            )
            .padding(horizontal = 9.dp, vertical = 5.dp),
        color = if (positive) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
        style = MaterialTheme.typography.bodySmall,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(modifier, color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.padding(14.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun NoticeBanner(message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .heightIn(min = 48.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
            Text(message, Modifier.weight(1f))
        }
    }
}

@Composable
private fun InlineError(message: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.errorContainer,
        shape = RoundedCornerShape(14.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Close, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Spacer(Modifier.width(8.dp))
            Text(message, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}

@Composable
private fun LoadingState() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.WarningAmber, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(12.dp))
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(14.dp))
        Button(onClick = onRetry) { Text("إعادة المحاولة") }
    }
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    Column(
        modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.Campaign, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(50.dp))
        Spacer(Modifier.height(12.dp))
        Text("لا توجد إعلانات", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("أنشئ أول إعلان لبثّه للموظفين", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SelectionHint() {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.Campaign, contentDescription = null, modifier = Modifier.size(56.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(14.dp))
        Text("اختر إعلانًا لعرض تفاصيله", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("ستظهر إحصاءات القراءة والقُرّاء هنا", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun AnnouncementSummary.audienceText(): String = when (audienceType) {
    AnnouncementAudienceType.ALL -> "كل الموظفين"
    AnnouncementAudienceType.BRANCH -> "فرع #${audienceBranchId ?: "؟"}"
    AnnouncementAudienceType.ROLE -> audienceRole ?: "دور محدَّد"
}

private fun priorityColors(priority: AnnouncementPriority): Pair<Color, Color> = when (priority) {
    AnnouncementPriority.NORMAL -> Color(0xFF5267B3) to Color(0xFFEBEEFF)
    AnnouncementPriority.IMPORTANT -> Color(0xFF8B5A00) to Color(0xFFFFF0D1)
    AnnouncementPriority.CRITICAL -> Color(0xFFB3261E) to Color(0xFFFFE2DE)
}

private fun formatDate(value: String): String = runCatching {
    OffsetDateTime.parse(value).format(DateTimeFormatter.ofPattern("d MMM yyyy، h:mm a", Locale.forLanguageTag("ar")))
}.getOrDefault(value)

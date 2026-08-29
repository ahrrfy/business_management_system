package online.alarabiya.superapp.feature.collaboration

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.collaboration.AssignableStaff
import online.alarabiya.superapp.model.collaboration.BroadcastAction
import online.alarabiya.superapp.model.collaboration.BroadcastActionPolicy
import online.alarabiya.superapp.model.collaboration.BroadcastTemplate
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CollaborationBranch
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.CreateTaskDraft
import online.alarabiya.superapp.model.collaboration.ServiceTypeOption
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TaskActionPolicy
import online.alarabiya.superapp.model.collaboration.TaskKind
import online.alarabiya.superapp.model.collaboration.TaskPriority
import online.alarabiya.superapp.model.collaboration.TaskStatus
import online.alarabiya.superapp.model.collaboration.TeamTaskDetail
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter
import online.alarabiya.superapp.model.collaboration.TeamTaskSummary
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastDetail
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastSummary
import online.alarabiya.superapp.ui.rtlIsolate
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun CollaborationRoute(viewModel: CollaborationViewModel, modifier: Modifier = Modifier) {
    CollaborationScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = CollaborationActions(
            selectSection = viewModel::selectSection,
            setBranch = viewModel::setBranch,
            retryBranches = viewModel::loadBranches,
            setTaskFilter = viewModel::setTaskFilter,
            applyTaskFilter = viewModel::applyTaskFilter,
            loadMoreTasks = viewModel::loadMoreTasks,
            selectTask = viewModel::selectTask,
            beginTask = viewModel::beginCreateTask,
            updateTask = viewModel::updateTaskDraft,
            closeTask = viewModel::closeTaskEditor,
            saveTask = viewModel::saveTask,
            requestTaskAction = viewModel::requestTaskAction,
            updateTaskAction = viewModel::updatePendingTaskAction,
            dismissTaskAction = viewModel::dismissTaskAction,
            confirmTaskAction = viewModel::confirmTaskAction,
            refreshBroadcasts = viewModel::loadBroadcasts,
            selectBroadcast = viewModel::selectBroadcast,
            beginBroadcast = viewModel::beginCreateBroadcast,
            updateBroadcast = viewModel::updateBroadcastDraft,
            closeBroadcast = viewModel::closeBroadcastEditor,
            previewBroadcast = viewModel::previewBroadcast,
            saveBroadcast = viewModel::saveBroadcast,
            broadcastAction = viewModel::performBroadcastAction,
            clearNotice = viewModel::clearNotice,
        ),
        modifier = modifier,
    )
}

data class CollaborationActions(
    val selectSection: (CollaborationSection) -> Unit,
    val setBranch: (Long) -> Unit,
    val retryBranches: () -> Unit,
    val setTaskFilter: (TeamTaskFilter) -> Unit,
    val applyTaskFilter: () -> Unit,
    val loadMoreTasks: () -> Unit,
    val selectTask: (Long?) -> Unit,
    val beginTask: () -> Unit,
    val updateTask: (CreateTaskDraft) -> Unit,
    val closeTask: () -> Unit,
    val saveTask: () -> Unit,
    val requestTaskAction: (TaskAction) -> Unit,
    val updateTaskAction: (String, Long?) -> Unit,
    val dismissTaskAction: () -> Unit,
    val confirmTaskAction: () -> Unit,
    val refreshBroadcasts: () -> Unit,
    val selectBroadcast: (Long?) -> Unit,
    val beginBroadcast: () -> Unit,
    val updateBroadcast: (CreateBroadcastDraft) -> Unit,
    val closeBroadcast: () -> Unit,
    val previewBroadcast: () -> Unit,
    val saveBroadcast: () -> Unit,
    val broadcastAction: (BroadcastAction, String?) -> Unit,
    val clearNotice: () -> Unit,
)

@Composable
fun CollaborationScreen(
    state: CollaborationUiState,
    capabilities: CollaborationCapabilities,
    actions: CollaborationActions,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("مساحة الفريق", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("المهام والتعاون", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (state.section == CollaborationSection.TASKS && capabilities.canWriteTasks) {
                    Button(onClick = actions.beginTask, enabled = state.branchId != null) {
                        Icon(Icons.Rounded.Add, contentDescription = null)
                        Text("مهمة")
                    }
                }
                if (state.section == CollaborationSection.BROADCASTS && capabilities.canManageBroadcasts && capabilities.canReadBroadcastsSafely) {
                    Button(onClick = actions.beginBroadcast) {
                        Icon(Icons.Rounded.Add, contentDescription = null)
                        Text("بث")
                    }
                }
            }
            val tabs = buildList {
                if (capabilities.tasks.canRead) add(CollaborationSection.TASKS)
                if (capabilities.campaigns.canRead) add(CollaborationSection.BROADCASTS)
            }
            if (tabs.isNotEmpty()) {
                TabRow(tabs.indexOf(state.section).coerceAtLeast(0)) {
                    tabs.forEach { section ->
                        Tab(
                            selected = state.section == section,
                            onClick = { actions.selectSection(section) },
                            text = { Text(if (section == CollaborationSection.TASKS) "مهام الفريق" else "بث واتساب") },
                            icon = { Icon(if (section == CollaborationSection.TASKS) Icons.AutoMirrored.Rounded.Assignment else Icons.Rounded.Campaign, null) },
                        )
                    }
                }
            }
            if (state.section == CollaborationSection.TASKS && capabilities.canSelectTaskBranch) {
                BranchSelector(
                    branches = state.branches,
                    selectedId = state.branchId,
                    loading = state.branchesLoading,
                    onSelect = actions.setBranch,
                    onRetry = actions.retryBranches,
                )
            }
            state.error?.let { InlineStatus(it, true) }
            state.notice?.let { InlineStatus(it, false, actions.clearNotice) }
            when {
                tabs.isEmpty() -> EmptyWorkspace("لا توجد صلاحية لمساحة الفريق", Modifier.weight(1f))
                state.section == CollaborationSection.TASKS && state.branchId == null -> BranchRequired(
                    canRetry = capabilities.canSelectTaskBranch && !state.branchesLoading && !state.branchesLoaded,
                    onRetry = actions.retryBranches,
                    modifier = Modifier.weight(1f),
                )
                state.section == CollaborationSection.TASKS -> TasksWorkspace(state, capabilities, actions, Modifier.weight(1f))
                else -> BroadcastsWorkspace(state, capabilities, actions, Modifier.weight(1f))
            }
        }
        state.taskEditor?.let { TaskEditorDialog(it, state.staff, state.serviceTypes, actions) }
        state.pendingTaskAction?.let {
            TaskActionDialog(
                pending = it,
                staff = state.staff,
                requireResolutionNote = state.selectedTask?.summary?.kind == TaskKind.SUPPORT,
                actions = actions,
            )
        }
        state.broadcastEditor?.let { BroadcastEditorDialog(it, state.templates, state.broadcastPreview, state.busyKey, actions) }
    }
}

@Composable
private fun TasksWorkspace(
    state: CollaborationUiState,
    capabilities: CollaborationCapabilities,
    actions: CollaborationActions,
    modifier: Modifier,
) {
    BoxWithConstraints(modifier) {
        val expanded = maxWidth >= 840.dp
        when {
            expanded -> Row(Modifier.fillMaxSize()) {
                TasksList(state, actions, Modifier.width(390.dp).fillMaxHeight())
                TaskDetail(state.selectedTask, state.loadingDetail, capabilities, actions, Modifier.weight(1f), false)
            }
            state.selectedTask != null || state.loadingDetail -> TaskDetail(state.selectedTask, state.loadingDetail, capabilities, actions, Modifier.fillMaxSize(), true)
            else -> TasksList(state, actions, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun TasksList(state: CollaborationUiState, actions: CollaborationActions, modifier: Modifier) {
    Column(modifier.background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        OutlinedTextField(
            value = state.taskFilter.query,
            onValueChange = { actions.setTaskFilter(state.taskFilter.copy(query = it.take(200))) },
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            placeholder = { Text("بحث في المهام") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { actions.applyTaskFilter() }),
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = state.taskFilter.status == null,
                onClick = { actions.setTaskFilter(state.taskFilter.copy(status = null)); actions.applyTaskFilter() },
                label = { Text("الكل") },
            )
            TaskStatus.entries.forEach { status ->
                FilterChip(
                    selected = state.taskFilter.status == status,
                    onClick = { actions.setTaskFilter(state.taskFilter.copy(status = status)); actions.applyTaskFilter() },
                    label = { Text(status.label) },
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            EnumPicker(
                label = "النوع",
                selectedLabel = state.taskFilter.kind?.label ?: "الكل",
                values = listOf<TaskKind?>(null) + TaskKind.entries,
                onSelect = { actions.setTaskFilter(state.taskFilter.copy(kind = it)); actions.applyTaskFilter() },
                labelOf = { it?.label ?: "الكل" },
            )
            EnumPicker(
                label = "الأولوية",
                selectedLabel = state.taskFilter.priority?.label ?: "الكل",
                values = listOf<TaskPriority?>(null) + TaskPriority.entries,
                onSelect = { actions.setTaskFilter(state.taskFilter.copy(priority = it)); actions.applyTaskFilter() },
                labelOf = { it?.label ?: "الكل" },
            )
            FilterChip(
                selected = state.taskFilter.overdue,
                onClick = { actions.setTaskFilter(state.taskFilter.copy(overdue = !state.taskFilter.overdue)); actions.applyTaskFilter() },
                label = { Text("متأخرة") },
            )
        }
        when {
            state.loading && state.tasks.isEmpty() -> Loading(Modifier.weight(1f))
            state.tasks.isEmpty() -> EmptyWorkspace("لا توجد مهام ضمن المرشحات", Modifier.weight(1f))
            else -> LazyColumn(
                Modifier.weight(1f),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                items(state.tasks, key = TeamTaskSummary::id) { task ->
                    TaskRow(task, state.selectedTask?.summary?.id == task.id) { actions.selectTask(task.id) }
                }
                if (state.nextTaskCursor != null) item {
                    OutlinedButton(onClick = actions.loadMoreTasks, enabled = !state.loadingMore, modifier = Modifier.fillMaxWidth()) {
                        if (state.loadingMore) CircularProgressIndicator(Modifier.size(18.dp)) else Text("عرض المزيد")
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: TeamTaskSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 26.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(task.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                StatusPill(task.status.label, if (task.isOverdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
            Text("${task.taskNumber} · ${task.kind.label}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row {
                Text(task.assigneeName ?: "بلا إسناد", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                Text(formatDate(task.effectiveDueAt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun TaskDetail(
    detail: TeamTaskDetail?,
    loading: Boolean,
    capabilities: CollaborationCapabilities,
    actions: CollaborationActions,
    modifier: Modifier,
    showBack: Boolean,
) {
    if (loading) return Loading(modifier)
    if (detail == null) return EmptyWorkspace("اختر مهمة لعرض تفاصيلها", modifier)
    val allowed = TaskActionPolicy.allowed(detail, capabilities)
    LazyColumn(modifier, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (showBack) IconButton({ actions.selectTask(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "العودة") }
                Column(Modifier.weight(1f)) {
                    Text(detail.summary.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(detail.summary.taskNumber, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                StatusPill(detail.summary.status.label, MaterialTheme.colorScheme.primary)
            }
        }
        item {
            TeamCard {
                detail.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                DetailLine("النوع", detail.summary.kind.label)
                DetailLine("الأولوية", detail.summary.priority.label)
                DetailLine("المسنَد إليه", detail.summary.assigneeName ?: "بلا إسناد")
                DetailLine("الاستحقاق", formatDate(detail.summary.effectiveDueAt))
                detail.summary.customerName?.let { DetailLine("العميل", it) }
                detail.summary.supplierName?.let { DetailLine("المورد", it) }
                detail.linkedWorkOrderId?.let { DetailLine("أمر العمل", "#$it") }
                detail.linkedInvoiceId?.let { DetailLine("الفاتورة", "#$it") }
                detail.linkedQuotationId?.let { DetailLine("عرض السعر", "#$it") }
                detail.resolutionNote?.let { DetailLine("ملاحظة الحل", it) }
            }
        }
        if (allowed.isNotEmpty()) item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                allowed.forEach { action ->
                    OutlinedButton(onClick = { actions.requestTaskAction(action) }) { Text(action.taskLabel) }
                }
            }
        }
        item { Text("النشاط", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        items(detail.events.reversed(), key = { it.id }) { event ->
            TeamCard {
                Text(event.type.eventLabel, fontWeight = FontWeight.SemiBold)
                event.note?.let { Text(it) }
                Text("${event.userName ?: "النظام"} · ${formatDate(event.createdAt)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun BroadcastsWorkspace(
    state: CollaborationUiState,
    capabilities: CollaborationCapabilities,
    actions: CollaborationActions,
    modifier: Modifier,
) {
    if (!capabilities.canReadBroadcastsSafely) {
        Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(Icons.Rounded.WarningAmber, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(10.dp))
            Text("البث غير متاح لهذا الحساب", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        return
    }
    BoxWithConstraints(modifier) {
        val expanded = maxWidth >= 840.dp
        when {
            expanded -> Row(Modifier.fillMaxSize()) {
                BroadcastList(state, actions, Modifier.width(390.dp).fillMaxHeight())
                BroadcastDetail(state.selectedBroadcast, state, capabilities, actions, Modifier.weight(1f), false)
            }
            state.selectedBroadcast != null || state.loadingDetail -> BroadcastDetail(state.selectedBroadcast, state, capabilities, actions, Modifier.fillMaxSize(), true)
            else -> BroadcastList(state, actions, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun BroadcastList(state: CollaborationUiState, actions: CollaborationActions, modifier: Modifier) {
    Column(modifier.background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("بث واتساب", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            IconButton(actions.refreshBroadcasts) { Icon(Icons.Rounded.Refresh, "تحديث") }
        }
        when {
            state.loading && state.broadcasts.isEmpty() -> Loading(Modifier.weight(1f))
            state.broadcasts.isEmpty() -> EmptyWorkspace("لا توجد حملات بث", Modifier.weight(1f))
            else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                items(state.broadcasts, key = WhatsappBroadcastSummary::id) { item ->
                    Card(
                        Modifier.fillMaxWidth().clickable { actions.selectBroadcast(item.id) },
                        shape = RoundedCornerShape(22.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                    ) {
                        Column(Modifier.padding(15.dp)) {
                            Row {
                                Text(item.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                StatusPill(item.status.label, MaterialTheme.colorScheme.secondary)
                            }
                            Text("${item.audienceCount} مستلم · ${item.costEstimate}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BroadcastDetail(
    detail: WhatsappBroadcastDetail?,
    state: CollaborationUiState,
    capabilities: CollaborationCapabilities,
    actions: CollaborationActions,
    modifier: Modifier,
    showBack: Boolean,
) {
    if (state.loadingDetail) return Loading(modifier)
    if (detail == null) return EmptyWorkspace("اختر بثاً لعرض نتائجه", modifier)
    var pendingAction by remember { mutableStateOf<BroadcastAction?>(null) }
    var reason by remember { mutableStateOf("") }
    val allowed = BroadcastActionPolicy.allowed(detail.summary, capabilities)
    LazyColumn(modifier, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (showBack) IconButton({ actions.selectBroadcast(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "العودة") }
                Text(detail.summary.name, Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                StatusPill(detail.summary.status.label, MaterialTheme.colorScheme.secondary)
            }
        }
        item {
            TeamCard {
                DetailLine("الجمهور", detail.summary.audienceCount.toString())
                DetailLine("الكلفة التقديرية", detail.summary.costEstimate)
                DetailLine("معدل الإرسال", "${detail.summary.throttlePerMinute} / دقيقة")
                detail.summary.pausedReason?.let { DetailLine("سبب الإيقاف", it) }
            }
        }
        if (allowed.isNotEmpty()) item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                allowed.forEach { action -> OutlinedButton(onClick = { pendingAction = action }) { Text(action.broadcastLabel) } }
            }
        }
        item { Text("نتائج التسليم", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        state.broadcastResults?.counts?.forEach { (key, value) ->
            item { TeamCard { DetailLine(key, "$value · ${state.broadcastResults.percentages[key] ?: "0.00"}%") } }
        }
    }
    pendingAction?.let { action ->
        AlertDialog(
            onDismissRequest = { pendingAction = null },
            title = { Text(action.broadcastLabel) },
            text = {
                if (action == BroadcastAction.PAUSE) OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it.take(200) },
                    label = { Text("سبب الإيقاف") },
                ) else Text("تأكيد الإجراء على هذا البث")
            },
            confirmButton = {
                Button(
                    onClick = {
                        actions.broadcastAction(action, reason.takeIf(String::isNotBlank))
                        pendingAction = null
                        reason = ""
                    },
                    enabled = action != BroadcastAction.PAUSE || reason.isNotBlank(),
                ) { Text("تأكيد") }
            },
            dismissButton = { TextButton({ pendingAction = null }) { Text("إلغاء") } },
        )
    }
}

@Composable
private fun TaskEditorDialog(
    draft: CreateTaskDraft,
    staff: List<AssignableStaff>,
    serviceTypes: List<ServiceTypeOption>,
    actions: CollaborationActions,
) {
    AlertDialog(
        onDismissRequest = actions.closeTask,
        title = { Text("مهمة جديدة") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item { OutlinedTextField(draft.title, { actions.updateTask(draft.copy(title = it.take(200))) }, Modifier.fillMaxWidth(), label = { Text("العنوان") }) }
                item { OutlinedTextField(draft.description, { actions.updateTask(draft.copy(description = it.take(4_000))) }, Modifier.fillMaxWidth(), label = { Text("الوصف") }, minLines = 3) }
                item {
                    EnumPicker(
                        label = "النوع",
                        selectedLabel = draft.kind.label,
                        values = TaskKind.entries,
                        onSelect = { actions.updateTask(draft.copy(kind = it)) },
                        labelOf = { it.label },
                    )
                }
                item {
                    EnumPicker(
                        label = "الأولوية",
                        selectedLabel = draft.priority?.label ?: "تلقائية",
                        values = listOf<TaskPriority?>(null) + TaskPriority.entries,
                        onSelect = { actions.updateTask(draft.copy(priority = it)) },
                        labelOf = { it?.label ?: "تلقائية" },
                    )
                }
                if (serviceTypes.isNotEmpty()) item {
                    ServiceTypePicker(serviceTypes, draft.serviceTypeId) { serviceType ->
                        actions.updateTask(
                            draft.copy(
                                serviceTypeId = serviceType?.id,
                                kind = serviceType?.defaultKind ?: draft.kind,
                                priority = draft.priority ?: serviceType?.defaultPriority,
                            ),
                        )
                    }
                }
                item { StaffPicker(staff, draft.assignedTo) { actions.updateTask(draft.copy(assignedTo = it)) } }
                // Codex P2 (٢٩/٨، #864): task dueAt يقبل ISO instant بوقتٍ محدَّد أيضاً؛ خدمتُه
                // تفسّر YYYY-MM-DD كمنتصف ليل UTC = 03:00 بغداد ⇒ يظهر متأخّراً معظمَ اليوم.
                // نُبقي حقلاً نصّياً حتى نُضيف ArabicInstantPicker يحمل وقتاً.
                item { OutlinedTextField(draft.dueAt, { actions.updateTask(draft.copy(dueAt = it.take(40))) }, Modifier.fillMaxWidth(), label = { Text("الاستحقاق (ISO أو YYYY-MM-DD)") }) }
            }
        },
        confirmButton = { Button(actions.saveTask) { Text("إنشاء") } },
        dismissButton = { TextButton(actions.closeTask) { Text("إلغاء") } },
    )
}

@Composable
private fun TaskActionDialog(
    pending: PendingTaskAction,
    staff: List<AssignableStaff>,
    requireResolutionNote: Boolean,
    actions: CollaborationActions,
) {
    val needsNote = pending.action in setOf(TaskAction.WAIT, TaskAction.RESOLVE, TaskAction.COMMENT, TaskAction.REOPEN, TaskAction.CANCEL)
    AlertDialog(
        onDismissRequest = actions.dismissTaskAction,
        title = { Text(pending.action.taskLabel) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (pending.action == TaskAction.ASSIGN) StaffPicker(staff, pending.assignedTo) { actions.updateTaskAction(pending.note, it) }
                if (needsNote) OutlinedTextField(
                    value = pending.note,
                    onValueChange = { actions.updateTaskAction(it, pending.assignedTo) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(if (pending.action == TaskAction.CANCEL) "السبب" else "ملاحظة") },
                    minLines = 3,
                )
                if (!needsNote && pending.action != TaskAction.ASSIGN) Text("تأكيد الإجراء")
            }
        },
        confirmButton = {
            val noteRequired = pending.action in setOf(TaskAction.COMMENT, TaskAction.CANCEL) ||
                (pending.action == TaskAction.RESOLVE && requireResolutionNote)
            Button(
                actions.confirmTaskAction,
                enabled = !noteRequired || pending.note.isNotBlank(),
            ) { Text("تأكيد") }
        },
        dismissButton = { TextButton(actions.dismissTaskAction) { Text("إلغاء") } },
    )
}

@Composable
private fun BroadcastEditorDialog(
    draft: CreateBroadcastDraft,
    templates: List<BroadcastTemplate>,
    preview: online.alarabiya.superapp.model.collaboration.BroadcastPreview?,
    busyKey: String?,
    actions: CollaborationActions,
) {
    val selected = templates.firstOrNull { it.id == draft.templateId }
    AlertDialog(
        onDismissRequest = actions.closeBroadcast,
        title = { Text("بث واتساب جديد") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item { OutlinedTextField(draft.name, { actions.updateBroadcast(draft.copy(name = it.take(160))) }, Modifier.fillMaxWidth(), label = { Text("اسم البث") }) }
                item {
                    TemplatePicker(templates, selected) { template ->
                        actions.updateBroadcast(
                            draft.copy(
                                templateId = template.id,
                                templateVariableCount = template.variableCount,
                                variables = emptyMap(),
                            ),
                        )
                    }
                }
                selected?.let { template ->
                    items(template.variableCount) { index ->
                        val key = (index + 1).toString()
                        VariablePicker(index + 1, draft.variables[key]) { value ->
                            actions.updateBroadcast(draft.copy(variables = draft.variables + (key to value)))
                        }
                    }
                }
                item {
                    Text("الجمهور", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                item {
                    SegmentMultiSelect(
                        label = "فئة السعر",
                        options = listOf("RETAIL" to "تجزئة", "WHOLESALE" to "جملة", "GOVERNMENT" to "حكومي"),
                        selected = draft.segment.priceTiers,
                    ) { selected -> actions.updateBroadcast(draft.copy(segment = draft.segment.copy(priceTiers = selected))) }
                }
                item {
                    SegmentMultiSelect(
                        label = "نوع العميل",
                        options = listOf("فرد" to "فرد", "تاجر" to "تاجر", "مؤسسة" to "مؤسسة", "شركة" to "شركة", "حكومي" to "حكومي"),
                        selected = draft.segment.customerTypes,
                    ) { selected -> actions.updateBroadcast(draft.copy(segment = draft.segment.copy(customerTypes = selected))) }
                }
                item {
                    EnumPicker(
                        label = "شريحة RFM",
                        selectedLabel = when (draft.segment.rfmPreset) {
                            "VIP" -> "كبار العملاء"
                            "AT_RISK" -> "معرضون للفقد"
                            "DORMANT" -> "غير نشطين"
                            "NEW" -> "جدد"
                            else -> "الكل"
                        },
                        values = listOf<String?>(null, "VIP", "AT_RISK", "DORMANT", "NEW"),
                        onSelect = { actions.updateBroadcast(draft.copy(segment = draft.segment.copy(rfmPreset = it))) },
                        labelOf = {
                            when (it) {
                                "VIP" -> "كبار العملاء"
                                "AT_RISK" -> "معرضون للفقد"
                                "DORMANT" -> "غير نشطين"
                                "NEW" -> "جدد"
                                else -> "الكل"
                            }
                        },
                    )
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = draft.segment.balanceMin.orEmpty(),
                            onValueChange = { actions.updateBroadcast(draft.copy(segment = draft.segment.copy(balanceMin = it.take(30)))) },
                            modifier = Modifier.weight(1f),
                            label = { Text("الرصيد من") },
                            singleLine = true,
                        )
                        OutlinedTextField(
                            value = draft.segment.balanceMax.orEmpty(),
                            onValueChange = { actions.updateBroadcast(draft.copy(segment = draft.segment.copy(balanceMax = it.take(30)))) },
                            modifier = Modifier.weight(1f),
                            label = { Text("الرصيد إلى") },
                            singleLine = true,
                        )
                    }
                }
                item { OutlinedTextField(draft.throttlePerMinute.toString(), { actions.updateBroadcast(draft.copy(throttlePerMinute = it.toIntOrNull() ?: 0)) }, Modifier.fillMaxWidth(), label = { Text("رسائل في الدقيقة") }) }
                item { OutlinedTextField(draft.scheduledAt, { actions.updateBroadcast(draft.copy(scheduledAt = it.take(40))) }, Modifier.fillMaxWidth(), label = { Text("الجدولة (اختياري)") }) }
                preview?.let { item { TeamCard { DetailLine("الجمهور", it.audienceCount.toString()); DetailLine("الكلفة", it.costEstimate) } } }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(actions.previewBroadcast, enabled = busyKey == null) { Text("معاينة") }
                Button(actions.saveBroadcast, enabled = preview != null && busyKey == null) { Text("إنشاء مسودة") }
            }
        },
        dismissButton = { TextButton(actions.closeBroadcast) { Text("إلغاء") } },
    )
}

@Composable
private fun StaffPicker(staff: List<AssignableStaff>, selectedId: Long?, onSelect: (Long?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ open = true }) { Text(staff.firstOrNull { it.id == selectedId }?.name ?: "بلا إسناد") }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem({ Text("بلا إسناد") }, onClick = { onSelect(null); open = false })
            staff.forEach { person -> DropdownMenuItem({ Text(person.name) }, onClick = { onSelect(person.id); open = false }) }
        }
    }
}

@Composable
private fun ServiceTypePicker(
    serviceTypes: List<ServiceTypeOption>,
    selectedId: Long?,
    onSelect: (ServiceTypeOption?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ open = true }) {
            Text(serviceTypes.firstOrNull { it.id == selectedId }?.name ?: "نوع الخدمة · اختياري")
        }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem({ Text("بلا نوع خدمة") }, onClick = { onSelect(null); open = false })
            serviceTypes.forEach { serviceType ->
                DropdownMenuItem(
                    text = { Text(serviceType.name) },
                    onClick = { onSelect(serviceType); open = false },
                )
            }
        }
    }
}

@Composable
private fun TemplatePicker(templates: List<BroadcastTemplate>, selected: BroadcastTemplate?, onSelect: (BroadcastTemplate) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ open = true }) { Text(selected?.name ?: "اختر قالباً معتمداً") }
        DropdownMenu(open, { open = false }) {
            templates.forEach { template -> DropdownMenuItem({ Text("${template.name} · ${template.language}") }, onClick = { onSelect(template); open = false }) }
        }
    }
}

@Composable
private fun VariablePicker(index: Int, selected: String?, onSelect: (String) -> Unit) {
    val options = listOf("name" to "اسم العميل", "currentBalance" to "الرصيد", "phone" to "الهاتف", "phoneE164" to "الهاتف الدولي")
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ open = true }) { Text("{{$index}} · ${options.firstOrNull { it.first == selected }?.second ?: "اختر الحقل"}") }
        DropdownMenu(open, { open = false }) {
            options.forEach { option -> DropdownMenuItem({ Text(option.second) }, onClick = { onSelect(option.first); open = false }) }
        }
    }
}

@Composable
private fun SegmentMultiSelect(
    label: String,
    options: List<Pair<String, String>>,
    selected: Set<String>,
    onChange: (Set<String>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEach { (value, text) ->
                FilterChip(
                    selected = value in selected,
                    onClick = { onChange(if (value in selected) selected - value else selected + value) },
                    label = { Text(text) },
                )
            }
        }
    }
}

@Composable
private fun <T> EnumPicker(
    label: String,
    selectedLabel: String,
    values: List<T>,
    onSelect: (T) -> Unit,
    labelOf: (T) -> String = { it.toString() },
) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ open = true }) { Text("$label · $selectedLabel") }
        DropdownMenu(open, { open = false }) {
            values.forEach { value -> DropdownMenuItem({ Text(labelOf(value)) }, onClick = { onSelect(value); open = false }) }
        }
    }
}

@Composable
private fun TeamCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 26.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content) }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(rtlIsolate(value), Modifier.weight(.58f), fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun StatusPill(text: String, color: Color) {
    Text(text, Modifier.background(color.copy(alpha = .12f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 5.dp), color = color)
}

@Composable
private fun InlineStatus(text: String, error: Boolean, onClick: (() -> Unit)? = null) {
    Text(
        text,
        Modifier.fillMaxWidth()
            .background(if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer)
            .heightIn(min = 48.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite }
            .padding(12.dp),
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

@Composable
private fun Loading(modifier: Modifier) = Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
private fun EmptyWorkspace(text: String, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Rounded.Groups, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(10.dp))
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun BranchRequired(canRetry: Boolean, onRetry: () -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Rounded.WarningAmber, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
        Text("اختر الفرع", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("لعرض مهام الفريق", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (canRetry) {
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = onRetry, modifier = Modifier.testTag("collaboration-branch-retry")) {
                Icon(Icons.Rounded.Refresh, null)
                Spacer(Modifier.width(6.dp))
                Text("إعادة تحميل الفروع")
            }
        }
    }
}

@Composable
private fun BranchSelector(
    branches: List<CollaborationBranch>,
    selectedId: Long?,
    loading: Boolean,
    onSelect: (Long) -> Unit,
    onRetry: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = branches.firstOrNull { it.id == selectedId }
    Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
        OutlinedButton(
            onClick = {
                if (branches.isEmpty()) onRetry() else expanded = true
            },
            enabled = !loading,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("collaboration-branch-selector"),
        ) {
            if (loading) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(selected?.name ?: if (loading) "جارٍ تحميل الفروع" else "اختر فرع المهام")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            branches.forEach { branch ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(branch.name, fontWeight = FontWeight.SemiBold)
                            branch.code?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(branch.id)
                    },
                    modifier = Modifier.testTag("collaboration-branch-${branch.id}"),
                )
            }
        }
    }
}

private val TaskAction.taskLabel get() = when (this) {
    TaskAction.CLAIM -> "سحب المهمة"
    TaskAction.WAIT -> "انتظار"
    TaskAction.RESUME -> "استئناف"
    TaskAction.RESOLVE -> "حل"
    TaskAction.COMMENT -> "تعليق"
    TaskAction.ASSIGN -> "إسناد"
    TaskAction.REOPEN -> "إعادة فتح"
    TaskAction.CANCEL -> "إلغاء"
}

private val BroadcastAction.broadcastLabel get() = when (this) {
    BroadcastAction.LAUNCH -> "إطلاق"
    BroadcastAction.APPROVE -> "اعتماد"
    BroadcastAction.PAUSE -> "إيقاف مؤقت"
    BroadcastAction.RESUME -> "استئناف"
    BroadcastAction.CANCEL -> "إلغاء"
}

private val online.alarabiya.superapp.model.collaboration.TaskEventType.eventLabel get() = when (this) {
    online.alarabiya.superapp.model.collaboration.TaskEventType.COMMENT -> "تعليق"
    online.alarabiya.superapp.model.collaboration.TaskEventType.STATUS -> "تغيير حالة"
    online.alarabiya.superapp.model.collaboration.TaskEventType.ASSIGN -> "إسناد"
    online.alarabiya.superapp.model.collaboration.TaskEventType.LINK -> "ربط"
    online.alarabiya.superapp.model.collaboration.TaskEventType.SYSTEM -> "حدث نظامي"
    online.alarabiya.superapp.model.collaboration.TaskEventType.CSAT -> "تقييم"
}

private fun formatDate(value: String?): String {
    if (value.isNullOrBlank()) return "—"
    return runCatching {
        val instant = runCatching { Instant.parse(value) }.getOrElse { OffsetDateTime.parse(value).toInstant() }
        DateTimeFormatter.ofPattern("d MMM yyyy، h:mm a", Locale.forLanguageTag("ar-IQ-u-nu-latn"))
            .withZone(ZoneId.systemDefault()).format(instant)
    }.getOrDefault(value.take(16))
}

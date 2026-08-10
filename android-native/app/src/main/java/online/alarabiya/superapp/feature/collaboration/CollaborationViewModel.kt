package online.alarabiya.superapp.feature.collaboration

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.CollaborationDataSource
import online.alarabiya.superapp.model.collaboration.BroadcastAction
import online.alarabiya.superapp.model.collaboration.BroadcastActionPolicy
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CollaborationValidation
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.CreateTaskDraft
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TaskActionPolicy
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter

class CollaborationViewModel(
    private val source: CollaborationDataSource,
    val capabilities: CollaborationCapabilities,
) : ViewModel() {
    var state by mutableStateOf(CollaborationUiState(branchId = capabilities.branchId))
        private set

    init {
        when {
            capabilities.tasks.canRead -> {
                if (capabilities.branchId != null) loadTasks()
                if (capabilities.canSelectTaskBranch) loadBranches()
            }
            capabilities.campaigns.canRead -> {
                state = state.copy(section = CollaborationSection.BROADCASTS)
                if (capabilities.canReadBroadcastsSafely) loadBroadcasts()
            }
        }
    }

    fun selectSection(section: CollaborationSection) {
        if (state.section == section) return
        state = state.copy(section = section, error = null, notice = null)
        when {
            section == CollaborationSection.BROADCASTS && state.broadcasts.isEmpty() -> loadBroadcasts()
            section == CollaborationSection.TASKS && state.branchId == null &&
                capabilities.canSelectTaskBranch && !state.branchesLoaded && !state.branchesLoading -> loadBranches()
        }
    }

    fun loadBranches() {
        if (!capabilities.canSelectTaskBranch || state.branchesLoading) return
        state = state.copy(branchesLoading = true, branchesLoaded = false, error = null, notice = null)
        viewModelScope.launch {
            runCatching { source.branches(capabilities) }
                .onSuccess { branches ->
                    state = state.copy(
                        branches = branches,
                        branchesLoading = false,
                        branchesLoaded = true,
                        error = if (branches.isEmpty()) "لا توجد فروع متاحة لمساحة المهام" else null,
                    )
                }
                .onFailure { error ->
                    state = state.copy(
                        branches = emptyList(),
                        branchesLoading = false,
                        branchesLoaded = false,
                        error = userMessage(error),
                    )
                }
        }
    }

    fun setBranch(branchId: Long) {
        val authorized = when {
            branchId <= 0 -> false
            capabilities.canSelectTaskBranch -> state.branches.any { it.id == branchId }
            else -> branchId == capabilities.branchId
        }
        if (!authorized) return fail("الفرع غير متاح لمساحة المهام")
        state = state.copy(
            section = CollaborationSection.TASKS,
            branchId = branchId,
            taskFilter = state.taskFilter.copy(branchId = branchId, cursor = null),
            selectedTask = null,
            tasks = emptyList(),
            nextTaskCursor = null,
        )
        loadTasks()
    }

    fun setTaskFilter(filter: TeamTaskFilter) {
        state = state.copy(taskFilter = filter.copy(branchId = state.branchId, cursor = null), selectedTask = null)
    }

    fun applyTaskFilter() = loadTasks()

    fun applyNavigationArguments(arguments: Map<String, String>) {
        if (!capabilities.tasks.canRead) return
        val overdue = arguments["overdue"].equals("true", ignoreCase = true) || arguments["overdue"] == "1"
        if (!overdue) return
        state = state.copy(
            section = CollaborationSection.TASKS,
            taskFilter = state.taskFilter.copy(overdue = true, branchId = state.branchId, cursor = null),
            selectedTask = null,
            error = null,
            notice = null,
        )
        if (state.branchId != null) loadTasks()
    }

    fun consumeBack(): Boolean {
        state = when {
            state.pendingTaskAction != null -> state.copy(pendingTaskAction = null)
            state.taskEditor != null -> state.copy(taskEditor = null)
            state.broadcastEditor != null -> state.copy(broadcastEditor = null, broadcastPreview = null)
            state.selectedTask != null || state.loadingDetail && state.section == CollaborationSection.TASKS ->
                state.copy(selectedTask = null, loadingDetail = false)
            state.selectedBroadcast != null || state.loadingDetail && state.section == CollaborationSection.BROADCASTS ->
                state.copy(selectedBroadcast = null, broadcastResults = null, loadingDetail = false)
            else -> return false
        }
        return true
    }

    fun loadMoreTasks() {
        val cursor = state.nextTaskCursor ?: return
        loadTasks(append = true, cursor = cursor)
    }

    fun selectTask(taskId: Long?) {
        if (taskId == null) {
            state = state.copy(selectedTask = null, pendingTaskAction = null, error = null)
            return
        }
        val branchId = state.branchId ?: return fail("اختر الفرع")
        state = state.copy(loadingDetail = true, error = null, pendingTaskAction = null)
        viewModelScope.launch {
            runCatching { source.task(taskId, branchId) }
                .onSuccess { state = state.copy(loadingDetail = false, selectedTask = it) }
                .onFailure { state = state.copy(loadingDetail = false, error = userMessage(it)) }
        }
    }

    fun beginCreateTask() {
        if (!capabilities.canWriteTasks) return
        val branchId = state.branchId ?: return fail("اختر الفرع")
        state = state.copy(taskEditor = CreateTaskDraft(branchId = branchId), error = null)
        if (state.staff.isEmpty() || state.serviceTypes.isEmpty()) {
            viewModelScope.launch {
                runCatching {
                    source.assignableStaff(branchId, capabilities) to source.serviceTypes()
                }.onSuccess { (staff, types) -> state = state.copy(staff = staff, serviceTypes = types) }
                    .onFailure { state = state.copy(error = userMessage(it)) }
            }
        }
    }

    fun updateTaskDraft(draft: CreateTaskDraft) {
        if (state.taskEditor != null) state = state.copy(taskEditor = draft, error = null)
    }

    fun closeTaskEditor() {
        state = state.copy(taskEditor = null, error = null)
    }

    fun saveTask() {
        val draft = state.taskEditor ?: return
        CollaborationValidation.task(draft, capabilities)?.let { return fail(it) }
        launch("task:create", "تم إنشاء المهمة") {
            val id = source.createTask(draft, capabilities)
            state = state.copy(taskEditor = null)
            loadTasksAfterMutation()
            selectTask(id)
        }
    }

    fun requestTaskAction(action: TaskAction) {
        val detail = state.selectedTask ?: return
        if (action !in TaskActionPolicy.allowed(detail, capabilities) || state.busyKey != null) return
        state = state.copy(pendingTaskAction = PendingTaskAction(action), error = null, notice = null)
    }

    fun updatePendingTaskAction(note: String, assignedTo: Long? = state.pendingTaskAction?.assignedTo) {
        state.pendingTaskAction?.let {
            state = state.copy(pendingTaskAction = it.copy(note = note.take(4_000), assignedTo = assignedTo))
        }
    }

    fun dismissTaskAction() {
        state = state.copy(pendingTaskAction = null)
    }

    fun confirmTaskAction() {
        val detail = state.selectedTask ?: return
        val pending = state.pendingTaskAction ?: return
        state = state.copy(pendingTaskAction = null)
        launch("task:${pending.action}", "تم تحديث المهمة") {
            source.taskAction(detail, capabilities, pending.action, pending.note, pending.assignedTo)
            state = state.copy(selectedTask = source.task(detail.summary.id, requireNotNull(state.branchId)))
            loadTasksAfterMutation()
        }
    }

    fun loadBroadcasts() {
        if (!capabilities.canReadBroadcastsSafely) {
            return fail("لا توجد صلاحية لقراءة البث")
        }
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { source.broadcasts(capabilities) }
                .onSuccess { state = state.copy(loading = false, broadcasts = it) }
                .onFailure { state = state.copy(loading = false, error = userMessage(it)) }
        }
    }

    fun selectBroadcast(id: Long?) {
        if (id == null) {
            state = state.copy(selectedBroadcast = null, broadcastResults = null, error = null)
            return
        }
        state = state.copy(loadingDetail = true, error = null)
        viewModelScope.launch {
            runCatching { source.broadcast(id, capabilities) to source.broadcastResults(id, capabilities) }
                .onSuccess { (detail, results) ->
                    state = state.copy(loadingDetail = false, selectedBroadcast = detail, broadcastResults = results)
                }
                .onFailure { state = state.copy(loadingDetail = false, error = userMessage(it)) }
        }
    }

    fun beginCreateBroadcast() {
        if (!capabilities.canManageBroadcasts || !capabilities.canReadBroadcastsSafely) return
        val writeBranchId = if (capabilities.role.equals("admin", true)) state.branchId else capabilities.branchId
        state = state.copy(
            broadcastEditor = CreateBroadcastDraft(branchId = writeBranchId, segment = online.alarabiya.superapp.model.collaboration.BroadcastSegment(branchId = writeBranchId)),
            broadcastPreview = null,
            error = null,
        )
        if (state.templates.isEmpty()) {
            viewModelScope.launch {
                runCatching { source.broadcastTemplates(capabilities) }
                    .onSuccess { state = state.copy(templates = it) }
                    .onFailure { state = state.copy(error = userMessage(it)) }
            }
        }
    }

    fun updateBroadcastDraft(draft: CreateBroadcastDraft) {
        if (state.broadcastEditor != null) state = state.copy(broadcastEditor = draft, broadcastPreview = null, error = null)
    }

    fun closeBroadcastEditor() {
        state = state.copy(broadcastEditor = null, broadcastPreview = null, error = null)
    }

    fun previewBroadcast() {
        val draft = state.broadcastEditor ?: return
        CollaborationValidation.broadcast(draft, capabilities)?.let { return fail(it) }
        launch("broadcast:preview") { state = state.copy(broadcastPreview = source.previewBroadcast(draft, capabilities)) }
    }

    fun saveBroadcast() {
        val draft = state.broadcastEditor ?: return
        CollaborationValidation.broadcast(draft, capabilities)?.let { return fail(it) }
        launch("broadcast:create", "تم إنشاء البث كمسودة") {
            val id = source.createBroadcast(draft, capabilities)
            state = state.copy(broadcastEditor = null, broadcastPreview = null)
            state = state.copy(broadcasts = source.broadcasts(capabilities))
            selectBroadcast(id)
        }
    }

    fun performBroadcastAction(action: BroadcastAction, reason: String? = null) {
        val detail = state.selectedBroadcast ?: return
        if (action !in BroadcastActionPolicy.allowed(detail.summary, capabilities)) return
        launch("broadcast:$action", "تم تحديث حالة البث") {
            source.broadcastAction(detail, capabilities, action, reason)
            val id = detail.summary.id
            state = state.copy(
                broadcasts = source.broadcasts(capabilities),
                selectedBroadcast = source.broadcast(id, capabilities),
                broadcastResults = source.broadcastResults(id, capabilities),
            )
        }
    }

    fun clearNotice() { state = state.copy(notice = null) }

    private fun loadTasks(append: Boolean = false, cursor: Long? = null) {
        if (!capabilities.tasks.canRead || state.loading || state.loadingMore) return
        val branch = state.branchId ?: return fail("اختر الفرع لعرض مهام الفريق")
        state = state.copy(loading = !append, loadingMore = append, error = null, notice = null)
        val filter = state.taskFilter.copy(branchId = branch, cursor = cursor)
        viewModelScope.launch {
            runCatching { source.tasks(filter, capabilities) }
                .onSuccess { page ->
                    val filterChangedWhileLoading = !append &&
                        state.taskFilter.copy(branchId = branch, cursor = null) != filter.copy(cursor = null)
                    state = state.copy(
                        loading = false,
                        loadingMore = false,
                        tasks = if (append) (state.tasks + page.rows).distinctBy { it.id } else page.rows,
                        nextTaskCursor = page.nextCursor,
                    )
                    if (filterChangedWhileLoading) loadTasks()
                }
                .onFailure { state = state.copy(loading = false, loadingMore = false, error = userMessage(it)) }
        }
    }

    private suspend fun loadTasksAfterMutation() {
        val branch = state.branchId ?: return
        val page = source.tasks(state.taskFilter.copy(branchId = branch, cursor = null), capabilities)
        state = state.copy(tasks = page.rows, nextTaskCursor = page.nextCursor)
    }

    private fun launch(key: String, success: String? = null, block: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, notice = null)
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { state = state.copy(busyKey = null, notice = success) }
                .onFailure { state = state.copy(busyKey = null, error = userMessage(it)) }
        }
    }

    private fun fail(message: String) { state = state.copy(error = message, busyKey = null) }
    private fun userMessage(error: Throwable) = error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class CollaborationViewModelFactory(
    private val source: CollaborationDataSource,
    private val capabilities: CollaborationCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CollaborationViewModel(source, capabilities) as T
}

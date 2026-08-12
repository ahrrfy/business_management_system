package online.alarabiya.superapp.feature.collaboration

import online.alarabiya.superapp.model.collaboration.AssignableStaff
import online.alarabiya.superapp.model.collaboration.BroadcastPreview
import online.alarabiya.superapp.model.collaboration.BroadcastResults
import online.alarabiya.superapp.model.collaboration.BroadcastTemplate
import online.alarabiya.superapp.model.collaboration.CollaborationBranch
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.CreateTaskDraft
import online.alarabiya.superapp.model.collaboration.ServiceTypeOption
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TeamTaskDetail
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter
import online.alarabiya.superapp.model.collaboration.TeamTaskSummary
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastDetail
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastSummary

enum class CollaborationSection { TASKS, BROADCASTS }

data class PendingTaskAction(
    val action: TaskAction,
    val note: String = "",
    val assignedTo: Long? = null,
)

data class CollaborationUiState(
    val section: CollaborationSection = CollaborationSection.TASKS,
    val branchId: Long? = null,
    val branches: List<CollaborationBranch> = emptyList(),
    val branchesLoading: Boolean = false,
    val branchesLoaded: Boolean = false,
    val loading: Boolean = false,
    val loadingDetail: Boolean = false,
    val loadingMore: Boolean = false,
    val busyKey: String? = null,
    val tasks: List<TeamTaskSummary> = emptyList(),
    val taskFilter: TeamTaskFilter = TeamTaskFilter(),
    val nextTaskCursor: Long? = null,
    val selectedTask: TeamTaskDetail? = null,
    val taskEditor: CreateTaskDraft? = null,
    val pendingTaskAction: PendingTaskAction? = null,
    val staff: List<AssignableStaff> = emptyList(),
    val serviceTypes: List<ServiceTypeOption> = emptyList(),
    val broadcasts: List<WhatsappBroadcastSummary> = emptyList(),
    val selectedBroadcast: WhatsappBroadcastDetail? = null,
    val broadcastResults: BroadcastResults? = null,
    val templates: List<BroadcastTemplate> = emptyList(),
    val broadcastEditor: CreateBroadcastDraft? = null,
    val broadcastPreview: BroadcastPreview? = null,
    val error: String? = null,
    val notice: String? = null,
)

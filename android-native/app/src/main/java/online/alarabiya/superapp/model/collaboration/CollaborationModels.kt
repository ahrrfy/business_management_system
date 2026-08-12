package online.alarabiya.superapp.model.collaboration

import online.alarabiya.superapp.model.AppBootstrap
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate

enum class CollaborationAccess {
    NONE, READ, FULL;
    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL
    companion object {
        fun fromWire(value: String?): CollaborationAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class CollaborationCapabilities(
    val userId: Long,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
    val tasks: CollaborationAccess,
    val campaigns: CollaborationAccess,
    val isOwner: Boolean = false,
) {
    private val normalizedRole get() = role.lowercase()
    val canWriteTasks: Boolean
        get() = tasks.canWrite && (normalizedRole == "admin" || normalizedRole in TASK_WRITE_ROLES)
    val canManageTasks: Boolean
        get() = tasks.canWrite && normalizedRole in setOf("admin", "manager")
    val canManageBroadcasts: Boolean
        get() = campaigns.canWrite && normalizedRole in setOf("admin", "manager")
    /** `branchScopedProcedure` deliberately gives admin/manager global read scope. */
    val canReadBroadcastsSafely: Boolean
        get() = campaigns.canRead
    val elevatedTasks: Boolean get() = isOwner || normalizedRole == "admin" || normalizedRole == "manager"
    val canSelectTaskBranch: Boolean
        get() = tasks.canRead && allBranches && elevatedTasks

    companion object {
        private val TASK_WRITE_ROLES = setOf("cashier", "manager", "sales_rep", "print_operator")
        fun fromBootstrap(bootstrap: AppBootstrap): CollaborationCapabilities {
            val modules = bootstrap.modules.associate { it.key to CollaborationAccess.fromWire(it.access) }
            return CollaborationCapabilities(
                userId = bootstrap.user.id,
                role = bootstrap.user.role,
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
                tasks = modules["tasks"] ?: CollaborationAccess.NONE,
                campaigns = modules["campaigns"] ?: CollaborationAccess.NONE,
                isOwner = bootstrap.isOwner || bootstrap.user.isOwner,
            )
        }
    }
}

data class CollaborationBranch(
    val id: Long,
    val name: String,
    val code: String?,
)

enum class TaskKind(val wire: String, val label: String) {
    SERVICE_REQUEST("SERVICE_REQUEST", "طلب خدمة"),
    SUPPORT("SUPPORT", "دعم"),
    INQUIRY("INQUIRY", "استفسار"),
    FOLLOW_UP("FOLLOW_UP", "متابعة"),
    INTERNAL("INTERNAL", "داخلية");
    companion object { fun fromWire(value: String?): TaskKind = entries.firstOrNull { it.wire == value } ?: INQUIRY }
}

enum class TaskStatus(val wire: String, val label: String) {
    NEW("NEW", "جديدة"),
    IN_PROGRESS("IN_PROGRESS", "قيد التنفيذ"),
    WAITING_CUSTOMER("WAITING_CUSTOMER", "بانتظار العميل"),
    RESOLVED("RESOLVED", "محلولة"),
    CANCELLED("CANCELLED", "ملغاة");
    val open get() = this in setOf(NEW, IN_PROGRESS, WAITING_CUSTOMER)
    companion object { fun fromWire(value: String?): TaskStatus = entries.firstOrNull { it.wire == value } ?: NEW }
}

enum class TaskPriority(val wire: String, val label: String) {
    LOW("LOW", "منخفضة"), NORMAL("NORMAL", "عادية"), HIGH("HIGH", "عالية"), URGENT("URGENT", "عاجلة");
    companion object { fun fromWire(value: String?): TaskPriority = entries.firstOrNull { it.wire == value } ?: NORMAL }
}

enum class TaskSourceChannel { WHATSAPP, INSTAGRAM, TIKTOK, STORE, PHONE, WALK_IN, OTHER }
enum class TaskEventType { COMMENT, STATUS, ASSIGN, LINK, SYSTEM, CSAT }
enum class TaskAction { CLAIM, WAIT, RESUME, RESOLVE, COMMENT, ASSIGN, REOPEN, CANCEL }

data class TeamTaskSummary(
    val id: Long,
    val taskNumber: String,
    val branchId: Long,
    val kind: TaskKind,
    val status: TaskStatus,
    val priority: TaskPriority,
    val title: String,
    val customerId: Long?,
    val customerName: String?,
    val supplierId: Long?,
    val supplierName: String?,
    val assignedTo: Long?,
    val assigneeName: String?,
    val createdBy: Long?,
    val conversationId: Long?,
    val dueAt: String?,
    val effectiveDueAt: String?,
    val isOverdue: Boolean,
    val createdAt: String?,
)

data class TaskEvent(
    val id: Long,
    val type: TaskEventType,
    val fromStatus: TaskStatus?,
    val toStatus: TaskStatus?,
    val note: String?,
    val userId: Long?,
    val userName: String?,
    val createdAt: String?,
)

data class TeamTaskDetail(
    val summary: TeamTaskSummary,
    val description: String?,
    val linkedWorkOrderId: Long?,
    val linkedInvoiceId: Long?,
    val linkedQuotationId: Long?,
    val serviceTypeId: Long?,
    val sourceChannel: TaskSourceChannel?,
    val firstResponseAt: String?,
    val resolvedAt: String?,
    val resolutionNote: String?,
    val reopenCount: Int,
    val csatScore: Int?,
    val updatedAt: String?,
    val events: List<TaskEvent>,
)

data class TeamTaskPage(val rows: List<TeamTaskSummary>, val hasMore: Boolean, val nextCursor: Long?)

data class TeamTaskFilter(
    val status: TaskStatus? = null,
    val kind: TaskKind? = null,
    val priority: TaskPriority? = null,
    val assignedTo: Long? = null,
    val branchId: Long? = null,
    val overdue: Boolean = false,
    val from: String = "",
    val to: String = "",
    val query: String = "",
    val cursor: Long? = null,
    val limit: Int = 80,
)

data class AssignableStaff(val id: Long, val name: String, val role: String)
data class ServiceTypeOption(val id: Long, val name: String, val defaultKind: TaskKind, val defaultPriority: TaskPriority, val slaHours: Int?)

data class CreateTaskDraft(
    val branchId: Long? = null,
    val kind: TaskKind = TaskKind.INTERNAL,
    val title: String = "",
    val description: String = "",
    val priority: TaskPriority? = null,
    val assignedTo: Long? = null,
    val dueAt: String = "",
    val serviceTypeId: Long? = null,
    val customerId: Long? = null,
    val supplierId: Long? = null,
    val conversationId: Long? = null,
    val linkedWorkOrderId: Long? = null,
    val linkedInvoiceId: Long? = null,
    val linkedQuotationId: Long? = null,
    val sourceChannel: TaskSourceChannel? = null,
)

object TaskActionPolicy {
    fun allowed(detail: TeamTaskDetail, capabilities: CollaborationCapabilities, now: Instant = Instant.now()): Set<TaskAction> {
        val task = detail.summary
        val assignee = task.assignedTo == capabilities.userId
        val creator = task.createdBy == capabilities.userId
        return buildSet {
            if (capabilities.canWriteTasks) {
                if (task.status == TaskStatus.NEW && (task.assignedTo == null || assignee)) add(TaskAction.CLAIM)
                if ((assignee || capabilities.elevatedTasks) && task.status in setOf(TaskStatus.NEW, TaskStatus.IN_PROGRESS)) add(TaskAction.WAIT)
                if ((assignee || capabilities.elevatedTasks) && task.status == TaskStatus.WAITING_CUSTOMER) add(TaskAction.RESUME)
                if ((assignee || capabilities.elevatedTasks) && task.status in setOf(TaskStatus.IN_PROGRESS, TaskStatus.WAITING_CUSTOMER)) add(TaskAction.RESOLVE)
                if (assignee || creator || capabilities.elevatedTasks) add(TaskAction.COMMENT)
            }
            if (capabilities.canManageTasks) {
                if (task.status.open) {
                    add(TaskAction.ASSIGN)
                    add(TaskAction.CANCEL)
                }
                if (task.status == TaskStatus.RESOLVED && detail.resolvedAt?.let {
                        runCatching { now.epochSecond - Instant.parse(it).epochSecond <= 7 * 24 * 3600 }.getOrDefault(false)
                    } == true
                ) add(TaskAction.REOPEN)
            }
        }
    }
}

enum class BroadcastStatus(val wire: String, val label: String) {
    DRAFT("DRAFT", "مسودة"),
    PENDING_APPROVAL("PENDING_APPROVAL", "بانتظار الاعتماد"),
    APPROVED("APPROVED", "معتمدة"),
    RUNNING("RUNNING", "قيد التشغيل"),
    PAUSED("PAUSED", "موقوفة"),
    COMPLETED("COMPLETED", "مكتملة"),
    CANCELLED("CANCELLED", "ملغاة");
    companion object { fun fromWire(value: String?): BroadcastStatus = entries.firstOrNull { it.wire == value } ?: DRAFT }
}

enum class BroadcastAction { LAUNCH, APPROVE, PAUSE, RESUME, CANCEL }

data class WhatsappBroadcastSummary(
    val id: Long,
    val name: String,
    val branchId: Long?,
    val crmCampaignId: Long?,
    val templateId: Long,
    val status: BroadcastStatus,
    val audienceCount: Int,
    val costEstimate: String,
    val throttlePerMinute: Int,
    val scheduledAt: String?,
    val startedAt: String?,
    val completedAt: String?,
    val pausedReason: String?,
    val createdBy: Long?,
    val approvedBy: Long?,
    val createdAt: String?,
)

data class WhatsappBroadcastDetail(
    val summary: WhatsappBroadcastSummary,
    val recipientCounts: Map<String, Int>,
)

data class BroadcastResults(
    val audienceCount: Int,
    val totalRecipients: Int,
    val counts: Map<String, Int>,
    val percentages: Map<String, String>,
)

data class BroadcastTemplate(val id: Long, val name: String, val language: String, val variableCount: Int, val bodyText: String?)

data class BroadcastSegment(
    val customerTypes: Set<String> = emptySet(),
    val priceTiers: Set<String> = emptySet(),
    val branchId: Long? = null,
    val rfmPreset: String? = null,
    val rfmRecencyDays: Int? = null,
    val rfmMinInvoices: Int? = null,
    val rfmMinSpend: String? = null,
    val balanceMin: String? = null,
    val balanceMax: String? = null,
)

data class BroadcastPreview(val audienceCount: Int, val costEstimate: String)

data class CreateBroadcastDraft(
    val name: String = "",
    val branchId: Long? = null,
    val crmCampaignId: Long? = null,
    val templateId: Long? = null,
    val templateVariableCount: Int = 0,
    val variables: Map<String, String> = emptyMap(),
    val segment: BroadcastSegment = BroadcastSegment(),
    val throttlePerMinute: Int = 10,
    val scheduledAt: String = "",
)

object BroadcastActionPolicy {
    fun allowed(item: WhatsappBroadcastSummary, capabilities: CollaborationCapabilities): Set<BroadcastAction> {
        if (!capabilities.canManageBroadcasts) return emptySet()
        val canWriteThisBroadcast = capabilities.role.equals("admin", true) ||
            (item.branchId != null && item.branchId == capabilities.branchId)
        if (!canWriteThisBroadcast) return emptySet()
        return buildSet {
            if (item.status in setOf(BroadcastStatus.DRAFT, BroadcastStatus.APPROVED)) add(BroadcastAction.LAUNCH)
            if (item.status == BroadcastStatus.PENDING_APPROVAL && item.createdBy != capabilities.userId) add(BroadcastAction.APPROVE)
            if (item.status == BroadcastStatus.RUNNING) add(BroadcastAction.PAUSE)
            if (item.status == BroadcastStatus.PAUSED) add(BroadcastAction.RESUME)
            if (item.status in setOf(BroadcastStatus.DRAFT, BroadcastStatus.PENDING_APPROVAL, BroadcastStatus.APPROVED, BroadcastStatus.RUNNING, BroadcastStatus.PAUSED)) add(BroadcastAction.CANCEL)
        }
    }
}

object CollaborationValidation {
    fun task(draft: CreateTaskDraft, capabilities: CollaborationCapabilities): String? = when {
        draft.branchId == null || draft.branchId <= 0 -> "اختر الفرع"
        !capabilities.elevatedTasks && draft.branchId != capabilities.branchId -> "لا يمكن إنشاء مهمة لفرع آخر"
        draft.title.trim().isEmpty() -> "عنوان المهمة مطلوب"
        draft.title.trim().length > 200 -> "عنوان المهمة أطول من الحد المسموح"
        draft.description.length > 4_000 -> "وصف المهمة أطول من الحد المسموح"
        listOfNotNull(
            draft.assignedTo, draft.serviceTypeId, draft.customerId, draft.supplierId, draft.conversationId,
            draft.linkedWorkOrderId, draft.linkedInvoiceId, draft.linkedQuotationId,
        ).any { it <= 0 } -> "أحد المعرّفات المرتبطة غير صالح"
        draft.dueAt.isNotBlank() && !validTaskDate(draft.dueAt) -> "موعد الاستحقاق غير صالح"
        else -> null
    }

    fun broadcast(draft: CreateBroadcastDraft, capabilities: CollaborationCapabilities): String? = when {
        !capabilities.canManageBroadcasts -> "لا توجد صلاحية لإدارة البث"
        !capabilities.role.equals("admin", true) && draft.branchId != capabilities.branchId -> "لا يمكن إدارة بث لفرع آخر"
        draft.name.trim().length !in 2..160 -> "اسم البث يجب أن يكون بين حرفين و160 حرفاً"
        draft.templateId == null || draft.templateId <= 0 -> "اختر قالباً معتمداً"
        (1..draft.templateVariableCount).any { draft.variables[it.toString()] !in SUPPORTED_BROADCAST_FIELDS } -> "أكمل ربط متغيرات القالب"
        !ALLOWED_CUSTOMER_TYPES.containsAll(draft.segment.customerTypes) -> "نوع عميل غير صالح في شريحة البث"
        !ALLOWED_PRICE_TIERS.containsAll(draft.segment.priceTiers) -> "فئة سعر غير صالحة في شريحة البث"
        draft.segment.rfmPreset != null && draft.segment.rfmPreset !in ALLOWED_RFM_PRESETS -> "شريحة RFM غير صالحة"
        draft.segment.rfmRecencyDays != null && draft.segment.rfmRecencyDays !in 1..3650 -> "مدة RFM غير صالحة"
        draft.segment.rfmMinInvoices != null && draft.segment.rfmMinInvoices !in 1..100_000 -> "عدد فواتير RFM غير صالح"
        draft.throttlePerMinute !in 1..120 -> "معدل الإرسال يجب أن يكون بين 1 و120"
        draft.scheduledAt.isNotBlank() && runCatching { Instant.parse(draft.scheduledAt) }.isFailure -> "وقت الجدولة غير صالح"
        else -> null
    }

    private val SUPPORTED_BROADCAST_FIELDS = setOf("name", "currentBalance", "phone", "phoneE164")
    private val ALLOWED_CUSTOMER_TYPES = setOf("فرد", "تاجر", "مؤسسة", "شركة", "حكومي")
    private val ALLOWED_PRICE_TIERS = setOf("RETAIL", "WHOLESALE", "GOVERNMENT")
    private val ALLOWED_RFM_PRESETS = setOf("VIP", "AT_RISK", "DORMANT", "NEW")
    private fun validTaskDate(value: String): Boolean =
        runCatching { Instant.parse(value) }.isSuccess || runCatching { LocalDate.parse(value) }.isSuccess
}

object CollaborationMappers {
    fun branches(json: JSONArray): List<CollaborationBranch> = json.objects { branch ->
        CollaborationBranch(
            id = branch.optLong("id"),
            name = branch.optString("name").trim(),
            code = branch.stringOrNull("code"),
        )
    }.filter { branch -> branch.id > 0 && branch.name.isNotEmpty() }
        .distinctBy(CollaborationBranch::id)

    fun taskPage(json: JSONObject) = TeamTaskPage(
        rows = json.optJSONArray("rows").objects(::taskSummary),
        hasMore = json.optBoolean("hasMore"),
        nextCursor = json.longOrNull("nextCursor"),
    )

    fun taskDetail(json: JSONObject) = TeamTaskDetail(
        summary = taskSummary(json),
        description = json.stringOrNull("description"),
        linkedWorkOrderId = json.longOrNull("linkedWorkOrderId"),
        linkedInvoiceId = json.longOrNull("linkedInvoiceId"),
        linkedQuotationId = json.longOrNull("linkedQuotationId"),
        serviceTypeId = json.longOrNull("serviceTypeId"),
        sourceChannel = enumOrNull<TaskSourceChannel>(json.stringOrNull("sourceChannel")),
        firstResponseAt = json.stringOrNull("firstResponseAt"),
        resolvedAt = json.stringOrNull("resolvedAt"),
        resolutionNote = json.stringOrNull("resolutionNote"),
        reopenCount = json.optInt("reopenCount"),
        csatScore = json.intOrNull("csatScore"),
        updatedAt = json.stringOrNull("updatedAt"),
        events = json.optJSONArray("events").objects { event ->
            TaskEvent(
                id = event.optLong("id"),
                type = enumOr(event.stringOrNull("eventType"), TaskEventType.SYSTEM),
                fromStatus = enumOrNull<TaskStatus>(event.stringOrNull("fromStatus")),
                toStatus = enumOrNull<TaskStatus>(event.stringOrNull("toStatus")),
                note = event.stringOrNull("note"),
                userId = event.longOrNull("userId"),
                userName = event.stringOrNull("userName"),
                createdAt = event.stringOrNull("createdAt"),
            )
        },
    )

    fun staff(json: JSONArray) = json.objects { AssignableStaff(it.optLong("id"), it.optString("name"), it.optString("role")) }
    fun serviceTypes(json: JSONArray) = json.objects {
        ServiceTypeOption(
            it.optLong("id"), it.optString("name"), TaskKind.fromWire(it.stringOrNull("defaultKind")),
            TaskPriority.fromWire(it.stringOrNull("defaultPriority")), it.intOrNull("slaHours"),
        )
    }
    fun broadcasts(json: JSONArray) = json.objects(::broadcastSummary)
    fun broadcastDetail(json: JSONObject) = WhatsappBroadcastDetail(
        summary = broadcastSummary(json), recipientCounts = json.optJSONObject("recipientCounts").intMap(),
    )
    fun broadcastResults(json: JSONObject) = BroadcastResults(
        audienceCount = json.optInt("audienceCount"), totalRecipients = json.optInt("totalRecipients"),
        counts = json.optJSONObject("counts").intMap(), percentages = json.optJSONObject("percentages").stringMap(),
    )
    fun templates(json: JSONArray) = json.objects {
        BroadcastTemplate(it.optLong("id"), it.optString("name"), it.optString("language", "ar"), it.optInt("variableCount"), it.stringOrNull("bodyText"))
    }.filter { it.id > 0 && it.name.isNotBlank() }

    private fun taskSummary(json: JSONObject) = TeamTaskSummary(
        id = json.optLong("id"), taskNumber = json.optString("taskNumber"), branchId = json.optLong("branchId"),
        kind = TaskKind.fromWire(json.stringOrNull("taskKind")), status = TaskStatus.fromWire(json.stringOrNull("taskStatus")),
        priority = TaskPriority.fromWire(json.stringOrNull("priority")), title = json.optString("title"),
        customerId = json.longOrNull("customerId"), customerName = json.stringOrNull("customerName"),
        supplierId = json.longOrNull("supplierId"), supplierName = json.stringOrNull("supplierName"),
        assignedTo = json.longOrNull("assignedTo"), assigneeName = json.stringOrNull("assigneeName"),
        createdBy = json.longOrNull("createdBy"), conversationId = json.longOrNull("conversationId"),
        dueAt = json.stringOrNull("dueAt"), effectiveDueAt = json.stringOrNull("effectiveDueAt"),
        isOverdue = json.optBoolean("isOverdue"), createdAt = json.stringOrNull("createdAt"),
    )

    private fun broadcastSummary(json: JSONObject) = WhatsappBroadcastSummary(
        id = json.optLong("id"), name = json.optString("name"), branchId = json.longOrNull("branchId"),
        crmCampaignId = json.longOrNull("crmCampaignId"), templateId = json.optLong("templateId"),
        status = BroadcastStatus.fromWire(json.stringOrNull("broadcastStatus")), audienceCount = json.optInt("audienceCount"),
        costEstimate = json.optString("costEstimate", "0"), throttlePerMinute = json.optInt("throttlePerMinute", 10),
        scheduledAt = json.stringOrNull("scheduledAt"), startedAt = json.stringOrNull("startedAt"),
        completedAt = json.stringOrNull("completedAt"), pausedReason = json.stringOrNull("pausedReason"),
        createdBy = json.longOrNull("createdBy"), approvedBy = json.longOrNull("approvedBy"), createdAt = json.stringOrNull("createdAt"),
    )
}

object NativeCollaborationContractGaps {
    const val INTERNAL_ANNOUNCEMENTS = "No employee/team announcement API exists. broadcasts.* is an external WhatsApp marketing transport and must not be presented as an internal announcement feed."
    const val MANAGER_BROADCAST_WRITE_SCOPE = "Manager broadcast reads are intentionally global, while create/lifecycle writes remain restricted to the manager's assigned branch by ownBranch/assertBroadcastBranchAccess."
    const val SHARED_PERSONAL_DETAIL = "Personal self-service exposes only compact tasks from superApp.myWorkspace; the central navigator must route both personal and team lists to this shared tasks.get detail screen."
    const val TASK_BRANCH_GET = "tasks.get has no expectedBranchId input for elevated users; native verifies the returned branch against the selected workspace, while server-side branch scoping for elevated direct lookup remains desirable."
}

private fun JSONObject.stringOrNull(key: String) = takeUnless { isNull(key) }?.optString(key)?.takeIf(String::isNotBlank)
private fun JSONObject.longOrNull(key: String) = takeUnless { isNull(key) }?.optLong(key)?.takeIf { it > 0 }
private fun JSONObject.intOrNull(key: String) = takeUnless { isNull(key) }?.optInt(key)
private fun <T> JSONArray?.objects(mapper: (JSONObject) -> T): List<T> = (this ?: JSONArray()).let { array -> buildList { for (i in 0 until array.length()) array.optJSONObject(i)?.let { add(mapper(it)) } } }
private fun JSONObject?.intMap(): Map<String, Int> = this?.let { json -> json.keys().asSequence().associateWith { json.optInt(it) } } ?: emptyMap()
private fun JSONObject?.stringMap(): Map<String, String> = this?.let { json -> json.keys().asSequence().associateWith { json.optString(it) } } ?: emptyMap()
private inline fun <reified T : Enum<T>> enumOrNull(value: String?): T? = value?.let { wire -> enumValues<T>().firstOrNull { it.name == wire } }
private inline fun <reified T : Enum<T>> enumOr(value: String?, fallback: T): T = enumOrNull<T>(value) ?: fallback

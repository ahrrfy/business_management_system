package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.collaboration.AssignableStaff
import online.alarabiya.superapp.model.collaboration.BroadcastAction
import online.alarabiya.superapp.model.collaboration.BroadcastActionPolicy
import online.alarabiya.superapp.model.collaboration.BroadcastPreview
import online.alarabiya.superapp.model.collaboration.BroadcastResults
import online.alarabiya.superapp.model.collaboration.BroadcastTemplate
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CollaborationBranch
import online.alarabiya.superapp.model.collaboration.CollaborationMappers
import online.alarabiya.superapp.model.collaboration.CollaborationValidation
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.CreateTaskDraft
import online.alarabiya.superapp.model.collaboration.ServiceTypeOption
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TaskActionPolicy
import online.alarabiya.superapp.model.collaboration.TeamTaskDetail
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter
import online.alarabiya.superapp.model.collaboration.TeamTaskPage
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastDetail
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastSummary
import org.json.JSONArray
import org.json.JSONObject

interface CollaborationDataSource {
    suspend fun branches(capabilities: CollaborationCapabilities): List<CollaborationBranch>
    suspend fun tasks(filter: TeamTaskFilter, capabilities: CollaborationCapabilities): TeamTaskPage
    suspend fun task(taskId: Long, expectedBranchId: Long): TeamTaskDetail
    suspend fun assignableStaff(branchId: Long, capabilities: CollaborationCapabilities): List<AssignableStaff>
    suspend fun serviceTypes(): List<ServiceTypeOption>
    suspend fun createTask(draft: CreateTaskDraft, capabilities: CollaborationCapabilities): Long
    suspend fun taskAction(
        detail: TeamTaskDetail,
        capabilities: CollaborationCapabilities,
        action: TaskAction,
        note: String? = null,
        assignedTo: Long? = null,
    )
    suspend fun broadcasts(capabilities: CollaborationCapabilities): List<WhatsappBroadcastSummary>
    suspend fun broadcast(id: Long, capabilities: CollaborationCapabilities): WhatsappBroadcastDetail
    suspend fun broadcastResults(id: Long, capabilities: CollaborationCapabilities): BroadcastResults
    suspend fun broadcastTemplates(capabilities: CollaborationCapabilities): List<BroadcastTemplate>
    suspend fun previewBroadcast(draft: CreateBroadcastDraft, capabilities: CollaborationCapabilities): BroadcastPreview
    suspend fun createBroadcast(draft: CreateBroadcastDraft, capabilities: CollaborationCapabilities): Long
    suspend fun broadcastAction(
        detail: WhatsappBroadcastDetail,
        capabilities: CollaborationCapabilities,
        action: BroadcastAction,
        reason: String? = null,
    )
}

internal interface CollaborationApi {
    suspend fun queryObject(procedure: String, input: JSONObject? = null): JSONObject
    suspend fun queryArray(procedure: String, input: JSONObject? = null): JSONArray
    suspend fun mutateObject(procedure: String, input: JSONObject? = null): JSONObject
}

private class TrpcCollaborationApi(private val client: TrpcClient) : CollaborationApi {
    override suspend fun queryObject(procedure: String, input: JSONObject?) = client.query(procedure, input)
    override suspend fun queryArray(procedure: String, input: JSONObject?) = client.queryArray(procedure, input)
    override suspend fun mutateObject(procedure: String, input: JSONObject?) = client.mutate(procedure, input)
}

class CollaborationRepository internal constructor(private val api: CollaborationApi) : CollaborationDataSource {
    constructor(client: TrpcClient) : this(TrpcCollaborationApi(client))

    override suspend fun branches(capabilities: CollaborationCapabilities): List<CollaborationBranch> {
        require(capabilities.canSelectTaskBranch) { "لا توجد صلاحية لاختيار فرع مهام الفريق" }
        return CollaborationMappers.branches(api.queryArray("branches.list"))
    }

    override suspend fun tasks(filter: TeamTaskFilter, capabilities: CollaborationCapabilities): TeamTaskPage {
        require(capabilities.tasks.canRead) { "لا توجد صلاحية لعرض المهام" }
        require(filter.limit in 1..200) { "حجم صفحة المهام غير صالح" }
        val branchId = requiredTaskBranch(filter.branchId, capabilities)
        val input = JSONObject().put("branchId", branchId).put("limit", filter.limit)
        filter.status?.let { input.put("status", it.wire) }
        filter.kind?.let { input.put("kind", it.wire) }
        filter.priority?.let { input.put("priority", it.wire) }
        filter.assignedTo?.also { require(it > 0) }?.let { input.put("assignedTo", it) }
        if (filter.overdue) input.put("overdue", true)
        filter.from.trim().takeIf(String::isNotEmpty)?.let { input.put("from", it) }
        filter.to.trim().takeIf(String::isNotEmpty)?.let { input.put("to", it) }
        filter.query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        filter.cursor?.also { require(it > 0) }?.let { input.put("cursor", it) }
        return CollaborationMappers.taskPage(api.queryObject("tasks.list", input))
    }

    override suspend fun task(taskId: Long, expectedBranchId: Long): TeamTaskDetail {
        require(taskId > 0 && expectedBranchId > 0) { "معرّف المهمة أو الفرع غير صالح" }
        return CollaborationMappers.taskDetail(
            api.queryObject("tasks.get", JSONObject().put("taskId", taskId)),
        ).also {
            require(it.summary.branchId == expectedBranchId) { "المهمة لا تخص مساحة الفرع المختارة" }
        }
    }

    override suspend fun assignableStaff(
        branchId: Long,
        capabilities: CollaborationCapabilities,
    ): List<AssignableStaff> {
        require(capabilities.tasks.canRead && branchId > 0) { "لا يمكن قراءة فريق هذا الفرع" }
        if (!capabilities.elevatedTasks) require(branchId == capabilities.branchId) { "لا يمكن قراءة فريق فرع آخر" }
        return CollaborationMappers.staff(
            api.queryArray("tasks.assignableStaff", JSONObject().put("branchId", branchId)),
        )
    }

    override suspend fun serviceTypes(): List<ServiceTypeOption> =
        CollaborationMappers.serviceTypes(api.queryArray("tasks.serviceTypes.list"))

    override suspend fun createTask(draft: CreateTaskDraft, capabilities: CollaborationCapabilities): Long {
        require(capabilities.canWriteTasks) { "لا توجد صلاحية لإنشاء المهام" }
        CollaborationValidation.task(draft, capabilities)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("branchId", requireNotNull(draft.branchId))
            .put("kind", draft.kind.wire)
            .put("title", draft.title.trim())
            .putNullable("description", draft.description)
            .putNullableLong("assignedTo", draft.assignedTo)
            .putNullable("dueAt", draft.dueAt)
            .putNullableLong("serviceTypeId", draft.serviceTypeId)
            .putNullableLong("customerId", draft.customerId)
            .putNullableLong("supplierId", draft.supplierId)
            .putNullableLong("conversationId", draft.conversationId)
            .putNullableLong("linkedWorkOrderId", draft.linkedWorkOrderId)
            .putNullableLong("linkedInvoiceId", draft.linkedInvoiceId)
            .putNullableLong("linkedQuotationId", draft.linkedQuotationId)
        draft.priority?.let { input.put("priority", it.wire) }
        draft.sourceChannel?.let { input.put("sourceChannel", it.name) }
        return api.mutateObject("tasks.create", input).optLong("taskId").also {
            require(it > 0) { "لم يرجع الخادم معرّف المهمة" }
        }
    }

    override suspend fun taskAction(
        detail: TeamTaskDetail,
        capabilities: CollaborationCapabilities,
        action: TaskAction,
        note: String?,
        assignedTo: Long?,
    ) {
        require(action in TaskActionPolicy.allowed(detail, capabilities)) { "الإجراء غير متاح لهذه المهمة" }
        val clean = note?.trim()?.takeIf(String::isNotEmpty)
        val input = JSONObject().put("taskId", detail.summary.id)
        val procedure = when (action) {
            TaskAction.CLAIM -> "tasks.claim"
            TaskAction.WAIT -> "tasks.setWaiting".also { input.putNullable("note", clean.orEmpty()) }
            TaskAction.RESUME -> "tasks.resume"
            TaskAction.RESOLVE -> {
                if (detail.summary.kind == online.alarabiya.superapp.model.collaboration.TaskKind.SUPPORT) {
                    require(!clean.isNullOrBlank()) { "ملاحظة الحل إلزامية لمهام الدعم" }
                }
                input.putNullable("resolutionNote", clean.orEmpty())
                "tasks.resolve"
            }
            TaskAction.COMMENT -> {
                require(!clean.isNullOrBlank()) { "اكتب التعليق أولاً" }
                input.put("note", clean)
                "tasks.addComment"
            }
            TaskAction.ASSIGN -> {
                input.put("assignedTo", assignedTo ?: JSONObject.NULL)
                "tasks.assign"
            }
            TaskAction.REOPEN -> "tasks.reopen".also { input.putNullable("note", clean.orEmpty()) }
            TaskAction.CANCEL -> {
                require(!clean.isNullOrBlank()) { "سبب الإلغاء مطلوب" }
                input.put("note", clean)
                "tasks.cancel"
            }
        }
        api.mutateObject(procedure, input)
    }

    override suspend fun broadcasts(capabilities: CollaborationCapabilities): List<WhatsappBroadcastSummary> {
        require(capabilities.canReadBroadcastsSafely) { "لا توجد صلاحية لقراءة البث" }
        return CollaborationMappers.broadcasts(api.queryArray("broadcasts.list"))
    }

    override suspend fun broadcast(id: Long, capabilities: CollaborationCapabilities): WhatsappBroadcastDetail {
        require(id > 0 && capabilities.canReadBroadcastsSafely) { "لا يمكن قراءة هذا البث بأمان" }
        return CollaborationMappers.broadcastDetail(
            api.queryObject("broadcasts.get", JSONObject().put("broadcastId", id)),
        ).also { detail -> verifyBroadcastReadScope(detail.summary, capabilities) }
    }

    override suspend fun broadcastResults(id: Long, capabilities: CollaborationCapabilities): BroadcastResults {
        require(id > 0 && capabilities.canReadBroadcastsSafely) { "لا يمكن قراءة نتائج هذا البث بأمان" }
        return CollaborationMappers.broadcastResults(
            api.queryObject("broadcasts.results", JSONObject().put("broadcastId", id)),
        )
    }

    override suspend fun broadcastTemplates(capabilities: CollaborationCapabilities): List<BroadcastTemplate> {
        require(capabilities.canManageBroadcasts) { "لا توجد صلاحية لإدارة قوالب البث" }
        return CollaborationMappers.templates(
            api.queryArray("integrations.templates.list", JSONObject().put("statusFilter", "APPROVED")),
        )
    }

    override suspend fun previewBroadcast(
        draft: CreateBroadcastDraft,
        capabilities: CollaborationCapabilities,
    ): BroadcastPreview {
        CollaborationValidation.broadcast(draft, capabilities)?.let { throw IllegalArgumentException(it) }
        val result = api.queryObject("broadcasts.preview", JSONObject().put("segment", segmentJson(draft, capabilities)))
        return BroadcastPreview(result.optInt("audienceCount"), result.optString("costEstimate", "0"))
    }

    override suspend fun createBroadcast(
        draft: CreateBroadcastDraft,
        capabilities: CollaborationCapabilities,
    ): Long {
        CollaborationValidation.broadcast(draft, capabilities)?.let { throw IllegalArgumentException(it) }
        require(capabilities.canReadBroadcastsSafely) { "لا توجد صلاحية لقراءة البث" }
        val input = JSONObject()
            .put("name", draft.name.trim())
            .put("branchId", draft.branchId ?: JSONObject.NULL)
            .put("crmCampaignId", draft.crmCampaignId ?: JSONObject.NULL)
            .put("templateId", requireNotNull(draft.templateId))
            .put("segment", segmentJson(draft, capabilities))
            .put("throttlePerMinute", draft.throttlePerMinute)
            .put("scheduledAt", draft.scheduledAt.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)
            .put("varsMapJson", JSONObject(draft.variables))
        return api.mutateObject("broadcasts.create", input).optLong("broadcastId").also {
            require(it > 0) { "لم يرجع الخادم معرّف البث" }
        }
    }

    override suspend fun broadcastAction(
        detail: WhatsappBroadcastDetail,
        capabilities: CollaborationCapabilities,
        action: BroadcastAction,
        reason: String?,
    ) {
        require(action in BroadcastActionPolicy.allowed(detail.summary, capabilities)) { "الإجراء غير متاح لهذا البث" }
        require(capabilities.canReadBroadcastsSafely) { "لا توجد صلاحية لقراءة البث" }
        verifyBroadcastWriteScope(detail.summary, capabilities)
        val input = JSONObject().put("broadcastId", detail.summary.id)
        val procedure = when (action) {
            BroadcastAction.LAUNCH -> "broadcasts.launch"
            BroadcastAction.APPROVE -> "broadcasts.approve"
            BroadcastAction.PAUSE -> {
                val clean = reason?.trim().orEmpty()
                require(clean.isNotBlank()) { "سبب الإيقاف مطلوب" }
                input.put("reason", clean.take(200))
                "broadcasts.pause"
            }
            BroadcastAction.RESUME -> "broadcasts.resume"
            BroadcastAction.CANCEL -> "broadcasts.cancel"
        }
        api.mutateObject(procedure, input)
    }

    private fun requiredTaskBranch(requested: Long?, capabilities: CollaborationCapabilities): Long {
        val branch = requested ?: capabilities.branchId
        require(branch != null && branch > 0) { "اختر الفرع لعرض مهام الفريق" }
        if (!capabilities.elevatedTasks) require(branch == capabilities.branchId) { "لا يمكن قراءة مهام فرع آخر" }
        return branch
    }

    private fun segmentJson(draft: CreateBroadcastDraft, capabilities: CollaborationCapabilities): JSONObject {
        val branch = if (capabilities.role.equals("admin", true)) draft.segment.branchId else capabilities.branchId
        return JSONObject()
            .put("customerTypes", JSONArray(draft.segment.customerTypes.toList()))
            .put("priceTiers", JSONArray(draft.segment.priceTiers.toList()))
            .put("branchId", branch ?: JSONObject.NULL)
            .put("requireOptIn", true)
            .apply {
                draft.segment.balanceMin?.trim()?.takeIf(String::isNotEmpty)?.let { put("balanceMin", it) }
                draft.segment.balanceMax?.trim()?.takeIf(String::isNotEmpty)?.let { put("balanceMax", it) }
                val rfm = JSONObject()
                draft.segment.rfmPreset?.takeIf(String::isNotBlank)?.let { rfm.put("preset", it) }
                draft.segment.rfmRecencyDays?.let { rfm.put("recencyDays", it) }
                draft.segment.rfmMinInvoices?.let { rfm.put("minInvoices", it) }
                draft.segment.rfmMinSpend?.trim()?.takeIf(String::isNotEmpty)?.let { rfm.put("minSpend", it) }
                if (rfm.length() > 0) {
                    put("rfm", rfm)
                }
            }
    }

    private fun verifyBroadcastReadScope(item: WhatsappBroadcastSummary, capabilities: CollaborationCapabilities) {
        if (capabilities.allBranches) return
        require(item.branchId == null || item.branchId == capabilities.branchId) { "البث لا يخص فرع المستخدم" }
    }

    private fun verifyBroadcastWriteScope(item: WhatsappBroadcastSummary, capabilities: CollaborationCapabilities) {
        if (capabilities.role.equals("admin", true)) return
        require(item.branchId != null && item.branchId == capabilities.branchId) { "لا يمكن إدارة بث خارج فرع المدير" }
    }
}

private fun JSONObject.putNullable(key: String, value: String): JSONObject =
    put(key, value.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)

private fun JSONObject.putNullableLong(key: String, value: Long?): JSONObject =
    put(key, value?.takeIf { it > 0 } ?: JSONObject.NULL)

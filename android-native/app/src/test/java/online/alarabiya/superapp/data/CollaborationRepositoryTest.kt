package online.alarabiya.superapp.data

import kotlinx.coroutines.runBlocking
import online.alarabiya.superapp.model.collaboration.BroadcastSegment
import online.alarabiya.superapp.model.collaboration.CollaborationAccess
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TaskKind
import online.alarabiya.superapp.model.collaboration.TaskPriority
import online.alarabiya.superapp.model.collaboration.TaskStatus
import online.alarabiya.superapp.model.collaboration.TeamTaskDetail
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter
import online.alarabiya.superapp.model.collaboration.TeamTaskSummary
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CollaborationRepositoryTest {
    @Test
    fun allBranchTaskScopeLoadsOnlyValidatedServerBranches() = runBlocking {
        val api = FakeCollaborationApi().apply {
            arrayResponses["branches.list"] = JSONArray()
                .put(JSONObject().put("id", 7).put("name", "الكرادة").put("code", "BGD"))
                .put(JSONObject().put("id", 0).put("name", "غير صالح"))
        }

        val branches = CollaborationRepository(api).branches(admin())

        assertEquals(1, branches.size)
        assertEquals(7L, branches.single().id)
        assertEquals("الكرادة", branches.single().name)
        assertEquals("branches.list", api.calls.single().procedure)
    }

    @Test
    fun fixedBranchEmployeeCannotEnumerateCompanyBranches() = runBlocking {
        val api = FakeCollaborationApi()

        val failure = runCatching { CollaborationRepository(api).branches(employee()) }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
        assertTrue(api.calls.isEmpty())
    }

    @Test
    fun taskListUsesExactFiltersAndPreservesSelectedBranch() = runBlocking {
        val api = FakeCollaborationApi().apply {
            objectResponses["tasks.list"] = JSONObject()
                .put("rows", JSONArray())
                .put("hasMore", false)
                .put("nextCursor", JSONObject.NULL)
        }
        CollaborationRepository(api).tasks(
            TeamTaskFilter(
                status = TaskStatus.IN_PROGRESS,
                kind = TaskKind.INTERNAL,
                priority = TaskPriority.HIGH,
                branchId = 7,
                overdue = true,
                from = "2026-08-01",
                to = "2026-08-06",
                query = "  تدقيق  ",
                limit = 40,
            ),
            admin(),
        )

        val call = api.calls.single()
        assertEquals("tasks.list", call.procedure)
        with(requireNotNull(call.input)) {
            assertEquals(7L, getLong("branchId"))
            assertEquals("IN_PROGRESS", getString("status"))
            assertEquals("INTERNAL", getString("kind"))
            assertEquals("HIGH", getString("priority"))
            assertEquals("تدقيق", getString("q"))
            assertTrue(getBoolean("overdue"))
            assertEquals("2026-08-01", getString("from"))
            assertEquals("2026-08-06", getString("to"))
            assertEquals(40, getInt("limit"))
        }
    }

    @Test
    fun directTaskLookupFailsClosedWhenReturnedBranchDiffers() = runBlocking {
        val api = FakeCollaborationApi().apply {
            objectResponses["tasks.get"] = taskJson(branchId = 9)
        }
        val failure = runCatching { CollaborationRepository(api).task(42, expectedBranchId = 7) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertEquals("tasks.get", api.calls.single().procedure)
    }

    @Test
    fun supportResolutionRequiresNoteAndUsesExactLifecycleProcedure() = runBlocking {
        val api = FakeCollaborationApi().apply {
            objectResponses["tasks.resolve"] = JSONObject().put("taskId", 42)
        }
        val repository = CollaborationRepository(api)
        val detail = detail(status = TaskStatus.IN_PROGRESS, kind = TaskKind.SUPPORT, assignedTo = 7)
        val user = employee(userId = 7)

        val failure = runCatching {
            repository.taskAction(detail, user, TaskAction.RESOLVE, note = null)
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertTrue(api.calls.isEmpty())

        repository.taskAction(detail, user, TaskAction.RESOLVE, note = "  تمت المعالجة  ")
        assertEquals("tasks.resolve", api.calls.single().procedure)
        assertEquals("تمت المعالجة", api.calls.single().input?.getString("resolutionNote"))
    }

    @Test
    fun managerBroadcastReadsUseIntentionalGlobalScopeButWritesStayOwnBranch() = runBlocking {
        val api = FakeCollaborationApi().apply {
            arrayResponses["broadcasts.list"] = JSONArray().put(broadcastJson(id = 5, branchId = 9))
            objectResponses["broadcasts.get"] = broadcastJson(id = 5, branchId = 9).put("recipientCounts", JSONObject())
        }
        val manager = employee(role = "manager", campaigns = CollaborationAccess.FULL)
        val repository = CollaborationRepository(api)
        assertEquals(9L, repository.broadcasts(manager).single().branchId)
        assertEquals(9L, repository.broadcast(5, manager).summary.branchId)
        assertEquals(listOf("broadcasts.list", "broadcasts.get"), api.calls.map { it.procedure })
    }

    @Test
    fun adminBroadcastCreationForcesOptInAndMapsTemplateVariables() = runBlocking {
        val api = FakeCollaborationApi().apply {
            objectResponses["broadcasts.preview"] = JSONObject().put("audienceCount", 12).put("costEstimate", "0.60")
            objectResponses["broadcasts.create"] = JSONObject().put("broadcastId", 88)
        }
        val draft = CreateBroadcastDraft(
            name = "  تذكير الرصيد  ",
            branchId = 7,
            templateId = 3,
            templateVariableCount = 2,
            variables = mapOf("1" to "name", "2" to "currentBalance"),
            segment = BroadcastSegment(branchId = 7),
            throttlePerMinute = 25,
        )
        val repository = CollaborationRepository(api)
        repository.previewBroadcast(draft, admin())
        val id = repository.createBroadcast(draft, admin())

        assertEquals(88L, id)
        assertEquals(listOf("broadcasts.preview", "broadcasts.create"), api.calls.map { it.procedure })
        val create = requireNotNull(api.calls.last().input)
        assertEquals("تذكير الرصيد", create.getString("name"))
        assertEquals(7L, create.getLong("branchId"))
        assertTrue(create.getJSONObject("segment").getBoolean("requireOptIn"))
        assertEquals(7L, create.getJSONObject("segment").getLong("branchId"))
        assertEquals("name", create.getJSONObject("varsMapJson").getString("1"))
        assertEquals("currentBalance", create.getJSONObject("varsMapJson").getString("2"))
    }

    private fun admin() = CollaborationCapabilities(
        userId = 1,
        role = "admin",
        branchId = null,
        allBranches = true,
        tasks = CollaborationAccess.FULL,
        campaigns = CollaborationAccess.FULL,
    )

    private fun employee(
        userId: Long = 7,
        role: String = "cashier",
        campaigns: CollaborationAccess = CollaborationAccess.NONE,
    ) = CollaborationCapabilities(
        userId = userId,
        role = role,
        branchId = 7,
        allBranches = role == "manager",
        tasks = CollaborationAccess.FULL,
        campaigns = campaigns,
    )

    private fun detail(
        status: TaskStatus,
        kind: TaskKind,
        assignedTo: Long?,
    ) = TeamTaskDetail(
        summary = TeamTaskSummary(
            id = 42,
            taskNumber = "TSK-42",
            branchId = 7,
            kind = kind,
            status = status,
            priority = TaskPriority.NORMAL,
            title = "دعم",
            customerId = null,
            customerName = null,
            supplierId = null,
            supplierName = null,
            assignedTo = assignedTo,
            assigneeName = null,
            createdBy = 9,
            conversationId = null,
            dueAt = null,
            effectiveDueAt = null,
            isOverdue = false,
            createdAt = null,
        ),
        description = null,
        linkedWorkOrderId = null,
        linkedInvoiceId = null,
        linkedQuotationId = null,
        serviceTypeId = null,
        sourceChannel = null,
        firstResponseAt = null,
        resolvedAt = null,
        resolutionNote = null,
        reopenCount = 0,
        csatScore = null,
        updatedAt = null,
        events = emptyList(),
    )

    private fun taskJson(branchId: Long) = JSONObject()
        .put("id", 42)
        .put("taskNumber", "TSK-42")
        .put("branchId", branchId)
        .put("taskKind", "INTERNAL")
        .put("taskStatus", "NEW")
        .put("priority", "NORMAL")
        .put("title", "مهمة")
        .put("events", JSONArray())

    private fun broadcastJson(id: Long, branchId: Long) = JSONObject()
        .put("id", id)
        .put("name", "بث")
        .put("branchId", branchId)
        .put("templateId", 3)
        .put("broadcastStatus", "DRAFT")
        .put("audienceCount", 5)
        .put("costEstimate", "0.50")
        .put("throttlePerMinute", 10)
}

private data class CollaborationApiCall(val procedure: String, val input: JSONObject?)

private class FakeCollaborationApi : CollaborationApi {
    val calls = mutableListOf<CollaborationApiCall>()
    val objectResponses = mutableMapOf<String, JSONObject>()
    val arrayResponses = mutableMapOf<String, JSONArray>()

    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject {
        calls += CollaborationApiCall(procedure, input)
        return objectResponses[procedure] ?: error("No object response for $procedure")
    }

    override suspend fun queryArray(procedure: String, input: JSONObject?): JSONArray {
        calls += CollaborationApiCall(procedure, input)
        return arrayResponses[procedure] ?: error("No array response for $procedure")
    }

    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject {
        calls += CollaborationApiCall(procedure, input)
        return objectResponses[procedure] ?: error("No mutation response for $procedure")
    }
}

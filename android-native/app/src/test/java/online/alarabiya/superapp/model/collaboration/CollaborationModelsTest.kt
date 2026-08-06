package online.alarabiya.superapp.model.collaboration

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class CollaborationModelsTest {
    @Test
    fun employeeTaskActionsFollowAssignmentAndLifecycleContract() {
        val capabilities = capabilities(role = "cashier", userId = 7)
        val unassigned = detail(status = TaskStatus.NEW, assignedTo = null, createdBy = 11)
        val unassignedActions = TaskActionPolicy.allowed(unassigned, capabilities)
        assertTrue(TaskAction.CLAIM in unassignedActions)
        assertFalse(TaskAction.COMMENT in unassignedActions)
        assertFalse(TaskAction.ASSIGN in unassignedActions)

        val assigned = detail(status = TaskStatus.IN_PROGRESS, assignedTo = 7, createdBy = 11)
        val assignedActions = TaskActionPolicy.allowed(assigned, capabilities)
        assertTrue(TaskAction.WAIT in assignedActions)
        assertTrue(TaskAction.RESOLVE in assignedActions)
        assertTrue(TaskAction.COMMENT in assignedActions)
        assertFalse(TaskAction.CANCEL in assignedActions)
    }

    @Test
    fun managerReopenAndBroadcastFourEyesRulesMatchServerLifecycle() {
        val manager = capabilities(role = "manager", userId = 8, campaigns = CollaborationAccess.FULL)
        val recent = detail(
            status = TaskStatus.RESOLVED,
            assignedTo = 7,
            createdBy = 7,
            resolvedAt = "2026-08-05T09:00:00Z",
        )
        assertTrue(TaskAction.REOPEN in TaskActionPolicy.allowed(recent, manager, Instant.parse("2026-08-06T09:00:00Z")))
        assertFalse(TaskAction.REOPEN in TaskActionPolicy.allowed(recent, manager, Instant.parse("2026-08-13T09:00:01Z")))

        val ownPending = broadcast(status = BroadcastStatus.PENDING_APPROVAL, createdBy = 8)
        val otherPending = broadcast(status = BroadcastStatus.PENDING_APPROVAL, createdBy = 9)
        assertFalse(BroadcastAction.APPROVE in BroadcastActionPolicy.allowed(ownPending, manager))
        assertTrue(BroadcastAction.APPROVE in BroadcastActionPolicy.allowed(otherPending, manager))
        assertTrue(manager.canReadBroadcastsSafely)
        assertTrue(BroadcastActionPolicy.allowed(broadcast(status = BroadcastStatus.DRAFT, createdBy = 9).copy(branchId = 2), manager).isEmpty())
    }

    @Test
    fun validationAcceptsServerTaskDateFormatsAndRequiresTemplateMappings() {
        val admin = capabilities(role = "admin", campaigns = CollaborationAccess.FULL)
        assertNull(
            CollaborationValidation.task(
                CreateTaskDraft(branchId = 1, title = "مراجعة الطلب", dueAt = "2026-08-12"),
                admin,
            ),
        )
        assertNull(
            CollaborationValidation.task(
                CreateTaskDraft(branchId = 1, title = "مراجعة الطلب", dueAt = "2026-08-12T10:30:00Z"),
                admin,
            ),
        )

        val incomplete = CreateBroadcastDraft(
            name = "تذكير العملاء",
            templateId = 4,
            templateVariableCount = 2,
            variables = mapOf("1" to "name"),
        )
        assertTrue(CollaborationValidation.broadcast(incomplete, admin)?.contains("متغيرات") == true)
        assertNull(
            CollaborationValidation.broadcast(
                incomplete.copy(variables = mapOf("1" to "name", "2" to "currentBalance")),
                admin,
            ),
        )
    }

    private fun capabilities(
        role: String,
        userId: Long = 1,
        campaigns: CollaborationAccess = CollaborationAccess.NONE,
    ) = CollaborationCapabilities(
        userId = userId,
        role = role,
        branchId = 1,
        allBranches = role == "admin" || role == "manager",
        tasks = CollaborationAccess.FULL,
        campaigns = campaigns,
    )

    private fun detail(
        status: TaskStatus,
        assignedTo: Long?,
        createdBy: Long?,
        resolvedAt: String? = null,
    ) = TeamTaskDetail(
        summary = TeamTaskSummary(
            id = 42,
            taskNumber = "TSK-42",
            branchId = 1,
            kind = TaskKind.SUPPORT,
            status = status,
            priority = TaskPriority.NORMAL,
            title = "مهمة",
            customerId = null,
            customerName = null,
            supplierId = null,
            supplierName = null,
            assignedTo = assignedTo,
            assigneeName = null,
            createdBy = createdBy,
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
        resolvedAt = resolvedAt,
        resolutionNote = null,
        reopenCount = 0,
        csatScore = null,
        updatedAt = null,
        events = emptyList(),
    )

    private fun broadcast(status: BroadcastStatus, createdBy: Long?) = WhatsappBroadcastSummary(
        id = 5,
        name = "بث",
        branchId = 1,
        crmCampaignId = null,
        templateId = 2,
        status = status,
        audienceCount = 10,
        costEstimate = "1.00",
        throttlePerMinute = 10,
        scheduledAt = null,
        startedAt = null,
        completedAt = null,
        pausedReason = null,
        createdBy = createdBy,
        approvedBy = null,
        createdAt = null,
    )
}

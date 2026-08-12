package online.alarabiya.superapp.feature.selfservice

import online.alarabiya.superapp.model.selfservice.LeaveRequestIssue
import online.alarabiya.superapp.model.selfservice.NativeSelfServiceBlockers
import online.alarabiya.superapp.model.selfservice.PersonalLeaveRequest
import online.alarabiya.superapp.model.selfservice.PersonalTask
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.SelfServiceCapabilities
import online.alarabiya.superapp.model.selfservice.SelfServicePolicies
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfServicePoliciesAndStateTest {
    @Test
    fun attendanceStaysPhysicalOnlyWhilePersonalPayrollHistoryIsAvailable() {
        val fullTasks = SelfServiceCapabilities.fromTasksAccess("FULL")

        assertTrue(fullTasks.canUpdateTasks)
        assertTrue(SelfServiceCapabilities.fromTasksAccess("full").canUpdateTasks)
        assertFalse(fullTasks.canWriteAttendance)
        assertTrue(fullTasks.payrollHistoryAvailable)
        assertTrue(fullTasks.payslipDetailAvailable)
        assertFalse(fullTasks.payslipDocumentAvailable)
        assertTrue(NativeSelfServiceBlockers.PAYSLIP_DOCUMENT.contains("PDF"))
    }

    @Test
    fun taskTransitionsOnlyExposeServerSupportedActions() {
        val fresh = task(status = "NEW")
        val active = task(status = "IN_PROGRESS")
        val waiting = task(status = "WAITING_CUSTOMER")
        val resolved = task(status = "RESOLVED")

        assertEquals(setOf(PersonalTaskAction.Claim), fresh.availableActions(canUpdate = true))
        assertEquals(
            setOf(PersonalTaskAction.Wait, PersonalTaskAction.Resolve, PersonalTaskAction.Comment),
            active.availableActions(canUpdate = true),
        )
        assertEquals(
            setOf(PersonalTaskAction.Resume, PersonalTaskAction.Resolve, PersonalTaskAction.Comment),
            waiting.availableActions(canUpdate = true),
        )
        assertEquals(emptySet<PersonalTaskAction>(), resolved.availableActions(canUpdate = true))
        assertEquals(emptySet<PersonalTaskAction>(), active.availableActions(canUpdate = false))
    }

    @Test
    fun leaveRequestValidationMatchesSelfServiceContract() {
        assertEquals(
            LeaveRequestIssue.MissingType,
            SelfServicePolicies.validateLeaveRequest("", "2026-08-10", "2026-08-11"),
        )
        assertEquals(
            LeaveRequestIssue.InvalidDate,
            SelfServicePolicies.validateLeaveRequest("سنوية", "10/08/2026", "2026-08-11"),
        )
        assertEquals(
            LeaveRequestIssue.InvalidDate,
            SelfServicePolicies.validateLeaveRequest("سنوية", "2026-02-30", "2026-03-01"),
        )
        assertEquals(
            LeaveRequestIssue.EndBeforeStart,
            SelfServicePolicies.validateLeaveRequest("سنوية", "2026-08-12", "2026-08-11"),
        )
        assertNull(SelfServicePolicies.validateLeaveRequest("سنوية", "2026-08-10", "2026-08-14"))
    }

    @Test
    fun onlyPendingPersonalLeaveCanBeWithdrawn() {
        assertTrue(leave(status = "pending").canWithdraw)
        assertTrue(leave(status = "PENDING").canWithdraw)
        assertFalse(leave(status = "approved").canWithdraw)
        assertFalse(leave(status = "rejected").canWithdraw)
    }

    @Test
    fun stateReducerClearsTransientMessagesAndKeepsSelectedSectionOnFailure() {
        val initial = SelfServiceUiState(
            section = SelfServiceSection.Leaves,
            message = "قديم",
            error = "خطأ قديم",
        )

        val refreshing = SelfServiceStateReducer.refreshing(initial)
        assertTrue(refreshing.loading)
        assertNull(refreshing.message)
        assertNull(refreshing.error)

        val failed = SelfServiceStateReducer.refreshFailed(refreshing, "تعذر التحديث")
        assertFalse(failed.loading)
        assertEquals(SelfServiceSection.Leaves, failed.section)
        assertEquals("تعذر التحديث", failed.error)

        val busy = SelfServiceStateReducer.operationStarted(failed, "leave:1")
        assertEquals("leave:1", busy.busyKey)
        assertNull(busy.error)

        val operationFailed = SelfServiceStateReducer.operationFailed(busy, "تعذر السحب")
        assertNull(operationFailed.busyKey)
        assertEquals(SelfServiceSection.Leaves, operationFailed.section)
        assertEquals("تعذر السحب", operationFailed.error)
    }

    private fun task(status: String) = PersonalTask(
        id = 1,
        number = "TSK-1",
        title = "مهمة",
        priority = "NORMAL",
        status = status,
        dueAt = null,
    )

    private fun leave(status: String) = PersonalLeaveRequest(
        id = 1,
        leaveType = "سنوية",
        fromDate = "2026-08-10",
        toDate = "2026-08-11",
        days = "2",
        status = status,
        reason = null,
        requestedAt = null,
        decidedAt = null,
    )
}

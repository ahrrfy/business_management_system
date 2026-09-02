package online.alarabiya.superapp.feature.selfservice

import online.alarabiya.superapp.model.selfservice.PersonalTask
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.NotificationFamily
import online.alarabiya.superapp.model.selfservice.SelfServiceCapabilities
import online.alarabiya.superapp.model.selfservice.SelfServiceMappers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfServiceMappersTest {
    @Test
    fun workspaceMapsPhysicalAttendancePayrollTasksAndLeaves() {
        val workspace = SelfServiceMappers.workspace(
            mapOf(
                "date" to "2026-08-06",
                "employee" to mapOf(
                    "id" to 3,
                    "name" to "أحمد المنصور",
                    "position" to "محاسب",
                    "department" to "المالية",
                    "branchId" to 2,
                    "employmentStatus" to "active",
                    "email" to "ahmed@example.test",
                    "phone" to "07700000000",
                    "hireDate" to "2024-01-10",
                    "payType" to "monthly",
                    "baseSalary" to "1200000",
                    "allowances" to "100000",
                    "annualLeaveBalance" to "12.5",
                    "sickLeaveBalance" to 4,
                ),
                "attendance" to mapOf(
                    "date" to "2026-08-06",
                    "checkIn" to "2026-08-06T08:15:00.000Z",
                    "checkOut" to null,
                    "status" to "PRESENT",
                    "hours" to "0",
                    "source" to "fingerprint",
                    "needsReview" to false,
                    "readOnly" to true,
                ),
                "attendanceHistory" to listOf(
                    mapOf(
                        "id" to 17,
                        "date" to "2026-08-06",
                        "checkIn" to "2026-08-06T08:15:00.000Z",
                        "checkOut" to null,
                        "status" to "PRESENT",
                        "hours" to "0",
                        "source" to "fingerprint",
                        "needsReview" to true,
                    ),
                ),
                "latestPayroll" to mapOf(
                    "itemId" to 18,
                    "runId" to 8,
                    "period" to "2026-07",
                    "status" to "paid",
                    "gross" to "1250000.00",
                    "allowances" to "100000.00",
                    "overtime" to 50000,
                    "commission" to "25000",
                    "deductions" to "75000",
                    "net" to "1350000",
                ),
                "tasks" to listOf(
                    mapOf(
                        "id" to 21,
                        "taskNumber" to "TSK-21",
                        "title" to "متابعة طلب العميل",
                        "priority" to "HIGH",
                        "status" to "IN_PROGRESS",
                        "dueAt" to null,
                    ),
                ),
                "leaveRequests" to listOf(
                    mapOf(
                        "id" to 4,
                        "leaveType" to "سنوية",
                        "fromDate" to "2026-08-10",
                        "toDate" to "2026-08-11",
                        "days" to 2,
                        "status" to "pending",
                        "reason" to "سفر",
                    ),
                ),
            ),
        )

        assertEquals("2026-08-06", workspace.date)
        assertEquals("أحمد المنصور", workspace.employee?.name)
        assertEquals("المالية", workspace.employee?.department)
        assertEquals("1200000", workspace.employee?.baseSalary)
        assertEquals(2L, workspace.employee?.branchId)
        assertTrue(workspace.todayAttendance?.readOnly == true)
        assertEquals("fingerprint", workspace.todayAttendance?.source)
        assertEquals(1, workspace.attendanceHistory.size)
        assertTrue(workspace.attendanceHistory.single().readOnly)
        assertEquals("fingerprint", workspace.attendanceHistory.single().source)
        assertNull(workspace.attendanceHistory.single().checkOut)
        assertEquals("2026-07", workspace.payroll?.period)
        assertEquals(18L, workspace.payroll?.itemId)
        assertEquals("1350000", workspace.payroll?.net)
        assertEquals("TSK-21", workspace.tasks.single().number)
        assertTrue(workspace.leaveRequests.single().canWithdraw)
        assertEquals("12.5", workspace.leaveBalances?.annual)
        assertEquals("4", workspace.leaveBalances?.sick)
    }

    @Test
    fun personalPayrollHistoryAndStructuredPayslipMapWithoutEmployeeIdentifier() {
        val history = SelfServiceMappers.payrollHistory(
            listOf(
                mapOf(
                    "itemId" to 41,
                    "runId" to 12,
                    "period" to "2026-07",
                    "status" to "paid",
                    "gross" to "1500000.00",
                    "deductions" to "150000.00",
                    "net" to "1350000.00",
                ),
            ),
        )
        val payslip = SelfServiceMappers.payslip(
            mapOf(
                "itemId" to 41,
                "runId" to 12,
                "period" to "2026-07",
                "status" to "paid",
                "payType" to "monthly",
                "gross" to "1500000.00",
                "allowances" to "100000.00",
                "advanceDeduction" to "50000.00",
                "socialSecurityEmployee" to "75000.00",
                "incomeTax" to "25000.00",
                "deductions" to "150000.00",
                "net" to "1350000.00",
            ),
        )

        assertEquals(41L, history.single().itemId)
        assertEquals("1350000.00", history.single().net)
        assertEquals("50000.00", payslip.advanceDeduction)
        assertEquals("75000.00", payslip.socialSecurityEmployee)
        assertEquals("1350000.00", payslip.net)
    }

    @Test
    fun persistedNotificationsAndPreferencesMapWithoutWebRoutes() {
        val center = SelfServiceMappers.notifications(
            mapOf(
                "unreadCount" to 1,
                "rows" to listOf(
                    mapOf(
                        "id" to 9,
                        "kind" to "ATTENDANCE",
                        "family" to "ADMIN",
                        "title" to "تم تسجيل الدخول",
                        "body" to "تمت مزامنة بصمة دخولك",
                        "route" to "/mobile#attendance",
                        "createdAt" to "2026-08-06T05:15:00.000Z",
                        "readAt" to null,
                        "requiresAction" to false,
                        "entityType" to "attendance",
                        "entityId" to 17,
                    ),
                ),
            ),
        )
        val preferences = SelfServiceMappers.notificationPreferences(
            mapOf(
                "taskAssigned" to true,
                "payrollReady" to true,
                "attendance" to true,
                "leaveStatus" to false,
                "approvals" to true,
                "quietHoursStart" to "22:00",
                "quietHoursEnd" to "07:00",
            ),
        )

        assertEquals(1, center.unreadCount)
        assertTrue(center.rows.single().isUnread)
        assertEquals("attendance", center.rows.single().entityType)
        assertEquals(NotificationFamily.ADMIN, center.rows.single().family)
        assertEquals("/mobile#attendance", center.rows.single().route)
        assertFalse(preferences.leaveStatus)
        assertEquals("22:00", preferences.quietHoursStart)
    }

    @Test
    fun taskActionsRespectStatusAndModuleAccess() {
        val task = PersonalTask(1, "TSK-1", "مهمة", "NORMAL", "IN_PROGRESS", null)

        assertEquals(emptySet<PersonalTaskAction>(), task.availableActions(canUpdate = false))
        assertEquals(
            setOf(PersonalTaskAction.Wait, PersonalTaskAction.Resolve, PersonalTaskAction.Comment),
            task.availableActions(canUpdate = true),
        )
        assertTrue(SelfServiceCapabilities.fromTasksAccess("FULL").canUpdateTasks)
        val readOnly = SelfServiceCapabilities.fromTasksAccess("READ")
        assertFalse(readOnly.canUpdateTasks)
        assertFalse(readOnly.canWriteAttendance)
        assertTrue(readOnly.payrollHistoryAvailable)
        assertTrue(readOnly.payslipDetailAvailable)
        assertFalse(readOnly.payslipDocumentAvailable)
    }
}

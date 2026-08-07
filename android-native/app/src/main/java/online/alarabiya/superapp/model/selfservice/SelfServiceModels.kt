package online.alarabiya.superapp.model.selfservice

import java.time.LocalDate

data class PersonalEmployeeProfile(
    val id: Long,
    val name: String,
    val position: String?,
    val department: String?,
    val branchId: Long?,
    val photoUrl: String?,
    val employmentStatus: String?,
    val email: String?,
    val phone: String?,
    val hireDate: String?,
    val payType: String?,
    val baseSalary: String?,
    val allowances: String?,
)

data class AttendanceEntry(
    val id: Long,
    val date: String,
    val checkIn: String?,
    val checkOut: String?,
    val status: String?,
    val hours: String?,
    val source: String?,
    val needsReview: Boolean,
) {
    /** Attendance is owned by the physical-device integration and is never writable here. */
    val readOnly: Boolean = true
}

data class PersonalPayroll(
    val itemId: Long,
    val runId: Long,
    val period: String,
    val status: String,
    val paidAt: String?,
    val gross: String,
    val allowances: String,
    val overtime: String,
    val commission: String,
    val deductions: String,
    val net: String,
)

data class PersonalPayslip(
    val itemId: Long,
    val runId: Long,
    val period: String,
    val status: String,
    val paidAt: String?,
    val payType: String,
    val hours: String?,
    val gross: String,
    val allowances: String,
    val overtime: String,
    val commission: String,
    val deductions: String,
    val advanceDeduction: String,
    val socialSecurityEmployee: String,
    val incomeTax: String,
    val net: String,
    val note: String?,
    val createdAt: String?,
)

enum class PersonalTaskAction {
    Claim,
    Wait,
    Resume,
    Resolve,
    Comment,
}

data class PersonalTask(
    val id: Long,
    val number: String,
    val title: String,
    val priority: String,
    val status: String,
    val dueAt: String?,
) {
    fun availableActions(canUpdate: Boolean): Set<PersonalTaskAction> {
        if (!canUpdate) return emptySet()
        return buildSet {
            when (status) {
                "NEW" -> add(PersonalTaskAction.Claim)
                "IN_PROGRESS" -> {
                    add(PersonalTaskAction.Wait)
                    add(PersonalTaskAction.Resolve)
                    add(PersonalTaskAction.Comment)
                }
                "WAITING_CUSTOMER" -> {
                    add(PersonalTaskAction.Resume)
                    add(PersonalTaskAction.Resolve)
                    add(PersonalTaskAction.Comment)
                }
            }
        }
    }
}

data class PersonalLeaveRequest(
    val id: Long,
    val leaveType: String,
    val fromDate: String,
    val toDate: String,
    val days: String,
    val status: String,
    val reason: String?,
    val requestedAt: String?,
    val decidedAt: String?,
) {
    val canWithdraw: Boolean get() = status.equals("pending", ignoreCase = true)
}

data class LeaveBalances(
    val annual: String,
    val sick: String,
)

data class SelfServiceWorkspace(
    val date: String,
    val employee: PersonalEmployeeProfile?,
    val todayAttendance: AttendanceEntry?,
    val attendanceHistory: List<AttendanceEntry>,
    val payroll: PersonalPayroll?,
    val tasks: List<PersonalTask>,
    val leaveRequests: List<PersonalLeaveRequest>,
    val leaveBalances: LeaveBalances?,
)

data class PersonalNotification(
    val id: Long,
    val kind: String,
    val title: String,
    val body: String,
    val createdAt: String?,
    val readAt: String?,
    val requiresAction: Boolean,
    val entityType: String?,
    val entityId: Long?,
) {
    val isUnread: Boolean get() = readAt == null
}

data class NotificationCenter(
    val rows: List<PersonalNotification>,
    val unreadCount: Int,
)

data class NotificationPreferences(
    val taskAssigned: Boolean,
    val payrollReady: Boolean,
    val attendance: Boolean,
    val leaveStatus: Boolean,
    val approvals: Boolean,
    val quietHoursStart: String?,
    val quietHoursEnd: String?,
)

data class SelfServiceSnapshot(
    val workspace: SelfServiceWorkspace,
    val notifications: NotificationCenter,
    val notificationPreferences: NotificationPreferences,
    val payrollHistory: List<PersonalPayroll> = emptyList(),
)

data class SelfServiceCapabilities(
    val canUpdateTasks: Boolean,
    val canWriteAttendance: Boolean = false,
    val payrollHistoryAvailable: Boolean = true,
    val payslipDetailAvailable: Boolean = true,
    val payslipDocumentAvailable: Boolean = false,
) {
    companion object {
        fun fromTasksAccess(access: String?): SelfServiceCapabilities =
            SelfServiceCapabilities(canUpdateTasks = access.equals("FULL", ignoreCase = true))
    }
}

enum class LeaveRequestIssue(val userMessage: String) {
    MissingType("اختر نوع الإجازة"),
    InvalidDate("صيغة التاريخ المطلوبة YYYY-MM-DD"),
    EndBeforeStart("تاريخ نهاية الإجازة يسبق تاريخ بدايتها"),
}

object SelfServicePolicies {
    private val date = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun validateLeaveRequest(leaveType: String, fromDate: String, toDate: String): LeaveRequestIssue? {
        val from = parseDate(fromDate)
        val to = parseDate(toDate)
        return when {
            leaveType.isBlank() -> LeaveRequestIssue.MissingType
            from == null || to == null -> LeaveRequestIssue.InvalidDate
            from > to -> LeaveRequestIssue.EndBeforeStart
            else -> null
        }
    }

    private fun parseDate(value: String): LocalDate? {
        if (!date.matches(value)) return null
        return runCatching { LocalDate.parse(value) }.getOrNull()
    }
}

/**
 * Explicit gaps in the current server/native contract. They are deliberately not represented as
 * successful UI states.
 */
object NativeSelfServiceBlockers {
    const val PAYSLIP_DOCUMENT =
        "The personal API returns an owned structured payslip; no server-generated PDF document exists and the native client must not advertise one."
}

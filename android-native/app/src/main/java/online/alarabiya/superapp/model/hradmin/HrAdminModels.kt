package online.alarabiya.superapp.model.hradmin

import online.alarabiya.superapp.model.AppBootstrap
import java.time.LocalDate

enum class HrAccess {
    NONE,
    READ,
    FULL;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL

    companion object {
        fun wire(value: String?): HrAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

/**
 * HR reads and writes follow the server's authoritative branch policy: admin/manager keep the
 * established company-wide scope, while custom roles are constrained to their session branch.
 */
data class HrAdminCapabilities(
    val access: HrAccess,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
    val currentUserId: Long,
) {
    val hasGlobalHrScope: Boolean get() = role.lowercase() in setOf("admin", "manager")
    val canReadEmployees: Boolean
        get() = access.canRead && (branchId != null || hasGlobalHrScope)
    val canManageEmployees: Boolean
        get() = access.canWrite && (branchId != null || hasGlobalHrScope)
    val canReadCompanyHr: Boolean get() = access.canRead && hasGlobalHrScope
    val canManageCompanyHr: Boolean get() = access.canWrite && hasGlobalHrScope

    fun acceptsEmployee(employee: HrEmployee): Boolean = canReadEmployees && when {
        hasGlobalHrScope -> true
        branchId != null -> employee.branchId == branchId
        else -> false
    }

    fun canTerminate(employee: HrEmployee): Boolean =
        canManageEmployees &&
            acceptsEmployee(employee) &&
            employee.employmentStatus != EmploymentStatus.TERMINATED &&
            employee.userId != currentUserId

    companion object {
        fun fromBootstrap(value: AppBootstrap): HrAdminCapabilities = HrAdminCapabilities(
            access = HrAccess.wire(value.modules.firstOrNull { it.key == "hr" }?.access),
            role = value.user.role,
            branchId = value.branchId,
            allBranches = value.allBranches,
            currentUserId = value.user.id,
        )
    }
}

enum class HrAdminSection { EMPLOYEES, PAYROLL, LEAVES, RECRUITMENT }

enum class EmploymentStatus(val wire: String) {
    ACTIVE("active"),
    LEAVE("leave"),
    TERMINATED("terminated");

    companion object {
        fun fromWire(value: String?): EmploymentStatus =
            entries.firstOrNull { it.wire == value } ?: ACTIVE
    }
}

data class HrEmployee(
    val id: Long,
    val userId: Long?,
    val branchId: Long?,
    val branchName: String?,
    val fullName: String,
    val position: String?,
    val department: String?,
    val phone: String?,
    val email: String?,
    val payType: String,
    val salary: String?,
    val allowances: String?,
    val employmentStatus: EmploymentStatus,
    val isActive: Boolean,
    val attendanceExempt: Boolean,
    val deviceLinked: Boolean,
    val hireDate: String?,
    val annualLeaveBalance: Int,
    val sickLeaveBalance: Int,
)

enum class EmployeeTerminationIssue(val userMessage: String) {
    InvalidDate("تاريخ إنهاء الخدمة مطلوب بصيغة YYYY-MM-DD"),
    MissingReason("سبب إنهاء الخدمة مطلوب"),
    ShortReason("سبب إنهاء الخدمة يجب أن يكون واضحاً (3 أحرف على الأقل)"),
}

object HrAdminPolicies {
    private val date = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun terminationIssue(dateValue: String, reason: String): EmployeeTerminationIssue? {
        val parsedDate = if (date.matches(dateValue)) runCatching { LocalDate.parse(dateValue) }.getOrNull() else null
        return when {
            parsedDate == null -> EmployeeTerminationIssue.InvalidDate
            reason.isBlank() -> EmployeeTerminationIssue.MissingReason
            reason.trim().length < 3 -> EmployeeTerminationIssue.ShortReason
            else -> null
        }
    }
}

data class HrEmployeePage(val rows: List<HrEmployee>, val total: Int)

enum class PayrollStatus(val wire: String) {
    DRAFT("draft"),
    APPROVED("approved"),
    PAID("paid");

    companion object {
        fun fromWire(value: String?): PayrollStatus =
            entries.firstOrNull { it.wire == value } ?: DRAFT
    }
}

data class PayrollRun(
    val id: Long,
    val period: String,
    val status: PayrollStatus,
    val employeeCount: Int,
    val totalGross: String,
    val totalOvertime: String,
    val totalCommission: String,
    val totalDeductions: String,
    val totalNet: String,
    val createdBy: Long?,
    val approvedBy: Long?,
    val paidBy: Long?,
    val approvedAt: String?,
    val paidAt: String?,
)

data class PayrollItem(
    val id: Long,
    val employeeId: Long,
    val employeeName: String,
    val position: String?,
    val department: String?,
    val gross: String,
    val overtime: String,
    val commission: String,
    val deductions: String,
    val net: String,
)

data class PayrollRunDetail(val run: PayrollRun, val items: List<PayrollItem>)

enum class LeaveStatus(val wire: String) {
    PENDING("pending"),
    APPROVED("approved"),
    REJECTED("rejected");

    companion object {
        fun fromWire(value: String?): LeaveStatus =
            entries.firstOrNull { it.wire == value } ?: PENDING
    }
}

data class LeaveRequest(
    val id: Long,
    val employeeId: Long,
    val employeeName: String,
    val department: String?,
    val leaveType: String,
    val paid: Boolean,
    val fromDate: String,
    val toDate: String,
    val days: Int,
    val status: LeaveStatus,
    val reason: String?,
    val requestedAt: String?,
)

data class LeaveCounts(val pending: Int, val approved: Int, val monthDays: Int)
data class LeavePage(
    val rows: List<LeaveRequest>,
    val total: Int,
    val hasMore: Boolean,
    val counts: LeaveCounts,
)

enum class ApplicantStage(val wire: String) {
    NEW("new"),
    REVIEW("review"),
    INTERVIEW("interview"),
    ACCEPTED("accepted"),
    REJECTED("rejected"),
    ARCHIVED("archived");

    companion object {
        fun fromWire(value: String?): ApplicantStage =
            entries.firstOrNull { it.wire == value } ?: NEW
    }
}

data class JobApplicant(
    val id: Long,
    val name: String,
    val jobTitle: String?,
    val vacancyId: Long?,
    val source: String,
    val stage: ApplicantStage,
    val appliedDate: String?,
    val phone: String?,
    val email: String?,
    val experience: String?,
    val education: String?,
    val rating: Int,
    val notes: String?,
)

data class JobVacancy(
    val id: Long,
    val title: String,
    val department: String?,
    val employmentType: String,
    val location: String?,
    val branchId: Long?,
    val summary: String?,
    val openings: Int,
    val isPublished: Boolean,
)

object HrAdminContractGaps {
    const val PAYROLL_BRANCH_SCOPE =
        "payroll.list/get/summary are company-wide and accept no branch scope; native access is administrator-only."
    const val LEAVE_BRANCH_SCOPE =
        "leaves.list/balances/decide accept no actor branch; native administration is administrator-only."
    const val RECRUITMENT_BRANCH_SCOPE =
        "recruitment applicant/vacancy administration is not actor-branch scoped; native access is administrator-only."
    const val EMPLOYEE_IDOR =
        "employees.get/update/setStatus do not enforce actor branch. Native managers act only on rows returned by their branch-filtered list, but the server remains the required security boundary."
    const val PAYROLL_OPERATION_CAPABILITIES =
        "bootstrap exposes hr READ/FULL but no maker/checker/pay permission. Server separation-of-duties errors remain authoritative."
}

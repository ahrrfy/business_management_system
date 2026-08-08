package online.alarabiya.superapp.model

data class UserIdentity(
    val id: Long,
    val name: String,
    val username: String?,
    val email: String?,
    val role: String,
    val roleLabel: String = role,
    val mustChangePassword: Boolean = false,
    val mustEnrollTwoFactor: Boolean = false,
)

data class TwoFactorStatus(
    val enabled: Boolean,
    val pending: Boolean,
    val recoveryCodesRemaining: Int,
    val cryptoReady: Boolean,
)

data class TwoFactorSetup(
    val secretBase32: String,
    val otpauthUri: String,
)

object AuthPolicyCode {
    const val PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"
    const val TWO_FACTOR_ENROLLMENT_REQUIRED = "TWO_FACTOR_ENROLLMENT_REQUIRED"
}

object TwoFactorEnrollmentStep {
    const val PASSWORD = "password"
    const val SETUP = "setup"
    const val RECOVERY = "recovery"
}

data class ModuleAccess(
    val key: String,
    val label: String,
    val access: String,
)

data class AppBootstrap(
    val user: UserIdentity,
    val modules: List<ModuleAccess>,
    val branchId: Long?,
    val allBranches: Boolean,
    val hasPersonalWorkspace: Boolean = true,
)

data class TaskSummary(
    val id: Long,
    val number: String,
    val title: String,
    val priority: String,
    val status: String,
    val dueAt: String?,
)

data class NotificationSummary(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val createdAt: String,
    val requiresAction: Boolean,
)

data class AttendanceSummary(
    val date: String,
    val checkIn: String?,
    val checkOut: String?,
    val status: String?,
    val needsReview: Boolean,
)

data class PayrollSummary(
    val period: String,
    val status: String,
    val gross: String,
    val deductions: String,
    val net: String,
)

data class EmployeeSummary(
    val name: String,
    val position: String?,
    val department: String?,
    val email: String?,
    val phone: String?,
    val annualLeaveBalance: String,
    val sickLeaveBalance: String,
)

data class PersonalWorkspace(
    val date: String,
    val employee: EmployeeSummary?,
    val attendance: AttendanceSummary?,
    val tasks: List<TaskSummary>,
    val notifications: List<NotificationSummary>,
    val payroll: PayrollSummary?,
)

data class ModuleMetric(
    val key: String,
    val label: String,
    val value: Double,
    val format: String,
)

sealed interface LoginOutcome {
    data class Success(val user: UserIdentity) : LoginOutcome
    data class TwoFactorRequired(val ticket: String) : LoginOutcome
}

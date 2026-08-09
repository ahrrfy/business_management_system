package online.alarabiya.superapp.feature.hradmin

import online.alarabiya.superapp.model.hradmin.ApplicantStage
import online.alarabiya.superapp.model.hradmin.HrAdminSection
import online.alarabiya.superapp.model.hradmin.HrEmployee
import online.alarabiya.superapp.model.hradmin.HrEmployeePage
import online.alarabiya.superapp.model.hradmin.JobApplicant
import online.alarabiya.superapp.model.hradmin.JobVacancy
import online.alarabiya.superapp.model.hradmin.LeavePage
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollRun
import online.alarabiya.superapp.model.hradmin.PayrollRunDetail
import online.alarabiya.superapp.model.hradmin.AttendancePage
import online.alarabiya.superapp.model.hradmin.EmployeeAdvance
import online.alarabiya.superapp.model.hradmin.EmployeePromotion
import online.alarabiya.superapp.model.hradmin.FingerprintDevice
import online.alarabiya.superapp.model.hradmin.HrLinkableUser
import online.alarabiya.superapp.model.hradmin.PayrollLegalSettings

enum class HrAdminBusy {
    INITIAL,
    EMPLOYEES,
    EMPLOYEE_STATUS,
    PAYROLL,
    PAYROLL_ACTION,
    LEAVES,
    LEAVE_ACTION,
    RECRUITMENT,
    RECRUITMENT_ACTION,
    ATTENDANCE,
    DEVICES,
    ADVANCES,
    PROMOTIONS,
    EMPLOYEE_ACCOUNT,
    LEGAL_SETTINGS,
}

data class HrAdminUiState(
    val initialized: Boolean = false,
    val loadedSections: Set<HrAdminSection> = emptySet(),
    val staleSections: Set<HrAdminSection> = emptySet(),
    val section: HrAdminSection = HrAdminSection.EMPLOYEES,
    val busy: HrAdminBusy? = null,
    val error: String? = null,
    val notice: String? = null,
    val employeeQuery: String = "",
    val includeInactiveEmployees: Boolean = false,
    val employees: HrEmployeePage = HrEmployeePage(emptyList(), 0),
    val selectedEmployeeId: Long? = null,
    val payrollPeriod: String = "",
    val payrollRuns: List<PayrollRun> = emptyList(),
    val payrollDetail: PayrollRunDetail? = null,
    val leaveFilter: LeaveStatus? = LeaveStatus.PENDING,
    val leaves: LeavePage? = null,
    val applicantFilter: ApplicantStage? = null,
    val applicants: List<JobApplicant> = emptyList(),
    val vacancies: List<JobVacancy> = emptyList(),
    val attendancePeriod: String = java.time.YearMonth.now().toString(),
    val attendance: AttendancePage? = null,
    val devices: List<FingerprintDevice> = emptyList(),
    val advances: List<EmployeeAdvance> = emptyList(),
    val promotions: List<EmployeePromotion> = emptyList(),
    val linkableUsers: List<HrLinkableUser> = emptyList(),
    val accountEmployeeId: Long? = null,
    val legalSettings: PayrollLegalSettings? = null,
    val legalSettingsLoaded: Boolean = false,
) {
    val locked: Boolean get() = busy != null
    val selectedEmployee: HrEmployee?
        get() = employees.rows.firstOrNull { it.id == selectedEmployeeId }

    fun start(operation: HrAdminBusy): HrAdminUiState? =
        if (locked) null else copy(busy = operation, error = null, notice = null)

    fun failed(message: String, section: HrAdminSection? = null): HrAdminUiState = copy(
        busy = null,
        error = message,
        notice = null,
        staleSections = section?.let { staleSections + it } ?: staleSections,
    )

    fun sectionLoaded(section: HrAdminSection): HrAdminUiState = copy(
        initialized = true,
        busy = null,
        loadedSections = loadedSections + section,
        staleSections = staleSections - section,
        error = null,
    )

    fun isFresh(section: HrAdminSection): Boolean = section in loadedSections && section !in staleSections

    fun employeesLoaded(page: HrEmployeePage, append: Boolean): HrAdminUiState {
        val merged = if (append) (employees.rows + page.rows).distinctBy { it.id } else page.rows
        return copy(
            initialized = true,
            busy = null,
            employees = page.copy(rows = merged),
            selectedEmployeeId = selectedEmployeeId?.takeIf { id -> merged.any { it.id == id } },
            error = null,
        )
    }
}

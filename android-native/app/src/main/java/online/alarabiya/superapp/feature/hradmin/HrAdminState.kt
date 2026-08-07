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
}

data class HrAdminUiState(
    val initialized: Boolean = false,
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
) {
    val locked: Boolean get() = busy != null
    val selectedEmployee: HrEmployee?
        get() = employees.rows.firstOrNull { it.id == selectedEmployeeId }

    fun start(operation: HrAdminBusy): HrAdminUiState? =
        if (locked) null else copy(busy = operation, error = null, notice = null)

    fun failed(message: String): HrAdminUiState = copy(
        busy = null,
        initialized = true,
        error = message,
        notice = null,
    )

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

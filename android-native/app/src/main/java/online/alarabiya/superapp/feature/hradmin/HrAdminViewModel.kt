package online.alarabiya.superapp.feature.hradmin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.HrAdminDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.hradmin.ApplicantStage
import online.alarabiya.superapp.model.hradmin.EmploymentStatus
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.hradmin.HrAdminSection
import online.alarabiya.superapp.model.hradmin.JobApplicant
import online.alarabiya.superapp.model.hradmin.JobVacancy
import online.alarabiya.superapp.model.hradmin.LeaveRequest
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollStatus
import online.alarabiya.superapp.model.hradmin.CreateEmployeeAccountCommand
import online.alarabiya.superapp.model.hradmin.PayrollLegalSettings

class HrAdminViewModel(
    private val source: HrAdminDataSource,
    val capabilities: HrAdminCapabilities,
) : ViewModel() {
    var state by mutableStateOf(HrAdminUiState(section = firstSection(capabilities)))
        private set

    fun initialize() {
        if (state.initialized || state.locked) return
        loadSection(state.section, HrAdminBusy.INITIAL)
    }

    fun section(value: HrAdminSection) {
        if (!allowed(value)) return fail("هذه المساحة غير متاحة ضمن نطاق الجلسة")
        state = state.copy(section = value, error = null, notice = null)
        loadSection(value, when (value) {
            HrAdminSection.EMPLOYEES -> HrAdminBusy.EMPLOYEES
            HrAdminSection.PAYROLL -> HrAdminBusy.PAYROLL
            HrAdminSection.LEAVES -> HrAdminBusy.LEAVES
            HrAdminSection.RECRUITMENT -> HrAdminBusy.RECRUITMENT
            HrAdminSection.ATTENDANCE -> HrAdminBusy.ATTENDANCE
            HrAdminSection.DEVICES -> HrAdminBusy.DEVICES
            HrAdminSection.ADVANCES -> HrAdminBusy.ADVANCES
            HrAdminSection.PROMOTIONS -> HrAdminBusy.PROMOTIONS
        })
    }

    fun retry() {
        if (state.locked) return
        loadSection(state.section, busyFor(state.section))
    }

    fun attendancePeriod(value: String) {
        state = state.copy(attendancePeriod = value.filter { it.isDigit() || it == '-' }.take(7))
    }

    fun refreshAttendance() = loadAttendance()

    fun employeeQuery(value: String) {
        state = state.copy(employeeQuery = value.take(120))
    }

    fun includeInactiveEmployees(value: Boolean) {
        state = state.copy(includeInactiveEmployees = value)
        searchEmployees()
    }

    fun searchEmployees() = loadEmployees(append = false)

    fun moreEmployees() {
        if (state.employees.rows.size >= state.employees.total) return
        loadEmployees(append = true)
    }

    fun selectEmployee(id: Long?) {
        val safe = id?.takeIf { target -> state.employees.rows.any { it.id == target } }
        state = state.copy(selectedEmployeeId = safe, error = null, notice = null)
    }

    fun setEmployeeStatus(status: EmploymentStatus) {
        val employee = state.selectedEmployee ?: return
        if (!capabilities.canManageEmployees) return fail("صلاحية الموارد البشرية للقراءة فقط")
        launch(HrAdminBusy.EMPLOYEE_STATUS) {
            val updated = source.setEmployeeStatus(employee, status)
            state = state.copy(
                employees = state.employees.copy(
                    rows = state.employees.rows.map { if (it.id == updated.id) updated else it },
                ),
                notice = "تم تحديث حالة ${updated.fullName}",
            )
        }
    }

    fun terminateEmployee(terminationDate: String, terminationReason: String) {
        val employee = state.selectedEmployee ?: return
        if (!capabilities.canTerminate(employee)) {
            return fail(
                if (employee.userId == capabilities.currentUserId) {
                    "لا يمكنك إنهاء خدمة سجلّك الشخصي"
                } else {
                    "لا يمكن إنهاء خدمة هذا الموظف ضمن نطاق الجلسة"
                },
            )
        }
        launch(HrAdminBusy.EMPLOYEE_STATUS) {
            val updated = source.terminateEmployee(employee, terminationDate, terminationReason)
            state = state.copy(
                employees = state.employees.copy(
                    rows = state.employees.rows.map { if (it.id == updated.id) updated else it },
                ),
                notice = "تم إنهاء خدمة ${updated.fullName}",
            )
        }
    }

    fun selectPayroll(id: Long?) {
        if (id == null) {
            state = state.copy(payrollDetail = null, error = null)
            return
        }
        launch(HrAdminBusy.PAYROLL) { state = state.copy(payrollDetail = source.payrollRun(id)) }
    }

    fun payrollPeriod(value: String) {
        state = state.copy(payrollPeriod = value.filter { it.isDigit() || it == '-' }.take(7))
    }

    fun generatePayroll() {
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        if (!state.isFresh(HrAdminSection.PAYROLL)) return fail("حدّث قسم الرواتب بنجاح قبل التنفيذ")
        val period = state.payrollPeriod
        if (!Regex("^\\d{4}-(0[1-9]|1[0-2])$").matches(period)) return fail("أدخل الشهر بصيغة YYYY-MM")
        launch(HrAdminBusy.PAYROLL_ACTION) {
            val created = source.generatePayroll(period)
            state = state.copy(
                payrollRuns = (state.payrollRuns + created.run).distinctBy { it.id }
                    .sortedByDescending { it.period },
                payrollDetail = created,
                notice = "تم إنشاء مسودة مسيّر $period",
            )
        }
    }

    fun approvePayroll() = payrollAction("تم اعتماد المسيّر") { source.approvePayroll(it) }
    fun payPayroll() = payrollAction("تم صرف المسيّر") { source.payPayroll(it) }

    fun cancelPayroll() {
        val run = state.payrollDetail?.run ?: return
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        if (!state.isFresh(HrAdminSection.PAYROLL)) return fail("حدّث قسم الرواتب بنجاح قبل التنفيذ")
        launch(HrAdminBusy.PAYROLL_ACTION) {
            val updated = source.cancelPayroll(run.id)
            val runs = if (updated == null) {
                state.payrollRuns.filterNot { it.id == run.id }
            } else {
                state.payrollRuns.map { if (it.id == run.id) updated.run else it }
            }
            state = state.copy(payrollRuns = runs, payrollDetail = updated, notice = "تم تحديث دورة المسيّر")
        }
    }

    fun leaveFilter(value: LeaveStatus?) {
        state = state.copy(leaveFilter = value)
        loadLeaves()
    }

    fun decideLeave(request: LeaveRequest, decision: LeaveStatus) {
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        launch(HrAdminBusy.LEAVE_ACTION) {
            source.decideLeave(request, decision)
            val refreshed = source.leaveRequests(state.leaveFilter)
            state = state.copy(
                leaves = refreshed,
                notice = if (decision == LeaveStatus.APPROVED) "تم اعتماد الإجازة" else "تم رفض الإجازة",
            )
        }
    }

    fun applicantFilter(value: ApplicantStage?) {
        state = state.copy(applicantFilter = value)
        loadRecruitment()
    }

    fun setApplicantStage(applicant: JobApplicant, stage: ApplicantStage) {
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        launch(HrAdminBusy.RECRUITMENT_ACTION) {
            source.setApplicantStage(applicant, stage)
            state = state.copy(
                applicants = source.applicants(state.applicantFilter),
                notice = "تم تحديث مرحلة المتقدم",
            )
        }
    }

    fun setVacancyPublished(vacancy: JobVacancy, published: Boolean) {
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        launch(HrAdminBusy.RECRUITMENT_ACTION) {
            val updated = source.setVacancyPublished(vacancy, published)
            state = state.copy(
                vacancies = state.vacancies.map { if (it.id == updated.id) updated else it },
                notice = if (published) "تم نشر الوظيفة" else "تم إخفاء الوظيفة",
            )
        }
    }

    fun clearMessage() {
        state = state.copy(error = null, notice = null)
    }

    private fun loadSection(section: HrAdminSection, busy: HrAdminBusy) {
        when (section) {
            HrAdminSection.EMPLOYEES -> loadEmployees(false, busy)
            HrAdminSection.PAYROLL -> loadPayroll(busy)
            HrAdminSection.LEAVES -> loadLeaves(busy)
            HrAdminSection.RECRUITMENT -> loadRecruitment(busy)
            HrAdminSection.ATTENDANCE -> loadAttendance(busy)
            HrAdminSection.DEVICES -> loadDevices(busy)
            HrAdminSection.ADVANCES -> loadAdvances(busy)
            HrAdminSection.PROMOTIONS -> loadPromotions(busy)
        }
    }

    fun loadLinkableUsers(query: String = "") {
        val employee = state.selectedEmployee ?: return
        if (!capabilities.role.equals("admin", true) || employee.userId != null) return fail("ربط الحساب غير متاح لهذا السجل")
        launch(HrAdminBusy.EMPLOYEE_ACCOUNT) {
            state = state.copy(accountEmployeeId = employee.id, linkableUsers = source.linkableUsers(employee, query))
        }
    }

    fun clearAccountManager() {
        state = state.copy(accountEmployeeId = null, linkableUsers = emptyList())
    }

    fun linkEmployeeAccount(userId: Long) = accountMutation("تم ربط الحساب بالموظف") { employee ->
        source.linkEmployeeAccount(employee, userId)
    }

    fun unlinkEmployeeAccount() = accountMutation("تم فك ربط الحساب") { employee ->
        source.unlinkEmployeeAccount(employee)
    }

    fun createEmployeeAccount(command: CreateEmployeeAccountCommand) = accountMutation("تم إنشاء الحساب وربطه") { employee ->
        source.createEmployeeAccount(employee, command)
    }

    fun loadLegalSettings() {
        if (!capabilities.canReadCompanyHr) return fail("لا توجد صلاحية لقراءة إعدادات الرواتب")
        state = state.copy(legalSettingsLoaded = false)
        launch(HrAdminBusy.LEGAL_SETTINGS) {
            state = state.copy(legalSettings = source.payrollLegalSettings(), legalSettingsLoaded = true)
        }
    }

    fun updateLegalSettings(value: PayrollLegalSettings) {
        if (!capabilities.canManageCompanyHr) return fail("لا توجد صلاحية لتحديث إعدادات الرواتب")
        if (!state.isFresh(HrAdminSection.PAYROLL) || !state.legalSettingsLoaded || state.legalSettings == null) return fail("حمّل قسم الرواتب والإعدادات الحالية بنجاح قبل الحفظ")
        launch(HrAdminBusy.LEGAL_SETTINGS) {
            val before = requireNotNull(state.legalSettings)
            val after = source.updatePayrollLegalSettings(value)
            state = state.copy(
                legalSettings = after,
                legalSettingsLoaded = true,
                notice = "تم تحديث الإعدادات القانونية من ${before.updatedAt ?: "الإعداد الافتراضي"} إلى ${after.updatedAt ?: "الآن"}",
            )
        }
    }

    private fun loadAttendance(busy: HrAdminBusy = HrAdminBusy.ATTENDANCE) {
        if (!capabilities.canReadCompanyHr) return fail("سجل الحضور متاح لإدارة الموارد البشرية المخولة فقط")
        val period = state.attendancePeriod
        if (!Regex("^\\d{4}-(0[1-9]|1[0-2])$").matches(period)) return fail("أدخل الشهر بصيغة YYYY-MM")
        launch(busy) { state = state.copy(initialized = true, attendance = source.attendance(period)) }
    }

    private fun loadDevices(busy: HrAdminBusy = HrAdminBusy.DEVICES) {
        if (!capabilities.canReadCompanyHr) return fail("أجهزة البصمة متاحة لإدارة الموارد البشرية المخولة فقط")
        launch(busy) { state = state.copy(initialized = true, devices = source.fingerprintDevices()) }
    }

    private fun loadAdvances(busy: HrAdminBusy = HrAdminBusy.ADVANCES) {
        if (!capabilities.canReadCompanyHr) return fail("السلف متاحة لإدارة الموارد البشرية المخولة فقط")
        launch(busy) { state = state.copy(initialized = true, advances = source.advances()) }
    }

    private fun loadPromotions(busy: HrAdminBusy = HrAdminBusy.PROMOTIONS) {
        if (!capabilities.canReadCompanyHr) return fail("الترقيات متاحة لإدارة الموارد البشرية المخولة فقط")
        launch(busy) { state = state.copy(initialized = true, promotions = source.promotions()) }
    }

    private fun loadEmployees(append: Boolean, busy: HrAdminBusy = HrAdminBusy.EMPLOYEES) {
        if (!capabilities.canReadEmployees) return fail("لا يوجد فرع مرتبط بهذه الجلسة")
        launch(busy) {
            val offset = if (append) state.employees.rows.size else 0
            state = state.employeesLoaded(
                source.employees(state.employeeQuery, state.includeInactiveEmployees, offset),
                append,
            )
        }
    }

    private fun loadPayroll(busy: HrAdminBusy = HrAdminBusy.PAYROLL) {
        if (!capabilities.canReadCompanyHr) return fail("قراءة الرواتب غير مقيّدة بالفرع في الخادم")
        launch(busy) {
            val runs = source.payrollRuns()
            state = state.copy(
                initialized = true,
                payrollRuns = runs,
                payrollDetail = state.payrollDetail?.takeIf { detail -> runs.any { it.id == detail.run.id } },
            )
        }
    }

    private fun loadLeaves(busy: HrAdminBusy = HrAdminBusy.LEAVES) {
        if (!capabilities.canReadCompanyHr) return fail("قراءة الإجازات غير مقيّدة بالفرع في الخادم")
        launch(busy) { state = state.copy(initialized = true, leaves = source.leaveRequests(state.leaveFilter)) }
    }

    private fun loadRecruitment(busy: HrAdminBusy = HrAdminBusy.RECRUITMENT) {
        if (!capabilities.canReadCompanyHr) return fail("بيانات التوظيف غير مقيّدة بالفرع في الخادم")
        launch(busy) {
            val result = coroutineScope {
                val applicants = async { source.applicants(state.applicantFilter) }
                val vacancies = async { source.vacancies() }
                applicants.await() to vacancies.await()
            }
            state = state.copy(initialized = true, applicants = result.first, vacancies = result.second)
        }
    }

    private fun payrollAction(success: String, action: suspend (Long) -> online.alarabiya.superapp.model.hradmin.PayrollRunDetail) {
        val run = state.payrollDetail?.run ?: return
        if (!capabilities.canManageCompanyHr) return fail("صلاحية الموارد البشرية للقراءة فقط")
        if (!state.isFresh(HrAdminSection.PAYROLL)) return fail("حدّث قسم الرواتب بنجاح قبل التنفيذ")
        launch(HrAdminBusy.PAYROLL_ACTION) {
            val updated = action(run.id)
            state = state.copy(
                payrollDetail = updated,
                payrollRuns = state.payrollRuns.map { if (it.id == updated.run.id) updated.run else it },
                notice = success,
            )
        }
    }

    private fun accountMutation(success: String, action: suspend (online.alarabiya.superapp.model.hradmin.HrEmployee) -> online.alarabiya.superapp.model.hradmin.HrEmployee) {
        val employee = state.selectedEmployee ?: return
        if (employee.userId == capabilities.currentUserId) return fail("لا يمكن إدارة ربط حسابك الحالي")
        launch(HrAdminBusy.EMPLOYEE_ACCOUNT) {
            val updated = action(employee)
            state = state.copy(
                employees = state.employees.copy(rows = state.employees.rows.map { if (it.id == updated.id) updated else it }),
                selectedEmployeeId = updated.id,
                accountEmployeeId = null,
                linkableUsers = emptyList(),
                notice = success,
            )
        }
    }

    private fun allowed(section: HrAdminSection): Boolean = when (section) {
        HrAdminSection.EMPLOYEES -> capabilities.canReadEmployees
        HrAdminSection.PAYROLL, HrAdminSection.LEAVES, HrAdminSection.RECRUITMENT ->
            capabilities.canReadCompanyHr
        HrAdminSection.ATTENDANCE, HrAdminSection.DEVICES,
        HrAdminSection.ADVANCES, HrAdminSection.PROMOTIONS -> capabilities.canReadCompanyHr
    }

    private fun launch(operation: HrAdminBusy, block: suspend () -> Unit) {
        val loadingSection = operation.loadingSection(state.section)
        val started = state.start(operation) ?: return
        state = started
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess {
                    state = loadingSection?.let(state::sectionLoaded)
                        ?: state.copy(busy = null, initialized = true)
                }
                .onFailure {
                    state = state.failed(message(it), loadingSection)
                    if (operation == HrAdminBusy.LEGAL_SETTINGS) state = state.copy(legalSettingsLoaded = false)
                }
        }
    }

    private fun fail(message: String) {
        state = state.failed(message)
    }

    private fun message(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"

    companion object {
        private fun busyFor(section: HrAdminSection): HrAdminBusy = when (section) {
            HrAdminSection.EMPLOYEES -> HrAdminBusy.EMPLOYEES
            HrAdminSection.PAYROLL -> HrAdminBusy.PAYROLL
            HrAdminSection.LEAVES -> HrAdminBusy.LEAVES
            HrAdminSection.RECRUITMENT -> HrAdminBusy.RECRUITMENT
            HrAdminSection.ATTENDANCE -> HrAdminBusy.ATTENDANCE
            HrAdminSection.DEVICES -> HrAdminBusy.DEVICES
            HrAdminSection.ADVANCES -> HrAdminBusy.ADVANCES
            HrAdminSection.PROMOTIONS -> HrAdminBusy.PROMOTIONS
        }
        private fun firstSection(capabilities: HrAdminCapabilities): HrAdminSection = when {
            capabilities.canReadEmployees -> HrAdminSection.EMPLOYEES
            capabilities.canReadCompanyHr -> HrAdminSection.PAYROLL
            else -> HrAdminSection.EMPLOYEES
        }
    }
}

private fun HrAdminBusy.loadingSection(current: HrAdminSection): HrAdminSection? = when (this) {
    HrAdminBusy.INITIAL -> current
    HrAdminBusy.EMPLOYEES -> HrAdminSection.EMPLOYEES
    HrAdminBusy.PAYROLL -> HrAdminSection.PAYROLL
    HrAdminBusy.LEAVES -> HrAdminSection.LEAVES
    HrAdminBusy.RECRUITMENT -> HrAdminSection.RECRUITMENT
    HrAdminBusy.ATTENDANCE -> HrAdminSection.ATTENDANCE
    HrAdminBusy.DEVICES -> HrAdminSection.DEVICES
    HrAdminBusy.ADVANCES -> HrAdminSection.ADVANCES
    HrAdminBusy.PROMOTIONS -> HrAdminSection.PROMOTIONS
    else -> null
}

class HrAdminViewModelFactory(
    private val source: HrAdminDataSource,
    bootstrap: AppBootstrap,
) : ViewModelProvider.Factory {
    private val capabilities = HrAdminCapabilities.fromBootstrap(bootstrap)

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        HrAdminViewModel(source, capabilities) as T
}

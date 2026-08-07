package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.hradmin.ApplicantStage
import online.alarabiya.superapp.model.hradmin.EmploymentStatus
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.hradmin.HrEmployee
import online.alarabiya.superapp.model.hradmin.HrEmployeePage
import online.alarabiya.superapp.model.hradmin.HrAdminPolicies
import online.alarabiya.superapp.model.hradmin.JobApplicant
import online.alarabiya.superapp.model.hradmin.JobVacancy
import online.alarabiya.superapp.model.hradmin.LeaveCounts
import online.alarabiya.superapp.model.hradmin.LeavePage
import online.alarabiya.superapp.model.hradmin.LeaveRequest
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollItem
import online.alarabiya.superapp.model.hradmin.PayrollRun
import online.alarabiya.superapp.model.hradmin.PayrollRunDetail
import online.alarabiya.superapp.model.hradmin.PayrollStatus
import org.json.JSONArray
import org.json.JSONObject

interface HrAdminDataSource {
    suspend fun employees(query: String, includeInactive: Boolean, offset: Int = 0): HrEmployeePage
    suspend fun setEmployeeStatus(employee: HrEmployee, status: EmploymentStatus): HrEmployee
    suspend fun terminateEmployee(employee: HrEmployee, terminationDate: String, terminationReason: String): HrEmployee
    suspend fun payrollRuns(): List<PayrollRun>
    suspend fun payrollRun(id: Long): PayrollRunDetail
    suspend fun generatePayroll(period: String): PayrollRunDetail
    suspend fun approvePayroll(id: Long): PayrollRunDetail
    suspend fun payPayroll(id: Long): PayrollRunDetail
    suspend fun cancelPayroll(id: Long): PayrollRunDetail?
    suspend fun leaveRequests(status: LeaveStatus? = null, offset: Int = 0): LeavePage
    suspend fun decideLeave(request: LeaveRequest, decision: LeaveStatus): LeaveRequest
    suspend fun applicants(stage: ApplicantStage? = null): List<JobApplicant>
    suspend fun setApplicantStage(applicant: JobApplicant, stage: ApplicantStage): JobApplicant
    suspend fun vacancies(): List<JobVacancy>
    suspend fun setVacancyPublished(vacancy: JobVacancy, published: Boolean): JobVacancy
}

class HrAdminRepository(
    private val api: TrpcClient,
    private val capabilities: HrAdminCapabilities,
) : HrAdminDataSource {
    override suspend fun employees(query: String, includeInactive: Boolean, offset: Int): HrEmployeePage {
        require(capabilities.canReadEmployees) { "لا توجد صلاحية آمنة لعرض موظفي الفرع" }
        val input = JSONObject()
            .put("q", query.trim())
            .put("includeInactive", includeInactive)
            .put("limit", PAGE_SIZE)
            .put("offset", offset)
        capabilities.branchId?.let { input.put("branchId", it) }
        return api.query("employees.list", input).toEmployeePage(
            expectedBranchId = capabilities.branchId,
            allowCompanyScope = capabilities.hasGlobalHrScope,
        )
    }

    override suspend fun setEmployeeStatus(employee: HrEmployee, status: EmploymentStatus): HrEmployee {
        require(capabilities.canManageEmployees && capabilities.acceptsEmployee(employee)) {
            "لا يمكن تغيير موظف خارج الفرع المرتبط بالجلسة"
        }
        require(status != EmploymentStatus.TERMINATED) {
            "إنهاء الخدمة يتطلب تاريخاً وسبباً ومراجعة مخصّصة"
        }
        return api.mutate(
            "employees.setStatus",
            JSONObject().put("id", employee.id).put("status", status.wire),
        ).toEmployee().also {
            require(capabilities.acceptsEmployee(it)) { "رفضت الاستجابة لأنها لا تطابق فرع الجلسة" }
        }
    }

    override suspend fun terminateEmployee(
        employee: HrEmployee,
        terminationDate: String,
        terminationReason: String,
    ): HrEmployee {
        require(capabilities.canTerminate(employee)) {
            if (employee.userId == capabilities.currentUserId) {
                "لا يمكنك إنهاء خدمة سجلّك الشخصي"
            } else {
                "لا يمكن إنهاء خدمة هذا الموظف ضمن نطاق الجلسة"
            }
        }
        val issue = HrAdminPolicies.terminationIssue(terminationDate, terminationReason)
        require(issue == null) { issue?.userMessage.orEmpty() }
        return api.mutate(
            "employees.setStatus",
            JSONObject()
                .put("id", employee.id)
                .put("status", EmploymentStatus.TERMINATED.wire)
                .put("terminationDate", terminationDate)
                .put("terminationReason", terminationReason.trim()),
        ).toEmployee().also {
            require(capabilities.acceptsEmployee(it)) { "رفضت الاستجابة لأنها لا تطابق فرع الجلسة" }
        }
    }

    override suspend fun payrollRuns(): List<PayrollRun> {
        requireCompanyRead()
        return api.queryArray("payroll.list").objects().mapNotNull(JSONObject::toPayrollRunOrNull)
    }

    override suspend fun payrollRun(id: Long): PayrollRunDetail {
        requireCompanyRead()
        require(id > 0) { "معرّف المسيّر غير صالح" }
        return api.query("payroll.get", JSONObject().put("id", id)).toPayrollDetail()
    }

    override suspend fun generatePayroll(period: String): PayrollRunDetail {
        requireCompanyWrite()
        require(PERIOD.matches(period)) { "الشهر يجب أن يكون بصيغة YYYY-MM" }
        return api.mutate("payroll.generate", JSONObject().put("period", period)).toPayrollDetail()
    }

    override suspend fun approvePayroll(id: Long): PayrollRunDetail = payrollMutation("payroll.approve", id)
    override suspend fun payPayroll(id: Long): PayrollRunDetail = payrollMutation("payroll.pay", id)

    override suspend fun cancelPayroll(id: Long): PayrollRunDetail? {
        requireCompanyWrite()
        val response = api.mutate("payroll.cancel", JSONObject().put("id", id))
        if (response.optBoolean("deleted")) return null
        return payrollRun(id)
    }

    override suspend fun leaveRequests(status: LeaveStatus?, offset: Int): LeavePage {
        requireCompanyRead()
        val input = JSONObject().put("limit", PAGE_SIZE).put("offset", offset)
        status?.let { input.put("status", it.wire) }
        return api.query("leaves.list", input).toLeavePage()
    }

    override suspend fun decideLeave(request: LeaveRequest, decision: LeaveStatus): LeaveRequest {
        requireCompanyWrite()
        require(request.status == LeaveStatus.PENDING) { "تم اتخاذ قرار على هذا الطلب مسبقاً" }
        require(decision == LeaveStatus.APPROVED || decision == LeaveStatus.REJECTED) {
            "قرار الإجازة غير صالح"
        }
        return api.mutate(
            "leaves.decide",
            JSONObject().put("id", request.id).put("decision", decision.wire),
        ).toLeaveRequest()
    }

    override suspend fun applicants(stage: ApplicantStage?): List<JobApplicant> {
        requireCompanyRead()
        val input = JSONObject().apply { stage?.let { put("stage", it.wire) } }
        return api.queryArray("recruitment.list", input).objects().mapNotNull(JSONObject::toApplicantOrNull)
    }

    override suspend fun setApplicantStage(applicant: JobApplicant, stage: ApplicantStage): JobApplicant {
        requireCompanyWrite()
        require(applicant.id > 0) { "معرّف المتقدم غير صالح" }
        return api.mutate(
            "recruitment.updateStage",
            JSONObject().put("id", applicant.id).put("stage", stage.wire),
        ).toApplicant()
    }

    override suspend fun vacancies(): List<JobVacancy> {
        requireCompanyRead()
        return api.queryArray("recruitment.vacancyList", JSONObject()).objects().mapNotNull(JSONObject::toVacancyOrNull)
    }

    override suspend fun setVacancyPublished(vacancy: JobVacancy, published: Boolean): JobVacancy {
        requireCompanyWrite()
        require(vacancy.id > 0) { "معرّف الوظيفة غير صالح" }
        return api.mutate(
            "recruitment.vacancyPublish",
            JSONObject().put("id", vacancy.id).put("isPublished", published),
        ).toVacancy()
    }

    private suspend fun payrollMutation(procedure: String, id: Long): PayrollRunDetail {
        requireCompanyWrite()
        require(id > 0) { "معرّف المسيّر غير صالح" }
        return api.mutate(procedure, JSONObject().put("id", id)).toPayrollDetail()
    }

    private fun requireCompanyRead() {
        require(capabilities.canReadCompanyHr) {
            "عقد الخادم الحالي غير مقيّد بالفرع؛ هذه البيانات متاحة لمدير النظام فقط"
        }
    }

    private fun requireCompanyWrite() {
        require(capabilities.canManageCompanyHr) {
            "لا توجد صلاحية آمنة لتنفيذ هذا الإجراء على مستوى الشركة"
        }
    }

    private companion object {
        const val PAGE_SIZE = 50
        val PERIOD = Regex("^\\d{4}-(0[1-9]|1[0-2])$")
    }
}

internal fun JSONObject.toEmployeePage(
    expectedBranchId: Long?,
    allowCompanyScope: Boolean = false,
): HrEmployeePage {
    val rows = optJSONArray("rows").objects().mapNotNull(JSONObject::toEmployeeOrNull)
    require(allowCompanyScope || (expectedBranchId != null && rows.all { it.branchId == expectedBranchId })) {
        "أعاد الخادم موظفاً من خارج الفرع المطلوب"
    }
    return HrEmployeePage(rows, optInt("total", rows.size))
}

internal fun JSONObject.toEmployee(): HrEmployee = toEmployeeOrNull()
    ?: error("بيانات الموظف غير مكتملة")

internal fun JSONObject.toEmployeeOrNull(): HrEmployee? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val name = optString("fullName").takeIf(String::isNotBlank) ?: return null
    return HrEmployee(
        id = id,
        userId = nullableLong("userId"),
        branchId = nullableLong("branchId"),
        branchName = nullableText("branchName"),
        fullName = name,
        position = nullableText("position"),
        department = nullableText("department"),
        phone = nullableText("phone"),
        email = nullableText("email"),
        payType = optString("payType", "monthly"),
        salary = nullableText("salary"),
        allowances = nullableText("allowances"),
        employmentStatus = EmploymentStatus.fromWire(optString("employmentStatus")),
        isActive = optBoolean("isActive", true),
        attendanceExempt = optBoolean("attendanceExempt"),
        deviceLinked = optBoolean("deviceLinked"),
        hireDate = nullableText("hireDate"),
        annualLeaveBalance = optInt("annualLeaveBalance"),
        sickLeaveBalance = optInt("sickLeaveBalance"),
    )
}

internal fun JSONObject.toPayrollDetail(): PayrollRunDetail {
    val run = toPayrollRunOrNull() ?: error("بيانات المسيّر غير مكتملة")
    val items = optJSONArray("items").objects().mapNotNull { row ->
        val id = row.optLong("id").takeIf { it > 0 } ?: return@mapNotNull null
        PayrollItem(
            id = id,
            employeeId = row.optLong("employeeId"),
            employeeName = row.optString("employeeName", "موظف #${row.optLong("employeeId")}"),
            position = row.nullableText("position"),
            department = row.nullableText("department"),
            gross = row.optMoney("gross"),
            overtime = row.optMoney("overtime"),
            commission = row.optMoney("commission"),
            deductions = row.optMoney("deductions"),
            net = row.optMoney("net"),
        )
    }
    return PayrollRunDetail(run, items)
}

internal fun JSONObject.toPayrollRunOrNull(): PayrollRun? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val period = optString("period").takeIf(String::isNotBlank) ?: return null
    return PayrollRun(
        id = id,
        period = period,
        status = PayrollStatus.fromWire(optString("status")),
        employeeCount = optInt("employeeCount"),
        totalGross = optMoney("totalGross"),
        totalOvertime = optMoney("totalOvertime"),
        totalCommission = optMoney("totalCommission"),
        totalDeductions = optMoney("totalDeductions"),
        totalNet = optMoney("totalNet"),
        createdBy = nullableLong("createdBy"),
        approvedBy = nullableLong("approvedBy"),
        paidBy = nullableLong("paidBy"),
        approvedAt = nullableText("approvedAt"),
        paidAt = nullableText("paidAt"),
    )
}

internal fun JSONObject.toLeavePage(): LeavePage {
    val rows = optJSONArray("rows").objects().mapNotNull(JSONObject::toLeaveRequestOrNull)
    val counts = optJSONObject("counts")
    return LeavePage(
        rows = rows,
        total = optInt("total", rows.size),
        hasMore = optBoolean("hasMore"),
        counts = LeaveCounts(
            pending = counts?.optInt("pending") ?: 0,
            approved = counts?.optInt("approved") ?: 0,
            monthDays = counts?.optInt("monthDays") ?: 0,
        ),
    )
}

internal fun JSONObject.toLeaveRequest(): LeaveRequest = toLeaveRequestOrNull()
    ?: error("بيانات طلب الإجازة غير مكتملة")

internal fun JSONObject.toLeaveRequestOrNull(): LeaveRequest? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val employeeId = optLong("employeeId").takeIf { it > 0 } ?: return null
    return LeaveRequest(
        id = id,
        employeeId = employeeId,
        employeeName = optString("employeeName", "موظف #$employeeId"),
        department = nullableText("department"),
        leaveType = optString("leaveType"),
        paid = optBoolean("paid"),
        fromDate = optString("fromDate"),
        toDate = optString("toDate"),
        days = optInt("days"),
        status = LeaveStatus.fromWire(optString("status")),
        reason = nullableText("reason"),
        requestedAt = nullableText("requestedAt"),
    )
}

internal fun JSONObject.toApplicant(): JobApplicant = toApplicantOrNull()
    ?: error("بيانات المتقدم غير مكتملة")

internal fun JSONObject.toApplicantOrNull(): JobApplicant? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val name = optString("name").takeIf(String::isNotBlank) ?: return null
    return JobApplicant(
        id = id,
        name = name,
        jobTitle = nullableText("jobTitle"),
        vacancyId = nullableLong("vacancyId"),
        source = optString("source", "external"),
        stage = ApplicantStage.fromWire(optString("stage")),
        appliedDate = nullableText("appliedDate"),
        phone = nullableText("phone"),
        email = nullableText("email"),
        experience = nullableText("experience"),
        education = nullableText("education"),
        rating = optInt("rating").coerceIn(0, 5),
        notes = nullableText("notes"),
    )
}

internal fun JSONObject.toVacancy(): JobVacancy = toVacancyOrNull()
    ?: error("بيانات الوظيفة غير مكتملة")

internal fun JSONObject.toVacancyOrNull(): JobVacancy? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val title = optString("title").takeIf(String::isNotBlank) ?: return null
    return JobVacancy(
        id = id,
        title = title,
        department = nullableText("department"),
        employmentType = optString("employmentType", "full_time"),
        location = nullableText("location"),
        branchId = nullableLong("branchId"),
        summary = nullableText("summary"),
        openings = optInt("openings", 1),
        isPublished = optBoolean("isPublished"),
    )
}

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    val source = this@objects ?: return@buildList
    for (index in 0 until source.length()) source.optJSONObject(index)?.let(::add)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONObject.optMoney(key: String): String = nullableText(key) ?: "0"

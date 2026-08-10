package online.alarabiya.superapp.model.selfservice

import org.json.JSONArray
import org.json.JSONObject

object SelfServiceMappers {
    fun workspace(root: JSONObject): SelfServiceWorkspace = workspace(root.toWireMap())

    internal fun workspace(root: Map<String, Any?>): SelfServiceWorkspace {
        val employee = root.obj("employee")
        return SelfServiceWorkspace(
            date = root.text("date"),
            employee = employee?.let {
                PersonalEmployeeProfile(
                    id = it.long("id"),
                    name = it.text("name"),
                    position = it.nullableText("position"),
                    department = it.nullableText("department"),
                    branchId = it.nullableLong("branchId"),
                    photoUrl = it.nullableText("photoUrl"),
                    employmentStatus = it.nullableText("employmentStatus"),
                    email = it.nullableText("email"),
                    phone = it.nullableText("phone"),
                    hireDate = it.nullableText("hireDate"),
                    payType = it.nullableText("payType"),
                    baseSalary = it.nullableText("baseSalary"),
                    allowances = it.nullableText("allowances"),
                )
            },
            todayAttendance = root.obj("attendance")?.toAttendanceEntry(id = 0L),
            attendanceHistory = root.list("attendanceHistory").mapNotNull { item ->
                val value = item as? Map<*, *> ?: return@mapNotNull null
                val row = value.stringKeyed()
                row.toAttendanceEntry(id = row.long("id"))
            },
            payroll = root.obj("latestPayroll")?.let { item ->
                item.toPersonalPayroll()
            },
            tasks = root.list("tasks").mapNotNull { item ->
                val value = item as? Map<*, *> ?: return@mapNotNull null
                val row = value.stringKeyed()
                PersonalTask(
                    id = row.long("id"),
                    number = row.text("taskNumber"),
                    title = row.text("title"),
                    priority = row.text("priority"),
                    status = row.text("status"),
                    dueAt = row.nullableText("dueAt"),
                )
            },
            leaveRequests = root.list("leaveRequests").mapNotNull { item ->
                val value = item as? Map<*, *> ?: return@mapNotNull null
                val row = value.stringKeyed()
                PersonalLeaveRequest(
                    id = row.long("id"),
                    leaveType = row.text("leaveType"),
                    fromDate = row.text("fromDate"),
                    toDate = row.text("toDate"),
                    days = row.text("days", "0"),
                    status = row.text("status"),
                    reason = row.nullableText("reason"),
                    requestedAt = row.nullableText("requestedAt"),
                    decidedAt = row.nullableText("decidedAt"),
                )
            },
            leaveBalances = employee?.let {
                LeaveBalances(
                    annual = it.text("annualLeaveBalance", "0"),
                    sick = it.text("sickLeaveBalance", "0"),
                )
            },
        )
    }

    fun notifications(root: JSONObject): NotificationCenter = notifications(root.toWireMap())

    fun payrollHistory(root: JSONArray): List<PersonalPayroll> =
        (root.toWireValue() as? List<*>).orEmpty().mapNotNull { item ->
            val value = item as? Map<*, *> ?: return@mapNotNull null
            value.stringKeyed().toPersonalPayroll().takeIf { it.itemId > 0 }
        }

    internal fun payrollHistory(rows: List<Map<String, Any?>>): List<PersonalPayroll> =
        rows.mapNotNull { it.toPersonalPayroll().takeIf { payroll -> payroll.itemId > 0 } }

    fun payslip(root: JSONObject): PersonalPayslip = payslip(root.toWireMap())

    internal fun payslip(root: Map<String, Any?>): PersonalPayslip = PersonalPayslip(
        itemId = root.long("itemId"),
        runId = root.long("runId"),
        period = root.text("period"),
        status = root.text("status"),
        paidAt = root.nullableText("paidAt"),
        payType = root.text("payType"),
        hours = root.nullableText("hours"),
        gross = root.text("gross", "0"),
        allowances = root.text("allowances", "0"),
        overtime = root.text("overtime", "0"),
        commission = root.text("commission", "0"),
        deductions = root.text("deductions", "0"),
        advanceDeduction = root.text("advanceDeduction", "0"),
        socialSecurityEmployee = root.text("socialSecurityEmployee", "0"),
        incomeTax = root.text("incomeTax", "0"),
        net = root.text("net", "0"),
        note = root.nullableText("note"),
        createdAt = root.nullableText("createdAt"),
    )

    internal fun notifications(root: Map<String, Any?>): NotificationCenter = NotificationCenter(
        rows = root.list("rows").mapNotNull { item ->
            val value = item as? Map<*, *> ?: return@mapNotNull null
            val row = value.stringKeyed()
            PersonalNotification(
                id = row.long("id"),
                kind = row.text("kind"),
                title = row.text("title"),
                body = row.text("body"),
                createdAt = row.nullableText("createdAt"),
                readAt = row.nullableText("readAt"),
                requiresAction = row.bool("requiresAction"),
                entityType = row.nullableText("entityType"),
                entityId = row.nullableLong("entityId"),
            )
        },
        unreadCount = root.long("unreadCount").toInt(),
    )

    fun notificationPreferences(root: JSONObject): NotificationPreferences =
        notificationPreferences(root.toWireMap())

    internal fun notificationPreferences(root: Map<String, Any?>): NotificationPreferences =
        NotificationPreferences(
            taskAssigned = root.bool("taskAssigned"),
            payrollReady = root.bool("payrollReady"),
            attendance = root.bool("attendance"),
            leaveStatus = root.bool("leaveStatus"),
            approvals = root.bool("approvals"),
            quietHoursStart = root.nullableText("quietHoursStart"),
            quietHoursEnd = root.nullableText("quietHoursEnd"),
        )
}

private fun Map<String, Any?>.toPersonalPayroll(): PersonalPayroll = PersonalPayroll(
    itemId = long("itemId"),
    runId = long("runId"),
    period = text("period"),
    status = text("status"),
    paidAt = nullableText("paidAt"),
    gross = text("gross", "0"),
    allowances = text("allowances", "0"),
    overtime = text("overtime", "0"),
    commission = text("commission", "0"),
    deductions = text("deductions", "0"),
    net = text("net", "0"),
)

private fun Map<String, Any?>.toAttendanceEntry(id: Long): AttendanceEntry = AttendanceEntry(
    id = id,
    date = text("date"),
    checkIn = nullableText("checkIn"),
    checkOut = nullableText("checkOut"),
    status = nullableText("status"),
    hours = nullableText("hours"),
    source = nullableText("source"),
    needsReview = bool("needsReview"),
)

private fun JSONObject.toWireMap(): Map<String, Any?> = buildMap {
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        put(key, opt(key).toWireValue())
    }
}

private fun Any?.toWireValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toWireMap()
    is JSONArray -> buildList {
        for (index in 0 until length()) add(opt(index).toWireValue())
    }
    else -> this
}

private fun Map<*, *>.stringKeyed(): Map<String, Any?> = entries.associate { (key, value) -> key.toString() to value }
private fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = (this[key] as? Map<*, *>)?.stringKeyed()
private fun Map<String, Any?>.list(key: String): List<Any?> = this[key] as? List<Any?> ?: emptyList()
private fun Map<String, Any?>.text(key: String, default: String = ""): String = nullableText(key) ?: default
private fun Map<String, Any?>.nullableText(key: String): String? = this[key]?.toString()?.takeIf { it.isNotBlank() }
private fun Map<String, Any?>.long(key: String): Long = nullableLong(key) ?: 0L
private fun Map<String, Any?>.nullableLong(key: String): Long? = when (val value = this[key]) {
    is Number -> value.toLong()
    is String -> value.toLongOrNull()
    else -> null
}
private fun Map<String, Any?>.bool(key: String): Boolean = when (val value = this[key]) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value.equals("true", ignoreCase = true) || value == "1"
    else -> false
}

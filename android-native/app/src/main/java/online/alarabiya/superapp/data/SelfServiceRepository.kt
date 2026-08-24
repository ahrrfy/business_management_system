package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.selfservice.NotificationCenter
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.PersonalPayroll
import online.alarabiya.superapp.model.selfservice.PersonalPayslip
import online.alarabiya.superapp.model.selfservice.SelfServiceMappers
import online.alarabiya.superapp.model.selfservice.SelfServicePolicies
import online.alarabiya.superapp.model.selfservice.SelfServiceSnapshot
import online.alarabiya.superapp.model.selfservice.SelfServiceWorkspace
import org.json.JSONObject

/**
 * ن-١: مرشّحات الإشعارات التي تعبر خادمياً لاقتطاع الصندوق على المصدر الحيّ لا الشاشة —
 * لأنّ `limit` يقتطع قبل أن تصل الحمولةُ إلى العميل.
 */
enum class NotificationFilter { All, UnreadOnly, RequiresActionOnly }

interface SelfServiceDataSource {
    suspend fun loadWorkspace(): SelfServiceWorkspace
    suspend fun loadNotifications(limit: Int = 40, filter: NotificationFilter = NotificationFilter.All): NotificationCenter
    suspend fun loadNotificationPreferences(): NotificationPreferences
    suspend fun loadPayrollHistory(limit: Int = 24): List<PersonalPayroll> = emptyList()
    suspend fun loadPayslip(payrollItemId: Long): PersonalPayslip =
        error("تفاصيل قسيمة الراتب غير متاحة في مصدر البيانات الحالي")
    suspend fun performTaskAction(taskId: Long, action: PersonalTaskAction, note: String? = null)
    suspend fun requestLeave(leaveType: String, fromDate: String, toDate: String, reason: String? = null)
    suspend fun withdrawLeave(id: Long)
    suspend fun markNotificationRead(id: Long)
    suspend fun markAllNotificationsRead()
    suspend fun updateNotificationPreferences(preferences: NotificationPreferences): NotificationPreferences
}

class SelfServiceRepository(private val api: TrpcClient) : SelfServiceDataSource {
    suspend fun loadSnapshot(): SelfServiceSnapshot = SelfServiceSnapshot(
        workspace = loadWorkspace(),
        notifications = loadNotifications(),
        notificationPreferences = loadNotificationPreferences(),
        payrollHistory = loadPayrollHistory(),
    )

    override suspend fun loadWorkspace(): SelfServiceWorkspace =
        SelfServiceMappers.workspace(api.query("superApp.myWorkspace"))

    override suspend fun loadNotifications(limit: Int, filter: NotificationFilter): NotificationCenter {
        val input = JSONObject().put("limit", limit.coerceIn(1, 100))
        when (filter) {
            NotificationFilter.UnreadOnly -> input.put("unreadOnly", true)
            NotificationFilter.RequiresActionOnly -> input.put("requiresActionOnly", true)
            NotificationFilter.All -> Unit
        }
        return SelfServiceMappers.notifications(api.query("superApp.notifications", input))
    }

    override suspend fun loadNotificationPreferences(): NotificationPreferences =
        SelfServiceMappers.notificationPreferences(api.query("superApp.notificationPreferences"))

    override suspend fun loadPayrollHistory(limit: Int): List<PersonalPayroll> =
        SelfServiceMappers.payrollHistory(
            api.queryArray("superApp.payrollHistory", JSONObject().put("limit", limit.coerceIn(1, 36))),
        )

    override suspend fun loadPayslip(payrollItemId: Long): PersonalPayslip {
        require(payrollItemId > 0) { "معرّف قسيمة الراتب غير صالح" }
        return SelfServiceMappers.payslip(
            api.query("superApp.payslipDetail", JSONObject().put("payrollItemId", payrollItemId)),
        )
    }

    override suspend fun performTaskAction(taskId: Long, action: PersonalTaskAction, note: String?) {
        require(taskId > 0) { "معرّف المهمة غير صالح" }
        val cleanNote = note?.trim()?.takeIf { it.isNotEmpty() }
        val input = JSONObject().put("taskId", taskId)
        val procedure = when (action) {
            PersonalTaskAction.Claim -> "tasks.claim"
            PersonalTaskAction.Wait -> "tasks.setWaiting".also { cleanNote?.let { value -> input.put("note", value) } }
            PersonalTaskAction.Resume -> "tasks.resume"
            PersonalTaskAction.Resolve -> "tasks.resolve".also { cleanNote?.let { value -> input.put("resolutionNote", value) } }
            PersonalTaskAction.Comment -> {
                requireNotNull(cleanNote) { "اكتب تعليقاً قبل الإرسال" }
                input.put("note", cleanNote)
                "tasks.addComment"
            }
        }
        api.mutate(procedure, input)
    }

    override suspend fun requestLeave(
        leaveType: String,
        fromDate: String,
        toDate: String,
        reason: String?,
    ) {
        val issue = SelfServicePolicies.validateLeaveRequest(leaveType, fromDate, toDate)
        require(issue == null) { issue?.userMessage.orEmpty() }
        val input = JSONObject()
            .put("leaveType", leaveType)
            .put("fromDate", fromDate)
            .put("toDate", toDate)
        reason?.trim()?.takeIf { it.isNotEmpty() }?.let { input.put("reason", it) }
        api.mutate("superApp.requestLeave", input)
    }

    override suspend fun withdrawLeave(id: Long) {
        require(id > 0) { "معرّف طلب الإجازة غير صالح" }
        api.mutate("superApp.withdrawLeave", JSONObject().put("id", id))
    }

    override suspend fun markNotificationRead(id: Long) {
        require(id > 0) { "معرّف التنبيه غير صالح" }
        api.mutate("superApp.markNotificationRead", JSONObject().put("id", id))
    }

    override suspend fun markAllNotificationsRead() {
        api.mutate("superApp.markAllNotificationsRead")
    }

    override suspend fun updateNotificationPreferences(
        preferences: NotificationPreferences,
    ): NotificationPreferences {
        val input = JSONObject()
            .put("taskAssigned", preferences.taskAssigned)
            .put("payrollReady", preferences.payrollReady)
            .put("attendance", preferences.attendance)
            .put("leaveStatus", preferences.leaveStatus)
            .put("approvals", preferences.approvals)
        preferences.quietHoursStart?.takeIf { it.isNotBlank() }?.let { input.put("quietHoursStart", it) }
        preferences.quietHoursEnd?.takeIf { it.isNotBlank() }?.let { input.put("quietHoursEnd", it) }
        return SelfServiceMappers.notificationPreferences(
            api.mutate("superApp.updateNotificationPreferences", input),
        )
    }

}

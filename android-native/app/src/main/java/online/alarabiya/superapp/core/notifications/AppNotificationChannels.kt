package online.alarabiya.superapp.core.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/** Stable channel identifiers. Never derive channel IDs from remote payloads. */
object AppNotificationChannels {
    const val OPERATIONS = "operations_v1"
    const val ADMIN = "administration_v1"
    const val EMPLOYEE = "employee_updates_v1"
    const val SYSTEM = "system_updates_v1"
    const val APPROVALS = "approvals_v1"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    OPERATIONS,
                    "العمليات والمهام",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "المهام والإسنادات وتحديثات سير العمل"
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    ADMIN,
                    "الإشعارات الإدارية",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "الحضور والجلسات والتنبيهات الموجهة للإدارة"
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    EMPLOYEE,
                    "إشعارات الموظف",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "الدوام والإجازات والرواتب والتحديثات الشخصية"
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    SYSTEM,
                    "إشعارات النظام",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "الإعلانات والتنبيهات الآلية من النظام"
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    APPROVALS,
                    "الاعتمادات المطلوبة",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "الطلبات والقرارات التي تتطلب اعتماداً"
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
            ),
        )
    }
}

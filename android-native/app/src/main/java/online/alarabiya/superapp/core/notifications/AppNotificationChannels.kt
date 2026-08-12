package online.alarabiya.superapp.core.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/** Stable channel identifiers. Never derive channel IDs from remote payloads. */
object AppNotificationChannels {
    const val ACTIONS = "operational_actions"
    const val INFORMATION = "business_updates"
    // New stable ID: channel importance cannot be raised after Android creates a channel.
    const val ATTENDANCE_UPDATES = "attendance_updates_v1"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    ACTIONS,
                    "إجراءات مطلوبة",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "الموافقات والمهام التي تتطلب إجراءً"
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    INFORMATION,
                    "تحديثات العمل",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "تحديثات الدوام والرواتب والعمليات"
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(
                    ATTENDANCE_UPDATES,
                    "الحضور والانصراف",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "تأكيدات الحضور والانصراف المسجلة من أجهزة الشركة"
                    enableVibration(true)
                    // The individual notification decides PUBLIC vs PRIVATE from its sanitized
                    // payload. A channel-level override would incorrectly expose sensitive events.
                },
            ),
        )
    }
}

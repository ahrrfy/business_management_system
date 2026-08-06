package online.alarabiya.superapp.core.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/** Stable channel identifiers. Never derive channel IDs from remote payloads. */
object AppNotificationChannels {
    const val ACTIONS = "operational_actions"
    const val INFORMATION = "business_updates"

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
            ),
        )
    }
}

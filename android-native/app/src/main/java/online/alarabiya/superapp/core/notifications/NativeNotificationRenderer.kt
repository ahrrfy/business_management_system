package online.alarabiya.superapp.core.notifications

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import online.alarabiya.superapp.MainActivity
import online.alarabiya.superapp.R
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec

object NativeNotificationRenderer {
    const val EXTRA_NOTIFICATION_ID = "online.alarabiya.superapp.notification.ID"
    const val EXTRA_NOTIFICATION_KIND = "online.alarabiya.superapp.notification.KIND"

    fun show(context: Context, payload: NativeNotificationPayload): Boolean {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }

        val destination = NativeDeepLinkCodec.encode(payload.destination)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = destination.toUri()
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_NOTIFICATION_ID, payload.notificationId)
            putExtra(EXTRA_NOTIFICATION_KIND, payload.kind)
        }
        val requestCode = payload.notificationId.hashCode() and Int.MAX_VALUE
        val contentIntent = PendingIntent.getActivity(
            context,
            requestCode,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val channel = when (NativeNotificationPrivacyPolicy.deliveryLane(payload.kind, payload.urgency)) {
            NotificationDeliveryLane.ATTENDANCE -> AppNotificationChannels.ATTENDANCE_UPDATES
            NotificationDeliveryLane.ACTIONS -> AppNotificationChannels.ACTIONS
            NotificationDeliveryLane.INFORMATION -> AppNotificationChannels.INFORMATION
        }
        val lockScreenExposure = NativeNotificationPrivacyPolicy.lockScreenExposure(payload.sensitive)
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle("سوبر العربية")
            .setContentText("لديك تحديث جديد")
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val notificationBuilder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(
                if (payload.urgency == NotificationUrgency.ACTION) {
                    NotificationCompat.CATEGORY_REMINDER
                } else {
                    NotificationCompat.CATEGORY_STATUS
                },
            )
            .setPriority(
                if (payload.urgency == NotificationUrgency.ACTION || payload.kind == "ATTENDANCE") {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .setVisibility(
                if (lockScreenExposure == LockScreenExposure.PUBLIC) {
                    NotificationCompat.VISIBILITY_PUBLIC
                } else {
                    NotificationCompat.VISIBILITY_PRIVATE
                },
            )
        if (lockScreenExposure == LockScreenExposure.PRIVATE) {
            notificationBuilder.setPublicVersion(publicVersion)
        }
        val notification = notificationBuilder.build()

        return runCatching {
            NotificationManagerCompat.from(context).notify(requestCode, notification)
            true
        }.getOrDefault(false)
    }
}

package online.alarabiya.superapp.core.notifications

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit

/** Request only after the user opts in or enables a feature that relies on alerts. */
object NotificationPermissionController {
    const val REQUEST_CODE = 4107
    private const val PREFERENCES = "native_notification_permission"
    private const val ASKED_AFTER_AUTH = "asked_after_auth"

    fun canPost(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun request(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !canPost(activity)) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_CODE,
            )
        }
    }

    /** أول طلب تلقائي فقط وبعد وصول الجلسة إلى Ready؛ الطلب اليدوي من الإعدادات يبقى متاحاً عبر request. */
    fun requestOnceAfterAuthentication(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || canPost(activity)) return false
        val preferences = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (preferences.getBoolean(ASKED_AFTER_AUTH, false)) return false
        preferences.edit { putBoolean(ASKED_AFTER_AUTH, true) }
        request(activity)
        return true
    }
}

package online.alarabiya.superapp

import android.app.Application
import online.alarabiya.superapp.core.notifications.AppNotificationChannels

class AlrueyaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppNotificationChannels.create(this)
    }
}

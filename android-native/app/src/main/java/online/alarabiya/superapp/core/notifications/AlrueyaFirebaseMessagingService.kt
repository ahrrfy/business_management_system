package online.alarabiya.superapp.core.notifications

import android.annotation.SuppressLint
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// Firebase Messaging 25.1+ replaced registration tokens with Firebase Installation IDs (FIDs).
// Android Lint 8.8 still asks for the deprecated onNewToken callback, even though this client
// deliberately uses register()/onRegistered() and the server targets message.fid.
@SuppressLint("MissingFirebaseInstanceTokenRefresh")
class AlrueyaFirebaseMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        NativePushCoordinator.installationRegistered(applicationContext, installationId)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val parsed = NativeNotificationPayloadParser.parse(message.data)
        if (parsed is NativeNotificationParseResult.Accepted) {
            NativeNotificationRenderer.show(applicationContext, parsed.payload)
        }
    }
}

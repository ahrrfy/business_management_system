package online.alarabiya.superapp.core.notifications

import android.content.Intent
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination

data class NativeNotificationNavigation(
    val destination: NativeDestination,
    val kind: String? = null,
)

/** One-shot typed destinations delivered by immutable notification PendingIntents. */
object NativeNotificationNavigationInbox {
    private val channel = Channel<NativeNotificationNavigation>(capacity = Channel.BUFFERED)
    val destinations: Flow<NativeNotificationNavigation> = channel.receiveAsFlow()

    fun accept(intent: Intent?): Boolean {
        if (intent?.action != Intent.ACTION_VIEW) return false
        val raw = intent.dataString ?: return false
        val parsed = NativeDeepLinkCodec.parse(raw)
        if (parsed !is DeepLinkResult.Accepted) return false
        val kind = intent.getStringExtra(NativeNotificationRenderer.EXTRA_NOTIFICATION_KIND)
        if (kind != null && !NativeNotificationPayloadParser.allowsDestination(kind, parsed.destination)) return false
        return channel.trySend(NativeNotificationNavigation(parsed.destination, kind)).isSuccess
    }
}

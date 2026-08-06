package online.alarabiya.superapp.core.notifications

import android.content.Intent
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination

/** One-shot typed destinations delivered by immutable notification PendingIntents. */
object NativeNotificationNavigationInbox {
    private val channel = Channel<NativeDestination>(capacity = Channel.BUFFERED)
    val destinations: Flow<NativeDestination> = channel.receiveAsFlow()

    fun accept(intent: Intent?): Boolean {
        if (intent?.action != Intent.ACTION_VIEW) return false
        val raw = intent.dataString ?: return false
        val parsed = NativeDeepLinkCodec.parse(raw)
        if (parsed !is DeepLinkResult.Accepted) return false
        return channel.trySend(parsed.destination).isSuccess
    }
}

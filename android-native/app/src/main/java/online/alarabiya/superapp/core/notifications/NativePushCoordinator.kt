package online.alarabiya.superapp.core.notifications

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.security.DeviceProofKey
import online.alarabiya.superapp.core.security.SecureSessionStore
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Push lifecycle entry point. Login/logout code can call these methods without depending on FCM
 * details. When environment Firebase configuration is absent it fails closed and performs no
 * network registration.
 */
object NativePushCoordinator {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun registerExistingSession(context: Context) {
        if (!isConfigured(context)) return
        val appContext = context.applicationContext
        val store = SecureSessionStore(appContext)
        if (store.loadCookie().isNullOrBlank()) return
        scope.launch {
            runCatching {
                val messaging = FirebaseMessaging.getInstance()
                messaging.isAutoInitEnabled = true
                // The current FCM API delivers the Firebase Installation ID through onRegistered.
                // Calling register on every authenticated startup also refreshes the server binding.
                messaging.register().awaitResult()
            }
        }
    }

    fun installationRegistered(context: Context, installationId: String) {
        if (!isConfigured(context) || installationId.isBlank()) return
        val appContext = context.applicationContext
        val store = SecureSessionStore(appContext)
        if (store.loadCookie().isNullOrBlank()) return
        scope.launch {
            runCatching {
                NativePushRegistrationClient(TrpcClient(store)).register(
                    installationId = installationId,
                    deviceKeyThumbprint = DeviceProofKey().publicKeyThumbprint(),
                )
            }
        }
    }

    /** Call before clearing the authenticated cookie. Never blocks logout beyond [timeoutMs]. */
    suspend fun revokeBeforeLogout(context: Context, timeoutMs: Long = 3_500): Boolean {
        if (!isConfigured(context)) return true
        val appContext = context.applicationContext
        val store = SecureSessionStore(appContext)
        if (store.loadCookie().isNullOrBlank()) return true
        val messaging = FirebaseMessaging.getInstance()
        val serverRevoked = withTimeoutOrNull(timeoutMs.coerceIn(1_000, 5_000)) {
            val client = NativePushRegistrationClient(TrpcClient(store))
            runCatching { client.revokeDevice() }.isSuccess
        } ?: false
        messaging.isAutoInitEnabled = false
        val localUnregistered = withTimeoutOrNull(timeoutMs.coerceIn(1_000, 5_000)) {
            runCatching { messaging.unregister().awaitResult() }.isSuccess
        } ?: false
        return serverRevoked && localUnregistered
    }

    fun isConfigured(context: Context): Boolean = runCatching {
        BuildConfig.REMOTE_PUSH_CONFIGURED && FirebaseApp.getApps(context).isNotEmpty()
    }.getOrDefault(false)

    private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
        addOnSuccessListener { result -> continuation.resume(result) }
        addOnFailureListener { error -> continuation.resumeWithException(error) }
        addOnCanceledListener { continuation.cancel() }
    }
}

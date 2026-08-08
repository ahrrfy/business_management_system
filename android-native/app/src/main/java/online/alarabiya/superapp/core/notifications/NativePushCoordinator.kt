package online.alarabiya.superapp.core.notifications

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.security.DeviceProofKey
import online.alarabiya.superapp.core.security.SecureSessionStore
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Push lifecycle entry point. Login/logout code can call these methods without depending on FCM
 * details. When environment Firebase configuration is absent it fails closed and performs no
 * network registration.
 */
object NativePushCoordinator {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val fcmRegistrationInFlight = AtomicBoolean(false)
    private val serverBindingInFlight = AtomicBoolean(false)
    private val pendingInstallationId = AtomicReference<String?>(null)

    fun registerExistingSession(context: Context) {
        if (!isConfigured(context)) return
        val appContext = context.applicationContext
        val store = SecureSessionStore(appContext)
        if (store.loadCookie().isNullOrBlank()) return
        if (!fcmRegistrationInFlight.compareAndSet(false, true)) return
        scope.launch {
            try {
                NativePushRetryPolicy.execute(
                    onFailure = { attempt, error -> logRetry("FCM client registration", attempt, error) },
                ) {
                    val messaging = FirebaseMessaging.getInstance()
                    messaging.isAutoInitEnabled = true
                    // The current FCM API delivers the Firebase Installation ID through onRegistered.
                    // Calling register on every authenticated startup also refreshes the server binding.
                    messaging.register().awaitResult()
                }
                Log.i(TAG, "FCM client registration ready")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.e(TAG, "FCM client registration exhausted retries: ${safeErrorType(error)}")
            } finally {
                fcmRegistrationInFlight.set(false)
            }
        }
    }

    fun installationRegistered(context: Context, installationId: String) {
        if (!isConfigured(context) || installationId.isBlank()) return
        val appContext = context.applicationContext
        val store = SecureSessionStore(appContext)
        if (store.loadCookie().isNullOrBlank()) return
        pendingInstallationId.set(installationId)
        drainPendingServerBinding(appContext)
    }

    private fun drainPendingServerBinding(appContext: Context) {
        if (!serverBindingInFlight.compareAndSet(false, true)) return
        scope.launch {
            try {
                val store = SecureSessionStore(appContext)
                while (true) {
                    val installationId = pendingInstallationId.getAndSet(null) ?: break
                    if (store.loadCookie().isNullOrBlank()) break
                    NativePushRetryPolicy.execute(
                        onFailure = { attempt, error -> logRetry("server push binding", attempt, error) },
                        shouldRetry = ::isRetryableServerBindingFailure,
                    ) {
                        NativePushRegistrationClient(TrpcClient(store)).register(
                            installationId = installationId,
                            deviceKeyThumbprint = DeviceProofKey().publicKeyThumbprint(),
                        )
                    }
                    Log.i(TAG, "Server push binding ready")
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.e(TAG, "Server push binding unavailable: ${safeErrorType(error)}")
            } finally {
                serverBindingInFlight.set(false)
                if (pendingInstallationId.get() != null) drainPendingServerBinding(appContext)
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

    private fun logRetry(stage: String, attempt: Int, error: Throwable) {
        Log.w(TAG, "$stage failed ($attempt/${NativePushRetryPolicy.maxAttempts}): ${safeErrorType(error)}")
    }

    private fun safeErrorType(error: Throwable): String = error::class.java.simpleName
        .takeIf { it.isNotBlank() }
        ?: "UnknownFailure"

    private fun isRetryableServerBindingFailure(error: Throwable): Boolean {
        val apiError = error as? ApiException ?: return false
        return apiError.retryableTransportFailure ||
            apiError.status == 408 ||
            apiError.status == 429 ||
            (apiError.status ?: 0) in 500..599
    }

    private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
        addOnSuccessListener { result -> continuation.resume(result) }
        addOnFailureListener { error -> continuation.resumeWithException(error) }
        addOnCanceledListener { continuation.cancel() }
    }

    private const val TAG = "NativePushCoordinator"
}

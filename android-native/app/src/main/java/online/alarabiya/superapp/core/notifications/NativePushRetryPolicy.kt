package online.alarabiya.superapp.core.notifications

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Bounded retry used only for idempotent FCM/FID registration operations. */
internal object NativePushRetryPolicy {
    const val maxAttempts = 4
    private val backoffMillis = longArrayOf(1_000L, 3_000L, 10_000L)

    fun backoffAfter(completedAttempts: Int): Long =
        backoffMillis.getOrElse((completedAttempts - 1).coerceAtLeast(0)) { backoffMillis.last() }

    suspend fun <T> execute(
        onFailure: (completedAttempts: Int, error: Throwable) -> Unit,
        shouldRetry: (error: Throwable) -> Boolean = { true },
        wait: suspend (Long) -> Unit = { delay(it) },
        operation: suspend () -> T,
    ): T {
        var completedAttempts = 0
        while (true) {
            try {
                return operation()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                completedAttempts += 1
                onFailure(completedAttempts, error)
                if (completedAttempts >= maxAttempts || !shouldRetry(error)) throw error
                wait(backoffAfter(completedAttempts))
            }
        }
    }
}

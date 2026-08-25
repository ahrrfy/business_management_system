package online.alarabiya.superapp.core.network

import java.util.concurrent.ThreadLocalRandom

/**
 * A deliberately small retry policy for transport reads. Mutations are never retried here because
 * a lost response does not prove that the server did not apply the write.
 *
 * 429 is retried because the server explicitly asked us to back off; without this the cashier would
 * stall at peak load (openings, back-to-school). The server's Retry-After hint is honored when
 * present, and a small random jitter is added on every wait so that N devices coming back from a
 * shared outage do not stampede in lockstep (rate-limit-peak-stoppage-2026-08-08 pattern).
 */
internal object IdempotentRequestRetryPolicy {
    const val maxAttempts = 3
    const val maxJitterMillis = 250L
    const val maxBackoffMillis = 15_000L
    private val backoffMillis = longArrayOf(250L, 750L)
    private val retryableStatuses = setOf(408, 429, 502, 503, 504)

    fun shouldRetry(method: String, completedAttempts: Int, error: Throwable): Boolean {
        if (!method.equals("GET", ignoreCase = true) || completedAttempts >= maxAttempts) return false
        val apiError = error as? ApiException ?: return false
        return apiError.retryableTransportFailure || apiError.status in retryableStatuses
    }

    fun backoffAfter(completedAttempts: Int, retryAfterMillis: Long? = null): Long {
        val base = backoffMillis.getOrElse((completedAttempts - 1).coerceAtLeast(0)) { backoffMillis.last() }
        val floor = retryAfterMillis?.coerceAtLeast(0L)?.let { maxOf(it, base) } ?: base
        return floor.coerceAtMost(maxBackoffMillis)
    }

    fun <T> execute(
        method: String,
        sleep: (Long) -> Unit = Thread::sleep,
        jitter: () -> Long = ::defaultJitterMillis,
        request: () -> T,
    ): T {
        var completedAttempts = 0
        while (true) {
            try {
                return request()
            } catch (error: ApiException) {
                completedAttempts += 1
                if (!shouldRetry(method, completedAttempts, error)) throw error
                val wait = backoffAfter(completedAttempts, error.retryAfterMillis) + jitter()
                try {
                    sleep(wait.coerceAtLeast(0L))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw error
                }
            }
        }
    }

    private fun defaultJitterMillis(): Long = ThreadLocalRandom.current().nextLong(0L, maxJitterMillis)
}

package online.alarabiya.superapp.core.network

/**
 * A deliberately small retry policy for transport reads. Mutations are never retried here because
 * a lost response does not prove that the server did not apply the write.
 */
internal object IdempotentRequestRetryPolicy {
    const val maxAttempts = 3
    private val backoffMillis = longArrayOf(250L, 750L)
    private val retryableStatuses = setOf(408, 502, 503, 504)

    fun shouldRetry(method: String, completedAttempts: Int, error: Throwable): Boolean {
        if (!method.equals("GET", ignoreCase = true) || completedAttempts >= maxAttempts) return false
        val apiError = error as? ApiException ?: return false
        return apiError.retryableTransportFailure || apiError.status in retryableStatuses
    }

    fun backoffAfter(completedAttempts: Int): Long =
        backoffMillis.getOrElse((completedAttempts - 1).coerceAtLeast(0)) { backoffMillis.last() }

    fun <T> execute(
        method: String,
        sleep: (Long) -> Unit = Thread::sleep,
        request: () -> T,
    ): T {
        var completedAttempts = 0
        while (true) {
            try {
                return request()
            } catch (error: ApiException) {
                completedAttempts += 1
                if (!shouldRetry(method, completedAttempts, error)) throw error
                try {
                    sleep(backoffAfter(completedAttempts))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw error
                }
            }
        }
    }
}

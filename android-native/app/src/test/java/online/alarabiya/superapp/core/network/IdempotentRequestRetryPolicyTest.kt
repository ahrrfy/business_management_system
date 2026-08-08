package online.alarabiya.superapp.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class IdempotentRequestRetryPolicyTest {
    @Test
    fun getRetriesBoundedTransportFailuresWithBackoff() {
        var calls = 0
        val waits = mutableListOf<Long>()

        val result = IdempotentRequestRetryPolicy.execute("GET", waits::add) {
            calls += 1
            if (calls < 3) throw ApiException("offline", retryableTransportFailure = true)
            "ready"
        }

        assertEquals("ready", result)
        assertEquals(3, calls)
        assertEquals(listOf(250L, 750L), waits)
    }

    @Test
    fun mutationsAreNeverRetriedEvenForTransportFailures() {
        var calls = 0

        assertThrows(ApiException::class.java) {
            IdempotentRequestRetryPolicy.execute("POST", sleep = {}) {
                calls += 1
                throw ApiException("uncertain write", retryableTransportFailure = true)
            }
        }

        assertEquals(1, calls)
    }

    @Test
    fun getRetriesTemporaryGatewayStatuses() {
        var calls = 0

        val result = IdempotentRequestRetryPolicy.execute("GET", sleep = {}) {
            calls += 1
            if (calls == 1) throw ApiException("unavailable", status = 503)
            "ready"
        }

        assertEquals("ready", result)
        assertEquals(2, calls)
    }

    @Test
    fun getDoesNotRetryApplicationOrValidationErrors() {
        var calls = 0

        assertThrows(ApiException::class.java) {
            IdempotentRequestRetryPolicy.execute("GET", sleep = {}) {
                calls += 1
                throw ApiException("invalid", status = 400)
            }
        }

        assertEquals(1, calls)
    }

    @Test
    fun interruptedBackoffStopsRetrying() {
        var calls = 0

        assertThrows(ApiException::class.java) {
            IdempotentRequestRetryPolicy.execute(
                method = "GET",
                sleep = { throw InterruptedException("stop") },
            ) {
                calls += 1
                throw ApiException("offline", retryableTransportFailure = true)
            }
        }

        assertEquals(1, calls)
        // Clear the test thread's interrupt flag so it cannot leak into the Gradle test worker.
        Thread.interrupted()
    }
}

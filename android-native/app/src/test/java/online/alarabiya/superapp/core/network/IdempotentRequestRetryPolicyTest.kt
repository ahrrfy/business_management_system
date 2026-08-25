package online.alarabiya.superapp.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class IdempotentRequestRetryPolicyTest {
    private val noJitter: () -> Long = { 0L }

    @Test
    fun getRetriesBoundedTransportFailuresWithBackoff() {
        var calls = 0
        val waits = mutableListOf<Long>()

        val result = IdempotentRequestRetryPolicy.execute(
            method = "GET",
            sleep = waits::add,
            jitter = noJitter,
        ) {
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
            IdempotentRequestRetryPolicy.execute("POST", sleep = {}, jitter = noJitter) {
                calls += 1
                throw ApiException("uncertain write", retryableTransportFailure = true)
            }
        }

        assertEquals(1, calls)
    }

    @Test
    fun getRetriesTemporaryGatewayStatuses() {
        var calls = 0

        val result = IdempotentRequestRetryPolicy.execute("GET", sleep = {}, jitter = noJitter) {
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
            IdempotentRequestRetryPolicy.execute("GET", sleep = {}, jitter = noJitter) {
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
                jitter = noJitter,
            ) {
                calls += 1
                throw ApiException("offline", retryableTransportFailure = true)
            }
        }

        assertEquals(1, calls)
        // Clear the test thread's interrupt flag so it cannot leak into the Gradle test worker.
        Thread.interrupted()
    }

    @Test
    fun rateLimitedRequestsAreRetried() {
        // Regression for H4: the cashier used to fail hard on 429 at peak load. Now the read is
        // retried after the recommended backoff so recoverable rate-limiting does not turn into
        // a user-visible failure.
        var calls = 0

        val result = IdempotentRequestRetryPolicy.execute("GET", sleep = {}, jitter = noJitter) {
            calls += 1
            if (calls == 1) throw ApiException("too many requests", status = 429)
            "ready"
        }

        assertEquals("ready", result)
        assertEquals(2, calls)
    }

    @Test
    fun retryAfterHintFromServerRaisesTheBackoffFloor() {
        val waits = mutableListOf<Long>()

        IdempotentRequestRetryPolicy.execute("GET", sleep = waits::add, jitter = noJitter) {
            if (waits.isEmpty()) {
                throw ApiException("too many requests", status = 429, retryAfterMillis = 5_000L)
            }
            "ready"
        }

        assertEquals(1, waits.size)
        // Server hint of 5s beats the local 250ms first-step so we do not stampede.
        assertEquals(5_000L, waits[0])
    }

    @Test
    fun retryAfterIsCappedSoTheUiStaysResponsive() {
        val waits = mutableListOf<Long>()

        IdempotentRequestRetryPolicy.execute("GET", sleep = waits::add, jitter = noJitter) {
            if (waits.isEmpty()) {
                throw ApiException("too many requests", status = 429, retryAfterMillis = 60_000L)
            }
            "ready"
        }

        // A pathological Retry-After (60 s) must not freeze the client for a minute.
        assertEquals(IdempotentRequestRetryPolicy.maxBackoffMillis, waits[0])
    }

    @Test
    fun jitterIsAddedToEveryWaitSoDevicesDoNotStampedeAtBoundary() {
        val waits = mutableListOf<Long>()
        // Deterministic jitter for the assertion — production uses a real random source.
        val fixedJitter = { 137L }

        IdempotentRequestRetryPolicy.execute("GET", sleep = waits::add, jitter = fixedJitter) {
            if (waits.size < 2) throw ApiException("offline", retryableTransportFailure = true)
            "ready"
        }

        assertEquals(listOf(250L + 137L, 750L + 137L), waits)
    }

    @Test
    fun defaultJitterFallsWithinAdvertisedBounds() {
        // The public production configuration must never wait longer than maxBackoffMillis +
        // maxJitterMillis on any single step, and never negative.
        repeat(200) {
            val waits = mutableListOf<Long>()
            IdempotentRequestRetryPolicy.execute("GET", sleep = waits::add) {
                if (waits.isEmpty()) throw ApiException("offline", retryableTransportFailure = true)
                "ready"
            }
            val wait = waits.single()
            assertTrue("wait must be positive: $wait", wait >= 0L)
            assertTrue(
                "wait must respect the announced ceiling",
                wait <= IdempotentRequestRetryPolicy.maxBackoffMillis + IdempotentRequestRetryPolicy.maxJitterMillis,
            )
        }
    }
}

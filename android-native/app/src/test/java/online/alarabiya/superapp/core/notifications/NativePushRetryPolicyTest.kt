package online.alarabiya.superapp.core.notifications

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class NativePushRetryPolicyTest {
    @Test
    fun registrationRetriesWithBoundedBackoffAndThenSucceeds() = runBlocking {
        var calls = 0
        val failures = mutableListOf<Int>()
        val waits = mutableListOf<Long>()

        val result = NativePushRetryPolicy.execute(
            onFailure = { attempt, _ -> failures += attempt },
            wait = { waits += it },
        ) {
            calls += 1
            if (calls < 4) error("temporary")
            "registered"
        }

        assertEquals("registered", result)
        assertEquals(4, calls)
        assertEquals(listOf(1, 2, 3), failures)
        assertEquals(listOf(1_000L, 3_000L, 10_000L), waits)
    }

    @Test
    fun registrationStopsAfterMaximumAttempts() {
        var calls = 0

        assertThrows(IllegalStateException::class.java) {
            runBlocking {
                NativePushRetryPolicy.execute(
                    onFailure = { _, _ -> Unit },
                    wait = {},
                ) {
                    calls += 1
                    error("still unavailable")
                }
            }
        }

        assertEquals(NativePushRetryPolicy.maxAttempts, calls)
    }

    @Test
    fun coroutineCancellationIsNeverRetriedOrLogged() {
        var calls = 0
        var loggedFailures = 0

        assertThrows(CancellationException::class.java) {
            runBlocking {
                NativePushRetryPolicy.execute(
                    onFailure = { _, _ -> loggedFailures += 1 },
                    wait = {},
                ) {
                    calls += 1
                    throw CancellationException("lifecycle stopped")
                }
            }
        }

        assertEquals(1, calls)
        assertEquals(0, loggedFailures)
    }

    @Test
    fun permanentRegistrationFailureIsNotRetried() {
        var calls = 0
        val waits = mutableListOf<Long>()

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                NativePushRetryPolicy.execute(
                    onFailure = { _, _ -> Unit },
                    shouldRetry = { false },
                    wait = { waits += it },
                ) {
                    calls += 1
                    throw IllegalArgumentException("invalid registration")
                }
            }
        }

        assertEquals(1, calls)
        assertEquals(emptyList<Long>(), waits)
    }
}

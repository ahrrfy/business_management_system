package online.alarabiya.superapp.core.network

import java.net.SocketTimeoutException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeChallengeFailureClassificationTest {
    @Test
    fun `challenge timeout is reported as retryable server transport failure`() {
        val cause = SocketTimeoutException("timed out")
        val error = nativeChallengeTransportError(cause)

        assertTrue(error.retryableTransportFailure)
        assertTrue(error.message.orEmpty().contains("خادم الشركة"))
        assertFalse(error.message.orEmpty().contains("حماية الجهاز"))
        assertSame(cause, error.cause)
    }
}

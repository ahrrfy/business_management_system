package online.alarabiya.superapp.data

import org.junit.Assert.assertThrows
import org.junit.Test

class LegalRepositoryTransportTest {
    @Test
    fun `accepts the same dev loopback policy as the API client`() {
        LegalRepository("http://10.0.2.2:3000", "dev")
    }

    @Test
    fun `rejects cleartext outside dev loopback`() {
        assertThrows(IllegalArgumentException::class.java) {
            LegalRepository("http://10.0.2.2:3000", "prod")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LegalRepository("http://example.test", "dev")
        }
    }
}

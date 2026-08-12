package online.alarabiya.superapp.core.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class DeviceProofThumbprintTest {
    @Test
    fun pushAndSessionUseTheSameServerBase64UrlThumbprintContract() {
        val spkiDer = Base64.getUrlDecoder().decode(SPKI_VECTOR)

        val actual = DeviceProofThumbprint.fromSpki(spkiDer)

        assertEquals(THUMBPRINT_VECTOR, actual)
        assertEquals(43, actual.length)
        assertTrue(actual.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        assertFalse(actual.matches(Regex("^[a-f0-9]{64}$")))
    }

    private companion object {
        const val SPKI_VECTOR = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVEO20KsqYittr-8CcyU3nyjf8Ev9Ptt-luhFicMxX8n4i2FJFeymOu2t3Ab9nCAgbSgz2NWDz92ATp0bWpPWoA"
        const val THUMBPRINT_VECTOR = "zpFtQhDQqNaoENCcVMAjOuasISgpZOuCpx4EvZvEi4Y"
    }
}

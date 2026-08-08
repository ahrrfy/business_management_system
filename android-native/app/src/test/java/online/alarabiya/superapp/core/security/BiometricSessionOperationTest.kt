package online.alarabiya.superapp.core.security

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher

class BiometricSessionOperationTest {
    @Test
    fun `accepts only the exact cipher returned through the prompt crypto object`() {
        val prepared = Cipher.getInstance("AES/GCM/NoPadding")
        val substituted = Cipher.getInstance("AES/GCM/NoPadding")
        val operation = BiometricSessionOperation(
            cipher = prepared,
            mode = BiometricOperationMode.UNLOCK,
            payload = byteArrayOf(1),
        )

        assertTrue(operation.accepts(prepared))
        assertFalse(operation.accepts(substituted))
        assertFalse(operation.accepts(null))
    }

    @Test
    fun `cancel erases the transient session key material`() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val operation = BiometricSessionOperation(
            cipher = Cipher.getInstance("AES/GCM/NoPadding"),
            mode = BiometricOperationMode.ENROLL,
            payload = payload,
        )

        operation.cancel()

        assertTrue(payload.all { it == 0.toByte() })
    }
}

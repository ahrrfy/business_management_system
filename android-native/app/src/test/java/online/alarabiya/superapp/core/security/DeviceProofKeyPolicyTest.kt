package online.alarabiya.superapp.core.security

import android.security.keystore.KeyProperties
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceProofKeyPolicyTest {
    @Test
    fun `unlocked-device authorization starts only after affected Android versions`() {
        assertFalse(DeviceProofKeyPolicy.requiresUnlockedDevice(28))
        assertFalse(DeviceProofKeyPolicy.requiresUnlockedDevice(31))
        assertFalse(DeviceProofKeyPolicy.requiresUnlockedDevice(34))
        assertTrue(DeviceProofKeyPolicy.requiresUnlockedDevice(35))
        assertTrue(DeviceProofKeyPolicy.requiresUnlockedDevice(36))
    }

    @Test
    fun `only secure hardware security levels are accepted`() {
        assertFalse(DeviceProofKeyPolicy.isSecureHardwareLevel(KeyProperties.SECURITY_LEVEL_UNKNOWN))
        assertFalse(DeviceProofKeyPolicy.isSecureHardwareLevel(KeyProperties.SECURITY_LEVEL_SOFTWARE))
        assertTrue(DeviceProofKeyPolicy.isSecureHardwareLevel(KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE))
        assertTrue(DeviceProofKeyPolicy.isSecureHardwareLevel(KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT))
        assertTrue(DeviceProofKeyPolicy.isSecureHardwareLevel(KeyProperties.SECURITY_LEVEL_STRONGBOX))
    }
}

package online.alarabiya.superapp.core.security

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceProofSourcePolicyTest {
    private fun source(): String {
        val candidates = listOf(
            File("src/main/java/online/alarabiya/superapp/core/security/DeviceProofKey.kt"),
            File("android-native/app/src/main/java/online/alarabiya/superapp/core/security/DeviceProofKey.kt"),
        )
        return candidates.firstOrNull(File::isFile)?.readText()
            ?: error("DeviceProofKey.kt was not found from ${File(".").absolutePath}")
    }

    @Test
    fun `installation proof remains available while device is locked`() {
        assertFalse(source().contains("setUnlockedDeviceRequired"))
    }

    @Test
    fun `production does not impose unverifiable hardware-only gate`() {
        assertFalse(source().contains("isHardwareBacked("))
        assertTrue(source().contains("setIsStrongBoxBacked(useStrongBox)"))
    }

    @Test
    fun `legacy key rotates and invalid aliases recover`() {
        val code = source()
        assertTrue(code.contains("alrueya_native_device_proof_v2"))
        assertTrue(code.contains("private fun loadExistingKeyPair(): KeyPair?"))
        assertTrue(code.contains("keyStore.deleteEntry(KEY_ALIAS)"))
    }
}

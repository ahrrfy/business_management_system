package online.alarabiya.superapp.feature.security

import online.alarabiya.superapp.data.TwoFactorAccountStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TwoFactorStateTest {
    @Test
    fun `authenticator validation accepts exactly six digits`() {
        assertTrue(TwoFactorValidation.authenticatorCode("123456"))
        assertTrue(TwoFactorValidation.authenticatorCode(" 123456 "))
        assertFalse(TwoFactorValidation.authenticatorCode("12345"))
        assertFalse(TwoFactorValidation.authenticatorCode("12345A"))
        assertFalse(TwoFactorValidation.authenticatorCode("١٢٣٤٥٦"))
    }

    @Test
    fun `credential validation rejects empty and oversized secrets`() {
        assertTrue(TwoFactorValidation.password("valid-password"))
        assertFalse(TwoFactorValidation.password("   "))
        assertFalse(TwoFactorValidation.password("x".repeat(129)))
        assertTrue(TwoFactorValidation.recoveryCode("ABCD-EFGH"))
        assertFalse(TwoFactorValidation.recoveryCode("short"))
    }

    @Test
    fun `ready state carries authoritative server status`() {
        val status = TwoFactorAccountStatus(
            enabled = true,
            pending = false,
            recoveryCodesRemaining = 8,
            cryptoReady = true,
        )
        val state = TwoFactorUiState(content = TwoFactorContent.Ready(status))

        assertTrue((state.content as TwoFactorContent.Ready).status.enabled)
        assertTrue(state.recoveryCodes.isEmpty())
    }

    @Test
    fun `settings entry is visible only to an authenticated server role`() {
        assertTrue(TwoFactorEntryPolicy.visible(authenticated = true, role = "employee"))
        assertTrue(TwoFactorEntryPolicy.visible(authenticated = true, role = "admin"))
        assertFalse(TwoFactorEntryPolicy.visible(authenticated = false, role = "admin"))
        assertFalse(TwoFactorEntryPolicy.visible(authenticated = true, role = ""))
    }

    @Test
    fun `authenticator navigation accepts only bounded totp links`() {
        assertTrue(AuthenticatorUriPolicy.canOpen("otpauth://totp/account?secret=ABCD2345"))
        assertFalse(AuthenticatorUriPolicy.canOpen("https://attacker.invalid/totp"))
        assertFalse(AuthenticatorUriPolicy.canOpen("otpauth://hotp/account?secret=ABCD2345"))
        assertFalse(AuthenticatorUriPolicy.canOpen("otpauth://totp/" + "x".repeat(2_048)))
    }
}

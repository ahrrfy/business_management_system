package online.alarabiya.superapp.feature.settings

import online.alarabiya.superapp.data.LegalPolicyMapper
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsStateTest {
    @Test
    fun `notification mapping updates only selected preference`() {
        val initial = preferences()

        NotificationSettingKey.entries.forEach { key ->
            val updated = SettingsStateMapper.updateNotification(initial, key, false)
            NotificationSettingKey.entries.forEach { candidate ->
                val expected = candidate != key
                assertEquals(expected, SettingsStateMapper.notificationValue(updated, candidate))
            }
            assertEquals("22:00", updated.quietHoursStart)
            assertEquals("07:00", updated.quietHoursEnd)
        }
    }

    @Test
    fun `account mapping prefers email and reports branch scope`() {
        val user = UserIdentity(
            id = 7,
            name = "موظف الاختبار",
            username = "employee",
            email = "employee@example.com",
            role = "manager",
            roleLabel = "مدير فرع",
        )

        val branchAccount = SettingsStateMapper.account(
            AppBootstrap(user, emptyList(), branchId = 12, allBranches = false),
        )
        val globalAccount = SettingsStateMapper.account(
            AppBootstrap(user, emptyList(), branchId = null, allBranches = true),
        )

        assertEquals("employee@example.com", branchAccount.identifier)
        assertEquals("مدير فرع", branchAccount.role)
        assertEquals("الفرع 12", branchAccount.branch)
        assertEquals("كل الفروع", globalAccount.branch)
    }

    @Test
    fun `legal mapping keeps public link on trusted relative path`() {
        val document = LegalPolicyMapper.fromValues(
            mapOf(
                "appName" to "سوبر العربية",
                "dataControllerName" to "شركة الرؤية العربية",
                "privacyContactEmail" to "privacy@example.com",
                "privacyPolicyVersion" to "2026-08-05",
                "privacyPath" to "/privacy",
            ),
            baseUrl = "https://example.com",
        )

        assertEquals("https://example.com/privacy", document.publicUrl)
        assertEquals("privacy@example.com", document.config.privacyContactEmail)
        assertTrue(document.sections.isNotEmpty())
    }

    @Test
    fun `legal mapping rejects untrusted path and malformed contact`() {
        val document = LegalPolicyMapper.fromValues(
            mapOf(
                "privacyContactEmail" to "not-an-email",
                "privacyPath" to "https://attacker.invalid/privacy",
            ),
            baseUrl = "https://example.com",
        )

        assertEquals("https://example.com/privacy", document.publicUrl)
        assertEquals("/privacy", document.config.privacyPath)
        assertNull(document.config.privacyContactEmail)
        assertFalse(document.sections.any { it.body.contains("attacker.invalid") })
    }

    private fun preferences() = NotificationPreferences(
        taskAssigned = true,
        payrollReady = true,
        attendance = true,
        leaveStatus = true,
        approvals = true,
        quietHoursStart = "22:00",
        quietHoursEnd = "07:00",
    )
}

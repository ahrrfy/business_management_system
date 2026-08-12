package online.alarabiya.superapp.feature.systemsettings

import online.alarabiya.superapp.model.systemsettings.SystemSettingsMappers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

class SystemSettingsMappersTest {
    @Test
    fun kioskCatalogExcludesRawTokenAndMasksNetworkAddress() {
        val device = SystemSettingsMappers.kioskDevices(
            JSONArray().put(
                JSONObject().put("id", 8).put("branchId", 2).put("branchName", "الكرادة")
                    .put("label", "قارئ المدخل").put("tokenPrefix", "kde_12345678")
                    .put("isActive", true).put("lastSeenIp", "192.168.8.44")
                    .put("rawToken", "must-never-enter-catalog"),
            ),
        ).single()

        assertEquals("192.168.8.•••", device.maskedLastSeenIp)
        assertFalse(device.toString().contains("must-never-enter-catalog"))
    }

    @Test
    fun oneTimeTokenRequiresActualRawSecret() {
        val token = SystemSettingsMappers.oneTimeKioskToken(
            JSONObject().put("id", 8).put("rawToken", "kde_one_time").put("tokenPrefix", "kde_one"),
        )
        assertEquals("kde_one_time", token.rawToken)
        org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            SystemSettingsMappers.oneTimeKioskToken(JSONObject().put("id", 8))
        }
    }
    @Test
    fun integrationMapperRetainsOnlySecretPresenceFlags() {
        val verify = "••••secret-tail"
        val app = "••••app-tail"
        val access = "••••access-tail"
        val mapped = SystemSettingsMappers.integrations(
            listOf(
                mapOf(
                    "id" to 9, "branchId" to 2, "branchName" to "الكرادة", "channel" to "WHATSAPP",
                    "verifyTokenMasked" to verify, "appSecretMasked" to app, "accessTokenMasked" to access,
                    "status" to "ACTIVE", "displayName" to "خدمة العملاء",
                ),
            ),
        ).single()

        assertTrue(mapped.hasVerifyToken)
        assertTrue(mapped.hasAppSecret)
        assertTrue(mapped.hasAccessToken)
        assertFalse(mapped.toString().contains(verify))
        assertFalse(mapped.toString().contains(app))
        assertFalse(mapped.toString().contains(access))
    }

    @Test
    fun safeSystemInfoDropsDatabaseHostPathAndConfirmationToken() {
        val info = SystemSettingsMappers.safeSystemInfo(
            mapOf(
                "db" to mapOf("name" to "erp_prod", "host" to "10.0.0.4"),
                "confirmToken" to "erp_prod",
                "counts" to mapOf("branches" to 3, "users" to 18, "products" to 120, "customers" to 88, "invoices" to 901),
                "backups" to mapOf("count" to 4, "totalKb" to 8000, "latest" to "2026-08-06", "dir" to "D:/secret/backups"),
                "printer" to mapOf("enabled" to true, "description" to "A4"),
                "schedule" to mapOf("dailyAt" to "02:00", "offsiteConfigured" to true),
            ),
        )

        assertEquals(18, info.counts.users)
        assertEquals(4, info.backups.count)
        assertTrue(info.printer.enabled)
        assertFalse(info.toString().contains("erp_prod"))
        assertFalse(info.toString().contains("10.0.0.4"))
        assertFalse(info.toString().contains("secret/backups"))
    }

    @Test
    fun backupCatalogKeepsOperationalMetadataAndDropsServerDirectory() {
        val mapped = SystemSettingsMappers.backups(
            mapOf(
                "dir" to "D:/secret/backups",
                "backups" to listOf(
                    mapOf("name" to "erp-2026-08-09.sql", "sizeKb" to 2048, "createdAt" to "2026-08-09T18:45:00Z"),
                ),
            ),
        ).single()

        assertEquals("erp-2026-08-09.sql", mapped.name)
        assertEquals(2048L, mapped.sizeKb)
        assertEquals("2026-08-09T18:45:00Z", mapped.createdAt)
        assertFalse(mapped.toString().contains("secret/backups"))
    }

    @Test
    fun whatsappMapperDetectsStructuredBusinessHoursWithoutRetainingRawJson() {
        val mapped = SystemSettingsMappers.waHub(
            mapOf(
                "triageMode" to "KEYWORD_ONLY",
                "autoTaskEnabled" to true,
                "businessHoursJson" to mapOf("monday" to listOf("09:00", "17:00")),
                "throttlePerMinute" to 25,
                "campaignApprovalThreshold" to 1000,
                "flowReservationNearExpiry" to true,
            ),
        )
        assertTrue(mapped.hasBusinessHours)
        assertEquals(25, mapped.throttlePerMinute)
        assertTrue(mapped.flowReservationNearExpiry)
        assertNull(mapped.welcomeReply)
        assertFalse(mapped.toString().contains("monday"))
    }
}

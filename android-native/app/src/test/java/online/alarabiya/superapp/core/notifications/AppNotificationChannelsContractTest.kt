package online.alarabiya.superapp.core.notifications

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNotificationChannelsContractTest {
    @Test
    fun `employee and system channels use fresh heads-up channel ids`() {
        val source = File(
            "src/main/java/online/alarabiya/superapp/core/notifications/AppNotificationChannels.kt",
        ).readText()

        assertTrue(source.contains("employee_updates_v2"))
        assertTrue(source.contains("system_updates_v2"))
        val highImportanceCount = "NotificationManager.IMPORTANCE_HIGH".toRegex()
            .findAll(source)
            .count()
        assertEquals(5, highImportanceCount)
    }
}

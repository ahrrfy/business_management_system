package online.alarabiya.superapp.core.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkStatusMonitorTest {
    @Test
    fun `network must provide validated internet`() {
        assertTrue(NetworkStatusMonitor.isUsable(hasInternet = true, validated = true))
    }

    @Test
    fun `captive or absent network is offline`() {
        assertFalse(NetworkStatusMonitor.isUsable(hasInternet = true, validated = false))
        assertFalse(NetworkStatusMonitor.isUsable(hasInternet = false, validated = false))
    }
}

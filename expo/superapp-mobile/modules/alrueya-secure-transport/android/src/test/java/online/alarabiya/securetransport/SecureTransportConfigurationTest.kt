package online.alarabiya.securetransport

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SecureTransportConfigurationTest {
  @Test
  fun productionRequiresACompiledPin() {
    val missingPin = SecureTransportConfiguration.parse(
      """{"environment":"production","baseUrl":"https://erp.example.test","spkiPins":[]}""",
    )
    val pinned = SecureTransportConfiguration.parse(
      """{"environment":"production","baseUrl":"https://erp.example.test","spkiPins":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}""",
    )

    assertFalse(missingPin.isConfigured)
    assertTrue(
      "configuration was rejected: ${pinned.statusReason}; endpoint=${pinned.baseUrl}; pins=${pinned.spkiPins.size}",
      pinned.isConfigured,
    )
  }

  @Test
  fun parsesTheExactVersionedAndroidResourceEnvelope() {
    val encoded = "base64url-v1:eyJlbnZpcm9ubWVudCI6InByb2R1Y3Rpb24iLCJiYXNlVXJsIjoiaHR0cHM6Ly9zcnYxNTQ4NDg3LmhzdGdyLmNsb3VkIiwic3BraVBpbnMiOlsiaGV5eDI0VnpnaWdMTlVLX3hyTU00SU9EWTBrTFIzM21qcWpnX2I4SFVQZyIsImJyenZ0Q0VMQ0laVW80c0RfcVBYMGNjUnRQc2QzRFk2UmZteHBPVTlvQjQiXX0"
    val configuration = SecureTransportConfiguration.parse(encoded)

    assertTrue("configuration was rejected: ${configuration.statusReason}", configuration.isConfigured)
    assertEquals("production", configuration.environment)
    assertEquals("https://srv1548487.hstgr.cloud", configuration.baseUrl)
    assertEquals(2, configuration.spkiPins.size)
  }

  @Test
  fun rejectsUnsafeOrAmbiguousEndpoints() {
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("http://erp.example.test", "development"))
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("https://user@erp.example.test", "production"))
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("https://erp.example.test/api", "production"))
    assertTrue(SecureTransportConfiguration.isAllowedEndpoint("https://erp.example.test", "production"))
  }
}

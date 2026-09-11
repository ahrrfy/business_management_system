package online.alarabiya.securetransport

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
  fun rejectsUnsafeOrAmbiguousEndpoints() {
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("http://erp.example.test", "development"))
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("https://user@erp.example.test", "production"))
    assertFalse(SecureTransportConfiguration.isAllowedEndpoint("https://erp.example.test/api", "production"))
    assertTrue(SecureTransportConfiguration.isAllowedEndpoint("https://erp.example.test", "production"))
  }
}

package online.alarabiya.securetransport

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.charset.StandardCharsets

@RunWith(RobolectricTestRunner::class)
class DeviceProofEncodingTest {
  @Test
  fun registrationMessageMatchesServerCanonicalFormat() {
    val ticket = "signed-ticket"
    val thumbprint = "thumbprint"

    val actual = String(
      DeviceProofEncoding.registrationMessage(ticket, thumbprint),
      StandardCharsets.UTF_8,
    )

    assertEquals(
      "ALRUEYA-NATIVE-REGISTER\n1\n" +
        DeviceProofEncoding.sha256Base64Url(ticket.toByteArray(StandardCharsets.UTF_8)) +
        "\nthumbprint",
      actual,
    )
  }

  @Test
  fun requestMessageMatchesServerCanonicalFormat() {
    val actual = String(
      DeviceProofEncoding.requestMessage(
        timestamp = 1_700_000_000_000,
        counter = 1_700_000_000_001,
        nonce = "nonce-value",
        sessionToken = "session-token",
        method = "post",
        target = "/api/trpc/superApp.mobileToday?batch=1",
        body = "{\"0\":{\"json\":null}}",
      ),
      StandardCharsets.UTF_8,
    )

    assertEquals(
      "ALRUEYA-NATIVE-REQUEST\n1\n1700000000000\n1700000000001\nnonce-value\n" +
        DeviceProofEncoding.sha256Base64Url("session-token".toByteArray(StandardCharsets.UTF_8)) +
        "\nPOST\n/api/trpc/superApp.mobileToday?batch=1\n" +
        DeviceProofEncoding.sha256Base64Url("{\"0\":{\"json\":null}}".toByteArray(StandardCharsets.UTF_8)),
      actual,
    )
  }
}

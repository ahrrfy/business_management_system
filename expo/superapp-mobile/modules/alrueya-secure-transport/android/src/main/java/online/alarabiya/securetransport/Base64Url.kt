package online.alarabiya.securetransport

import android.util.Base64
import java.nio.charset.StandardCharsets

internal object Base64Url {
  fun encode(value: ByteArray): String = Base64.encodeToString(
    value,
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )

  fun decode(value: String): ByteArray = Base64.decode(
    value,
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )

  fun validateRegistrationTicket(value: String) {
    if (
      value.isEmpty() ||
      value.toByteArray(StandardCharsets.UTF_8).size > 4096 ||
      value.contains('\r') ||
      value.contains('\n')
    ) {
      throw SecureTransportException(
        "E_SECURE_TRANSPORT_INVALID_TICKET",
        "The device registration ticket is invalid.",
      )
    }
  }
}

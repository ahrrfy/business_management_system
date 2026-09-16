package online.alarabiya.securetransport

import expo.modules.kotlin.exception.CodedException

internal class SecureTransportException(
  code: String,
  message: String,
  cause: Throwable? = null,
) : CodedException(code, message, cause)

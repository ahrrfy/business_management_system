package online.alarabiya.securetransport

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Shared wire contract with server/auth/deviceProof.ts. */
internal object DeviceProofEncoding {
  const val CLIENT_ID = "superapp-expo"
  const val CLIENT_VERSION = "1"
  const val PROOF_VERSION = "1"
  const val REGISTRATION_PREFIX = "ALRUEYA-NATIVE-REGISTER"
  const val REQUEST_PREFIX = "ALRUEYA-NATIVE-REQUEST"

  fun registrationMessage(ticket: String, keyThumbprint: String): ByteArray = listOf(
    REGISTRATION_PREFIX,
    PROOF_VERSION,
    sha256Base64Url(ticket.toByteArray(StandardCharsets.UTF_8)),
    keyThumbprint,
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  fun sha256Base64Url(value: ByteArray): String =
    Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(value))

  fun requestMessage(
    timestamp: Long,
    counter: Long,
    nonce: String,
    sessionToken: String,
    method: String,
    target: String,
    body: String,
  ): ByteArray = listOf(
    REQUEST_PREFIX,
    PROOF_VERSION,
    timestamp.toString(),
    counter.toString(),
    nonce,
    sha256Base64Url(sessionToken.toByteArray(StandardCharsets.UTF_8)),
    method.uppercase(),
    target,
    sha256Base64Url(body.toByteArray(StandardCharsets.UTF_8)),
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  fun nonce(): String = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
    .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
}

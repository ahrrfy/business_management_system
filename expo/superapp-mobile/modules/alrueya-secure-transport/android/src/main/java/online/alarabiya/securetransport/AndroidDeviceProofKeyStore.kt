package online.alarabiya.securetransport

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

internal data class AndroidDeviceProofKey(
  val privateKey: PrivateKey,
  val publicKey: PublicKey,
  val publicKeySpki: ByteArray,
)

/**
 * Stores only a non-exportable private P-256 key in Android Keystore. The
 * returned SPKI and thumbprint identify the device key; neither is a session
 * credential. StrongBox is preferred when available, but supported devices
 * without it retain the Android Keystore implementation instead of losing
 * access to the app.
 */
internal class AndroidDeviceProofKeyStore(context: Context) {
  private val keyAlias = "${context.packageName}.alrueya.device-proof.v1"

  fun getOrCreate(): AndroidDeviceProofKey = loadExisting() ?: generate()

  fun exists(): Boolean = keyStore().containsAlias(keyAlias)

  fun delete(): Boolean {
    val store = keyStore()
    if (!store.containsAlias(keyAlias)) return false
    store.deleteEntry(keyAlias)
    return true
  }

  fun signRegistration(ticket: String): AndroidDeviceProofKey {
    Base64Url.validateRegistrationTicket(ticket)
    return getOrCreate()
  }

  fun signatureForRegistration(key: AndroidDeviceProofKey, ticket: String): ByteArray = try {
    sign(key, DeviceProofEncoding.registrationMessage(ticket, DeviceProofEncoding.sha256Base64Url(key.publicKeySpki)))
  } catch (error: Exception) {
    throw SecureTransportException(
      "E_SECURE_TRANSPORT_SIGNING_UNAVAILABLE",
      "The device proof key could not sign the registration proof.",
      error,
    )
  }

  /**
   * Internal request proof only. JavaScript receives the server response, never
   * a signature, replay counter, or the session cookie used to create it.
   */
  fun signedRequestHeaders(
    method: String,
    target: String,
    body: String,
    sessionToken: String,
  ): Map<String, String> {
    val key = getOrCreate()
    val timestamp = System.currentTimeMillis()
    val counter = nextCounter(timestamp)
    val nonce = DeviceProofEncoding.nonce()
    val signature = sign(
      key,
      DeviceProofEncoding.requestMessage(
        timestamp = timestamp,
        counter = counter,
        nonce = nonce,
        sessionToken = sessionToken,
        method = method,
        target = target,
        body = body,
      ),
    )
    return baseHeaders(key.publicKeySpki) + mapOf(
      "X-Alrueya-Device-Timestamp" to timestamp.toString(),
      "X-Alrueya-Device-Counter" to counter.toString(),
      "X-Alrueya-Device-Nonce" to nonce,
      "X-Alrueya-Device-Signature" to Base64Url.encode(signature),
    )
  }

  fun registrationHeaders(ticket: String): Map<String, String> {
    val key = signRegistration(ticket)
    return baseHeaders(key.publicKeySpki) + mapOf(
      "X-Alrueya-Device-Challenge" to ticket,
      "X-Alrueya-Device-Signature" to Base64Url.encode(signatureForRegistration(key, ticket)),
    )
  }

  fun baseHeaders(): Map<String, String> = baseHeaders(null)

  private fun baseHeaders(publicKeySpki: ByteArray?): Map<String, String> = buildMap {
    put("X-Alrueya-Client", DeviceProofEncoding.CLIENT_ID)
    put("X-Alrueya-Client-Version", DeviceProofEncoding.CLIENT_VERSION)
    put("X-Alrueya-Device-Proof-Version", DeviceProofEncoding.PROOF_VERSION)
    if (publicKeySpki != null) put("X-Alrueya-Device-Key", Base64Url.encode(publicKeySpki))
  }

  private fun sign(key: AndroidDeviceProofKey, message: ByteArray): ByteArray = try {
    Signature.getInstance(SIGNATURE_ALGORITHM).run {
      initSign(key.privateKey)
      update(message)
      sign()
    }
  } catch (error: Exception) {
    throw SecureTransportException(
      "E_SECURE_TRANSPORT_SIGNING_UNAVAILABLE",
      "The device proof key could not sign the protected request.",
      error,
    )
  }

  private fun nextCounter(now: Long): Long {
    while (true) {
      val previous = requestCounter.get()
      val next = max(now, previous + 1)
      if (requestCounter.compareAndSet(previous, next)) return next
    }
  }

  private fun loadExisting(): AndroidDeviceProofKey? {
    val store = keyStore()
    if (!store.containsAlias(keyAlias)) return null
    return try {
      val privateKey = store.getKey(keyAlias, null) as? PrivateKey
      val publicKey = store.getCertificate(keyAlias)?.publicKey
      if (privateKey == null || publicKey == null) {
        store.deleteEntry(keyAlias)
        null
      } else {
        AndroidDeviceProofKey(privateKey, publicKey, publicKey.encoded)
      }
    } catch (_: Exception) {
      // Keystore aliases can be invalidated by a lock-screen reset or a vendor
      // migration. This is an installation credential, so rotate it; the next
      // authenticated registration binds the replacement key on the server.
      runCatching { store.deleteEntry(keyAlias) }
      null
    }
  }

  private fun generate(): AndroidDeviceProofKey {
    fun create(useStrongBox: Boolean): KeyPair = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      KEYSTORE_PROVIDER,
    ).run {
      initialize(keySpec(useStrongBox))
      generateKeyPair()
    }

    val pair = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) create(useStrongBox = true) else create(useStrongBox = false)
    } catch (_: Exception) {
      runCatching { keyStore().deleteEntry(keyAlias) }
      try {
        create(useStrongBox = false)
      } catch (error: Exception) {
        throw SecureTransportException(
          "E_SECURE_TRANSPORT_KEY_UNAVAILABLE",
          "A protected device proof key could not be created.",
          error,
        )
      }
    }

    return AndroidDeviceProofKey(pair.private, pair.public, pair.public.encoded)
  }

  private fun keySpec(useStrongBox: Boolean): KeyGenParameterSpec {
    val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
      .setDigests(KeyProperties.DIGEST_SHA256)
      // Step-up authentication belongs to a dedicated native user-presence
      // action. Requiring it on every registration would break background
      // retries without giving the server a stronger verifiable guarantee.
      .setUserAuthenticationRequired(false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(useStrongBox)
    }
    return builder.build()
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

  private companion object {
    val requestCounter = AtomicLong(System.currentTimeMillis())
    const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    const val CURVE = "secp256r1"
    const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
  }
}

package online.alarabiya.securetransport

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the bearer session completely inside the native layer. The key is a
 * non-exportable AES-GCM Android Keystore key, unlocked only for a short
 * system-authenticated window. JavaScript can ask whether a session exists but
 * can never read or set its cookie.
 */
internal class SecureNativeSessionStore(private val context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val keyAlias = "${context.packageName}.alrueya.session.v1"

  fun hasSession(): Boolean = preferences.contains(COOKIE_PAYLOAD)

  fun loadCookie(): String? {
    val encoded = preferences.getString(COOKIE_PAYLOAD, null) ?: return null
    return try {
      val bytes = Base64Url.decode(encoded)
      if (bytes.size <= IV_BYTES) throw IllegalArgumentException("Malformed session")
      val iv = bytes.copyOfRange(0, IV_BYTES)
      val cipherText = bytes.copyOfRange(IV_BYTES, bytes.size)
      val cipher = Cipher.getInstance(TRANSFORMATION).apply {
        init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
      }
      cipher.doFinal(cipherText).toString(Charsets.UTF_8).takeIf(::isSessionCookie)
        ?: throw IllegalArgumentException("Unexpected session cookie")
    } catch (_: Exception) {
      clear()
      null
    }
  }

  fun saveCookie(cookie: String) {
    require(isSessionCookie(cookie)) { "Invalid session cookie" }
    val iv = ByteArray(IV_BYTES).also(SecureRandom()::nextBytes)
    val cipher = Cipher.getInstance(TRANSFORMATION).apply {
      init(Cipher.ENCRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
    }
    val payload = iv + cipher.doFinal(cookie.toByteArray(Charsets.UTF_8))
    preferences.edit().putString(COOKIE_PAYLOAD, Base64Url.encode(payload)).apply()
  }

  fun clear() {
    preferences.edit().remove(COOKIE_PAYLOAD).apply()
    runCatching {
      KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(keyAlias)
    }
  }

  private fun getOrCreateKey(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(
        KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .setUserAuthenticationRequired(true)
          .also { builder ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
              builder.setUserAuthenticationParameters(
                AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
              )
            } else {
              @Suppress("DEPRECATION")
              builder.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
            }
          }
          .build(),
      )
      generateKey()
    }
  }

  private fun isSessionCookie(value: String): Boolean =
    value.startsWith("app_session_id=") && value.length in 18..8192 && !value.contains(';') && !value.contains('\n') && !value.contains('\r')

  private companion object {
    const val PREFERENCES = "alrueya_secure_transport"
    const val COOKIE_PAYLOAD = "session_cookie_v1"
    const val KEYSTORE = "AndroidKeyStore"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
    const val TAG_BITS = 128
    const val AUTH_VALIDITY_SECONDS = 30
  }
}

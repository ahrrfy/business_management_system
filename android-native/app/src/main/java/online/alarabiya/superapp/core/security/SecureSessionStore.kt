package online.alarabiya.superapp.core.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal enum class BiometricOperationMode { ENROLL, UNLOCK }

class BiometricSessionOperation internal constructor(
    val cipher: Cipher,
    internal val mode: BiometricOperationMode,
    internal val payload: ByteArray,
) {
    /** BiometricPrompt must return the exact CryptoObject prepared for this operation. */
    internal fun accepts(authenticatedCipher: Cipher?): Boolean = authenticatedCipher === cipher

    /** Erase the transient wrapped key input when the system prompt does not complete. */
    internal fun cancel() = payload.fill(0)
}

class BiometricSessionInvalidatedException(cause: Throwable? = null) :
    SecurityException("Biometric session key is no longer valid", cause)

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    @Volatile private var unlockedDataKey: SecretKey? = null

    /**
     * The cookie is encrypted with a random data key. In biometric mode that key exists at rest
     * only as an Android-Keystore, authentication-bound ciphertext. A locked process receives a
     * harmless non-session sentinel so the legacy `hasSession()` contract can still select the
     * locked screen without exposing the bearer cookie.
     */
    fun saveCookie(cookie: String) {
        val dataKey = if (isBiometricEnabled()) {
            unlockedDataKey ?: error("Biometric session is locked")
        } else {
            loadOrCreateStandardDataKey()
        }
        preferences.edit {
            putString(KEY_COOKIE_PAYLOAD, encryptWithKey(dataKey, cookie.toByteArray(Charsets.UTF_8)))
            remove(KEY_COOKIE_LEGACY)
        }
    }

    fun loadCookie(): String? {
        if (!hasPersistedSession()) return null
        if (isBiometricEnabled()) {
            val key = unlockedDataKey ?: return LOCKED_COOKIE_SENTINEL
            val cookie = decryptCookiePayload(key)
            if (cookie == null) invalidateBiometricSession()
            return cookie
        }
        val cookie = runCatching {
            decryptCookiePayload(loadOrCreateStandardDataKey())
        }.getOrNull()
        if (cookie == null) {
            clear()
        }
        return cookie
    }

    fun saveUserSnapshot(snapshot: String) = saveGeneralEncrypted(KEY_USER, snapshot)
    fun loadUserSnapshot(): String? = loadGeneralEncrypted(KEY_USER)

    fun setBiometricEnabled(enabled: Boolean) {
        if (enabled) {
            // Enrollment must have completed through BiometricPrompt + CryptoObject first.
            check(preferences.contains(KEY_DATA_KEY_BIOMETRIC)) {
                "Biometric protection must be enrolled through an authenticated CryptoObject"
            }
            preferences.edit { putBoolean(KEY_BIOMETRIC, true) }
            return
        }

        if (!isBiometricEnabled()) return
        val key = unlockedDataKey ?: return // Fail closed; a locked session cannot disable its guard.
        preferences.edit {
            putString(KEY_DATA_KEY_STANDARD, encryptWithKey(getOrCreateGeneralKey(), key.encoded))
            remove(KEY_DATA_KEY_BIOMETRIC)
            putBoolean(KEY_BIOMETRIC, false)
        }
        deleteKey(BIOMETRIC_KEY_ALIAS)
        unlockedDataKey = null
    }

    fun isBiometricEnabled(): Boolean = preferences.getBoolean(KEY_BIOMETRIC, false)

    /** Drop only the in-memory key. The encrypted session remains available for the next prompt. */
    fun lock() {
        unlockedDataKey = null
    }

    fun prepareBiometricEnrollment(): BiometricSessionOperation {
        val dataKey = when {
            isBiometricEnabled() && unlockedDataKey != null -> unlockedDataKey!!
            else -> loadOrCreateStandardDataKey()
        }
        check(decryptCookiePayload(dataKey) != null) { "No session is available to protect" }
        return BiometricSessionOperation(
            cipher = newBiometricCipher(Cipher.ENCRYPT_MODE),
            mode = BiometricOperationMode.ENROLL,
            payload = dataKey.encoded.copyOf(),
        )
    }

    fun prepareBiometricUnlock(): BiometricSessionOperation {
        check(isBiometricEnabled()) { "Biometric protection is not enabled" }
        val wrapped = preferences.getString(KEY_DATA_KEY_BIOMETRIC, null)
        if (wrapped == null) {
            // One-time secure migration for sessions created by the pre-CryptoObject client.
            return prepareBiometricEnrollment()
        }
        val blob = decodeBlob(wrapped)
        return BiometricSessionOperation(
            cipher = newBiometricCipher(Cipher.DECRYPT_MODE, blob.iv),
            mode = BiometricOperationMode.UNLOCK,
            payload = blob.ciphertext,
        )
    }

    /**
     * Must be called only with the Cipher returned by BiometricPrompt.AuthenticationResult.
     * `doFinal` is the security boundary: it fails unless Android Keystore observed a successful
     * strong biometric authentication for this exact operation.
     */
    fun completeBiometricOperation(operation: BiometricSessionOperation, authenticatedCipher: Cipher): Boolean {
        if (!operation.accepts(authenticatedCipher)) {
            operation.cancel()
            invalidateBiometricSession()
            return false
        }
        return try {
            when (operation.mode) {
                BiometricOperationMode.ENROLL -> {
                    val wrapped = authenticatedCipher.doFinal(operation.payload)
                    val key = SecretKeySpec(operation.payload.copyOf(), KeyProperties.KEY_ALGORITHM_AES)
                    check(decryptCookiePayload(key) != null) { "Session ciphertext is unavailable" }
                    preferences.edit {
                        putString(
                            KEY_DATA_KEY_BIOMETRIC,
                            encodeBlob(authenticatedCipher.iv, wrapped),
                        )
                        remove(KEY_DATA_KEY_STANDARD)
                        remove(KEY_COOKIE_LEGACY)
                        putBoolean(KEY_BIOMETRIC, true)
                    }
                    unlockedDataKey = key
                }

                BiometricOperationMode.UNLOCK -> {
                    val rawKey = authenticatedCipher.doFinal(operation.payload)
                    try {
                        require(rawKey.size == DATA_KEY_BYTES) { "Session data key has an invalid size" }
                        val key = SecretKeySpec(rawKey, KeyProperties.KEY_ALGORITHM_AES)
                        check(decryptCookiePayload(key) != null) { "Session ciphertext is unavailable" }
                        unlockedDataKey = key
                    } finally {
                        rawKey.fill(0)
                    }
                }
            }
            true
        } catch (error: Exception) {
            if (isPermanentKeyFailure(error)) {
                invalidateBiometricSession()
                throw BiometricSessionInvalidatedException(error)
            }
            // Any malformed envelope, mismatched CryptoObject, or failed GCM tag invalidates the
            // local bearer session instead of allowing a weaker retry path.
            invalidateBiometricSession()
            false
        } finally {
            operation.cancel()
        }
    }

    fun clear() {
        unlockedDataKey = null
        preferences.edit { clear() }
        deleteKey(BIOMETRIC_KEY_ALIAS)
        deleteKey(GENERAL_KEY_ALIAS)
    }

    fun invalidateBiometricSession() {
        unlockedDataKey = null
        preferences.edit {
            remove(KEY_COOKIE_PAYLOAD)
            remove(KEY_COOKIE_LEGACY)
            remove(KEY_DATA_KEY_STANDARD)
            remove(KEY_DATA_KEY_BIOMETRIC)
            putBoolean(KEY_BIOMETRIC, false)
        }
        deleteKey(BIOMETRIC_KEY_ALIAS)
    }

    private fun hasPersistedSession(): Boolean =
        preferences.contains(KEY_COOKIE_PAYLOAD) || preferences.contains(KEY_COOKIE_LEGACY)

    private fun loadOrCreateStandardDataKey(): SecretKey {
        preferences.getString(KEY_DATA_KEY_STANDARD, null)?.let { wrapped ->
            val raw = decryptWithKey(getOrCreateGeneralKey(), wrapped)
            if (raw.size == DATA_KEY_BYTES) {
                val key = SecretKeySpec(raw, KeyProperties.KEY_ALGORITHM_AES)
                raw.fill(0)
                return key
            }
            raw.fill(0)
            clear()
            error("Stored session data key is invalid")
        }

        val raw = ByteArray(DATA_KEY_BYTES).also { SecureRandom().nextBytes(it) }
        val key = SecretKeySpec(raw, KeyProperties.KEY_ALGORITHM_AES)
        val legacyCookie = loadGeneralEncrypted(KEY_COOKIE_LEGACY)
        preferences.edit {
            putString(KEY_DATA_KEY_STANDARD, encryptWithKey(getOrCreateGeneralKey(), raw))
            if (legacyCookie != null && !preferences.contains(KEY_COOKIE_PAYLOAD)) {
                putString(KEY_COOKIE_PAYLOAD, encryptWithKey(key, legacyCookie.toByteArray(Charsets.UTF_8)))
            }
            remove(KEY_COOKIE_LEGACY)
        }
        raw.fill(0)
        return key
    }

    private fun decryptCookiePayload(key: SecretKey): String? = runCatching {
        val encoded = preferences.getString(KEY_COOKIE_PAYLOAD, null) ?: return null
        String(decryptWithKey(key, encoded), Charsets.UTF_8)
    }.getOrNull()

    private fun saveGeneralEncrypted(key: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateGeneralKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        preferences.edit { putString(key, encodeBlob(cipher.iv, ciphertext)) }
    }

    private fun loadGeneralEncrypted(key: String): String? = runCatching {
        val encoded = preferences.getString(key, null) ?: return null
        val blob = decodeBlob(encoded)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateGeneralKey(),
            GCMParameterSpec(GCM_TAG_BITS, blob.iv),
        )
        String(cipher.doFinal(blob.ciphertext), Charsets.UTF_8)
    }.getOrNull()

    private fun encryptWithKey(key: SecretKey, plaintext: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return encodeBlob(cipher.iv, cipher.doFinal(plaintext))
    }

    private fun decryptWithKey(key: SecretKey, encoded: String): ByteArray {
        val blob = decodeBlob(encoded)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob.iv))
        return cipher.doFinal(blob.ciphertext)
    }

    private fun newBiometricCipher(mode: Int, iv: ByteArray? = null): Cipher {
        try {
            val key = if (mode == Cipher.DECRYPT_MODE) {
                getExistingBiometricKey() ?: run {
                    invalidateBiometricSession()
                    throw BiometricSessionInvalidatedException()
                }
            } else {
                getOrCreateBiometricKey()
            }
            return Cipher.getInstance(TRANSFORMATION).apply {
                if (mode == Cipher.ENCRYPT_MODE) init(mode, key)
                else init(mode, key, GCMParameterSpec(GCM_TAG_BITS, requireNotNull(iv)))
            }
        } catch (error: Exception) {
            if (isPermanentKeyFailure(error)) {
                invalidateBiometricSession()
                throw BiometricSessionInvalidatedException(error)
            }
            throw error
        }
    }

    private fun getOrCreateGeneralKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(GENERAL_KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    GENERAL_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun getExistingBiometricKey(): SecretKey? =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .getKey(BIOMETRIC_KEY_ALIAS, null) as? SecretKey

    private fun getOrCreateBiometricKey(): SecretKey {
        getExistingBiometricKey()?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            val spec = KeyGenParameterSpec.Builder(
                BIOMETRIC_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            } else {
                @Suppress("DEPRECATION")
                spec.setUserAuthenticationValidityDurationSeconds(-1)
            }
            init(spec.build())
            generateKey()
        }
    }

    private fun encodeBlob(iv: ByteArray, ciphertext: ByteArray): String =
        Base64.encodeToString(EncryptedBlobCodec.pack(iv, ciphertext), Base64.NO_WRAP)

    private fun decodeBlob(encoded: String): EncryptedBlob =
        EncryptedBlobCodec.unpack(Base64.decode(encoded, Base64.NO_WRAP))

    private fun deleteKey(alias: String) {
        runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        }
    }

    private fun isPermanentKeyFailure(error: Throwable): Boolean {
        var current: Throwable? = error
        while (current != null) {
            if (current is KeyPermanentlyInvalidatedException) return true
            if (current is InvalidKeyException && current.message?.contains("invalidated", ignoreCase = true) == true) {
                return true
            }
            current = current.cause
        }
        return false
    }

    private companion object {
        const val PREFS_NAME = "alrueya_secure_session"
        const val GENERAL_KEY_ALIAS = "alrueya_native_session_v1"
        const val BIOMETRIC_KEY_ALIAS = "alrueya_native_biometric_v2"
        const val KEY_COOKIE_LEGACY = "session_cookie"
        const val KEY_COOKIE_PAYLOAD = "session_cookie_v2"
        const val KEY_DATA_KEY_STANDARD = "session_data_key_standard_v2"
        const val KEY_DATA_KEY_BIOMETRIC = "session_data_key_biometric_v2"
        const val KEY_USER = "user_snapshot"
        const val KEY_BIOMETRIC = "biometric_enabled"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val DATA_KEY_BYTES = 32
        const val LOCKED_COOKIE_SENTINEL = "__alrueya_locked__=1"
    }
}

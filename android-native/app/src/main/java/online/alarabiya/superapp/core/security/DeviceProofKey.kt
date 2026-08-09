package online.alarabiya.superapp.core.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import online.alarabiya.superapp.BuildConfig
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

data class NativeDeviceChallenge(
    val ticket: String,
    val expiresAt: Long,
)

class DeviceProofUnavailableException(cause: Throwable? = null) :
    SecurityException("تعذر تهيئة حماية الجهاز", cause)

/**
 * Owns a non-exportable P-256 signing key in Android Keystore. StrongBox is requested first and
 * falls back to the device TEE; production refuses a software-only key.
 */
class DeviceProofKey {
    /** SHA-256(SPKI DER), base64url without padding — exactly the server session `dpk` format. */
    fun publicKeyThumbprint(): String =
        DeviceProofThumbprint.fromSpki(getOrCreateKeyPair().public.encoded)

    fun registrationHeaders(challenge: NativeDeviceChallenge): Map<String, String> {
        check(challenge.expiresAt * 1000L >= System.currentTimeMillis()) { "Device challenge expired" }
        val keyPair = getOrCreateKeyPair()
        val publicKey = keyPair.public.encoded
        val thumbprint = DeviceProofThumbprint.fromSpki(publicKey)
        val message = listOf(
            "ALRUEYA-NATIVE-REGISTER",
            PROOF_VERSION,
            sha256(challenge.ticket.toByteArray(Charsets.UTF_8)),
            thumbprint,
        ).joinToString("\n")
        return baseHeaders(publicKey) + mapOf(
            HEADER_CHALLENGE to challenge.ticket,
            HEADER_SIGNATURE to sign(keyPair, message),
        )
    }

    fun sessionHeaders(
        method: String,
        target: String,
        body: String,
        sessionToken: String,
    ): Map<String, String> {
        val keyPair = getOrCreateKeyPair()
        val timestamp = System.currentTimeMillis()
        val requestCounter = nextCounter(timestamp)
        val nonce = ByteArray(NONCE_BYTES).also { SecureRandom().nextBytes(it) }.toBase64Url()
        val message = listOf(
            "ALRUEYA-NATIVE-REQUEST",
            PROOF_VERSION,
            timestamp.toString(),
            requestCounter.toString(),
            nonce,
            sha256(sessionToken.toByteArray(Charsets.UTF_8)),
            method.uppercase(),
            target,
            sha256(body.toByteArray(Charsets.UTF_8)),
        ).joinToString("\n")
        return baseHeaders(keyPair.public.encoded) + mapOf(
            HEADER_TIMESTAMP to timestamp.toString(),
            HEADER_COUNTER to requestCounter.toString(),
            HEADER_NONCE to nonce,
            HEADER_SIGNATURE to sign(keyPair, message),
        )
    }

    fun clear() {
        runCatching {
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS)
        }
        counter.set(System.currentTimeMillis())
    }

    private fun baseHeaders(publicKey: ByteArray): Map<String, String> = mapOf(
        HEADER_CLIENT to CLIENT_ID,
        HEADER_CLIENT_VERSION to CLIENT_VERSION,
        HEADER_PROOF_VERSION to PROOF_VERSION,
        HEADER_PUBLIC_KEY to publicKey.toBase64Url(),
    )

    private fun sign(keyPair: KeyPair, message: String): String = try {
        Signature.getInstance(SIGNATURE_ALGORITHM).run {
            initSign(keyPair.private)
            update(message.toByteArray(Charsets.UTF_8))
            sign().toBase64Url()
        }
    } catch (error: Exception) {
        throw DeviceProofUnavailableException(error)
    }

    private fun getOrCreateKeyPair(): KeyPair {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val privateKey = keyStore.getKey(KEY_ALIAS, null)
        val publicKey = keyStore.getCertificate(KEY_ALIAS)?.publicKey
        val pair = if (privateKey != null && publicKey != null) {
            KeyPair(publicKey, privateKey as java.security.PrivateKey)
        } else {
            generateKeyPair(preferStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        }
        if (BuildConfig.ENVIRONMENT == "prod" && !isHardwareBacked(pair)) {
            clear()
            throw DeviceProofUnavailableException()
        }
        return pair
    }

    private fun generateKeyPair(preferStrongBox: Boolean): KeyPair {
        fun buildSpec(useStrongBox: Boolean): KeyGenParameterSpec {
            val builder = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // Android 12-14 cannot create or use unlocked-device-required keys when a secure
                // lock screen is absent. Android documents the issue as fixed in Android 15, so
                // keep the authorization there without excluding otherwise supported tablets.
                if (!BuildConfig.DEBUG && DeviceProofKeyPolicy.requiresUnlockedDevice(Build.VERSION.SDK_INT)) {
                    builder.setUnlockedDeviceRequired(true)
                }
                builder.setIsStrongBoxBacked(useStrongBox)
            }
            return builder.build()
        }

        fun generate(useStrongBox: Boolean): KeyPair =
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
                initialize(buildSpec(useStrongBox))
                generateKeyPair()
            }

        if (!preferStrongBox) return generate(false)
        return try {
            generate(true)
        } catch (_: Exception) {
            runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS) }
            try {
                generate(false)
            } catch (error: Exception) {
                throw DeviceProofUnavailableException(error)
            }
        }
    }

    private fun isHardwareBacked(keyPair: KeyPair): Boolean = runCatching {
        val keyInfo = KeyFactory.getInstance(keyPair.private.algorithm, KEYSTORE)
            .getKeySpec(keyPair.private, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            DeviceProofKeyPolicy.isSecureHardwareLevel(keyInfo.securityLevel)
        } else {
            @Suppress("DEPRECATION")
            keyInfo.isInsideSecureHardware
        }
    }.getOrDefault(false)

    private fun nextCounter(now: Long): Long {
        while (true) {
            val previous = counter.get()
            val next = max(now, previous + 1)
            if (counter.compareAndSet(previous, next)) return next
        }
    }

    private fun sha256(value: ByteArray): String =
        DeviceProofThumbprint.sha256Base64Url(value)

    private fun ByteArray.toBase64Url(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(this)

    private companion object {
        // Shared by every TrpcClient in the process (foreground UI + push worker) so two valid
        // callers cannot emit the same or out-of-order proof counter.
        val counter = AtomicLong(System.currentTimeMillis())
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "alrueya_native_device_proof_v1"
        const val CURVE = "secp256r1"
        const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
        const val NONCE_BYTES = 16
        const val CLIENT_ID = "android-native"
        const val CLIENT_VERSION = "2"
        const val PROOF_VERSION = "1"
        const val HEADER_CLIENT = "X-Alrueya-Client"
        const val HEADER_CLIENT_VERSION = "X-Alrueya-Client-Version"
        const val HEADER_PROOF_VERSION = "X-Alrueya-Device-Proof-Version"
        const val HEADER_PUBLIC_KEY = "X-Alrueya-Device-Key"
        const val HEADER_CHALLENGE = "X-Alrueya-Device-Challenge"
        const val HEADER_TIMESTAMP = "X-Alrueya-Device-Timestamp"
        const val HEADER_COUNTER = "X-Alrueya-Device-Counter"
        const val HEADER_NONCE = "X-Alrueya-Device-Nonce"
        const val HEADER_SIGNATURE = "X-Alrueya-Device-Signature"
    }
}

/** Pure policy kept outside Android Keystore calls so compatibility decisions are unit tested. */
internal object DeviceProofKeyPolicy {
    // setUnlockedDeviceRequired() has known Android 12-14 defects and is safe to enable from 15.
    fun requiresUnlockedDevice(apiLevel: Int): Boolean = apiLevel >= 35

    fun isSecureHardwareLevel(securityLevel: Int): Boolean = securityLevel in setOf(
        KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE,
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
        KeyProperties.SECURITY_LEVEL_STRONGBOX,
    )
}

/** Pure JVM contract used by Android device proof and its unit tests. */
internal object DeviceProofThumbprint {
    fun fromSpki(spkiDer: ByteArray): String = sha256Base64Url(spkiDer)

    fun sha256Base64Url(value: ByteArray): String = Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(value))
}

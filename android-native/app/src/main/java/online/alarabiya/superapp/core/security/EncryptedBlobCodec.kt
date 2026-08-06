package online.alarabiya.superapp.core.security

internal data class EncryptedBlob(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

/**
 * Binary envelope used for every AES-GCM value persisted by [SecureSessionStore].
 * Keeping the codec Android-free lets the corruption boundaries be unit-tested on the JVM.
 */
internal object EncryptedBlobCodec {
    const val IV_BYTES = 12

    fun pack(iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(iv.size == IV_BYTES) { "AES-GCM IV must be exactly $IV_BYTES bytes" }
        require(ciphertext.isNotEmpty()) { "AES-GCM ciphertext must not be empty" }
        return ByteArray(iv.size + ciphertext.size).also { packed ->
            iv.copyInto(packed, 0)
            ciphertext.copyInto(packed, iv.size)
        }
    }

    fun unpack(packed: ByteArray): EncryptedBlob {
        require(packed.size > IV_BYTES) { "Encrypted value is truncated" }
        return EncryptedBlob(
            iv = packed.copyOfRange(0, IV_BYTES),
            ciphertext = packed.copyOfRange(IV_BYTES, packed.size),
        )
    }
}

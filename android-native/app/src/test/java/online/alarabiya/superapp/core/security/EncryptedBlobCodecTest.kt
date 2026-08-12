package online.alarabiya.superapp.core.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EncryptedBlobCodecTest {
    @Test
    fun `pack and unpack preserve the complete encrypted value`() {
        val iv = ByteArray(EncryptedBlobCodec.IV_BYTES) { it.toByte() }
        val ciphertext = byteArrayOf(12, 34, 56, 78, 90)

        val unpacked = EncryptedBlobCodec.unpack(EncryptedBlobCodec.pack(iv, ciphertext))

        assertArrayEquals(iv, unpacked.iv)
        assertArrayEquals(ciphertext, unpacked.ciphertext)
    }

    @Test
    fun `pack rejects a non standard gcm iv`() {
        assertThrows(IllegalArgumentException::class.java) {
            EncryptedBlobCodec.pack(ByteArray(EncryptedBlobCodec.IV_BYTES - 1), byteArrayOf(1))
        }
    }

    @Test
    fun `pack rejects an empty ciphertext`() {
        assertThrows(IllegalArgumentException::class.java) {
            EncryptedBlobCodec.pack(ByteArray(EncryptedBlobCodec.IV_BYTES), byteArrayOf())
        }
    }

    @Test
    fun `unpack rejects a truncated encrypted value`() {
        assertThrows(IllegalArgumentException::class.java) {
            EncryptedBlobCodec.unpack(ByteArray(EncryptedBlobCodec.IV_BYTES))
        }
    }
}

package online.alarabiya.superapp.model.operations

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64

object AssetDocumentEncoding {
    const val MAX_RAW_BYTES: Int = 2_500_000

    private val acceptedMimeTypes = setOf("image/jpeg", "image/png", "image/webp")

    fun encode(bytes: ByteArray, mimeType: String): String {
        val mime = mimeType.lowercase()
        require(mime in acceptedMimeTypes) { "نوع الصورة غير مدعوم" }
        require(bytes.isNotEmpty()) { "ملف الصورة فارغ" }
        require(bytes.size <= MAX_RAW_BYTES) { "حجم الصورة يتجاوز الحد المسموح" }
        return "data:$mime;base64,${Base64.getEncoder().encodeToString(bytes)}"
            .also { require(it.length <= 3_500_000) { "حجم الصورة بعد الترميز يتجاوز الحد المسموح" } }
    }

    fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= MAX_RAW_BYTES) { "حجم الصورة يتجاوز الحد المسموح" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }
}

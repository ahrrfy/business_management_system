package online.alarabiya.superapp.core.scanner

enum class NativeScanField {
    BARCODE,
    SKU_OR_BARCODE,
    DOCUMENT_REFERENCE,
    LATIN_REFERENCE_SEARCH,
    PASSWORD,
    DATE,
    AMOUNT,
}

enum class NativeScanEngine { BARCODE, OCR }

private val LatinReferencePattern = Regex("[\\p{IsLatin}\\p{N}\\p{Punct}\\p{Zs}]+")

fun NativeScanField.scanEngineOrNull(): NativeScanEngine? = when (this) {
    NativeScanField.BARCODE,
    NativeScanField.SKU_OR_BARCODE,
    -> NativeScanEngine.BARCODE

    NativeScanField.DOCUMENT_REFERENCE,
    NativeScanField.LATIN_REFERENCE_SEARCH,
    -> NativeScanEngine.OCR

    NativeScanField.PASSWORD,
    NativeScanField.DATE,
    NativeScanField.AMOUNT,
    -> null
}

fun normalizeNativeScanResult(field: NativeScanField, rawValue: String): String? {
    if (field.scanEngineOrNull() == null) return null
    val normalized = when (field.scanEngineOrNull()) {
        NativeScanEngine.BARCODE -> rawValue.trim().replace(Regex("[\\r\\n\\t]+"), "")
        NativeScanEngine.OCR -> rawValue.trim().replace(Regex("\\s+"), " ")
        null -> return null
    }
    if (normalized.isBlank() || normalized.any(Char::isISOControl)) return null
    if (field.scanEngineOrNull() == NativeScanEngine.OCR && !LatinReferencePattern.matches(normalized)) return null
    val limit = when (field) {
        NativeScanField.BARCODE, NativeScanField.SKU_OR_BARCODE -> 128
        NativeScanField.DOCUMENT_REFERENCE -> 160
        NativeScanField.LATIN_REFERENCE_SEARCH -> 240
        else -> return null
    }
    return normalized.take(limit)
}

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

private val AllowedNumberTypes = setOf(
    Character.DECIMAL_DIGIT_NUMBER.toInt(),
    Character.LETTER_NUMBER.toInt(),
    Character.OTHER_NUMBER.toInt(),
)

private val AllowedPunctuationTypes = setOf(
    Character.CONNECTOR_PUNCTUATION.toInt(),
    Character.DASH_PUNCTUATION.toInt(),
    Character.START_PUNCTUATION.toInt(),
    Character.END_PUNCTUATION.toInt(),
    Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
    Character.FINAL_QUOTE_PUNCTUATION.toInt(),
    Character.OTHER_PUNCTUATION.toInt(),
)

private val InvisibleBarcodeMarks = Regex("[\\u00ad\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]")
private val EdgeScannerFraming = Regex("^[\\s\\u0000-\\u001f\\u007f-\\u009f]+|[\\s\\u0000-\\u001f\\u007f-\\u009f]+$")
private val UnsupportedBarcodeWhitespace = Regex("[\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]")

/** نفس عقد هوية الباركود في الخادم: framing طرفي، أرقام عربية، وعلامات RTL الخفية. */
fun normalizeNativeBarcode(rawValue: String): String? {
    val visible = rawValue.replace(InvisibleBarcodeMarks, "").replace(EdgeScannerFraming, "")
    val normalized = buildString(visible.length) {
        visible.forEach { char ->
            append(
                when (char) {
                    in '٠'..'٩' -> ('0'.code + (char.code - '٠'.code)).toChar()
                    in '۰'..'۹' -> ('0'.code + (char.code - '۰'.code)).toChar()
                    else -> char
                },
            )
        }
    }
    if (normalized.isBlank() || normalized.any(Char::isISOControl) || UnsupportedBarcodeWhitespace.containsMatchIn(normalized)) return null
    return normalized
}

private fun gtinCheckDigit(body: String, firstWeight: Int): Int {
    val sum = body.mapIndexed { index, char -> (char - '0') * if (index % 2 == 0) firstWeight else 4 - firstWeight }.sum()
    return (10 - sum % 10) % 10
}

fun nativeBarcodeCandidates(rawValue: String): List<String> {
    val code = normalizeNativeBarcode(rawValue) ?: return emptyList()
    val upc = code.length == 12 && code.all(Char::isDigit) && (code.last() - '0') == gtinCheckDigit(code.dropLast(1), 3)
    val ean = code.length == 13 && code.startsWith('0') && code.all(Char::isDigit) && (code.last() - '0') == gtinCheckDigit(code.dropLast(1), 1)
    return when {
        upc -> listOf(code, "0$code")
        ean -> listOf(code, code.drop(1))
        else -> listOf(code)
    }
}

fun nativeBarcodesEquivalent(left: String, right: String): Boolean {
    val rightKeys = nativeBarcodeCandidates(right).map(String::lowercase).toSet()
    return nativeBarcodeCandidates(left).any { it.lowercase() in rightKeys }
}

sealed interface NativeBarcodeResolution<out T> {
    data object NoMatch : NativeBarcodeResolution<Nothing>
    data object Ambiguous : NativeBarcodeResolution<Nothing>
    data class Unique<T>(val value: T, val normalizedBarcode: String) : NativeBarcodeResolution<T>
}

/** Resolves a scan by business identity, so aliases on one item do not create false ambiguity. */
fun <T> resolveNativeBarcode(
    rawValue: String,
    candidates: Iterable<T>,
    identity: (T) -> Any,
    barcodes: (T) -> Iterable<String>,
): NativeBarcodeResolution<T> {
    val normalized = normalizeNativeBarcode(rawValue) ?: return NativeBarcodeResolution.NoMatch
    val matchedIdentities = mutableSetOf<Any>()
    val matches = mutableListOf<T>()
    for (candidate in candidates) {
        if (barcodes(candidate).none { nativeBarcodesEquivalent(it, normalized) }) continue
        if (!matchedIdentities.add(identity(candidate))) continue
        matches += candidate
        if (matches.size > 1) return NativeBarcodeResolution.Ambiguous
    }
    return matches.singleOrNull()?.let { NativeBarcodeResolution.Unique(it, normalized) }
        ?: NativeBarcodeResolution.NoMatch
}

/**
 * A keyboard Enter is HID evidence only after a compact burst of single-character text mutations.
 * Pasted or manually submitted text therefore stays SEARCH_PICK and cannot satisfy SCAN_REQUIRED.
 */
class HidWedgeClassifier(
    private val maxInterKeyMillis: Long = 50,
    private val maxTerminatorDelayMillis: Long = 80,
    private val minimumDataKeys: Int = 3,
) {
    private var dataKeyCount = 0
    private var lastDataKeyAt: Long? = null

    init {
        require(maxInterKeyMillis > 0)
        require(maxTerminatorDelayMillis > 0)
        require(minimumDataKeys >= 2)
    }

    fun recordDataKey(eventTimeMillis: Long) {
        val previous = lastDataKeyAt
        if (previous != null && (eventTimeMillis < previous || eventTimeMillis - previous > maxInterKeyMillis)) {
            reset()
        }
        dataKeyCount += 1
        lastDataKeyAt = eventTimeMillis
    }

    fun consumeTerminator(eventTimeMillis: Long): Boolean {
        val previous = lastDataKeyAt
        val hid = previous != null &&
            dataKeyCount >= minimumDataKeys &&
            eventTimeMillis >= previous &&
            eventTimeMillis - previous <= maxTerminatorDelayMillis
        reset()
        return hid
    }

    fun reset() {
        dataKeyCount = 0
        lastDataKeyAt = null
    }
}

private fun isLatinReference(value: String): Boolean {
    var index = 0
    while (index < value.length) {
        val codePoint = value.codePointAt(index)
        val type = Character.getType(codePoint)
        val allowed = when {
            Character.isLetter(codePoint) ->
                Character.UnicodeScript.of(codePoint) == Character.UnicodeScript.LATIN
            type in AllowedNumberTypes -> true
            type == Character.SPACE_SEPARATOR.toInt() -> true
            type in AllowedPunctuationTypes -> true
            else -> false
        }
        if (!allowed) return false
        index += Character.charCount(codePoint)
    }
    return value.isNotEmpty()
}

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
        NativeScanEngine.BARCODE -> normalizeNativeBarcode(rawValue) ?: return null
        NativeScanEngine.OCR -> rawValue.trim().replace(Regex("\\s+"), " ")
        null -> return null
    }
    if (normalized.isBlank() || normalized.any(Char::isISOControl)) return null
    if (field.scanEngineOrNull() == NativeScanEngine.OCR && !isLatinReference(normalized)) return null
    val limit = when (field) {
        NativeScanField.BARCODE -> 64
        NativeScanField.SKU_OR_BARCODE -> 120
        NativeScanField.DOCUMENT_REFERENCE -> 160
        NativeScanField.LATIN_REFERENCE_SEARCH -> 240
        else -> return null
    }
    return normalized.takeIf { it.length <= limit }
}

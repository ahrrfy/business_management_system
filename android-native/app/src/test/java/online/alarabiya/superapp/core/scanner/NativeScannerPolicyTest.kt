package online.alarabiya.superapp.core.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeScannerPolicyTest {
    @Test
    fun `scanner is forbidden for secrets dates and amounts`() {
        assertNull(NativeScanField.PASSWORD.scanEngineOrNull())
        assertNull(NativeScanField.DATE.scanEngineOrNull())
        assertNull(NativeScanField.AMOUNT.scanEngineOrNull())
        assertNull(normalizeNativeScanResult(NativeScanField.PASSWORD, "secret"))
    }

    @Test
    fun `barcode and sku fields use Play services barcode analysis`() {
        assertEquals(NativeScanEngine.BARCODE, NativeScanField.BARCODE.scanEngineOrNull())
        assertEquals(NativeScanEngine.BARCODE, NativeScanField.SKU_OR_BARCODE.scanEngineOrNull())
        assertEquals("ABC-120045", normalizeNativeScanResult(NativeScanField.SKU_OR_BARCODE, " ABC-120045\n"))
    }

    @Test
    fun `document and search fields use OCR with bounded whitespace`() {
        assertEquals(NativeScanEngine.OCR, NativeScanField.DOCUMENT_REFERENCE.scanEngineOrNull())
        assertEquals(NativeScanEngine.OCR, NativeScanField.LATIN_REFERENCE_SEARCH.scanEngineOrNull())
        assertEquals("INV-2026-51 Baghdad", normalizeNativeScanResult(NativeScanField.DOCUMENT_REFERENCE, " INV-2026-51\n Baghdad "))
        assertEquals("Réf-2026", normalizeNativeScanResult(NativeScanField.DOCUMENT_REFERENCE, "Réf-2026"))
        assertNull(normalizeNativeScanResult(NativeScanField.DOCUMENT_REFERENCE, "فاتورة INV-2026-51"))
        assertNull(normalizeNativeScanResult(NativeScanField.DOCUMENT_REFERENCE, "INV-2026-51 🔒"))
    }

    @Test
    fun `blank and control-only results are rejected`() {
        assertNull(normalizeNativeScanResult(NativeScanField.BARCODE, " \n\t "))
        assertNull(normalizeNativeScanResult(NativeScanField.LATIN_REFERENCE_SEARCH, "\u0000"))
    }

    @Test
    fun `barcode normalization matches server identity contract`() {
        assertEquals("10095", normalizeNativeBarcode("\u200f\u2060\u00ad ١٠٠٩٥\r\n"))
        assertNull(normalizeNativeBarcode("AB\t12"))
        assertTrue(nativeBarcodesEquivalent("0036000291452", "036000291452"))
        assertFalse(nativeBarcodesEquivalent("000123", "00123"))
        assertNull(normalizeNativeScanResult(NativeScanField.BARCODE, "A".repeat(65)))
    }
}

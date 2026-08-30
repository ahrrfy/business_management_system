package online.alarabiya.superapp.ui.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class OcrImagePreparationTest {
    @Test
    fun `camera images at or below the OCR bound are not resampled`() {
        assertEquals(1, calculateOcrSampleSize(2_048, 1_536))
        assertEquals(1, calculateOcrSampleSize(1_080, 1_920))
    }

    @Test
    fun `large camera images use a power-of-two sample that bounds the longest edge`() {
        assertEquals(2, calculateOcrSampleSize(3_000, 2_000))
        assertEquals(8, calculateOcrSampleSize(12_000, 9_000))
    }

    @Test
    fun `invalid image bounds are rejected before decoding`() {
        assertThrows(IllegalArgumentException::class.java) { calculateOcrSampleSize(0, 1_000) }
        assertThrows(IllegalArgumentException::class.java) { calculateOcrSampleSize(1_000, -1) }
        assertThrows(IllegalArgumentException::class.java) { calculateOcrSampleSize(1_000, 1_000, 0) }
    }
}

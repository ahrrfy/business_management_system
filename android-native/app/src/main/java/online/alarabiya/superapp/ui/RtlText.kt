package online.alarabiya.superapp.ui

import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.core.text.BidiFormatter

private val rtlFormatter = BidiFormatter.getInstance(true)

/** Keeps server-provided identifiers, references, and mixed-script values stable in RTL UI. */
fun rtlIsolate(value: String): String = rtlFormatter.unicodeWrap(value)

/** A predictable visual direction for dates, identifiers, and numeric entry in Arabic forms. */
@Composable
fun ltrInputTextStyle(): TextStyle = LocalTextStyle.current.copy(
    textDirection = TextDirection.Ltr,
    textAlign = TextAlign.Right,
)

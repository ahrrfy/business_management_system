package online.alarabiya.superapp.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Ink = Color(0xFF1D1930)
val MutedInk = Color(0xFF777286)
// The public names are retained to avoid a risky cross-module rename; the selected Super App
// visual language is violet/lavender throughout the native client.
val Emerald = Color(0xFF5B36D2)
val EmeraldDark = Color(0xFF362087)
val Mint = Color(0xFFF0ECFF)
val Orange = Color(0xFFEC2F86)
val OrangeSoft = Color(0xFFFFEAF4)
val Canvas = Color(0xFFF8F7FC)
val Surface = Color(0xFFFFFFFF)
val Stroke = Color(0xFFE5E0F1)

private val AppColors = lightColorScheme(
    primary = Emerald,
    onPrimary = Color.White,
    primaryContainer = Mint,
    onPrimaryContainer = EmeraldDark,
    secondary = Orange,
    onSecondary = Color.White,
    secondaryContainer = Mint,
    onSecondaryContainer = EmeraldDark,
    background = Canvas,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = Color(0xFFF1EEFA),
    onSurfaceVariant = MutedInk,
    outline = Stroke,
    error = Color(0xFFBA1A1A),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(topStart = 24.dp, topEnd = 16.dp, bottomEnd = 24.dp, bottomStart = 16.dp),
    large = RoundedCornerShape(topStart = 32.dp, topEnd = 20.dp, bottomEnd = 32.dp, bottomStart = 20.dp),
    extraLarge = RoundedCornerShape(topStart = 42.dp, topEnd = 26.dp, bottomEnd = 42.dp, bottomStart = 26.dp),
)

@Composable
fun AlrueyaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AppColors,
        shapes = AppShapes,
        typography = MaterialTheme.typography.copy(
            headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 35.sp, lineHeight = 45.sp),
            headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 27.sp, lineHeight = 37.sp),
            titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 23.sp, lineHeight = 32.sp),
            titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 27.sp),
            bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 17.sp, lineHeight = 28.sp),
            bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 24.sp),
            labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 24.sp),
            labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 21.sp),
        ),
        content = content,
    )
}

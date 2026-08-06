package online.alarabiya.superapp.ui

import android.animation.ValueAnimator
import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import online.alarabiya.superapp.R

internal const val BRAND_LAUNCH_MINIMUM_DURATION_MILLIS = 1_180L
internal const val BRAND_LAUNCH_REDUCED_MOTION_DURATION_MILLIS = 180L

internal fun brandLaunchRemainingMillis(
    startedAtMillis: Long,
    nowMillis: Long,
    motionEnabled: Boolean = true,
): Long {
    val minimumDuration = if (motionEnabled) {
        BRAND_LAUNCH_MINIMUM_DURATION_MILLIS
    } else {
        BRAND_LAUNCH_REDUCED_MOTION_DURATION_MILLIS
    }
    return (minimumDuration - (nowMillis - startedAtMillis)).coerceAtLeast(0L)
}

internal fun brandLaunchPhase(progress: Float, start: Float, end: Float): Float {
    if (end <= start) return if (progress >= end) 1f else 0f
    return ((progress - start) / (end - start)).coerceIn(0f, 1f)
}

@Composable
internal fun BrandLaunchHost(
    sessionState: AppSessionState,
    launchAnimationReady: Boolean,
    onVisibilityChanged: (Boolean) -> Unit = {},
    content: @Composable BoxScope.() -> Unit,
) {
    var launchVisible by rememberSaveable { mutableStateOf(true) }
    var launchStartedAt by rememberSaveable { mutableStateOf<Long?>(null) }
    var contentMounted by rememberSaveable { mutableStateOf(false) }
    val motionEnabled = remember { ValueAnimator.areAnimatorsEnabled() }
    val appIsStarting = sessionState is AppSessionState.Starting || sessionState is AppSessionState.Loading

    LaunchedEffect(launchVisible) {
        onVisibilityChanged(launchVisible)
    }

    // Start only after the platform splash has handed the frame to Compose. Startup work continues
    // behind this layer, so the choreography consumes real bootstrap time instead of adding it.
    LaunchedEffect(launchAnimationReady) {
        if (launchAnimationReady && launchStartedAt == null) {
            withFrameNanos { }
            launchStartedAt = SystemClock.elapsedRealtime()
        }
    }
    LaunchedEffect(appIsStarting, launchVisible, launchStartedAt, motionEnabled) {
        val startedAt = launchStartedAt
        if (launchVisible && !appIsStarting && startedAt != null) {
            delay(
                brandLaunchRemainingMillis(
                    startedAtMillis = startedAt,
                    nowMillis = SystemClock.elapsedRealtime(),
                    motionEnabled = motionEnabled,
                ),
            )
            // Mount the destination only after the one-shot choreography. Its first composition
            // can be expensive on a cold process; keeping the completed brand frame above it
            // prevents that work from stealing frames from the entrance motion.
            contentMounted = true
            withFrameNanos { }
            if (motionEnabled) delay(72)
            launchVisible = false
        }
    }

    Box(Modifier.fillMaxSize()) {
        if (contentMounted || !launchVisible) content()
        AnimatedVisibility(
            visible = launchVisible,
            enter = fadeIn(animationSpec = tween(if (motionEnabled) 90 else 0)),
            exit = fadeOut(
                animationSpec = tween(
                    durationMillis = if (motionEnabled) 240 else 0,
                    easing = FastOutSlowInEasing,
                ),
            ),
            label = "brand-launch-visibility",
        ) {
            BrandLaunchScreen(
                startAnimation = launchAnimationReady,
                motionEnabled = motionEnabled,
                accessibilityStatus = when (sessionState) {
                    AppSessionState.Starting -> "جارٍ بدء سوبر العربية"
                    is AppSessionState.Loading -> sessionState.message
                    else -> "سوبر العربية جاهز"
                },
            )
        }
    }
}

@Composable
private fun BrandLaunchScreen(
    accessibilityStatus: String,
    startAnimation: Boolean,
    motionEnabled: Boolean,
) {
    val timeline = remember { Animatable(0f) }
    LaunchedEffect(startAnimation, motionEnabled) {
        if (!startAnimation) return@LaunchedEffect
        if (motionEnabled) {
            timeline.animateTo(
                targetValue = 1f,
                animationSpec = tween(
                    durationMillis = BRAND_LAUNCH_MINIMUM_DURATION_MILLIS.toInt(),
                    easing = LinearEasing,
                ),
            )
        } else {
            timeline.snapTo(1f)
        }
    }

    val progress = timeline.value
    val curtainProgress = easedPhase(progress, 0f, .43f)
    val orbitProgress = easedPhase(progress, .08f, .61f)
    val logoProgress = easedPhase(progress, .13f, .64f)
    val wordmarkProgress = easedPhase(progress, .46f, .82f)
    val railProgress = easedPhase(progress, .70f, .96f)
    val waitingMotion = rememberInfiniteTransition(label = "brand-launch-waiting")
    val waitingPosition by waitingMotion.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_450, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "brand-launch-waiting-position",
    )

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        Color(0xFF17122E),
                        Color(0xFF2A1767),
                        Color(0xFF4D2BBC),
                    ),
                ),
            )
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .semantics {
                contentDescription = accessibilityStatus
                liveRegion = LiveRegionMode.Polite
            }
            .testTag("brand-launch"),
    ) {
        val tablet = maxWidth >= 600.dp
        val logoSize = if (tablet) 154.dp else 126.dp
        val orbitSize = if (tablet) 248.dp else 204.dp

        CurvedLaunchBackdrop(
            reveal = curtainProgress,
            modifier = Modifier.fillMaxSize(),
        )

        // A quiet optical anchor prevents the top of tall devices and tablets from feeling empty.
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = if (tablet) 42.dp else 26.dp)
                .width(if (tablet) 44.dp else 36.dp)
                .height(4.dp)
                .graphicsLayer { alpha = curtainProgress * .72f }
                .clip(RoundedCornerShape(100.dp))
                .background(Color.White),
        )

        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .offset(y = if (tablet) (-34).dp else (-24).dp)
                .fillMaxWidth()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier.size(orbitSize),
                contentAlignment = Alignment.Center,
            ) {
                BrandOrbit(
                    progress = orbitProgress,
                    modifier = Modifier.fillMaxSize(),
                )
                BrandMark(
                    size = logoSize,
                    progress = logoProgress,
                )
            }

            Spacer(Modifier.height(if (tablet) 24.dp else 15.dp))
            Column(
                modifier = Modifier.graphicsLayer {
                    alpha = wordmarkProgress
                    translationY = (1f - wordmarkProgress) * 24.dp.toPx()
                    scaleX = .96f + (.04f * wordmarkProgress)
                    scaleY = .96f + (.04f * wordmarkProgress)
                },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = "سوبر العربية",
                    color = Color.White,
                    fontSize = if (tablet) 39.sp else 33.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-.35).sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .width(if (tablet) 88.dp else 74.dp)
                        .height(3.dp)
                        .clip(RoundedCornerShape(100.dp))
                        .background(
                            Brush.horizontalGradient(
                                colors = listOf(
                                    Color.Transparent,
                                    Color(0xFFFF7EB3),
                                    Color(0xFFBCA7FF),
                                    Color.Transparent,
                                ),
                            ),
                        ),
                )
            }
        }

        BrandProgressRail(
            reveal = railProgress,
            waitingPosition = if (motionEnabled) waitingPosition else 1f,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = if (tablet) 54.dp else 34.dp),
        )
    }
}

@Composable
private fun CurvedLaunchBackdrop(reveal: Float, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val accentTop = floatLerp(size.height * 1.04f, size.height * .735f, reveal)
        val panelTop = accentTop + (9.dp.toPx() * reveal)

        val accentPath = Path().apply {
            moveTo(0f, accentTop + size.height * .035f)
            cubicTo(
                size.width * .19f,
                accentTop - size.height * .055f,
                size.width * .54f,
                accentTop + size.height * .065f,
                size.width,
                accentTop - size.height * .018f,
            )
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        }
        drawPath(
            path = accentPath,
            brush = Brush.horizontalGradient(
                colors = listOf(Color(0xFFFF5FA2), Color(0xFF9B7BFF), Color(0xFF65D9E8)),
            ),
            alpha = .82f * reveal,
        )

        val panelPath = Path().apply {
            moveTo(0f, panelTop + size.height * .04f)
            cubicTo(
                size.width * .23f,
                panelTop - size.height * .04f,
                size.width * .57f,
                panelTop + size.height * .055f,
                size.width,
                panelTop - size.height * .012f,
            )
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        }
        drawPath(path = panelPath, color = Color(0xFFFAF9FF), alpha = reveal)

        val glowCenter = Offset(size.width * .5f, size.height * .38f)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0xFFBDA9FF).copy(alpha = .18f), Color.Transparent),
                center = glowCenter,
                radius = size.minDimension * .48f,
            ),
            radius = size.minDimension * .48f,
            center = glowCenter,
            alpha = reveal,
        )
    }
}

@Composable
private fun BrandOrbit(progress: Float, modifier: Modifier = Modifier) {
    Canvas(
        modifier = modifier.graphicsLayer {
            alpha = progress
            rotationZ = -28f + (28f * progress)
            scaleX = .86f + (.14f * progress)
            scaleY = .86f + (.14f * progress)
        },
    ) {
        val inset = 10.dp.toPx()
        val outer = Rect(inset, inset, size.width - inset, size.height - inset)
        val innerInset = 24.dp.toPx()
        val inner = Rect(innerInset, innerInset, size.width - innerInset, size.height - innerInset)

        drawArc(
            brush = Brush.sweepGradient(
                colors = listOf(
                    Color.Transparent,
                    Color(0xFFFF8ABB),
                    Color.White,
                    Color(0xFFBCA7FF),
                    Color.Transparent,
                ),
            ),
            startAngle = 202f,
            sweepAngle = 238f * progress,
            useCenter = false,
            topLeft = outer.topLeft,
            size = outer.size,
            style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round),
        )
        drawArc(
            color = Color.White.copy(alpha = .32f),
            startAngle = 18f,
            sweepAngle = 124f * progress,
            useCenter = false,
            topLeft = inner.topLeft,
            size = inner.size,
            style = Stroke(width = 1.dp.toPx(), cap = StrokeCap.Round),
        )
        drawCircle(
            color = Color(0xFFFF7EB3),
            radius = 4.5.dp.toPx() * progress,
            center = Offset(size.width * .16f, size.height * .69f),
        )
        drawCircle(
            color = Color(0xFF88E5EF),
            radius = 3.dp.toPx() * progress,
            center = Offset(size.width * .83f, size.height * .28f),
        )
    }
}

@Composable
private fun BrandMark(size: Dp, progress: Float) {
    val shape = RoundedCornerShape(
        topStart = size * .31f,
        topEnd = size * .17f,
        bottomEnd = size * .31f,
        bottomStart = size * .17f,
    )
    Box(
        modifier = Modifier
            .size(size)
            .graphicsLayer {
                alpha = progress
                scaleX = .72f + (.28f * progress)
                scaleY = .72f + (.28f * progress)
                translationY = (1f - progress) * 28.dp.toPx()
                rotationZ = -3.5f + (3.5f * progress)
            }
            .shadow(
                elevation = 30.dp,
                shape = shape,
                ambientColor = Color.Black.copy(alpha = .26f),
                spotColor = Color(0xFF170C3B).copy(alpha = .5f),
            )
            .clip(shape)
            .background(Color.White)
            .border(1.dp, Color.White.copy(alpha = .9f), shape)
            .padding(7.dp)
            .semantics { contentDescription = "شعار سوبر العربية" },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(R.mipmap.ic_maskable),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun BrandProgressRail(
    reveal: Float,
    waitingPosition: Float,
    modifier: Modifier = Modifier,
) {
    Canvas(
        modifier = modifier
            .width(112.dp)
            .height(18.dp)
            .graphicsLayer { alpha = reveal },
    ) {
        val railHeight = 4.dp.toPx()
        val railTop = (size.height - railHeight) / 2f
        drawRoundRect(
            color = Color(0xFFDED8F0),
            topLeft = Offset(0f, railTop),
            size = Size(size.width, railHeight),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(railHeight),
        )
        val segmentWidth = size.width * .34f
        val travel = size.width + segmentWidth
        val segmentStart = (waitingPosition * travel) - segmentWidth
        drawRoundRect(
            brush = Brush.horizontalGradient(
                colors = listOf(Color(0xFF6D4BE5), Color(0xFFFF5FA2)),
                startX = segmentStart,
                endX = segmentStart + segmentWidth,
            ),
            topLeft = Offset(segmentStart.coerceAtLeast(0f), railTop),
            size = Size(
                width = segmentWidth.coerceAtMost(size.width - segmentStart.coerceAtLeast(0f)),
                height = railHeight,
            ),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(railHeight),
        )
    }
}

private fun easedPhase(progress: Float, start: Float, end: Float): Float =
    FastOutSlowInEasing.transform(brandLaunchPhase(progress, start, end))

private fun floatLerp(start: Float, end: Float, fraction: Float): Float =
    start + ((end - start) * fraction.coerceIn(0f, 1f))

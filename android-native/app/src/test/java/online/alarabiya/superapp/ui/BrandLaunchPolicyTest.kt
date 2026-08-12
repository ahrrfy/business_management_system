package online.alarabiya.superapp.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class BrandLaunchPolicyTest {
    @Test
    fun `keeps the minimum brand sequence without adding extra delay`() {
        assertEquals(1_180L, brandLaunchRemainingMillis(startedAtMillis = 1_000L, nowMillis = 1_000L))
        assertEquals(580L, brandLaunchRemainingMillis(startedAtMillis = 1_000L, nowMillis = 1_600L))
        assertEquals(0L, brandLaunchRemainingMillis(startedAtMillis = 1_000L, nowMillis = 2_300L))
    }

    @Test
    fun `reduced motion shows a stable brand frame without waiting for choreography`() {
        assertEquals(
            180L,
            brandLaunchRemainingMillis(
                startedAtMillis = 1_000L,
                nowMillis = 1_000L,
                motionEnabled = false,
            ),
        )
        assertEquals(
            0L,
            brandLaunchRemainingMillis(
                startedAtMillis = 1_000L,
                nowMillis = 1_200L,
                motionEnabled = false,
            ),
        )
    }

    @Test
    fun `startup work can never hold the brand layer indefinitely`() {
        assertEquals(
            2_500L,
            brandLaunchExitDelayMillis(
                startedAtMillis = 1_000L,
                nowMillis = 1_000L,
                appIsStarting = true,
            ),
        )
        assertEquals(
            100L,
            brandLaunchExitDelayMillis(
                startedAtMillis = 1_000L,
                nowMillis = 3_400L,
                appIsStarting = true,
            ),
        )
        assertEquals(
            0L,
            brandLaunchExitDelayMillis(
                startedAtMillis = 1_000L,
                nowMillis = 3_600L,
                appIsStarting = true,
            ),
        )
    }

    @Test
    fun `ready content exits after the shorter minimum sequence`() {
        assertEquals(
            580L,
            brandLaunchExitDelayMillis(
                startedAtMillis = 1_000L,
                nowMillis = 1_600L,
                appIsStarting = false,
            ),
        )
    }

    @Test
    fun `motion phases clamp before and after their choreography window`() {
        assertEquals(0f, brandLaunchPhase(.1f, .2f, .6f))
        assertEquals(.5f, brandLaunchPhase(.4f, .2f, .6f), .0001f)
        assertEquals(1f, brandLaunchPhase(.9f, .2f, .6f))
    }
}

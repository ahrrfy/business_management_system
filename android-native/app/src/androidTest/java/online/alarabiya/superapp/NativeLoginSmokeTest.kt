package online.alarabiya.superapp

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeLoginSmokeTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun nativeLoginSurfaceRendersWithoutBrowserChrome() {
        composeRule.onNodeWithText("سوبر العربية").assertIsDisplayed()
        composeRule.onNodeWithText("تسجيل الدخول").assertIsDisplayed()
        composeRule.onNodeWithText("اسم المستخدم أو البريد").assertIsDisplayed()
        composeRule.onNodeWithText("كلمة المرور").assertIsDisplayed()
    }

    @Test
    fun rememberDeviceUsesOneNamedToggleTarget() {
        composeRule.onNodeWithTag("remember_device")
            .assertIsDisplayed()
            .assertHasClickAction()
            .assertIsOn()
            .performClick()
            .assertIsOff()
    }

    @Test
    fun emptyLoginShowsAccessibleInlineError() {
        composeRule.onNodeWithTag("login_submit").performClick()
        composeRule.onNodeWithTag("login_error").assertIsDisplayed()
        composeRule.onNodeWithText("أدخل اسم المستخدم أو البريد وكلمة المرور").assertIsDisplayed()
    }
}

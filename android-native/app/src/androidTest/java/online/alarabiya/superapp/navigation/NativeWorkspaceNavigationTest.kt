package online.alarabiya.superapp.navigation

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.flow.MutableSharedFlow
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.data.ApprovalsDataSource
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalDecisionReceipt
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.selfservice.LeaveBalances
import online.alarabiya.superapp.model.selfservice.NotificationCenter
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.SelfServiceWorkspace
import online.alarabiya.superapp.ui.AppSessionState
import online.alarabiya.superapp.ui.AppWorkspace
import online.alarabiya.superapp.ui.theme.AlrueyaTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NativeWorkspaceNavigationTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val notificationDestinations = MutableSharedFlow<NativeDestination>(extraBufferCapacity = 1)

    @Test
    fun nativeServiceCardNavigatesAndSystemBackReturnsHome() {
        setWorkspace()

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-route-services").assertIsDisplayed()
        compose.onNodeWithTag("native-service-self-service").performClick()
        compose.onNodeWithTag("native-route-self-service").assertIsDisplayed()

        compose.activityRule.scenario.onActivity {
            it.onBackPressedDispatcher.onBackPressed()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
    }

    @Test
    fun unimplementedBootstrapModulesAreNotRenderedAsCards() {
        setWorkspace()

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-self-service").assertIsDisplayed()
        compose.onNodeWithTag("native-service-approvals").assertIsDisplayed()
        compose.onNodeWithTag("native-service-sales").assertDoesNotExist()
    }

    @Test
    fun personalSelfServiceRemainsReachableWithoutAdministrativeModuleGrants() {
        setWorkspace(modules = emptyList())

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-self-service").performClick()
        compose.onNodeWithTag("native-route-self-service").assertIsDisplayed()
    }

    @Test
    fun notificationDestinationWaitsForReadyWorkspaceThenOpensNativeApprovalRoute() {
        setWorkspace()

        compose.runOnIdle {
            assertTrue(notificationDestinations.tryEmit(NativeDestination.Approvals))
        }
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("native-route-approvals")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("native-route-approvals").assertIsDisplayed()
    }

    private fun setWorkspace(
        modules: List<ModuleAccess> = listOf(
            ModuleAccess("tasks", "المهام", "FULL"),
            ModuleAccess("hr", "الموارد البشرية", "FULL"),
            ModuleAccess("inventory", "المخزون", "FULL"),
            ModuleAccess("sales", "المبيعات", "FULL"),
        ),
    ) {
        val ready = AppSessionState.Ready(
            bootstrap = AppBootstrap(
                user = UserIdentity(
                    id = 7,
                    name = "مدير الاختبار",
                    username = "manager",
                    email = null,
                    role = "manager",
                    roleLabel = "مدير",
                ),
                modules = modules,
                branchId = 1,
                allBranches = false,
            ),
            workspace = PersonalWorkspace(
                date = "2026-08-06",
                employee = null,
                attendance = null,
                tasks = emptyList(),
                notifications = emptyList(),
                payroll = null,
            ),
            biometricEnabled = false,
        )

        compose.setContent {
            AlrueyaTheme {
                AppWorkspace(
                    state = ready,
                    biometricAvailable = false,
                    onRefresh = {},
                    onEnableBiometric = {},
                    onDisableBiometric = {},
                    onLogout = {},
                    selfServiceSource = FakeSelfServiceSource,
                    approvalsSource = FakeApprovalsSource,
                    notificationDestinations = notificationDestinations,
                )
            }
        }
    }
}

private object FakeSelfServiceSource : SelfServiceDataSource {
    private val preferences = NotificationPreferences(
        taskAssigned = true,
        payrollReady = true,
        attendance = true,
        leaveStatus = true,
        approvals = true,
        quietHoursStart = null,
        quietHoursEnd = null,
    )

    override suspend fun loadWorkspace(): SelfServiceWorkspace = SelfServiceWorkspace(
        date = "2026-08-06",
        attendanceHistory = emptyList(),
        payroll = null,
        tasks = emptyList(),
        leaveRequests = emptyList(),
        leaveBalances = LeaveBalances("0", "0"),
    )

    override suspend fun loadNotifications(limit: Int): NotificationCenter =
        NotificationCenter(emptyList(), 0)

    override suspend fun loadNotificationPreferences(): NotificationPreferences = preferences
    override suspend fun performTaskAction(taskId: Long, action: PersonalTaskAction, note: String?) = Unit
    override suspend fun requestLeave(leaveType: String, fromDate: String, toDate: String, reason: String?) = Unit
    override suspend fun withdrawLeave(id: Long) = Unit
    override suspend fun markNotificationRead(id: Long) = Unit
    override suspend fun markAllNotificationsRead() = Unit
    override suspend fun updateNotificationPreferences(preferences: NotificationPreferences) = preferences
}

private object FakeApprovalsSource : ApprovalsDataSource {
    override suspend fun loadPending(): List<ApprovalRequest> = emptyList()

    override suspend fun decide(
        request: ApprovalRequest,
        decision: ApprovalDecision,
    ): ApprovalDecisionReceipt = error("No approval mutation is expected in navigation tests")
}

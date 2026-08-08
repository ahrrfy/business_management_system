package online.alarabiya.superapp.navigation

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.flow.MutableSharedFlow
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule
import online.alarabiya.superapp.core.notifications.NativeNotificationNavigation
import online.alarabiya.superapp.data.ApprovalsDataSource
import online.alarabiya.superapp.data.CollaborationDataSource
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalDecisionReceipt
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.collaboration.AssignableStaff
import online.alarabiya.superapp.model.collaboration.BroadcastAction
import online.alarabiya.superapp.model.collaboration.BroadcastPreview
import online.alarabiya.superapp.model.collaboration.BroadcastResults
import online.alarabiya.superapp.model.collaboration.BroadcastTemplate
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CreateBroadcastDraft
import online.alarabiya.superapp.model.collaboration.CreateTaskDraft
import online.alarabiya.superapp.model.collaboration.ServiceTypeOption
import online.alarabiya.superapp.model.collaboration.TaskAction
import online.alarabiya.superapp.model.collaboration.TaskKind
import online.alarabiya.superapp.model.collaboration.TaskPriority
import online.alarabiya.superapp.model.collaboration.TaskStatus
import online.alarabiya.superapp.model.collaboration.TeamTaskDetail
import online.alarabiya.superapp.model.collaboration.TeamTaskFilter
import online.alarabiya.superapp.model.collaboration.TeamTaskPage
import online.alarabiya.superapp.model.collaboration.TeamTaskSummary
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastDetail
import online.alarabiya.superapp.model.collaboration.WhatsappBroadcastSummary
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

    private val notificationDestinations = MutableSharedFlow<NativeNotificationNavigation>(extraBufferCapacity = 1)

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
        assertTrue(compose.onAllNodes(hasTestTag("native-service-sales")).fetchSemanticsNodes().isEmpty())
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
            assertTrue(notificationDestinations.tryEmit(NativeNotificationNavigation(NativeDestination.Approvals)))
        }
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("native-route-approvals")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("native-route-approvals").assertIsDisplayed()
    }

    @Test
    fun typedTaskDeepLinkKeepsItsEntityAndOpensThatNativeDetail() {
        setWorkspace(collaborationSource = FakeCollaborationSource)

        compose.runOnIdle {
            assertTrue(
                notificationDestinations.tryEmit(
                    NativeNotificationNavigation(
                        NativeDestination.Feature(
                            NativeModule.TASKS,
                            NativeFeatureIntent.VIEW,
                            FakeCollaborationSource.taskId.toString(),
                        ),
                    ),
                ),
            )
        }

        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("native-route-collaboration")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(FakeCollaborationSource.taskTitle).assertIsDisplayed()
    }

    @Test
    fun attendanceCheckInNotificationOpensPersonalAttendanceNotHrAdministration() {
        setWorkspace()

        compose.runOnIdle {
            assertTrue(
                notificationDestinations.tryEmit(
                    NativeNotificationNavigation(
                        destination = NativeDestination.Feature(
                            NativeModule.HR,
                            NativeFeatureIntent.BROWSE,
                        ),
                        kind = "ATTENDANCE_CHECK_IN",
                    ),
                ),
            )
        }

        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("native-route-self-service")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("السجل متزامن من جهاز البصمة داخل الشركة").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasTestTag("native-route-hr-admin")).fetchSemanticsNodes().isEmpty())
    }

    private fun setWorkspace(
        modules: List<ModuleAccess> = listOf(
            ModuleAccess("tasks", "المهام", "FULL"),
            ModuleAccess("hr", "الموارد البشرية", "FULL"),
            ModuleAccess("inventory", "المخزون", "FULL"),
            ModuleAccess("sales", "المبيعات", "FULL"),
        ),
        collaborationSource: CollaborationDataSource? = null,
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
                    collaborationSource = collaborationSource,
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
        employee = null,
        todayAttendance = null,
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

private object FakeCollaborationSource : CollaborationDataSource {
    const val taskId = 42L
    const val taskTitle = "مهمة رابط الاختبار"

    private val summary = TeamTaskSummary(
        id = taskId,
        taskNumber = "TASK-42",
        branchId = 1,
        kind = TaskKind.INTERNAL,
        status = TaskStatus.NEW,
        priority = TaskPriority.NORMAL,
        title = taskTitle,
        customerId = null,
        customerName = null,
        supplierId = null,
        supplierName = null,
        assignedTo = 7,
        assigneeName = "مدير الاختبار",
        createdBy = 7,
        conversationId = null,
        dueAt = null,
        effectiveDueAt = null,
        isOverdue = false,
        createdAt = "2026-08-06T08:00:00Z",
    )
    private val detail = TeamTaskDetail(
        summary = summary,
        description = "تفاصيل أصلية محمّلة بالمعرّف 42",
        linkedWorkOrderId = null,
        linkedInvoiceId = null,
        linkedQuotationId = null,
        serviceTypeId = null,
        sourceChannel = null,
        firstResponseAt = null,
        resolvedAt = null,
        resolutionNote = null,
        reopenCount = 0,
        csatScore = null,
        updatedAt = "2026-08-06T08:00:00Z",
        events = emptyList(),
    )

    override suspend fun tasks(filter: TeamTaskFilter, capabilities: CollaborationCapabilities) =
        TeamTaskPage(listOf(summary), hasMore = false, nextCursor = null)

    override suspend fun task(taskId: Long, expectedBranchId: Long): TeamTaskDetail {
        check(taskId == this.taskId && expectedBranchId == summary.branchId)
        return detail
    }

    override suspend fun assignableStaff(branchId: Long, capabilities: CollaborationCapabilities): List<AssignableStaff> =
        error("No staff read is expected in navigation tests")
    override suspend fun serviceTypes(): List<ServiceTypeOption> =
        error("No service type read is expected in navigation tests")
    override suspend fun createTask(draft: CreateTaskDraft, capabilities: CollaborationCapabilities): Long =
        error("No task mutation is expected in navigation tests")
    override suspend fun taskAction(
        detail: TeamTaskDetail,
        capabilities: CollaborationCapabilities,
        action: TaskAction,
        note: String?,
        assignedTo: Long?,
    ) = error("No task action is expected in navigation tests")
    override suspend fun broadcasts(capabilities: CollaborationCapabilities): List<WhatsappBroadcastSummary> = emptyList()
    override suspend fun broadcast(id: Long, capabilities: CollaborationCapabilities): WhatsappBroadcastDetail =
        error("No broadcast detail is expected in navigation tests")
    override suspend fun broadcastResults(id: Long, capabilities: CollaborationCapabilities): BroadcastResults =
        error("No broadcast results are expected in navigation tests")
    override suspend fun broadcastTemplates(capabilities: CollaborationCapabilities): List<BroadcastTemplate> = emptyList()
    override suspend fun previewBroadcast(
        draft: CreateBroadcastDraft,
        capabilities: CollaborationCapabilities,
    ): BroadcastPreview = error("No broadcast preview is expected in navigation tests")
    override suspend fun createBroadcast(draft: CreateBroadcastDraft, capabilities: CollaborationCapabilities): Long =
        error("No broadcast mutation is expected in navigation tests")
    override suspend fun broadcastAction(
        detail: WhatsappBroadcastDetail,
        capabilities: CollaborationCapabilities,
        action: BroadcastAction,
        reason: String?,
    ) = error("No broadcast action is expected in navigation tests")
}

private object FakeApprovalsSource : ApprovalsDataSource {
    override suspend fun loadPending(): List<ApprovalRequest> = emptyList()

    override suspend fun decide(
        request: ApprovalRequest,
        decision: ApprovalDecision,
    ): ApprovalDecisionReceipt = error("No approval mutation is expected in navigation tests")
}

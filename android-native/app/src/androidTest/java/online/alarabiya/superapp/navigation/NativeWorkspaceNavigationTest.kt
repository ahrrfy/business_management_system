package online.alarabiya.superapp.navigation

import androidx.activity.ComponentActivity
import android.content.ContentValues
import android.graphics.Bitmap
import android.provider.MediaStore
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import kotlinx.coroutines.flow.MutableSharedFlow
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeModule
import online.alarabiya.superapp.core.notifications.NativeNotificationNavigation
import online.alarabiya.superapp.data.ApprovalsDataSource
import online.alarabiya.superapp.data.BranchDirectoryDataSource
import online.alarabiya.superapp.data.CollaborationDataSource
import online.alarabiya.superapp.data.InsightsDataSource
import online.alarabiya.superapp.data.InventoryDataSource
import online.alarabiya.superapp.data.LegalConfig
import online.alarabiya.superapp.data.LegalDataSource
import online.alarabiya.superapp.data.LegalDocument
import online.alarabiya.superapp.data.LegalSection
import online.alarabiya.superapp.data.PurchasingDataSource
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.data.StoreAdminDataSource
import online.alarabiya.superapp.data.TwoFactorAccountStatus
import online.alarabiya.superapp.data.TwoFactorDataSource
import online.alarabiya.superapp.data.TwoFactorEnrollment
import online.alarabiya.superapp.data.TwoFactorVerification
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.session.SessionBranch
import online.alarabiya.superapp.model.ExecutiveCapabilities
import online.alarabiya.superapp.model.ExecutiveCommandCenter
import online.alarabiya.superapp.model.ExecutiveDecision
import online.alarabiya.superapp.model.ExecutiveAction
import online.alarabiya.superapp.model.ExecutiveDestinationKey
import online.alarabiya.superapp.model.ExecutiveHealth
import online.alarabiya.superapp.model.ExecutiveHealthStatus
import online.alarabiya.superapp.model.ExecutiveMetrics
import online.alarabiya.superapp.model.ExecutiveMoney
import online.alarabiya.superapp.model.ExecutiveFreshness
import online.alarabiya.superapp.model.ExecutiveOperationalSnapshot
import online.alarabiya.superapp.model.ExecutiveSalesToday
import online.alarabiya.superapp.model.ExecutiveTreasurySnapshot
import online.alarabiya.superapp.model.ExecutiveMorningBrief
import online.alarabiya.superapp.model.ExecutiveSalesPulse
import online.alarabiya.superapp.model.ExecutiveScope
import online.alarabiya.superapp.model.ExecutiveSeverity
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalDecisionReceipt
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.collaboration.AssignableStaff
import online.alarabiya.superapp.model.collaboration.BroadcastAction
import online.alarabiya.superapp.model.collaboration.BroadcastPreview
import online.alarabiya.superapp.model.collaboration.BroadcastResults
import online.alarabiya.superapp.model.collaboration.BroadcastTemplate
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.collaboration.CollaborationBranch
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
import online.alarabiya.superapp.model.insights.AlertSeverity
import online.alarabiya.superapp.model.insights.FinancialReportsInsight
import online.alarabiya.superapp.model.insights.HrReportsInsight
import online.alarabiya.superapp.model.insights.InsightDateRange
import online.alarabiya.superapp.model.insights.InsightMoney
import online.alarabiya.superapp.model.insights.ManagementAlert
import online.alarabiya.superapp.model.insights.ReportInsights
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.insights.SearchInsight
import online.alarabiya.superapp.model.insights.StoreInsights
import online.alarabiya.superapp.model.inventory.MovementPage
import online.alarabiya.superapp.model.inventory.StockBalance
import online.alarabiya.superapp.model.inventory.TransferPage
import online.alarabiya.superapp.model.purchasing.Currency
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseStatus
import online.alarabiya.superapp.model.purchasing.SupplierPage
import online.alarabiya.superapp.model.purchasing.PurchaseReturnPage
import online.alarabiya.superapp.model.selfservice.LeaveBalances
import online.alarabiya.superapp.model.selfservice.AttendanceEntry
import online.alarabiya.superapp.model.selfservice.NotificationCenter
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.selfservice.PersonalEmployeeProfile
import online.alarabiya.superapp.model.selfservice.PersonalPayroll
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.SelfServiceWorkspace
import online.alarabiya.superapp.model.storeadmin.StoreBannerDraft
import online.alarabiya.superapp.model.storeadmin.StoreSettingsDraft
import online.alarabiya.superapp.ui.AppSessionState
import online.alarabiya.superapp.ui.AppWorkspace
import online.alarabiya.superapp.feature.executive.ExecutiveHomeState
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
        setWorkspace(storeAdminSource = FakeStoreAdminSource)

        assertTrue(compose.onAllNodes(hasTestTag("native-workspace-up")).fetchSemanticsNodes().isEmpty())

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-store-admin").performClick()
        assertTrue(compose.onAllNodes(hasTestTag("native-route-store-admin")).fetchSemanticsNodes().isNotEmpty())

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-route-services").assertIsDisplayed()
        compose.onNodeWithTag("native-workspace-up").assertIsDisplayed()
        compose.onNodeWithTag("native-service-self-service").performClick()
        compose.onNodeWithTag("native-route-self-service").assertIsDisplayed()

        compose.activityRule.scenario.onActivity {
            it.onBackPressedDispatcher.onBackPressed()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasTestTag("native-workspace-up")).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun visibleWorkspaceUpActionReturnsPrimaryRouteToHome() {
        setWorkspace()

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-route-services").assertIsDisplayed()
        compose.onNodeWithTag("native-workspace-up").performClick()

        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasTestTag("native-workspace-up")).fetchSemanticsNodes().isEmpty())
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

    @Test
    fun capturePersonalWorkspaceForVisualAudit() {
        setWorkspace()

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-self-service").performClick()
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("native-route-self-service")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("مدير الاختبار").assertIsDisplayed()
        compose.waitForIdle()

        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val resolver = compose.activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "visual-self-service.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/SuperArabicQA")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = requireNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
        resolver.openOutputStream(uri).use { stream ->
            requireNotNull(stream)
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
    }

    @Test
    fun allBranchAdministratorMustChooseAVisibleServerBranchBeforeTasksLoad() {
        FakeCollaborationSource.selectedTaskBranch.set(-1)
        setWorkspace(
            modules = listOf(ModuleAccess("tasks", "المهام", "FULL")),
            collaborationSource = FakeCollaborationSource,
            role = "admin",
            branchId = null,
            allBranches = true,
        )

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-collaboration").performClick()
        compose.onNodeWithTag("session-branch-picker").assertIsDisplayed()
        assertTrue(FakeCollaborationSource.selectedTaskBranch.get() < 0)

        compose.onNodeWithTag("session-branch-7").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { FakeCollaborationSource.selectedTaskBranch.get() == 7L }
        compose.onNodeWithText(FakeCollaborationSource.taskTitle).assertIsDisplayed()
    }

    @Test
    fun purchasingSystemBackClearsCompactOrderBeforeLeavingTheNativeModule() {
        setWorkspace(
            modules = listOf(
                ModuleAccess("purchases", "المشتريات", "FULL"),
                ModuleAccess("suppliers", "الموردون", "READ"),
            ),
            purchasingSourceFactory = { _, _ -> FakePurchasingSource.dataSource },
        )

        compose.runOnIdle {
            assertTrue(
                notificationDestinations.tryEmit(
                    NativeNotificationNavigation(
                        NativeDestination.Feature(
                            NativeModule.PURCHASES,
                            NativeFeatureIntent.VIEW,
                            "order-91",
                        ),
                    ),
                ),
            )
        }
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasText(FakePurchasingSource.orderNumber)).fetchSemanticsNodes().isNotEmpty()
        }

        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag("native-route-purchasing").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasText(FakePurchasingSource.orderNumber)).fetchSemanticsNodes().isEmpty())

        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
    }

    @Test
    fun allBranchOwnerSelectionIsAppliedToPurchasingBeforeTheRouteStarts() {
        val factoryBranch = AtomicLong(-1)
        setWorkspace(
            modules = listOf(
                ModuleAccess("purchases", "المشتريات", "FULL"),
                ModuleAccess("suppliers", "الموردون", "READ"),
            ),
            role = "admin",
            branchId = null,
            allBranches = true,
            purchasingSourceFactory = { _, selectedBranch ->
                factoryBranch.set(selectedBranch ?: -1)
                FakePurchasingSource.dataSource
            },
        )

        compose.onNodeWithTag("native-tab-native-services").performClick()
        compose.onNodeWithTag("native-service-purchasing").performClick()
        compose.onNodeWithTag("session-branch-picker").assertIsDisplayed()
        assertTrue(factoryBranch.get() < 0)

        compose.onNodeWithTag("session-branch-7").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { factoryBranch.get() == 7L }
        compose.onNodeWithTag("native-route-purchasing").assertIsDisplayed()
    }

    @Test
    fun nativeHomeHeaderAndFeedRemainReachableAtTwoHundredPercentFontScale() {
        setWorkspace(isExecutive = false, fontScale = 2f)

        compose.onNodeWithTag("native-home-header").assertIsDisplayed()
        compose.onNodeWithTag("native-home-feed").performScrollToNode(hasText("اليوم"))
        compose.onNodeWithText("اليوم").assertIsDisplayed()
    }

    @Test
    fun settingsSystemBackClosesTwoFactorBeforeLeavingTheProfileRoute() {
        setWorkspace(legalSource = FakeLegalSource, twoFactorSource = FakeTwoFactorSource)

        compose.onNodeWithTag("native-tab-native-profile").performClick()
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("open_two_factor")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("open_two_factor").performClick()
        compose.onNodeWithTag("two_factor_back").assertIsDisplayed()

        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodes(hasTestTag("open_two_factor")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("native-route-profile").assertIsDisplayed()

        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
    }

    @Test
    fun captureManagerExecutiveHomeForAudit() {
        setWorkspace()
        compose.onNodeWithTag("native-route-home").assertIsDisplayed()
        compose.onNodeWithText("مبيعات اليوم").assertIsDisplayed()
        compose.waitForIdle()

        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val resolver = compose.activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "manager-home-executive-after.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/SuperArabicQA")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = requireNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
        resolver.openOutputStream(uri).use { stream ->
            requireNotNull(stream)
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
    }

    @Test
    fun executiveManagementActionOpensNativeApprovalWorkspace() {
        setWorkspace()

        compose.onNodeWithTag("executive-home-feed")
            .performScrollToNode(hasText("رصيد الخزينة"))
        compose.onNodeWithText("رصيد الخزينة").assertIsDisplayed()
        compose.onNodeWithTag("executive-home-feed")
            .performScrollToNode(hasTestTag("executive-management-action-0"))
        compose.onNodeWithTag("executive-management-action-0").performClick()

        compose.onNodeWithTag("native-route-approvals").assertIsDisplayed()
    }

    @Test
    fun executiveStockDecisionOpensInventoryAndAppliesItsOperationalFilter() {
        FakeInventorySource.lowOnlyRequested.set(false)
        setWorkspace(
            modules = listOf(
                ModuleAccess("inventory", "المخزون", "FULL"),
            ),
            inventorySourceFactory = { _, _ -> FakeInventorySource.dataSource },
        )

        compose.onNodeWithTag("executive-home-feed")
            .performScrollToNode(hasText("مراجعة المخزون"))
        compose.onNodeWithText("مراجعة المخزون").performClick()

        compose.waitUntil(timeoutMillis = 5_000) { FakeInventorySource.lowOnlyRequested.get() }
        compose.onNodeWithTag("native-route-inventory").assertIsDisplayed()
        compose.onNodeWithText("LOW-EXECUTIVE-STOCK").assertIsDisplayed()
    }

    private fun setWorkspace(
        modules: List<ModuleAccess> = listOf(
            ModuleAccess("tasks", "المهام", "FULL"),
            ModuleAccess("hr", "الموارد البشرية", "FULL"),
            ModuleAccess("inventory", "المخزون", "FULL"),
            ModuleAccess("sales", "المبيعات", "FULL"),
            ModuleAccess("store", "المتجر", "FULL"),
        ),
        collaborationSource: CollaborationDataSource? = null,
        storeAdminSource: StoreAdminDataSource? = null,
        insightsSource: InsightsDataSource? = null,
        branchDirectorySource: BranchDirectoryDataSource? = FakeBranchDirectorySource,
        inventorySourceFactory: ((AppBootstrap, Long?) -> InventoryDataSource)? = null,
        purchasingSourceFactory: ((AppBootstrap, Long?) -> PurchasingDataSource)? = null,
        role: String = "manager",
        branchId: Long? = 1,
        allBranches: Boolean = false,
        isExecutive: Boolean = true,
        fontScale: Float = 1f,
        legalSource: LegalDataSource? = null,
        twoFactorSource: TwoFactorDataSource? = null,
    ) {
        val ready = AppSessionState.Ready(
            bootstrap = AppBootstrap(
                user = UserIdentity(
                    id = 7,
                    name = "مدير الاختبار",
                    username = "manager",
                    email = null,
                    role = role,
                    roleLabel = "مدير",
                ),
                modules = modules,
                branchId = branchId,
                allBranches = allBranches,
                isExecutive = isExecutive,
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
            val currentDensity = LocalDensity.current
            CompositionLocalProvider(
                LocalLayoutDirection provides LayoutDirection.Rtl,
                LocalDensity provides Density(currentDensity.density, fontScale),
            ) {
                AlrueyaTheme {
                    AppWorkspace(
                    state = ready,
                    executiveState = ExecutiveHomeState.Content(executiveFixture()),
                    biometricAvailable = false,
                    onRefresh = {},
                    onEnableBiometric = {},
                    onDisableBiometric = {},
                    onLogout = {},
                    selfServiceSource = FakeSelfServiceSource,
                    branchDirectorySource = branchDirectorySource,
                    approvalsSource = FakeApprovalsSource,
                    notificationDestinations = notificationDestinations,
                    collaborationSource = collaborationSource,
                    storeAdminSource = storeAdminSource,
                    insightsSource = insightsSource,
                    inventorySourceFactory = inventorySourceFactory,
                    purchasingSourceFactory = purchasingSourceFactory,
                    legalSource = legalSource,
                    twoFactorSource = twoFactorSource,
                    )
                }
            }
        }
    }

    private fun executiveFixture() = ExecutiveCommandCenter(
        asOf = "2026-08-09T21:45:00.000Z",
        scope = ExecutiveScope(branchId = 1, allBranches = false),
        capabilities = ExecutiveCapabilities(
            financial = true, sales = true, inventory = true, receivables = true,
            workOrders = true, tasks = true, treasury = true,
        ),
        health = ExecutiveHealth(ExecutiveHealthStatus.OK, emptyList()),
        operationalSnapshot = ExecutiveOperationalSnapshot(
            salesToday = ExecutiveSalesToday(
                ExecutiveMoney.fromServer("3250000.00"), 14,
                ExecutiveFreshness("2026-08-09T21:44:00.000Z", "database"),
            ),
            treasury = ExecutiveTreasurySnapshot(
                ExecutiveMoney.fromServer("98500000.00"), ExecutiveMoney.fromServer("4200000.00"),
                ExecutiveMoney.fromServer("12800000.00"), ExecutiveMoney.fromServer("2750000.00"), 2,
                ExecutiveFreshness("2026-08-09T21:43:00.000Z", "treasury-ledger"),
            ),
        ),
        metrics = ExecutiveMetrics(
            lowStockCount = 12,
            overdueReceivablesCount = 8,
            overdueReceivablesTotal = ExecutiveMoney.fromServer("4850000.00"),
            salesPulse = ExecutiveSalesPulse(
                yesterday = ExecutiveMoney.fromServer("17850000.00"),
                average7Days = ExecutiveMoney.fromServer("15420000.00"),
                direction = "up",
                changePercent = 16,
            ),
            morningBrief = ExecutiveMorningBrief(4, 3, 2, 7, 1),
        ),
        decisions = listOf(
            ExecutiveDecision(
                id = "stock-low", severity = ExecutiveSeverity.WARNING,
                title = "أصناف قاربت حد إعادة الطلب", count = 12, amount = null,
                actionLabel = "مراجعة المخزون",
                action = ExecutiveAction(ExecutiveDestinationKey.PRODUCTS, mapOf("stockState" to "low")),
            ),
            ExecutiveDecision(
                id = "ar-overdue", severity = ExecutiveSeverity.CRITICAL,
                title = "ذمم تجاوزت موعد الاستحقاق", count = 8,
                amount = ExecutiveMoney.fromServer("4850000.00"), actionLabel = "فتح الذمم",
                action = ExecutiveAction(ExecutiveDestinationKey.RECEIVABLES, emptyMap()),
            ),
        ),
    )
}

private object FakeStoreAdminSource : StoreAdminDataSource {
    override suspend fun settings() = StoreSettingsDraft(isOpen = true)
    override suspend fun saveSettings(value: StoreSettingsDraft) = value
    override suspend fun banners(): List<StoreBannerDraft> = emptyList()
    override suspend fun createBanner(value: StoreBannerDraft) = 1L
    override suspend fun updateBanner(value: StoreBannerDraft) = Unit
    override suspend fun removeBanner(id: Long) = Unit
}

private object FakeInventorySource {
    val lowOnlyRequested = AtomicBoolean(false)

    @Suppress("UNCHECKED_CAST")
    val dataSource: InventoryDataSource = Proxy.newProxyInstance(
        InventoryDataSource::class.java.classLoader,
        arrayOf(InventoryDataSource::class.java),
    ) { proxy, method, args ->
        when (method.name) {
            "branches", "adjustments", "stocktakes", "countAssignments" -> emptyList<Any>()
            "balances" -> {
                val lowOnly = args?.getOrNull(1) as? Boolean ?: false
                if (lowOnly) lowOnlyRequested.set(true)
                listOf(
                    StockBalance(
                        variantId = 1,
                        branchId = 1,
                        productName = "LOW-EXECUTIVE-STOCK",
                        variantName = null,
                        sku = "LOW-1",
                        quantity = 1,
                        minimum = 3,
                        reorderPoint = 3,
                        isLow = true,
                        lastCountedAt = null,
                    ),
                )
            }
            "movements" -> MovementPage(emptyList(), false, null)
            "transfers" -> TransferPage(emptyList(), null)
            "equals" -> proxy === args?.getOrNull(0)
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "FakeInventorySource"
            else -> error("Unexpected inventory call: ${method.name}")
        }
    } as InventoryDataSource
}

private object FakePurchasingSource {
    const val orderNumber = "PO-NESTED-91"

    private val order = PurchaseOrderDetail(
        summary = PurchaseOrderSummary(
            id = 91,
            number = orderNumber,
            orderDate = "2026-08-09",
            supplierId = 2,
            supplierName = "مورد الاختبار",
            branchId = 1,
            total = "125000",
            paidAmount = "0",
            shippingCost = "0",
            customsCost = "0",
            agreedCurrency = Currency.IQD,
            usdTotal = null,
            paidUsd = null,
            returnedUsd = null,
            agreedRate = null,
            status = PurchaseStatus.DRAFT,
        ),
        subtotal = "125000",
        taxAmount = "0",
        taxRatePercent = "0",
        notes = null,
        lines = emptyList(),
    )

    @Suppress("UNCHECKED_CAST")
    val dataSource: PurchasingDataSource = Proxy.newProxyInstance(
        PurchasingDataSource::class.java.classLoader,
        arrayOf(PurchasingDataSource::class.java),
    ) { _, method, args ->
        when (method.name) {
            "orders", "catalog", "reminderQueue", "reminderHistory" -> emptyList<Any>()
            "suppliers" -> SupplierPage(emptyList(), 0)
            "returns" -> PurchaseReturnPage(emptyList(), 0)
            "order" -> order.also { check((args?.firstOrNull() as? Long) == 91L) }
            "toString" -> "FakePurchasingSource"
            else -> error("Unexpected purchasing call: ${method.name}")
        }
    } as PurchasingDataSource
}

private object FakeLegalSource : LegalDataSource {
    override suspend fun loadPrivacyPolicy() = LegalDocument(
        config = LegalConfig(
            appName = "سوبر العربية",
            dataControllerName = "شركة الرؤية العربية للتجارة",
            privacyContactEmail = "privacy@example.com",
            privacyPolicyVersion = "2026-08",
            privacyPath = "/privacy",
        ),
        sections = listOf(LegalSection("الخصوصية", "سياسة اختبار أصلية")),
        publicUrl = "https://online.alarabiya.store/privacy",
    )
}

private object FakeTwoFactorSource : TwoFactorDataSource {
    override suspend fun status() = TwoFactorAccountStatus(
        enabled = false,
        pending = false,
        recoveryCodesRemaining = 0,
        cryptoReady = true,
    )

    override suspend fun startEnrollment(password: String): TwoFactorEnrollment = error("Not requested")
    override suspend fun confirmEnrollment(code: String): List<String> = error("Not requested")
    override suspend fun regenerateRecoveryCodes(password: String, code: String): List<String> = error("Not requested")
    override suspend fun disable(password: String, verification: TwoFactorVerification) = error("Not requested")
}

private object FakeInsightsSource : InsightsDataSource {
    override suspend fun loadReports(
        range: InsightDateRange,
        branchId: Long?,
        rankBy: String,
    ) = ReportInsights(
        alerts = listOf(
            ManagementAlert(
                key = "stock-low",
                severity = AlertSeverity.WARNING,
                title = "أصناف قاربت حد إعادة الطلب",
                count = 12,
                amount = null,
                actionLabel = "مراجعة المخزون",
            ),
            ManagementAlert(
                key = "shift-variance",
                severity = AlertSeverity.CRITICAL,
                title = "فرق في تسوية الوردية",
                count = 1,
                amount = InsightMoney.fromServer("12500"),
                actionLabel = "مراجعة الفرق",
            ),
        ),
        generatedAt = "2026-08-09T21:45:00.000Z",
        topProducts = emptyList(),
        categoryProfit = emptyList(),
        slowMovers = emptyList(),
        mayBeTruncated = false,
    )

    override suspend fun loadStore(range: InsightDateRange): StoreInsights = error("Not requested")

    override suspend fun loadFinancial(
        range: InsightDateRange,
        branchId: Long?,
    ): FinancialReportsInsight = error("Not requested")

    override suspend fun loadHrReports(
        range: InsightDateRange,
        branchId: Long?,
    ): HrReportsInsight = error("Not requested")

    override suspend fun search(
        query: String,
        scopes: Set<SearchEntityType>,
    ): List<SearchInsight> = emptyList()
}

private object FakeBranchDirectorySource : BranchDirectoryDataSource {
    override suspend fun availableBranches(): List<SessionBranch> = listOf(
        SessionBranch(id = 7, name = "فرع الاختبار", code = "QA-7"),
        SessionBranch(id = 8, name = "الفرع الثاني", code = "QA-8"),
    )
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
        employee = PersonalEmployeeProfile(
            id = 7,
            name = "مدير الاختبار",
            position = "المدير العام",
            department = "الإدارة",
            branchId = 1,
            photoUrl = null,
            employmentStatus = "active",
            email = "manager@example.com",
            phone = "07700000000",
            hireDate = "2024-01-10",
            payType = "monthly",
            baseSalary = "2500000",
            allowances = "250000",
        ),
        todayAttendance = AttendanceEntry(
            id = 11,
            date = "2026-08-06",
            checkIn = "08:17",
            checkOut = null,
            status = "present",
            hours = "6.25",
            source = "DEVICE",
            needsReview = false,
        ),
        attendanceHistory = emptyList(),
        payroll = PersonalPayroll(
            itemId = 21,
            runId = 3,
            period = "2026-07",
            status = "paid",
            paidAt = "2026-08-01T08:00:00Z",
            gross = "2750000",
            allowances = "250000",
            overtime = "0",
            commission = "0",
            deductions = "50000",
            net = "2700000",
        ),
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
    val selectedTaskBranch = AtomicLong(-1)

    override suspend fun branches(capabilities: CollaborationCapabilities): List<CollaborationBranch> =
        listOf(CollaborationBranch(7, "فرع الكرادة", "BGD"))

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

    override suspend fun tasks(filter: TeamTaskFilter, capabilities: CollaborationCapabilities): TeamTaskPage {
        selectedTaskBranch.set(filter.branchId ?: -1)
        return TeamTaskPage(listOf(summary.copy(branchId = filter.branchId ?: summary.branchId)), hasMore = false, nextCursor = null)
    }

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

package online.alarabiya.superapp.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.Apps
import androidx.compose.material.icons.rounded.Badge
import androidx.compose.material.icons.rounded.BusinessCenter
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.flow.Flow
import online.alarabiya.superapp.R
import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.navigation.AccessDecision
import online.alarabiya.superapp.core.navigation.ExecutiveNavigation
import online.alarabiya.superapp.core.navigation.ModuleGrant
import online.alarabiya.superapp.core.navigation.NativeDestination
import online.alarabiya.superapp.core.navigation.NativeFeatureIntent
import online.alarabiya.superapp.core.navigation.NativeFeatureCatalog
import online.alarabiya.superapp.core.navigation.NativeModule
import online.alarabiya.superapp.core.navigation.NativeNavigationRegistry
import online.alarabiya.superapp.core.navigation.NativeScreen
import online.alarabiya.superapp.core.navigation.NavigationPrincipal
import online.alarabiya.superapp.core.notifications.NativeNotificationNavigation
import online.alarabiya.superapp.data.ApprovalsDataSource
import online.alarabiya.superapp.data.AccountingControlsDataSource
import online.alarabiya.superapp.data.AdminDataSource
import online.alarabiya.superapp.data.BranchDirectoryDataSource
import online.alarabiya.superapp.data.CommerceDataSource
import online.alarabiya.superapp.data.CollaborationDataSource
import online.alarabiya.superapp.data.CollectionsDataSource
import online.alarabiya.superapp.data.CrmDataSource
import online.alarabiya.superapp.data.ConversationsDataSource
import online.alarabiya.superapp.data.FinanceDataSource
import online.alarabiya.superapp.data.InventoryDataSource
import online.alarabiya.superapp.data.InsightsDataSource
import online.alarabiya.superapp.data.HrAdminDataSource
import online.alarabiya.superapp.data.LegalDataSource
import online.alarabiya.superapp.data.MarketingDataSource
import online.alarabiya.superapp.data.OperationsDataSource
import online.alarabiya.superapp.data.PurchasingDataSource
import online.alarabiya.superapp.data.ProductsDataSource
import online.alarabiya.superapp.data.ReceivablesDataSource
import online.alarabiya.superapp.data.SalesDataSource
import online.alarabiya.superapp.data.SelfServiceDataSource
import online.alarabiya.superapp.data.ShiftDataSource
import online.alarabiya.superapp.data.StoreDeliveryDataSource
import online.alarabiya.superapp.data.StoreAdminDataSource
import online.alarabiya.superapp.data.SystemSettingsDataSource
import online.alarabiya.superapp.data.TwoFactorDataSource
import online.alarabiya.superapp.data.WorkOrdersDataSource
import online.alarabiya.superapp.data.WarehouseToolsDataSource
import online.alarabiya.superapp.feature.approvals.ApprovalsRoute
import online.alarabiya.superapp.feature.accountingControls.AccountingControlsRoute
import online.alarabiya.superapp.feature.accountingControls.AccountingControlsViewModel
import online.alarabiya.superapp.feature.accountingControls.AccountingControlsViewModelFactory
import online.alarabiya.superapp.feature.admin.AdminRoute
import online.alarabiya.superapp.feature.admin.AdminViewModel
import online.alarabiya.superapp.feature.admin.AdminViewModelFactory
import online.alarabiya.superapp.feature.approvals.ApprovalsViewModel
import online.alarabiya.superapp.feature.approvals.ApprovalsViewModelFactory
import online.alarabiya.superapp.feature.commerce.CommerceRoute
import online.alarabiya.superapp.feature.commerce.CommerceSection
import online.alarabiya.superapp.feature.commerce.CommerceViewModel
import online.alarabiya.superapp.feature.commerce.CommerceViewModelFactory
import online.alarabiya.superapp.feature.commerce.readableSections
import online.alarabiya.superapp.feature.collaboration.CollaborationRoute
import online.alarabiya.superapp.feature.collaboration.CollaborationViewModel
import online.alarabiya.superapp.feature.collaboration.CollaborationViewModelFactory
import online.alarabiya.superapp.feature.collections.CollectionsRoute
import online.alarabiya.superapp.feature.collections.CollectionsViewModel
import online.alarabiya.superapp.feature.collections.CollectionsViewModelFactory
import online.alarabiya.superapp.feature.crm.CrmRoute
import online.alarabiya.superapp.feature.crm.CrmViewModel
import online.alarabiya.superapp.feature.crm.CrmViewModelFactory
import online.alarabiya.superapp.feature.conversations.ConversationsRoute
import online.alarabiya.superapp.feature.conversations.ConversationsViewModel
import online.alarabiya.superapp.feature.conversations.ConversationsViewModelFactory
import online.alarabiya.superapp.feature.finance.FinanceRoute
import online.alarabiya.superapp.feature.finance.FinanceViewModel
import online.alarabiya.superapp.feature.finance.FinanceViewModelFactory
import online.alarabiya.superapp.feature.inventory.InventoryRoute
import online.alarabiya.superapp.feature.hradmin.HrAdminRoute
import online.alarabiya.superapp.feature.hradmin.HrAdminViewModel
import online.alarabiya.superapp.feature.hradmin.HrAdminViewModelFactory
import online.alarabiya.superapp.feature.inventory.InventoryViewModel
import online.alarabiya.superapp.feature.inventory.InventoryViewModelFactory
import online.alarabiya.superapp.feature.insights.InsightsRoute
import online.alarabiya.superapp.feature.insights.InsightsViewModel
import online.alarabiya.superapp.feature.insights.InsightsViewModelFactory
import online.alarabiya.superapp.feature.marketing.MarketingScreen
import online.alarabiya.superapp.feature.marketing.MarketingViewModel
import online.alarabiya.superapp.feature.operations.OperationsScreen
import online.alarabiya.superapp.feature.operations.OperationsViewModel
import online.alarabiya.superapp.feature.purchasing.PurchasingRoute
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import online.alarabiya.superapp.feature.purchasing.PurchasingViewModel
import online.alarabiya.superapp.feature.purchasing.PurchasingViewModelFactory
import online.alarabiya.superapp.feature.products.ProductsRoute
import online.alarabiya.superapp.feature.products.ProductsViewModel
import online.alarabiya.superapp.feature.products.ProductsViewModelFactory
import online.alarabiya.superapp.feature.receivables.ReceivablesRoute
import online.alarabiya.superapp.feature.receivables.ReceivablesViewModel
import online.alarabiya.superapp.feature.receivables.ReceivablesViewModelFactory
import online.alarabiya.superapp.feature.sales.SalesRoute
import online.alarabiya.superapp.feature.sales.SalesViewModel
import online.alarabiya.superapp.feature.sales.SalesViewModelFactory
import online.alarabiya.superapp.feature.selfservice.SelfServiceRoute
import online.alarabiya.superapp.feature.selfservice.SelfServiceSection
import online.alarabiya.superapp.feature.selfservice.SelfServiceViewModel
import online.alarabiya.superapp.feature.selfservice.SelfServiceViewModelFactory
import online.alarabiya.superapp.feature.announcements.AnnouncementsAdminRoute
import online.alarabiya.superapp.feature.announcements.AnnouncementsAdminViewModel
import online.alarabiya.superapp.feature.announcements.AnnouncementsAdminViewModelFactory
import online.alarabiya.superapp.feature.announcements.AnnouncementsFeedRoute
import online.alarabiya.superapp.feature.announcements.AnnouncementsFeedViewModel
import online.alarabiya.superapp.feature.announcements.AnnouncementsFeedViewModelFactory
import online.alarabiya.superapp.data.AnnouncementsDataSource
import online.alarabiya.superapp.model.announcements.AnnouncementsCapabilities
import online.alarabiya.superapp.feature.shifts.ShiftScreen
import online.alarabiya.superapp.feature.shifts.ShiftViewModel
import online.alarabiya.superapp.feature.settings.SettingsScreen
import online.alarabiya.superapp.feature.settings.SettingsStateMapper
import online.alarabiya.superapp.feature.settings.SettingsUiState
import online.alarabiya.superapp.feature.settings.SettingsViewModel
import online.alarabiya.superapp.feature.security.AuthenticatorUriPolicy
import online.alarabiya.superapp.feature.security.TwoFactorEntryPolicy
import online.alarabiya.superapp.feature.security.TwoFactorScreen
import online.alarabiya.superapp.feature.security.TwoFactorViewModel
import online.alarabiya.superapp.feature.store.StoreDeliveryScreen
import online.alarabiya.superapp.feature.store.StoreDeliveryViewModel
import online.alarabiya.superapp.feature.storeadmin.StoreAdminRoute
import online.alarabiya.superapp.feature.storeadmin.StoreAdminViewModel
import online.alarabiya.superapp.model.storeadmin.StoreAdminCapabilities
import online.alarabiya.superapp.feature.systemsettings.SystemSettingsRoute
import online.alarabiya.superapp.feature.systemsettings.readableSections
import online.alarabiya.superapp.feature.executive.ExecutiveHomeScreen
import online.alarabiya.superapp.feature.executive.ExecutiveHomeState
import online.alarabiya.superapp.feature.executive.ExecutiveManagementAction
import online.alarabiya.superapp.model.ExecutiveDestinationKey
import online.alarabiya.superapp.feature.systemsettings.SystemSettingsViewModel
import online.alarabiya.superapp.feature.workorders.WorkOrdersRoute
import online.alarabiya.superapp.model.workorders.WorkOrdersSection
import online.alarabiya.superapp.feature.workorders.WorkOrdersViewModel
import online.alarabiya.superapp.feature.workorders.WorkOrdersViewModelFactory
import online.alarabiya.superapp.feature.warehouseTools.WarehouseToolsRoute
import online.alarabiya.superapp.feature.warehouseTools.WarehouseToolsViewModel
import online.alarabiya.superapp.feature.warehouseTools.WarehouseToolsViewModelFactory
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.ModuleMetric
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.crm.CrmSection
import online.alarabiya.superapp.model.NotificationSummary
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.TaskSummary
import online.alarabiya.superapp.model.TwoFactorEnrollmentStep
import online.alarabiya.superapp.model.approvals.ApprovalAccessPolicy
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.collaboration.CollaborationCapabilities
import online.alarabiya.superapp.model.crm.CrmAccess
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.conversations.ConversationCapabilities
import online.alarabiya.superapp.model.finance.FinanceAccessPolicy
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.insights.InsightTarget
import online.alarabiya.superapp.model.insights.InsightsAccessPolicy
import online.alarabiya.superapp.model.insights.SearchEntityType
import online.alarabiya.superapp.model.marketing.MarketingCapabilities
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.operations.OperationsCapabilities
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.receivables.ReceivablesAccessPolicy
import online.alarabiya.superapp.model.products.ProductsCapabilities
import online.alarabiya.superapp.model.sales.SalesCapabilities
import online.alarabiya.superapp.model.sales.SalesSection
import online.alarabiya.superapp.model.selfservice.SelfServiceCapabilities
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.shifts.ShiftAccessPolicy
import online.alarabiya.superapp.model.session.BranchDirectoryStatus
import online.alarabiya.superapp.model.session.SessionBranchContext
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.systemsettings.SystemSettingsCapabilities
import online.alarabiya.superapp.model.workorders.WorkOrdersCapabilities
import online.alarabiya.superapp.model.warehouseTools.WarehouseCapabilities
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Ink
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.OrangeSoft
import online.alarabiya.superapp.ui.theme.Stroke
import java.text.NumberFormat
import java.util.Locale

@Composable
fun SuperAppRoot(
    viewModel: SuperAppViewModel,
    launchAnimationReady: Boolean,
    onLaunchVisibilityChanged: (Boolean) -> Unit,
    biometricAvailable: Boolean,
    onBiometricUnlock: () -> Unit,
    onEnableBiometric: () -> Unit,
    selfServiceSource: SelfServiceDataSource,
    shiftSource: ShiftDataSource,
    branchDirectorySource: BranchDirectoryDataSource,
    approvalsSource: ApprovalsDataSource,
    accountingControlsSourceFactory: (AppBootstrap, Long?) -> AccountingControlsDataSource,
    adminSource: AdminDataSource,
    crmSource: CrmDataSource,
    conversationsSource: ConversationsDataSource,
    commerceSource: CommerceDataSource,
    collaborationSource: CollaborationDataSource,
    receivablesSource: ReceivablesDataSource,
    collectionsSourceFactory: (AppBootstrap) -> CollectionsDataSource,
    announcementsSourceFactory: (AppBootstrap) -> AnnouncementsDataSource,
    marketingSourceFactory: (AppBootstrap, Long?) -> MarketingDataSource,
    operationsSourceFactory: (AppBootstrap, Long?) -> OperationsDataSource,
    inventorySourceFactory: (AppBootstrap, Long?) -> InventoryDataSource,
    hrAdminSourceFactory: (AppBootstrap, Long?) -> HrAdminDataSource,
    salesSource: SalesDataSource,
    purchasingSourceFactory: (AppBootstrap, Long?) -> PurchasingDataSource,
    workOrdersSourceFactory: (AppBootstrap, Long?) -> WorkOrdersDataSource,
    warehouseToolsSourceFactory: (AppBootstrap, Long?) -> WarehouseToolsDataSource,
    storeDeliverySource: StoreDeliveryDataSource,
    storeAdminSource: StoreAdminDataSource,
    financeSource: FinanceDataSource,
    insightsSource: InsightsDataSource,
    productsSource: ProductsDataSource,
    legalSource: LegalDataSource,
    systemSettingsSource: SystemSettingsDataSource,
    twoFactorSource: TwoFactorDataSource,
    notificationDestinations: Flow<NativeNotificationNavigation>,
    networkAvailable: Boolean,
    cachedReadActive: Boolean,
) {
    androidx.compose.runtime.CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Surface(modifier = Modifier.fillMaxSize(), color = Canvas) {
            val sessionState = viewModel.sessionState
            BrandLaunchHost(
                sessionState = sessionState,
                launchAnimationReady = launchAnimationReady,
                onVisibilityChanged = onLaunchVisibilityChanged,
            ) {
                AnimatedContent(targetState = sessionState, label = "session") { state ->
                    when (state) {
                        AppSessionState.Starting -> LoadingScreen("جارٍ فتح مساحتك")
                        is AppSessionState.Loading -> LoadingScreen(state.message)
                        is AppSessionState.Locked -> LockedScreen(
                            userName = state.userName,
                            onUnlock = onBiometricUnlock,
                            onPassword = viewModel::usePasswordInstead,
                        )
                        is AppSessionState.SignedOut -> LoginScreen(
                            state = state,
                            onLogin = viewModel::login,
                            onVerify = viewModel::verifyTwoFactor,
                        )
                        is AppSessionState.PasswordChangeRequired -> PasswordChangeScreen(
                            state = state,
                            onSubmit = viewModel::changeRequiredPassword,
                        )
                        is AppSessionState.TwoFactorEnrollmentRequired -> TwoFactorEnrollmentScreen(
                            state = state,
                            onStart = viewModel::startTwoFactorEnrollment,
                            onConfirm = viewModel::confirmTwoFactorEnrollment,
                            onRecoveryCodesSaved = viewModel::dismissRecoveryCodes,
                        )
                        is AppSessionState.SessionUnavailable -> SessionUnavailableScreen(
                            state = state,
                            onRetry = viewModel::retrySession,
                        )
                        is AppSessionState.Ready -> AppWorkspace(
                            state = state,
                            executiveState = viewModel.executiveState,
                            onRetryExecutive = viewModel::retryExecutive,
                            biometricAvailable = biometricAvailable,
                            onRefresh = viewModel::refresh,
                            onEnableBiometric = onEnableBiometric,
                            onDisableBiometric = viewModel::disableBiometric,
                            onLogout = viewModel::logout,
                            selfServiceSource = selfServiceSource,
                            shiftSource = shiftSource,
                            branchDirectorySource = branchDirectorySource,
                            approvalsSource = approvalsSource,
                            accountingControlsSourceFactory = accountingControlsSourceFactory,
                            adminSource = adminSource,
                            crmSource = crmSource,
                            conversationsSource = conversationsSource,
                            commerceSource = commerceSource,
                            collaborationSource = collaborationSource,
                            receivablesSource = receivablesSource,
                            collectionsSourceFactory = collectionsSourceFactory,
                            announcementsSourceFactory = announcementsSourceFactory,
                            marketingSourceFactory = marketingSourceFactory,
                            operationsSourceFactory = operationsSourceFactory,
                            inventorySourceFactory = inventorySourceFactory,
                            hrAdminSourceFactory = hrAdminSourceFactory,
                            salesSource = salesSource,
                            purchasingSourceFactory = purchasingSourceFactory,
                            workOrdersSourceFactory = workOrdersSourceFactory,
                            warehouseToolsSourceFactory = warehouseToolsSourceFactory,
                            storeDeliverySource = storeDeliverySource,
                            storeAdminSource = storeAdminSource,
                            financeSource = financeSource,
                            insightsSource = insightsSource,
                            productsSource = productsSource,
                            legalSource = legalSource,
                            systemSettingsSource = systemSettingsSource,
                            twoFactorSource = twoFactorSource,
                            notificationDestinations = notificationDestinations,
                            networkAvailable = networkAvailable,
                            cachedReadActive = cachedReadActive,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LoadingScreen(message: String) {
    Box(
        Modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            BrandMark(82.dp)
            CircularProgressIndicator(
                color = Emerald,
                strokeWidth = 3.dp,
                modifier = Modifier.size(34.dp).semantics {
                    contentDescription = message
                    liveRegion = LiveRegionMode.Polite
                },
            )
            Text(message, style = MaterialTheme.typography.bodyLarge, color = MutedInk)
        }
    }
}

@Composable
private fun LockedScreen(userName: String?, onUnlock: () -> Unit, onPassword: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Box(
        Modifier.fillMaxSize().background(EmeraldDark)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            BrandMark(96.dp)
            Text(userName.orEmpty(), style = MaterialTheme.typography.headlineMedium, color = Color.White)
            Button(
                onClick = onUnlock,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = EmeraldDark),
                shape = RoundedCornerShape(20.dp),
            ) {
                Icon(Icons.Rounded.Fingerprint, null)
                Spacer(Modifier.width(10.dp))
                Text("فتح", style = MaterialTheme.typography.labelLarge)
            }
            TextButton(onClick = onPassword) { Text("استخدام كلمة المرور", color = Color.White.copy(alpha = .82f)) }
        }
    }
}

@Composable
private fun LoginScreen(
    state: AppSessionState.SignedOut,
    onLogin: (String, String, Boolean, String?) -> Unit,
    onVerify: (String) -> Unit,
) {
    var identifier by rememberSaveable { mutableStateOf("") }
    var companyCode by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var rememberDevice by rememberSaveable { mutableStateOf(true) }
    var passwordVisible by remember { mutableStateOf(false) }
    var useRecoveryCode by rememberSaveable { mutableStateOf(false) }
    val isTwoFactor = state.twoFactorTicket != null
    val errorFocusRequester = remember { FocusRequester() }
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                password = ""
                code = ""
                passwordVisible = false
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(isTwoFactor) {
        if (isTwoFactor) {
            password = ""
            passwordVisible = false
        }
    }

    AdaptiveAuthLayout {
        LoginForm(
            state = state,
            identifier = identifier,
            onIdentifierChange = { identifier = it },
            companyCode = companyCode,
            onCompanyCodeChange = { companyCode = it },
            password = password,
            onPasswordChange = { password = it },
            code = code,
            onCodeChange = { code = it },
            rememberDevice = rememberDevice,
            onRememberDeviceChange = { rememberDevice = it },
            passwordVisible = passwordVisible,
            onPasswordVisibilityChange = { passwordVisible = !passwordVisible },
            useRecoveryCode = useRecoveryCode,
            onRecoveryModeChange = {
                useRecoveryCode = it
                code = ""
            },
            errorFocusRequester = errorFocusRequester,
            onLogin = onLogin,
            onVerify = onVerify,
        )
    }
}

@Composable
private fun PasswordChangeScreen(
    state: AppSessionState.PasswordChangeRequired,
    onSubmit: (String, String) -> Unit,
) {
    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current
    val errorFocusRequester = remember { FocusRequester() }
    val error = localError ?: state.error

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                currentPassword = ""
                newPassword = ""
                confirmation = ""
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val submit = {
        when {
            currentPassword.isBlank() || newPassword.isBlank() || confirmation.isBlank() -> {
                localError = "أكمل حقول كلمة المرور"
            }
            newPassword != confirmation -> localError = "كلمتا المرور غير متطابقتين"
            else -> {
                val oldValue = currentPassword
                val newValue = newPassword
                currentPassword = ""
                newPassword = ""
                confirmation = ""
                localError = null
                onSubmit(oldValue, newValue)
            }
        }
    }

    AdaptiveAuthLayout {
        Text(
            "تحديث كلمة المرور",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(state.user.name, style = MaterialTheme.typography.bodyLarge, color = MutedInk)
        PasswordField(
            value = currentPassword,
            onValueChange = {
                currentPassword = it
                localError = null
            },
            label = "كلمة المرور الحالية",
            imeAction = ImeAction.Next,
            testTag = "current_password",
        )
        PasswordField(
            value = newPassword,
            onValueChange = {
                newPassword = it
                localError = null
            },
            label = "كلمة المرور الجديدة",
            imeAction = ImeAction.Next,
            testTag = "new_password",
        )
        PasswordField(
            value = confirmation,
            onValueChange = {
                confirmation = it
                localError = null
            },
            label = "تأكيد كلمة المرور",
            imeAction = ImeAction.Done,
            onDone = submit,
            testTag = "confirm_password",
        )
        AuthError(error, errorFocusRequester, "password_change_error")
        PrimaryAuthButton(
            label = "حفظ ومتابعة",
            submitting = state.submitting,
            onClick = submit,
            testTag = "password_change_submit",
        )
    }
}

@Composable
private fun TwoFactorEnrollmentScreen(
    state: AppSessionState.TwoFactorEnrollmentRequired,
    onStart: (String) -> Unit,
    onConfirm: (String) -> Unit,
    onRecoveryCodesSaved: () -> Unit,
) {
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    val lifecycleOwner = LocalLifecycleOwner.current
    val errorFocusRequester = remember { FocusRequester() }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                password = ""
                code = ""
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(state.status) {
        password = ""
        code = ""
    }
    AdaptiveAuthLayout {
        Text(
            "التحقق بخطوتين",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        when (state.status) {
            TwoFactorEnrollmentStep.PASSWORD -> {
                Text("تأكيد الهوية", style = MaterialTheme.typography.bodyLarge, color = MutedInk)
                PasswordField(
                    value = password,
                    onValueChange = { password = it },
                    label = "كلمة المرور الحالية",
                    imeAction = ImeAction.Done,
                    onDone = {
                        val value = password
                        password = ""
                        onStart(value)
                    },
                    testTag = "enrollment_password",
                )
                AuthError(state.error, errorFocusRequester, "enrollment_error")
                PrimaryAuthButton(
                    label = "متابعة",
                    submitting = state.submitting,
                    onClick = {
                        val value = password
                        password = ""
                        onStart(value)
                    },
                    testTag = "enrollment_start",
                )
            }
            TwoFactorEnrollmentStep.SETUP -> {
                Text("أضف المفتاح في تطبيق المصادقة", style = MaterialTheme.typography.bodyLarge, color = MutedInk)
                state.setup?.let { setup ->
                    SelectionContainer {
                        Text(
                            setup.secretBase32,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                                .background(Mint).padding(16.dp)
                                .semantics { contentDescription = "مفتاح التحقق ${setup.secretBase32}" }
                                .testTag("two_factor_secret"),
                            style = MaterialTheme.typography.titleMedium,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter(Char::isDigit).take(6) },
                    modifier = Modifier.fillMaxWidth().testTag("enrollment_code"),
                    label = { Text("رمز التحقق") },
                    leadingIcon = { Icon(Icons.Rounded.Lock, null) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val value = code
                        code = ""
                        onConfirm(value)
                    }),
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                )
                AuthError(state.error, errorFocusRequester, "enrollment_error")
                PrimaryAuthButton(
                    label = "تأكيد",
                    submitting = state.submitting,
                    onClick = {
                        val value = code
                        code = ""
                        onConfirm(value)
                    },
                    testTag = "enrollment_confirm",
                )
            }
            TwoFactorEnrollmentStep.RECOVERY -> {
                Text("رموز الاسترداد", style = MaterialTheme.typography.titleLarge)
                SelectionContainer {
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Mint).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        state.recoveryCodes.forEachIndexed { index, recoveryCode ->
                            Text(
                                "${index + 1}. $recoveryCode",
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.testTag("recovery_code_$index"),
                            )
                        }
                    }
                }
                PrimaryAuthButton(
                    label = "حفظت الرموز",
                    submitting = false,
                    onClick = onRecoveryCodesSaved,
                    testTag = "recovery_codes_saved",
                )
            }
        }
    }
}

@Composable
private fun SessionUnavailableScreen(
    state: AppSessionState.SessionUnavailable,
    onRetry: () -> Unit,
) {
    Box(
        Modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth().widthIn(max = 520.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White),
            shape = RoundedCornerShape(30.dp),
        ) {
            Column(
                Modifier.padding(26.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Icon(Icons.Rounded.WarningAmber, null, tint = Orange, modifier = Modifier.size(42.dp))
                Text(
                    "تعذّر فتح مساحة العمل",
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() },
                    textAlign = TextAlign.Center,
                )
                Text(
                    state.error,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MutedInk,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }.testTag("session_error"),
                )
                state.correlationId?.takeIf(String::isNotBlank)?.let {
                    Text("المرجع: $it", style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                }
                Button(
                    onClick = onRetry,
                    modifier = Modifier.fillMaxWidth().height(56.dp).testTag("session_retry"),
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(8.dp))
                    Text("إعادة المحاولة", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    imeAction: ImeAction,
    onDone: (() -> Unit)? = null,
    testTag: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        label = { Text(label) },
        leadingIcon = { Icon(Icons.Rounded.Lock, null) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        singleLine = true,
        shape = RoundedCornerShape(18.dp),
    )
}

@Composable
private fun ColumnScope.AuthError(
    message: String?,
    focusRequester: FocusRequester,
    testTag: String,
) {
    AnimatedVisibility(visible = !message.isNullOrBlank()) {
        LaunchedEffect(message) { focusRequester.requestFocus() }
        Row(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                .background(Color(0xFFFFEDEA))
                .focusRequester(focusRequester)
                .focusable()
                .semantics {
                    liveRegion = LiveRegionMode.Assertive
                    contentDescription = message.orEmpty()
                }
                .testTag(testTag)
                .padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(Icons.Rounded.WarningAmber, null, tint = MaterialTheme.colorScheme.error)
            Text(message.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun PrimaryAuthButton(
    label: String,
    submitting: Boolean,
    onClick: () -> Unit,
    testTag: String,
) {
    Button(
        onClick = onClick,
        enabled = !submitting,
        modifier = Modifier.fillMaxWidth().height(58.dp).testTag(testTag),
        shape = RoundedCornerShape(19.dp),
    ) {
        if (submitting) {
            CircularProgressIndicator(
                Modifier.size(22.dp).semantics {
                    contentDescription = "جارٍ التحقق"
                    liveRegion = LiveRegionMode.Polite
                },
                color = Color.White,
                strokeWidth = 2.dp,
            )
        } else {
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun AdaptiveAuthLayout(content: @Composable ColumnScope.() -> Unit) {
    BoxWithConstraints(
        Modifier.fillMaxSize().background(Canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
            .testTag("native-login-surface"),
    ) {
        if (maxWidth >= 600.dp) {
            Row(Modifier.fillMaxSize()) {
                LoginBrandPanel(Modifier.weight(.92f).fillMaxHeight(), compact = false)
                Box(
                    modifier = Modifier.weight(1.08f).fillMaxHeight().padding(horizontal = 36.dp, vertical = 28.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    AuthCard(Modifier.fillMaxWidth().widthIn(max = 580.dp).heightIn(max = 680.dp), content)
                }
            }
        } else {
            Box(Modifier.fillMaxSize()) {
                LoginBrandPanel(Modifier.fillMaxWidth().fillMaxHeight(.47f), compact = true)
                AuthCard(
                    Modifier.align(Alignment.BottomCenter)
                        .widthIn(max = 580.dp)
                        .fillMaxWidth()
                        .heightIn(max = 680.dp)
                        .padding(horizontal = 18.dp, vertical = 14.dp),
                    content,
                )
            }
        }
    }
}

@Composable
private fun AuthCard(modifier: Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.shadow(24.dp, RoundedCornerShape(34.dp)),
        shape = RoundedCornerShape(34.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 28.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
private fun LoginBrandPanel(modifier: Modifier, compact: Boolean) {
    val shape: Shape = if (compact) LoginHeaderShape else RoundedCornerShape(bottomStart = 42.dp, topStart = 42.dp)
    Box(modifier.clip(shape).background(EmeraldDark)) {
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = if (compact) 28.dp else 42.dp, vertical = 30.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 16.dp else 22.dp),
        ) {
            BrandMark(if (compact) 76.dp else 92.dp)
            if (compact) Spacer(Modifier.height(4.dp)) else Spacer(Modifier.weight(1f))
            Text(
                "سوبر العربية",
                style = if (compact) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.displaySmall,
                color = Color.White,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                "منصة الأعمال المركزية",
                style = MaterialTheme.typography.bodyLarge,
                color = Color.White.copy(alpha = .78f),
            )
            if (!compact) Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun LoginForm(
    state: AppSessionState.SignedOut,
    identifier: String,
    onIdentifierChange: (String) -> Unit,
    companyCode: String,
    onCompanyCodeChange: (String) -> Unit,
    password: String,
    onPasswordChange: (String) -> Unit,
    code: String,
    onCodeChange: (String) -> Unit,
    rememberDevice: Boolean,
    onRememberDeviceChange: (Boolean) -> Unit,
    passwordVisible: Boolean,
    onPasswordVisibilityChange: () -> Unit,
    useRecoveryCode: Boolean,
    onRecoveryModeChange: (Boolean) -> Unit,
    errorFocusRequester: FocusRequester,
    onLogin: (String, String, Boolean, String?) -> Unit,
    onVerify: (String) -> Unit,
) {
    val isTwoFactor = state.twoFactorTicket != null
    val focusManager = LocalFocusManager.current
    val submitVerification = {
        val submittedCode = code
        onCodeChange("")
        onVerify(submittedCode)
    }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                if (isTwoFactor) "التحقق بخطوتين" else "تسجيل الدخول",
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.semantics { heading() },
            )
            if (isTwoFactor) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { value ->
                        onCodeChange(if (useRecoveryCode) value else value.filter(Char::isDigit).take(6))
                    },
                    modifier = Modifier.fillMaxWidth().testTag("two_factor_input"),
                    label = { Text(if (useRecoveryCode) "رمز الاسترداد" else "رمز التحقق") },
                    leadingIcon = { Icon(Icons.Rounded.Lock, null) },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (useRecoveryCode) KeyboardType.Text else KeyboardType.NumberPassword,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { submitVerification() }),
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                )
                TextButton(
                    onClick = { onRecoveryModeChange(!useRecoveryCode) },
                    modifier = Modifier.align(Alignment.End).testTag("two_factor_mode"),
                ) {
                    Text(if (useRecoveryCode) "استخدام رمز التحقق" else "استخدام رمز الاسترداد")
                }
            } else {
                if (state.companyCodeRequired) {
                    OutlinedTextField(
                        value = companyCode,
                        onValueChange = { onCompanyCodeChange(it.take(40)) },
                        modifier = Modifier.fillMaxWidth().testTag("login_company_code"),
                        label = { Text("رمز الشركة") },
                        leadingIcon = { Icon(Icons.Rounded.BusinessCenter, null) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                        singleLine = true,
                        shape = RoundedCornerShape(18.dp),
                    )
                }
                OutlinedTextField(
                    value = identifier,
                    onValueChange = onIdentifierChange,
                    modifier = Modifier.fillMaxWidth().testTag("login_identifier"),
                    label = { Text("اسم المستخدم أو البريد") },
                    leadingIcon = { Icon(Icons.Rounded.Person, null) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = onPasswordChange,
                    modifier = Modifier.fillMaxWidth().testTag("login_password"),
                    label = { Text("كلمة المرور") },
                    leadingIcon = { Icon(Icons.Rounded.Lock, null) },
                    trailingIcon = {
                        IconButton(
                            onClick = onPasswordVisibilityChange,
                            modifier = Modifier.semantics {
                                contentDescription = if (passwordVisible) "إخفاء كلمة المرور" else "إظهار كلمة المرور"
                            },
                        ) {
                            Icon(if (passwordVisible) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, null)
                        }
                    },
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(
                        onDone = { onLogin(identifier, password, rememberDevice, companyCode.takeIf { it.isNotBlank() }) },
                    ),
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                        .toggleable(
                            value = rememberDevice,
                            role = Role.Checkbox,
                            onValueChange = onRememberDeviceChange,
                        )
                        .semantics(mergeDescendants = true) {
                            stateDescription = if (rememberDevice) "مفعّل" else "غير مفعّل"
                        }
                        .testTag("remember_device")
                        .padding(vertical = 4.dp),
                ) {
                    Checkbox(checked = rememberDevice, onCheckedChange = null)
                    Text("تذكّر هذا الجهاز", style = MaterialTheme.typography.bodyLarge)
                }
            }

            AuthError(state.error, errorFocusRequester, "login_error")

            Button(
                onClick = {
                    if (isTwoFactor) submitVerification()
                    else onLogin(identifier, password, rememberDevice, companyCode.takeIf { it.isNotBlank() })
                },
                enabled = !state.submitting,
                modifier = Modifier.fillMaxWidth().height(58.dp).testTag("login_submit"),
                shape = RoundedCornerShape(19.dp),
            ) {
                if (state.submitting) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp).semantics { contentDescription = "جارٍ التحقق" },
                        color = Color.White,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(if (isTwoFactor) "تحقق" else "دخول", style = MaterialTheme.typography.labelLarge)
                }
            }
    }
}

private enum class NativeComposeRoute(val route: String, val screen: NativeScreen? = null, val primary: Boolean = false) {
    Home("native-home", primary = true),
    Modules("native-services", primary = true),
    SelfService("native-self-service", NativeScreen.SELF_SERVICE, primary = true),
    Alerts("native-alerts", primary = true),
    Approvals("native-approvals", NativeScreen.APPROVALS),
    AccountingControls("native-accounting-controls", NativeScreen.ACCOUNTING_CONTROLS),
    Crm("native-crm", NativeScreen.CRM),
    Conversations("native-conversations", NativeScreen.CONVERSATIONS),
    Commerce("native-commerce", NativeScreen.COMMERCE),
    Collaboration("native-collaboration", NativeScreen.COLLABORATION),
    Marketing("native-marketing", NativeScreen.MARKETING),
    Operations("native-operations", NativeScreen.OPERATIONS),
    Admin("native-admin", NativeScreen.ADMIN),
    Insights("native-insights", NativeScreen.INSIGHTS),
    Shifts("native-shifts", NativeScreen.SHIFTS),
    WorkOrders("native-work-orders", NativeScreen.WORK_ORDERS),
    WarehouseTools("native-warehouse-tools", NativeScreen.WAREHOUSE_TOOLS),
    HrAdmin("native-hr-admin", NativeScreen.HR_ADMIN),
    SystemSettings("native-system-settings", NativeScreen.SYSTEM_SETTINGS),
    Inventory("native-inventory", NativeScreen.INVENTORY),
    Sales("native-sales", NativeScreen.SALES),
    Purchasing("native-purchasing", NativeScreen.PURCHASING),
    StoreDelivery("native-store-delivery", NativeScreen.STORE_DELIVERY),
    StoreAdmin("native-store-admin", NativeScreen.STORE_ADMIN),
    Finance("native-finance", NativeScreen.FINANCE),
    Receivables("native-receivables", NativeScreen.RECEIVABLES),
    Collections("native-collections", NativeScreen.COLLECTIONS),
    AnnouncementsFeed("native-announcements-feed", NativeScreen.ANNOUNCEMENTS_FEED),
    AnnouncementsAdmin("native-announcements-admin", NativeScreen.ANNOUNCEMENTS_ADMIN),
    Products("native-products", NativeScreen.PRODUCTS),
    Settings("native-profile", NativeScreen.SETTINGS, primary = true),
}

private enum class AppTab(
    val label: String,
    val icon: ImageVector,
    val route: NativeComposeRoute,
) {
    Home("الرئيسية", Icons.Rounded.Home, NativeComposeRoute.Home),
    Modules("الخدمات", Icons.Rounded.Apps, NativeComposeRoute.Modules),
    SelfService("مساحتي", Icons.AutoMirrored.Rounded.Assignment, NativeComposeRoute.SelfService),
    Alerts("التنبيهات", Icons.Rounded.Notifications, NativeComposeRoute.Alerts),
    Profile("حسابي", Icons.Rounded.Person, NativeComposeRoute.Settings),
}

private data class NativeServiceEntry(
    val key: String,
    val label: String,
    val accessLabel: String,
    val screen: NativeScreen,
    val destination: NativeDestination,
    val icon: ImageVector,
)

private data class PendingNativeNavigation(
    val destination: NativeDestination,
    val notificationKind: String? = null,
    val arguments: Map<String, String> = emptyMap(),
)

@Composable
internal fun AppWorkspace(
    state: AppSessionState.Ready,
    executiveState: ExecutiveHomeState = ExecutiveHomeState.Loading,
    onRetryExecutive: () -> Unit = {},
    biometricAvailable: Boolean,
    onRefresh: () -> Unit,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onLogout: () -> Unit,
    selfServiceSource: SelfServiceDataSource,
    shiftSource: ShiftDataSource? = null,
    branchDirectorySource: BranchDirectoryDataSource? = null,
    approvalsSource: ApprovalsDataSource,
    notificationDestinations: Flow<NativeNotificationNavigation>,
    networkAvailable: Boolean = true,
    cachedReadActive: Boolean = false,
    accountingControlsSourceFactory: ((AppBootstrap, Long?) -> AccountingControlsDataSource)? = null,
    adminSource: AdminDataSource? = null,
    crmSource: CrmDataSource? = null,
    conversationsSource: ConversationsDataSource? = null,
    commerceSource: CommerceDataSource? = null,
    collaborationSource: CollaborationDataSource? = null,
    receivablesSource: ReceivablesDataSource? = null,
    collectionsSourceFactory: ((AppBootstrap) -> CollectionsDataSource)? = null,
    announcementsSourceFactory: ((AppBootstrap) -> AnnouncementsDataSource)? = null,
    marketingSourceFactory: ((AppBootstrap, Long?) -> MarketingDataSource)? = null,
    operationsSourceFactory: ((AppBootstrap, Long?) -> OperationsDataSource)? = null,
    inventorySourceFactory: ((AppBootstrap, Long?) -> InventoryDataSource)? = null,
    hrAdminSourceFactory: ((AppBootstrap, Long?) -> HrAdminDataSource)? = null,
    salesSource: SalesDataSource? = null,
    purchasingSourceFactory: ((AppBootstrap, Long?) -> PurchasingDataSource)? = null,
    workOrdersSourceFactory: ((AppBootstrap, Long?) -> WorkOrdersDataSource)? = null,
    warehouseToolsSourceFactory: ((AppBootstrap, Long?) -> WarehouseToolsDataSource)? = null,
    storeDeliverySource: StoreDeliveryDataSource? = null,
    storeAdminSource: StoreAdminDataSource? = null,
    financeSource: FinanceDataSource? = null,
    insightsSource: InsightsDataSource? = null,
    productsSource: ProductsDataSource? = null,
    legalSource: LegalDataSource? = null,
    systemSettingsSource: SystemSettingsDataSource? = null,
    twoFactorSource: TwoFactorDataSource? = null,
) {
    val navController = rememberNavController()
    val initialBranchContext = remember(state.bootstrap) { SessionBranchContext.initial(state.bootstrap) }
    var sessionBranchContext by remember(initialBranchContext.principal) {
        mutableStateOf(initialBranchContext)
    }
    var branchDirectoryRetry by remember(initialBranchContext.principal) { mutableIntStateOf(0) }
    LaunchedEffect(initialBranchContext.principal, branchDirectorySource, branchDirectoryRetry) {
        if (!initialBranchContext.principal.canSelectBranch) return@LaunchedEffect
        val source = branchDirectorySource
        if (source == null) {
            sessionBranchContext = sessionBranchContext.failed("تعذر تحميل الفروع")
            return@LaunchedEffect
        }
        sessionBranchContext = sessionBranchContext.loading()
        sessionBranchContext = runCatching { source.availableBranches() }
            .fold(
                onSuccess = sessionBranchContext::loaded,
                onFailure = { error ->
                    sessionBranchContext.failed(error.message ?: "تعذر تحميل الفروع")
                },
            )
    }
    val effectiveBranchId = sessionBranchContext.effectiveBranchId
    val principal = remember(state.bootstrap) { state.bootstrap.toNavigationPrincipal() }
    val approvalPolicy = remember(state.bootstrap, effectiveBranchId) {
        ApprovalAccessPolicy.fromBootstrap(state.bootstrap, effectiveBranchId)
    }
    val accountingControlsCapabilities = remember(state.bootstrap, effectiveBranchId) {
        AccountingControlsCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val accountingControlsSource = remember(state.bootstrap, effectiveBranchId, accountingControlsSourceFactory) {
        accountingControlsSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val collaborationCapabilities = remember(state.bootstrap, effectiveBranchId) {
        CollaborationCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val shiftPolicy = remember(state.bootstrap) { ShiftAccessPolicy.fromBootstrap(state.bootstrap) }
    val receivablesPolicy = remember(state.bootstrap, effectiveBranchId) {
        ReceivablesAccessPolicy.fromBootstrap(state.bootstrap, effectiveBranchId)
    }
    val collectionsCapabilities = remember(state.bootstrap) { CollectionsCapabilities.fromBootstrap(state.bootstrap) }
    val collectionsSource = remember(state.bootstrap, collectionsSourceFactory) {
        collectionsSourceFactory?.invoke(state.bootstrap)
    }
    val announcementsCapabilities = remember(state.bootstrap) {
        AnnouncementsCapabilities.fromBootstrap(state.bootstrap)
    }
    val announcementsSource = remember(state.bootstrap, announcementsSourceFactory) {
        announcementsSourceFactory?.invoke(state.bootstrap)
    }
    val crmCapabilities = remember(state.bootstrap, effectiveBranchId) {
        state.bootstrap.toCrmCapabilities().copy(branchId = effectiveBranchId)
    }
    val commerceCapabilities = remember(state.bootstrap, effectiveBranchId) {
        CommerceCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val marketingCapabilities = remember(state.bootstrap) { state.bootstrap.toMarketingCapabilities() }
    val marketingScope = remember(state.bootstrap, effectiveBranchId) {
        MarketingScope(state.bootstrap.user.role, effectiveBranchId)
    }
    val marketingSource = remember(state.bootstrap, effectiveBranchId, marketingSourceFactory) {
        marketingSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val operationsScope = remember(state.bootstrap, effectiveBranchId) {
        OperationsScope(
            state.bootstrap.user.role,
            effectiveBranchId,
            state.bootstrap.isOwner || state.bootstrap.user.isOwner,
        )
    }
    val operationsCapabilities = remember(state.bootstrap, effectiveBranchId) {
        state.bootstrap.toOperationsCapabilities(effectiveBranchId)
    }
    val operationsSource = remember(state.bootstrap, effectiveBranchId, operationsSourceFactory) {
        operationsSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val insightsPolicy = remember(state.bootstrap) { InsightsAccessPolicy.fromBootstrap(state.bootstrap) }
    val inventorySource = remember(state.bootstrap, effectiveBranchId, inventorySourceFactory) {
        inventorySourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val hrAdminCapabilities = remember(state.bootstrap, effectiveBranchId) {
        HrAdminCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val hrAdminSource = remember(state.bootstrap, effectiveBranchId, hrAdminSourceFactory) {
        hrAdminSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val purchasingSource = remember(state.bootstrap, effectiveBranchId, purchasingSourceFactory) {
        purchasingSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val workOrdersCapabilities = remember(state.bootstrap, effectiveBranchId) {
        WorkOrdersCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val workOrdersSource = remember(state.bootstrap, effectiveBranchId, workOrdersSourceFactory) {
        workOrdersSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val warehouseToolsCapabilities = remember(state.bootstrap, effectiveBranchId) {
        WarehouseCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
    }
    val warehouseToolsSource = remember(state.bootstrap, effectiveBranchId, warehouseToolsSourceFactory) {
        warehouseToolsSourceFactory?.invoke(state.bootstrap, effectiveBranchId)
    }
    val installedScreens = remember(
        state.bootstrap, effectiveBranchId, sessionBranchContext.principal.canSelectBranch,
        adminSource, crmSource, conversationsSource, commerceSource, collaborationSource, shiftSource, receivablesSource, collectionsSource, marketingSource, operationsSource, accountingControlsSource, inventorySource, hrAdminSource, salesSource, purchasingSource, workOrdersSource, warehouseToolsSource, storeDeliverySource, storeAdminSource, financeSource, insightsSource, productsSource, legalSource, systemSettingsSource, announcementsSource,
    ) {
        buildSet {
            if (state.bootstrap.hasPersonalWorkspace) add(NativeScreen.SELF_SERVICE)
            if (shiftSource != null && shiftPolicy.canReadManagement) add(NativeScreen.SHIFTS)
            add(NativeScreen.APPROVALS)
            if (
                accountingControlsSource != null &&
                (accountingControlsCapabilities.canReadAccounts ||
                    accountingControlsCapabilities.canReadExchange ||
                    accountingControlsCapabilities.canGovernPeriods)
            ) add(NativeScreen.ACCOUNTING_CONTROLS)
            if (adminSource != null && state.bootstrap.user.role.equals("admin", ignoreCase = true)) add(NativeScreen.ADMIN)
            if (crmSource != null && crmCapabilities.visibleSections.isNotEmpty()) add(NativeScreen.CRM)
            if (conversationsSource != null) {
                val conversations = ConversationCapabilities.fromBootstrap(state.bootstrap)
                if (
                    conversations.access.canRead &&
                    (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch)
                ) add(NativeScreen.CONVERSATIONS)
            }
            if (commerceSource != null && commerceCapabilities.readableSections().isNotEmpty()) {
                add(NativeScreen.COMMERCE)
            }
            if (
                collaborationSource != null &&
                ((collaborationCapabilities.tasks.canRead &&
                    (collaborationCapabilities.branchId != null || collaborationCapabilities.canSelectTaskBranch)) ||
                    collaborationCapabilities.canReadBroadcastsSafely)
            ) add(NativeScreen.COLLABORATION)
            if (receivablesSource != null && receivablesPolicy.readableSections.isNotEmpty()) {
                add(NativeScreen.RECEIVABLES)
            }
            if (
                collectionsSource != null && collectionsCapabilities.canReadCreditDecisions &&
                principal.grantFor(NativeModule.COLLECTIONS).satisfies(ModuleGrant.FULL)
            ) add(NativeScreen.COLLECTIONS)
            if (announcementsSource != null) {
                // تغذية الإعلانات عالميّة لكل مصادَق؛ شاشة الإدارة محروسة بصلاحية الوحدة.
                add(NativeScreen.ANNOUNCEMENTS_FEED)
                if (announcementsCapabilities.canReadManagement) add(NativeScreen.ANNOUNCEMENTS_ADMIN)
            }
            if (
                marketingSource != null &&
                (marketingCapabilities.canReadCampaigns || marketingCapabilities.canReadCatalogQuality)
            ) add(NativeScreen.MARKETING)
            if (operationsSource != null && operationsCapabilities.sections.isNotEmpty()) {
                add(NativeScreen.OPERATIONS)
            }
            if (
                inventorySource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch)
            ) add(NativeScreen.INVENTORY)
            if (
                hrAdminSource != null &&
                (hrAdminCapabilities.canReadEmployees || hrAdminCapabilities.canReadCompanyHr)
            ) add(NativeScreen.HR_ADMIN)
            if (
                salesSource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch)
            ) add(NativeScreen.SALES)
            if (
                purchasingSource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch)
            ) add(NativeScreen.PURCHASING)
            if (
                workOrdersSource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch) &&
                (
                    principal.grantFor(NativeModule.WORK_ORDERS).satisfies(ModuleGrant.READ) ||
                    workOrdersCapabilities.workorders.canRead ||
                    workOrdersCapabilities.pos.canWrite ||
                    workOrdersCapabilities.inventory.canWrite ||
                    workOrdersCapabilities.canUsePricing
                )
            ) add(NativeScreen.WORK_ORDERS)
            if (
                warehouseToolsSource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch) &&
                principal.grantFor(NativeModule.INVENTORY).satisfies(ModuleGrant.READ) &&
                principal.grantFor(NativeModule.PRODUCTS).satisfies(ModuleGrant.READ)
            ) add(NativeScreen.WAREHOUSE_TOOLS)
            if (storeDeliverySource != null) add(NativeScreen.STORE_DELIVERY)
            if (storeAdminSource != null) {
                val storeAccess = state.bootstrap.modules.firstOrNull { it.key == NativeModule.STORE.wireName }?.access
                if (StoreAdminCapabilities.from(state.bootstrap.user.role, storeAccess).canRead) add(NativeScreen.STORE_ADMIN)
            }
            if (financeSource != null) add(NativeScreen.FINANCE)
            if (insightsSource != null && insightsPolicy.readableSections.isNotEmpty()) add(NativeScreen.INSIGHTS)
            if (
                productsSource != null &&
                (effectiveBranchId != null || sessionBranchContext.principal.canSelectBranch)
            ) add(NativeScreen.PRODUCTS)
            if (legalSource != null) add(NativeScreen.SETTINGS)
            if (
                systemSettingsSource != null &&
                SystemSettingsCapabilities.fromBootstrap(state.bootstrap).readableSections().isNotEmpty() &&
                principal.grantFor(NativeModule.SETTINGS).satisfies(ModuleGrant.READ)
            ) {
                add(NativeScreen.SYSTEM_SETTINGS)
            }
        }
    }
    val services = remember(state.bootstrap, installedScreens) {
        implementedServices(state.bootstrap, principal, approvalPolicy, installedScreens)
    }
    val tabs = remember(services, installedScreens) {
        buildList {
            add(AppTab.Home)
            if (services.isNotEmpty()) add(AppTab.Modules)
            if (services.any { it.destination.isSelfServiceDestination() }) add(AppTab.SelfService)
            add(AppTab.Alerts)
            if (NativeScreen.SETTINGS in installedScreens) add(AppTab.Profile)
        }
    }
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = NativeComposeRoute.entries.firstOrNull {
        it.route == backStackEntry?.destination?.route
    } ?: NativeComposeRoute.Home
    val currentTab = tabs.firstOrNull { it.route == currentRoute }
        ?: if (currentRoute.screen != null) AppTab.Modules else AppTab.Home
    var pendingNavigation by remember(state.bootstrap.user.id) {
        mutableStateOf<PendingNativeNavigation?>(null)
    }
    var pendingBranchNavigation by remember(initialBranchContext.principal) {
        mutableStateOf<PendingNativeNavigation?>(null)
    }
    var branchPickerVisible by remember(initialBranchContext.principal) { mutableStateOf(false) }

    fun performNavigation(request: PendingNativeNavigation) {
        val route = implementedRouteFor(
            request.destination,
            principal,
            approvalPolicy,
            installedScreens,
            request.notificationKind,
        ) ?: return
        val feature = request.destination as? NativeDestination.Feature
        pendingNavigation = when {
            notificationSelfServiceSection(request.notificationKind, request.destination) != null -> request
            request.arguments.isNotEmpty() -> request
            feature != null && route.supportsFeatureLaunch(feature) -> request
            else -> null
        }
        navController.navigateNative(route)
    }

    fun navigate(
        destination: NativeDestination,
        notificationKind: String? = null,
        arguments: Map<String, String> = emptyMap(),
    ) {
        val route = implementedRouteFor(
            destination,
            principal,
            approvalPolicy,
            installedScreens,
            notificationKind,
        ) ?: return
        val request = PendingNativeNavigation(destination, notificationKind, arguments)
        if (
            sessionBranchContext.requiresExplicitSelection &&
            route.screen in sessionBranchRequiredScreens
        ) {
            pendingBranchNavigation = request
            branchPickerVisible = true
            return
        }
        performNavigation(request)
    }
    val openDestination: (NativeDestination) -> Unit = { destination -> navigate(destination) }
    val openExecutiveDestination: (ExecutiveDestinationKey, Map<String, String>) -> Unit = { key, arguments ->
        ExecutiveNavigation.request(key, arguments).let { request ->
            navigate(request.destination, arguments = request.arguments)
        }
    }

    LaunchedEffect(state.bootstrap.user.id, principal, approvalPolicy, notificationDestinations) {
        notificationDestinations.collect { target -> navigate(target.destination, target.kind) }
    }
    LaunchedEffect(currentRoute, services, principal, approvalPolicy, installedScreens) {
        val stillAllowed = when (currentRoute) {
            NativeComposeRoute.SelfService -> services.any { it.destination.isSelfServiceDestination() }
            NativeComposeRoute.Approvals -> services.any { it.destination == NativeDestination.Approvals }
            NativeComposeRoute.Modules -> services.isNotEmpty()
            NativeComposeRoute.Settings -> NativeScreen.SETTINGS in installedScreens
            else -> currentRoute.screen?.let { it in NativeFeatureCatalog.reachableScreens(principal, installedScreens) } ?: true
        }
        if (!stillAllowed) navController.navigateNative(NativeComposeRoute.Home)
    }

    fun selectSessionBranch(branchId: Long) {
        val next = sessionBranchContext.select(branchId)
        if (next.effectiveBranchId == null) {
            sessionBranchContext = next
            return
        }
        sessionBranchContext = next
        branchPickerVisible = false
        val pending = pendingBranchNavigation
        pendingBranchNavigation = null
        pending?.let(::performNavigation)
    }

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .background(if (currentRoute == NativeComposeRoute.Home) EmeraldDark else Canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding(),
    ) {
        val useNavigationRail = maxWidth >= 600.dp
        val expandedLayout = maxWidth >= 840.dp
        if (useNavigationRail) {
            Row(Modifier.fillMaxSize()) {
                AppNavigationRail(
                    tabs = tabs,
                    selected = currentTab,
                    onSelect = { navController.navigateNative(it.route) },
                    badge = state.workspace.notifications.count { it.requiresAction },
                )
                NativeWorkspaceNavHost(
                    navController = navController,
                    state = state,
                    tablet = expandedLayout,
                    services = services,
                    onOpen = openDestination,
                    onOpenExecutive = openExecutiveDestination,
                    executiveState = executiveState,
                    onRetryExecutive = onRetryExecutive,
                    sessionBranchContext = sessionBranchContext,
                    onChangeSessionBranch = {
                        pendingBranchNavigation = null
                        branchPickerVisible = true
                    },
                    pendingNavigation = pendingNavigation,
                    onNavigationConsumed = { pendingNavigation = null },
                    onRefresh = onRefresh,
                    biometricAvailable = biometricAvailable,
                    onEnableBiometric = onEnableBiometric,
                    onDisableBiometric = onDisableBiometric,
                    onLogout = onLogout,
                    selfServiceSource = selfServiceSource,
                    shiftSource = shiftSource,
                    shiftPolicy = shiftPolicy,
                    approvalsSource = approvalsSource,
                    approvalPolicy = approvalPolicy,
                    accountingControlsSource = accountingControlsSource,
                    accountingControlsCapabilities = accountingControlsCapabilities,
                    adminSource = adminSource,
                    crmSource = crmSource,
                    crmCapabilities = crmCapabilities,
                    conversationsSource = conversationsSource,
                    commerceSource = commerceSource,
                    commerceCapabilities = commerceCapabilities,
                    collaborationSource = collaborationSource,
                    collaborationCapabilities = collaborationCapabilities,
                    receivablesSource = receivablesSource,
                    receivablesPolicy = receivablesPolicy,
                    collectionsSource = collectionsSource,
                    announcementsSource = announcementsSource,
                    announcementsCapabilities = announcementsCapabilities,
                    marketingSource = marketingSource,
                    marketingScope = marketingScope,
                    marketingCapabilities = marketingCapabilities,
                    operationsSource = operationsSource,
                    operationsScope = operationsScope,
                    operationsCapabilities = operationsCapabilities,
                    inventorySource = inventorySource,
                    hrAdminSource = hrAdminSource,
                    hrAdminCapabilities = hrAdminCapabilities,
                    salesSource = salesSource,
                    purchasingSource = purchasingSource,
                    workOrdersSource = workOrdersSource,
                    workOrdersCapabilities = workOrdersCapabilities,
                    warehouseToolsSource = warehouseToolsSource,
                    warehouseToolsCapabilities = warehouseToolsCapabilities,
                    storeDeliverySource = storeDeliverySource,
                    storeAdminSource = storeAdminSource,
                    financeSource = financeSource,
                    insightsSource = insightsSource,
                    insightsPolicy = insightsPolicy,
                    productsSource = productsSource,
                    legalSource = legalSource,
                    systemSettingsSource = systemSettingsSource,
                    twoFactorSource = twoFactorSource,
                    modifier = Modifier.weight(1f),
                )
            }
        } else {
            Scaffold(
                containerColor = Canvas,
                bottomBar = {
                    AppBottomBar(
                        tabs = tabs,
                        selected = currentTab,
                        onSelect = { navController.navigateNative(it.route) },
                        badge = state.workspace.notifications.count { it.requiresAction },
                    )
                },
            ) { padding ->
                NativeWorkspaceNavHost(
                    navController = navController,
                    state = state,
                    tablet = false,
                    services = services,
                    onOpen = openDestination,
                    onOpenExecutive = openExecutiveDestination,
                    executiveState = executiveState,
                    onRetryExecutive = onRetryExecutive,
                    sessionBranchContext = sessionBranchContext,
                    onChangeSessionBranch = {
                        pendingBranchNavigation = null
                        branchPickerVisible = true
                    },
                    pendingNavigation = pendingNavigation,
                    onNavigationConsumed = { pendingNavigation = null },
                    onRefresh = onRefresh,
                    biometricAvailable = biometricAvailable,
                    onEnableBiometric = onEnableBiometric,
                    onDisableBiometric = onDisableBiometric,
                    onLogout = onLogout,
                    selfServiceSource = selfServiceSource,
                    shiftSource = shiftSource,
                    shiftPolicy = shiftPolicy,
                    approvalsSource = approvalsSource,
                    approvalPolicy = approvalPolicy,
                    accountingControlsSource = accountingControlsSource,
                    accountingControlsCapabilities = accountingControlsCapabilities,
                    adminSource = adminSource,
                    crmSource = crmSource,
                    crmCapabilities = crmCapabilities,
                    conversationsSource = conversationsSource,
                    commerceSource = commerceSource,
                    commerceCapabilities = commerceCapabilities,
                    collaborationSource = collaborationSource,
                    collaborationCapabilities = collaborationCapabilities,
                    receivablesSource = receivablesSource,
                    receivablesPolicy = receivablesPolicy,
                    collectionsSource = collectionsSource,
                    announcementsSource = announcementsSource,
                    announcementsCapabilities = announcementsCapabilities,
                    marketingSource = marketingSource,
                    marketingScope = marketingScope,
                    marketingCapabilities = marketingCapabilities,
                    operationsSource = operationsSource,
                    operationsScope = operationsScope,
                    operationsCapabilities = operationsCapabilities,
                    inventorySource = inventorySource,
                    hrAdminSource = hrAdminSource,
                    hrAdminCapabilities = hrAdminCapabilities,
                    salesSource = salesSource,
                    purchasingSource = purchasingSource,
                    workOrdersSource = workOrdersSource,
                    workOrdersCapabilities = workOrdersCapabilities,
                    warehouseToolsSource = warehouseToolsSource,
                    warehouseToolsCapabilities = warehouseToolsCapabilities,
                    storeDeliverySource = storeDeliverySource,
                    storeAdminSource = storeAdminSource,
                    financeSource = financeSource,
                    insightsSource = insightsSource,
                    insightsPolicy = insightsPolicy,
                    productsSource = productsSource,
                    legalSource = legalSource,
                    systemSettingsSource = systemSettingsSource,
                    twoFactorSource = twoFactorSource,
                    modifier = Modifier.fillMaxSize().padding(bottom = padding.calculateBottomPadding()),
                )
            }
        }
        AnimatedVisibility(
            visible = !networkAvailable || state.usingCachedData || cachedReadActive,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
            enter = fadeIn(tween(180)) + slideInVertically(tween(220)) { -it },
            exit = fadeOut(tween(140)) + slideOutVertically(tween(180)) { -it },
        ) {
            Surface(
                color = Ink.copy(alpha = .94f),
                contentColor = Color.White,
                shape = RoundedCornerShape(22.dp),
                shadowElevation = 10.dp,
            ) {
                Row(
                    Modifier.padding(horizontal = 16.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Rounded.WarningAmber, null, modifier = Modifier.size(18.dp))
                    Text(
                        if (!networkAvailable) "بلا اتصال" else "بيانات محفوظة",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
        if (branchPickerVisible && sessionBranchContext.principal.canSelectBranch) {
            SessionBranchPicker(
                context = sessionBranchContext,
                onSelect = ::selectSessionBranch,
                onRetry = { branchDirectoryRetry += 1 },
                onDismiss = {
                    branchPickerVisible = false
                    pendingBranchNavigation = null
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionBranchPicker(
    context: SessionBranchContext,
    onSelect: (Long) -> Unit,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("session-branch-picker"),
        containerColor = Canvas,
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 34.dp),
    ) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("اختر الفرع", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
            when (context.directoryStatus) {
                BranchDirectoryStatus.IDLE,
                BranchDirectoryStatus.LOADING,
                -> Box(
                    Modifier.fillMaxWidth().height(160.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(color = Emerald) }

                BranchDirectoryStatus.FAILED -> {
                    Text(
                        context.error ?: "تعذر تحميل الفروع",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Button(
                        onClick = onRetry,
                        modifier = Modifier.fillMaxWidth().testTag("session-branch-retry"),
                    ) { Text("إعادة المحاولة") }
                }

                BranchDirectoryStatus.READY -> if (context.branches.isEmpty()) {
                    Text("لا توجد فروع متاحة", style = MaterialTheme.typography.bodyLarge, color = MutedInk)
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxWidth().heightIn(max = 440.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(bottom = 18.dp),
                    ) {
                        items(context.branches, key = { it.id }) { branch ->
                            val selected = context.selectedBranchId == branch.id
                            Surface(
                                modifier = Modifier.fillMaxWidth()
                                    .testTag("session-branch-${branch.id}")
                                    .clickable(role = Role.Button) { onSelect(branch.id) },
                                shape = RoundedCornerShape(20.dp),
                                color = if (selected) Emerald else Color.White,
                                contentColor = if (selected) Color.White else Ink,
                                tonalElevation = if (selected) 0.dp else 1.dp,
                            ) {
                                Row(
                                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 15.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    Icon(Icons.Rounded.BusinessCenter, null)
                                    Column(Modifier.weight(1f)) {
                                        Text(branch.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                        branch.code?.let { code ->
                                            Text(
                                                code,
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = if (selected) Color.White.copy(alpha = .76f) else MutedInk,
                                            )
                                        }
                                    }
                                    if (selected) Icon(Icons.Rounded.CheckCircle, null)
                                }
                            }
                        }
                    }
                }

                BranchDirectoryStatus.NOT_REQUIRED -> Unit
            }
        }
    }
}

@Composable
private fun NativeWorkspaceNavHost(
    navController: NavHostController,
    state: AppSessionState.Ready,
    tablet: Boolean,
    services: List<NativeServiceEntry>,
    onOpen: (NativeDestination) -> Unit,
    onOpenExecutive: (ExecutiveDestinationKey, Map<String, String>) -> Unit,
    executiveState: ExecutiveHomeState,
    onRetryExecutive: () -> Unit,
    sessionBranchContext: SessionBranchContext,
    onChangeSessionBranch: () -> Unit,
    pendingNavigation: PendingNativeNavigation?,
    onNavigationConsumed: () -> Unit,
    onRefresh: () -> Unit,
    biometricAvailable: Boolean,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onLogout: () -> Unit,
    selfServiceSource: SelfServiceDataSource,
    shiftSource: ShiftDataSource?,
    shiftPolicy: ShiftAccessPolicy,
    approvalsSource: ApprovalsDataSource,
    approvalPolicy: ApprovalAccessPolicy,
    accountingControlsSource: AccountingControlsDataSource?,
    accountingControlsCapabilities: AccountingControlsCapabilities,
    adminSource: AdminDataSource?,
    crmSource: CrmDataSource?,
    crmCapabilities: CrmCapabilities,
    conversationsSource: ConversationsDataSource?,
    commerceSource: CommerceDataSource?,
    commerceCapabilities: CommerceCapabilities,
    collaborationSource: CollaborationDataSource?,
    collaborationCapabilities: CollaborationCapabilities,
    receivablesSource: ReceivablesDataSource?,
    receivablesPolicy: ReceivablesAccessPolicy,
    collectionsSource: CollectionsDataSource?,
    announcementsSource: AnnouncementsDataSource?,
    announcementsCapabilities: AnnouncementsCapabilities,
    marketingSource: MarketingDataSource?,
    marketingScope: MarketingScope,
    marketingCapabilities: MarketingCapabilities,
    operationsSource: OperationsDataSource?,
    operationsScope: OperationsScope,
    operationsCapabilities: OperationsCapabilities,
    inventorySource: InventoryDataSource?,
    hrAdminSource: HrAdminDataSource?,
    hrAdminCapabilities: HrAdminCapabilities,
    salesSource: SalesDataSource?,
    purchasingSource: PurchasingDataSource?,
    workOrdersSource: WorkOrdersDataSource?,
    workOrdersCapabilities: WorkOrdersCapabilities,
    warehouseToolsSource: WarehouseToolsDataSource?,
    warehouseToolsCapabilities: WarehouseCapabilities,
    storeDeliverySource: StoreDeliveryDataSource?,
    storeAdminSource: StoreAdminDataSource?,
    financeSource: FinanceDataSource?,
    insightsSource: InsightsDataSource?,
    insightsPolicy: InsightsAccessPolicy,
    productsSource: ProductsDataSource?,
    legalSource: LegalDataSource?,
    systemSettingsSource: SystemSettingsDataSource?,
    twoFactorSource: TwoFactorDataSource?,
    modifier: Modifier = Modifier,
) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = NativeComposeRoute.entries.firstOrNull {
        it.route == backStackEntry?.destination?.route
    } ?: NativeComposeRoute.Home
    val nestedBackCoordinator = remember { WorkspaceBackCoordinator() }
    val effectiveBranchId = sessionBranchContext.effectiveBranchId
    val navigateUp: () -> Unit = {
        if (nestedBackCoordinator.consume(currentRoute)) {
            Unit
        } else if (!navController.popBackStack()) {
            navController.navigateNative(NativeComposeRoute.Home)
        }
        Unit
    }

    Column(modifier) {
        AnimatedVisibility(
            visible = currentRoute != NativeComposeRoute.Home && !currentRoute.ownsWorkspaceHeader(),
        ) {
            WorkspaceUpBar(onNavigateUp = navigateUp)
        }
        NavHost(
            navController = navController,
            startDestination = NativeComposeRoute.Home.route,
            modifier = Modifier.weight(1f),
        ) {
        composable(NativeComposeRoute.Home.route) {
            Box(Modifier.fillMaxSize().testTag("native-route-home")) {
                if (state.bootstrap.hasExecutiveHome()) {
                    val managementServices = services.sortedBy { service ->
                        when (service.screen) {
                            NativeScreen.APPROVALS -> 0
                            NativeScreen.ADMIN -> 1
                            NativeScreen.FINANCE -> 2
                            NativeScreen.SALES -> 3
                            NativeScreen.INVENTORY -> 4
                            NativeScreen.HR_ADMIN -> 5
                            NativeScreen.INSIGHTS -> 6
                            NativeScreen.STORE_ADMIN -> 7
                            else -> 20
                        }
                    }
                    ExecutiveHomeScreen(
                        state = executiveState,
                        userName = state.bootstrap.user.name,
                        roleLabel = state.bootstrap.user.roleLabel,
                        tablet = tablet,
                        managementActions = managementServices.take(6).map { ExecutiveManagementAction(it.label, it.icon) },
                        onRetry = onRetryExecutive,
                        onManagementAction = { index -> managementServices.getOrNull(index)?.destination?.let(onOpen) },
                        onAllServices = { onOpen(NativeDestination.ModuleDirectory) },
                        onOpen = onOpenExecutive,
                    )
                } else {
                    HomeScreen(state.bootstrap, state.workspace, tablet, services, onOpen, onRefresh)
                }
            }
        }
        composable(NativeComposeRoute.Modules.route) {
            Box(Modifier.fillMaxSize().testTag("native-route-services")) {
                ModulesScreen(services, sessionBranchContext, onChangeSessionBranch, onOpen)
            }
        }
        composable(NativeComposeRoute.SelfService.route) {
            val featureViewModel: SelfServiceViewModel = viewModel(
                key = "self-service-${state.bootstrap.user.id}",
                factory = SelfServiceViewModelFactory(selfServiceSource),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                val section = notificationSelfServiceSection(pending.notificationKind, pending.destination)
                    ?: return@LaunchedEffect
                featureViewModel.select(section)
                onNavigationConsumed()
            }
            val tasksAccess = state.bootstrap.modules.firstOrNull { it.key == NativeModule.TASKS.wireName }?.access
            Box(Modifier.fillMaxSize().testTag("native-route-self-service")) {
                SelfServiceRoute(
                    viewModel = featureViewModel,
                    capabilities = SelfServiceCapabilities.fromTasksAccess(tasksAccess),
                    account = state.bootstrap.user,
                    biometricAvailable = biometricAvailable,
                    biometricEnabled = state.biometricEnabled,
                    onEnableBiometric = onEnableBiometric,
                    onDisableBiometric = onDisableBiometric,
                    onClose = { navController.navigateNative(NativeComposeRoute.Home) },
                )
            }
        }
        composable(NativeComposeRoute.Alerts.route) {
            Box(Modifier.fillMaxSize().testTag("native-route-alerts")) {
                NotificationsScreen(state.workspace.notifications)
            }
        }
        composable(NativeComposeRoute.Approvals.route) {
            val featureViewModel: ApprovalsViewModel = viewModel(
                key = "approvals-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = ApprovalsViewModelFactory(approvalsSource, approvalPolicy),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Approvals, enabled = !tablet) {
                when {
                    featureViewModel.state.confirmation != null -> true.also { featureViewModel.cancelDecision() }
                    featureViewModel.state.selectedKey != null -> true.also { featureViewModel.select(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-approvals")) {
                ApprovalsRoute(featureViewModel)
            }
        }
        if (accountingControlsSource != null) composable(NativeComposeRoute.AccountingControls.route) {
            val featureViewModel: AccountingControlsViewModel = viewModel(
                key = "accounting-controls-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = NativeViewModelFactory {
                    AccountingControlsViewModel(accountingControlsSource, accountingControlsCapabilities)
                },
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.AccountingControls, enabled = !tablet) {
                if (featureViewModel.state.selectedExchangeHouseId == null) false
                else true.also { featureViewModel.selectExchangeHouse(null) }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-accounting-controls")) {
                AccountingControlsRoute(featureViewModel)
            }
        }
        if (adminSource != null) composable(NativeComposeRoute.Admin.route) {
            val featureViewModel: AdminViewModel = viewModel(
                key = "admin-${state.bootstrap.user.id}",
                factory = AdminViewModelFactory(adminSource, state.bootstrap),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Admin, enabled = !tablet) {
                when {
                    featureViewModel.state.selectedUserId != null -> true.also { featureViewModel.selectUser(null) }
                    featureViewModel.state.selectedRoleKey != null -> true.also { featureViewModel.selectRole(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-admin")) {
                AdminRoute(featureViewModel)
            }
        }
        if (crmSource != null) composable(NativeComposeRoute.Crm.route) {
            val capabilities = crmCapabilities
            val featureViewModel: CrmViewModel = viewModel(
                key = "crm-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = CrmViewModelFactory(crmSource, capabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val feature = pendingNavigation?.destination as? NativeDestination.Feature ?: return@LaunchedEffect
                when (feature.module) {
                    NativeModule.CRM -> feature.typedEntity("customer")?.let { id ->
                        featureViewModel.selectSection(CrmSection.Customers)
                        featureViewModel.selectCustomer(id)
                    } ?: return@LaunchedEffect
                    NativeModule.SALES -> feature.typedEntity("quotation", allowBare = false)?.let { id ->
                        featureViewModel.selectSection(CrmSection.Quotations)
                        featureViewModel.selectQuotation(id)
                    } ?: return@LaunchedEffect
                    else -> return@LaunchedEffect
                }
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Crm, enabled = !tablet) {
                when {
                    featureViewModel.state.customerEditor != null -> true.also { featureViewModel.closeCustomerEditor() }
                    featureViewModel.state.quotationEditor != null -> true.also { featureViewModel.closeQuotationEditor() }
                    featureViewModel.state.campaignEditor != null -> true.also { featureViewModel.closeCampaignEditor() }
                    featureViewModel.state.selectedCustomer != null -> true.also { featureViewModel.closeCustomerDetail() }
                    featureViewModel.state.selectedQuotation != null -> true.also { featureViewModel.closeQuotationDetail() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-crm")) {
                CrmRoute(featureViewModel, capabilities)
            }
        }
        if (conversationsSource != null) composable(NativeComposeRoute.Conversations.route) {
            val capabilities = remember(state.bootstrap, effectiveBranchId) {
                ConversationCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
            }
            val featureViewModel: ConversationsViewModel = viewModel(
                key = "conversations-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = ConversationsViewModelFactory(conversationsSource, capabilities),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Conversations, enabled = !tablet) {
                when {
                    featureViewModel.state.pendingWhatsapp != null -> true.also { featureViewModel.dismissWhatsappHandoff() }
                    featureViewModel.state.selectedId != null -> true.also { featureViewModel.select(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-conversations")) {
                ConversationsRoute(featureViewModel)
            }
        }
        if (commerceSource != null) composable(NativeComposeRoute.Commerce.route) {
            val capabilities = commerceCapabilities
            val featureViewModel: CommerceViewModel = viewModel(
                key = "commerce-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = CommerceViewModelFactory(commerceSource),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                val feature = pending.destination as? NativeDestination.Feature ?: return@LaunchedEffect
                val id = feature.entityId?.toLongOrNull()?.takeIf { it > 0 } ?: return@LaunchedEffect
                when (feature.module) {
                    NativeModule.GIFTS -> {
                        featureViewModel.select(CommerceSection.Gifts, capabilities)
                        featureViewModel.openGift(id)
                    }
                    NativeModule.RESERVATIONS -> {
                        featureViewModel.select(CommerceSection.Reservations, capabilities)
                        featureViewModel.openReservation(id)
                    }
                    else -> return@LaunchedEffect
                }
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Commerce, enabled = !tablet) {
                when {
                    featureViewModel.state.giftDetail != null -> true.also { featureViewModel.closeGift() }
                    featureViewModel.state.reservationDetail != null -> true.also { featureViewModel.closeReservation() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-commerce")) {
                CommerceRoute(featureViewModel, capabilities)
            }
        }
        if (collaborationSource != null) composable(NativeComposeRoute.Collaboration.route) {
            val featureViewModel: CollaborationViewModel = viewModel(
                key = "collaboration-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = CollaborationViewModelFactory(collaborationSource, collaborationCapabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                val taskId = pending.featureEntity(NativeModule.TASKS)
                when {
                    taskId != null -> featureViewModel.selectTask(taskId)
                    pending.destination == NativeDestination.Tasks && pending.arguments.isNotEmpty() ->
                        featureViewModel.applyNavigationArguments(pending.arguments)
                    else -> return@LaunchedEffect
                }
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(
                coordinator = nestedBackCoordinator,
                route = NativeComposeRoute.Collaboration,
                enabled = !tablet,
                handler = featureViewModel::consumeBack,
            )
            Box(Modifier.fillMaxSize().testTag("native-route-collaboration")) {
                CollaborationRoute(featureViewModel)
            }
        }
        if (receivablesSource != null) composable(NativeComposeRoute.Receivables.route) {
            val featureViewModel: ReceivablesViewModel = viewModel(
                key = "receivables-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = ReceivablesViewModelFactory(receivablesSource, receivablesPolicy),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                if (pending.destination != NativeDestination.Receivables || pending.arguments.isEmpty()) {
                    return@LaunchedEffect
                }
                featureViewModel.applyNavigationArguments(pending.arguments)
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Receivables, enabled = !tablet) {
                when {
                    featureViewModel.state.pendingAction != null || featureViewModel.state.newPlan != null ->
                        true.also { featureViewModel.closeOverlay() }
                    featureViewModel.state.selectedPlanId != null -> true.also { featureViewModel.selectPlan(null) }
                    featureViewModel.state.selectedReminderId != null -> true.also { featureViewModel.selectReminder(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-receivables")) {
                ReceivablesRoute(featureViewModel)
            }
        }
        if (collectionsSource != null) composable(NativeComposeRoute.Collections.route) {
            val featureViewModel: CollectionsViewModel = viewModel(
                key = "collections-${state.bootstrap.user.id}",
                factory = CollectionsViewModelFactory(collectionsSource, state.bootstrap),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Collections, enabled = !tablet) {
                if (featureViewModel.state.selectedId == null) false
                else true.also { featureViewModel.select(null) }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-collections")) {
                CollectionsRoute(featureViewModel)
            }
        }
        if (announcementsSource != null) composable(NativeComposeRoute.AnnouncementsFeed.route) {
            val feedViewModel: AnnouncementsFeedViewModel = viewModel(
                key = "announcements-feed-${state.bootstrap.user.id}",
                factory = AnnouncementsFeedViewModelFactory(announcementsSource),
            )
            LaunchedEffect(pendingNavigation) {
                val id = pendingNavigation.featureEntity(NativeModule.ANNOUNCEMENTS) ?: return@LaunchedEffect
                feedViewModel.openDetail(id)
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.AnnouncementsFeed, enabled = !tablet) {
                if (feedViewModel.state.selectedId == null) false
                else true.also { feedViewModel.closeDetail() }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-announcements")) {
                AnnouncementsFeedRoute(feedViewModel)
            }
        }
        if (announcementsSource != null && announcementsCapabilities.canReadManagement) {
            composable(NativeComposeRoute.AnnouncementsAdmin.route) {
                val adminViewModel: AnnouncementsAdminViewModel = viewModel(
                    key = "announcements-admin-${state.bootstrap.user.id}",
                    factory = AnnouncementsAdminViewModelFactory(announcementsSource, announcementsCapabilities),
                )
                WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.AnnouncementsAdmin, enabled = !tablet) {
                    when {
                        adminViewModel.state.editorOpen -> true.also { adminViewModel.closeEditor() }
                        adminViewModel.state.selectedId != null -> true.also { adminViewModel.select(null) }
                        else -> false
                    }
                }
                Box(Modifier.fillMaxSize().testTag("native-route-announcements-admin")) {
                    AnnouncementsAdminRoute(adminViewModel)
                }
            }
        }
        if (marketingSource != null) composable(NativeComposeRoute.Marketing.route) {
            val featureViewModel: MarketingViewModel = viewModel(
                key = "marketing-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = NativeViewModelFactory {
                    MarketingViewModel(marketingSource, marketingScope, marketingCapabilities)
                },
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Marketing, enabled = !tablet) {
                when {
                    featureViewModel.state.selectedPromotionId != null -> true.also { featureViewModel.selectPromotion(null) }
                    featureViewModel.state.selectedProgramId != null -> true.also { featureViewModel.selectProgram(null) }
                    featureViewModel.state.selectedAnomalyKey != null -> true.also { featureViewModel.selectAnomaly(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-marketing")) {
                MarketingScreen(featureViewModel, onBack = navigateUp)
            }
        }
        if (operationsSource != null) composable(NativeComposeRoute.Operations.route) {
            val featureViewModel: OperationsViewModel = viewModel(
                key = "operations-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = NativeViewModelFactory {
                    OperationsViewModel(operationsSource, operationsScope, operationsCapabilities)
                },
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Operations, enabled = !tablet) {
                featureViewModel.handleNestedBack()
            }
            Box(Modifier.fillMaxSize().testTag("native-route-operations")) {
                OperationsScreen(featureViewModel, onBack = navigateUp)
            }
        }
        if (inventorySource != null) composable(NativeComposeRoute.Inventory.route) {
            val capabilities = remember(state.bootstrap, effectiveBranchId) {
                InventoryCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
            }
            val featureViewModel: InventoryViewModel = viewModel(
                key = "inventory-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = InventoryViewModelFactory(inventorySource, capabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                if (
                    pending.destination != NativeDestination.Module(NativeModule.INVENTORY) ||
                    pending.arguments.isEmpty()
                ) return@LaunchedEffect
                featureViewModel.applyNavigationArguments(pending.arguments)
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Inventory, enabled = !tablet) {
                when {
                    featureViewModel.state.receiveDraft != null -> true.also { featureViewModel.closeReceiveDraft() }
                    featureViewModel.state.transferDraft != null -> true.also { featureViewModel.closeTransferDraft() }
                    featureViewModel.state.selectedTransfer != null -> true.also { featureViewModel.closeTransferDetail() }
                    featureViewModel.state.adjustmentDraft != null -> true.also { featureViewModel.closeAdjustmentDraft() }
                    featureViewModel.state.rejectingAdjustmentId != null -> true.also { featureViewModel.closeRejectAdjustment() }
                    featureViewModel.state.stocktakeDraft != null -> true.also { featureViewModel.closeStocktakeDraft() }
                    featureViewModel.state.recountVariantId != null -> true.also { featureViewModel.closeRecount() }
                    featureViewModel.state.selectedStocktake != null -> true.also { featureViewModel.closeStocktakeDetail() }
                    featureViewModel.state.selectedCount != null -> true.also { featureViewModel.closeCount() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-inventory")) {
                InventoryRoute(featureViewModel)
            }
        }
        if (hrAdminSource != null) composable(NativeComposeRoute.HrAdmin.route) {
            val featureViewModel: HrAdminViewModel = viewModel(
                key = "hr-admin-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = NativeViewModelFactory { HrAdminViewModel(hrAdminSource, hrAdminCapabilities) },
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.HrAdmin, enabled = !tablet) {
                when {
                    featureViewModel.state.payrollDetail != null -> true.also { featureViewModel.selectPayroll(null) }
                    featureViewModel.state.selectedEmployeeId != null -> true.also { featureViewModel.selectEmployee(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-hr-admin")) {
                HrAdminRoute(featureViewModel)
            }
        }
        if (salesSource != null) composable(NativeComposeRoute.Sales.route) {
            val capabilities = remember(state.bootstrap, effectiveBranchId) {
                SalesCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
            }
            val featureViewModel: SalesViewModel = viewModel(
                key = "sales-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = SalesViewModelFactory(salesSource, capabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val feature = pendingNavigation?.destination as? NativeDestination.Feature ?: return@LaunchedEffect
                val id = feature.typedEntity("invoice") ?: return@LaunchedEffect
                featureViewModel.section(SalesSection.HISTORY)
                featureViewModel.saleDetail(id)
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Sales, enabled = !tablet) {
                if (featureViewModel.state.selectedSale == null) false
                else true.also { featureViewModel.closeSale() }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-sales")) {
                SalesRoute(featureViewModel, capabilities)
            }
        }
        if (purchasingSource != null) composable(NativeComposeRoute.Purchasing.route) {
            val capabilities = remember(state.bootstrap, effectiveBranchId) {
                PurchasingCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
            }
            val featureViewModel: PurchasingViewModel = viewModel(
                key = "purchasing-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = PurchasingViewModelFactory(purchasingSource, capabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                if (
                    pending.destination == NativeDestination.Module(NativeModule.PURCHASES) &&
                    pending.arguments.isNotEmpty()
                ) {
                    featureViewModel.applyNavigationArguments(pending.arguments)
                    onNavigationConsumed()
                    return@LaunchedEffect
                }
                val feature = pending.destination as? NativeDestination.Feature ?: return@LaunchedEffect
                when (feature.module) {
                    NativeModule.PURCHASES -> {
                        val id = feature.typedEntity("order") ?: return@LaunchedEffect
                        featureViewModel.selectSection(PurchasingSection.ORDERS)
                        featureViewModel.selectOrder(id)
                    }
                    NativeModule.SUPPLIERS -> {
                        val id = feature.typedEntity("supplier") ?: return@LaunchedEffect
                        featureViewModel.selectSection(PurchasingSection.SUPPLIERS)
                        featureViewModel.selectSupplier(id)
                    }
                    else -> return@LaunchedEffect
                }
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(
                coordinator = nestedBackCoordinator,
                route = NativeComposeRoute.Purchasing,
                enabled = !tablet,
                handler = featureViewModel::consumeBack,
            )
            Box(Modifier.fillMaxSize().testTag("native-route-purchasing")) {
                PurchasingRoute(featureViewModel, onBack = navigateUp)
            }
        }
        if (workOrdersSource != null) composable(NativeComposeRoute.WorkOrders.route) {
            val featureViewModel: WorkOrdersViewModel = viewModel(
                key = "work-orders-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = WorkOrdersViewModelFactory(workOrdersSource, workOrdersCapabilities),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                val orderId = pending.featureEntity(NativeModule.WORK_ORDERS, "order")
                when {
                    orderId != null -> {
                        featureViewModel.selectSection(WorkOrdersSection.ORDERS)
                        featureViewModel.selectOrder(orderId)
                    }
                    pending.destination == NativeDestination.WorkOrders && pending.arguments.isNotEmpty() ->
                        featureViewModel.applyNavigationArguments(pending.arguments)
                    else -> return@LaunchedEffect
                }
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.WorkOrders, enabled = !tablet) {
                when {
                    featureViewModel.state.deliveryDraft != null -> true.also { featureViewModel.closeDelivery() }
                    featureViewModel.state.orderDraft != null -> true.also { featureViewModel.closeOrderDraft() }
                    featureViewModel.state.selectedOrder != null -> true.also { featureViewModel.closeOrder() }
                    featureViewModel.state.runDraft != null -> true.also { featureViewModel.closeRun() }
                    featureViewModel.state.selectedProduction != null -> true.also { featureViewModel.closeProduction() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-work-orders")) {
                WorkOrdersRoute(featureViewModel)
            }
        }
        if (warehouseToolsSource != null) composable(NativeComposeRoute.WarehouseTools.route) {
            val featureViewModel: WarehouseToolsViewModel = viewModel(
                key = "warehouse-tools-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = WarehouseToolsViewModelFactory(warehouseToolsSource, warehouseToolsCapabilities),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.WarehouseTools, enabled = !tablet) {
                when {
                    featureViewModel.state.selectedItem != null -> true.also { featureViewModel.closeCountEntry() }
                    featureViewModel.state.selectedCount != null -> true.also { featureViewModel.closeCount() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-warehouse-tools")) {
                WarehouseToolsRoute(featureViewModel)
            }
        }
        if (storeDeliverySource != null) composable(NativeComposeRoute.StoreDelivery.route) {
            val capabilities = remember(state.bootstrap) { state.bootstrap.toStoreCapabilities() }
            val featureViewModel: StoreDeliveryViewModel = viewModel(
                key = "store-${state.bootstrap.user.id}",
                factory = NativeViewModelFactory { StoreDeliveryViewModel(storeDeliverySource, capabilities) },
            )
            LaunchedEffect(pendingNavigation) {
                pendingNavigation.featureEntity(NativeModule.STORE)?.let(featureViewModel::selectOrder)
                    ?: return@LaunchedEffect
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.StoreDelivery, enabled = !tablet) {
                if (featureViewModel.state.selectedOrderId == null) false
                else true.also { featureViewModel.selectOrder(null) }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-store-delivery")) {
                StoreDeliveryScreen(featureViewModel, onBack = navigateUp)
            }
        }
        if (financeSource != null) composable(NativeComposeRoute.Finance.route) {
            val policy = remember(state.bootstrap, effectiveBranchId) {
                FinanceAccessPolicy.fromBootstrap(state.bootstrap, effectiveBranchId)
            }
            val featureViewModel: FinanceViewModel = viewModel(
                key = "finance-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = FinanceViewModelFactory(financeSource, policy),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Finance, enabled = !tablet) {
                when {
                    featureViewModel.state.createConfirmation != null || featureViewModel.state.transferConfirmation != null ->
                        true.also { featureViewModel.cancelConfirmation() }
                    featureViewModel.state.composer != null -> true.also { featureViewModel.closeComposer() }
                    featureViewModel.state.selectedKey != null -> true.also { featureViewModel.select(null) }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-finance")) {
                FinanceRoute(featureViewModel)
            }
        }
        if (shiftSource != null && shiftPolicy.canReadManagement) composable(NativeComposeRoute.Shifts.route) {
            val featureViewModel: ShiftViewModel = viewModel(
                key = "shifts-${state.bootstrap.user.id}",
                factory = NativeViewModelFactory { ShiftViewModel(shiftSource, shiftPolicy) },
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                if (pending.destination != NativeDestination.Shifts || pending.arguments.isEmpty()) {
                    return@LaunchedEffect
                }
                featureViewModel.applyNavigationArguments(pending.arguments)
                onNavigationConsumed()
            }
            WorkspaceNestedBackHandler(
                coordinator = nestedBackCoordinator,
                route = NativeComposeRoute.Shifts,
                enabled = !tablet,
                handler = featureViewModel::consumeBack,
            )
            Box(Modifier.fillMaxSize().testTag("native-route-shifts")) {
                ShiftScreen(featureViewModel)
            }
        }
        if (insightsSource != null) composable(NativeComposeRoute.Insights.route) {
            val featureViewModel: InsightsViewModel = viewModel(
                key = "insights-${state.bootstrap.user.id}",
                factory = InsightsViewModelFactory(insightsSource, insightsPolicy),
            )
            LaunchedEffect(pendingNavigation) {
                val pending = pendingNavigation ?: return@LaunchedEffect
                if (pending.destination != NativeDestination.Insights || pending.arguments.isEmpty()) {
                    return@LaunchedEffect
                }
                featureViewModel.applyNavigationArguments(pending.arguments)
                onNavigationConsumed()
            }
            Box(Modifier.fillMaxSize().testTag("native-route-insights")) {
                InsightsRoute(
                    viewModel = featureViewModel,
                    onOpenTarget = { target -> target.toNativeDestination()?.let(onOpen) },
                    canOpenTarget = { target -> target.toNativeDestination() != null },
                )
            }
        }
        if (productsSource != null) composable(NativeComposeRoute.Products.route) {
            val capabilities = remember(state.bootstrap, effectiveBranchId) {
                ProductsCapabilities.fromBootstrap(state.bootstrap).copy(branchId = effectiveBranchId)
            }
            val featureViewModel: ProductsViewModel = viewModel(
                key = "products-${state.bootstrap.user.id}-${effectiveBranchId ?: "none"}",
                factory = ProductsViewModelFactory(productsSource, capabilities),
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.Products, enabled = !tablet) {
                when {
                    featureViewModel.state.barcodeUnitId != null -> true.also { featureViewModel.closeBarcodes() }
                    featureViewModel.state.editor != null -> true.also { featureViewModel.closeEditor() }
                    featureViewModel.state.selected != null -> true.also { featureViewModel.closeDetails() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-products")) {
                ProductsRoute(featureViewModel, capabilities)
            }
        }
        if (legalSource != null) composable(NativeComposeRoute.Settings.route) {
            Box(Modifier.fillMaxSize().testTag("native-route-profile")) {
                NativeSettingsRoute(
                    state = state,
                    biometricAvailable = biometricAvailable,
                    selfServiceSource = selfServiceSource,
                    legalSource = legalSource,
                    twoFactorSource = twoFactorSource,
                    nestedBackCoordinator = nestedBackCoordinator,
                    onEnableBiometric = onEnableBiometric,
                    onDisableBiometric = onDisableBiometric,
                    onLogout = onLogout,
                )
            }
        }
        if (systemSettingsSource != null) composable(NativeComposeRoute.SystemSettings.route) {
            val capabilities = remember(state.bootstrap) { SystemSettingsCapabilities.fromBootstrap(state.bootstrap) }
            val featureViewModel: SystemSettingsViewModel = viewModel(
                key = "system-settings-${state.bootstrap.user.id}",
                factory = SystemSettingsViewModel.factory(systemSettingsSource),
            )
            Box(Modifier.fillMaxSize().testTag("native-route-system-settings")) {
                SystemSettingsRoute(featureViewModel, capabilities)
            }
        }
        if (storeAdminSource != null) composable(NativeComposeRoute.StoreAdmin.route) {
            val access = state.bootstrap.modules.firstOrNull { it.key == NativeModule.STORE.wireName }?.access
            val capabilities = remember(state.bootstrap) {
                StoreAdminCapabilities.from(state.bootstrap.user.role, access)
            }
            val featureViewModel: StoreAdminViewModel = viewModel(
                key = "store-admin-${state.bootstrap.user.id}",
                factory = NativeViewModelFactory { StoreAdminViewModel(storeAdminSource, capabilities) },
            )
            WorkspaceNestedBackHandler(nestedBackCoordinator, NativeComposeRoute.StoreAdmin, enabled = !tablet) {
                when {
                    featureViewModel.state.pendingDelete != null -> true.also { featureViewModel.cancelDelete() }
                    featureViewModel.state.editor != null -> true.also { featureViewModel.closeEditor() }
                    else -> false
                }
            }
            Box(Modifier.fillMaxSize().testTag("native-route-store-admin")) {
                StoreAdminRoute(featureViewModel, capabilities)
            }
        }
        }
        // Compose Navigation installs its own back callback from inside NavHost. Registering
        // our callback afterwards gives nested feature state (detail/editor/confirmation)
        // first refusal before the route itself is popped.
        BackHandler(enabled = currentRoute != NativeComposeRoute.Home, onBack = navigateUp)
    }
}

@Composable
private fun WorkspaceUpBar(onNavigateUp: () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Surface(
            modifier = Modifier.fillMaxWidth().testTag("native-workspace-up-bar"),
            color = Color.White,
            shadowElevation = 2.dp,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Start,
            ) {
                IconButton(
                    onClick = onNavigateUp,
                    modifier = Modifier.testTag("native-workspace-up"),
                ) {
                    Icon(
                        Icons.AutoMirrored.Rounded.ArrowBack,
                        contentDescription = "رجوع",
                        tint = EmeraldDark,
                    )
                }
                Text(
                    "رجوع",
                    style = MaterialTheme.typography.labelLarge,
                    color = EmeraldDark,
                )
            }
        }
    }
}

@Composable
private fun NativeSettingsRoute(
    state: AppSessionState.Ready,
    biometricAvailable: Boolean,
    selfServiceSource: SelfServiceDataSource,
    legalSource: LegalDataSource,
    twoFactorSource: TwoFactorDataSource?,
    nestedBackCoordinator: WorkspaceBackCoordinator,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onLogout: () -> Unit,
) {
    var showTwoFactor by remember(state.bootstrap.user.id) { mutableStateOf(false) }
    var preferences by remember(state.bootstrap.user.id) { mutableStateOf<NotificationPreferences?>(null) }
    var preferencesError by remember(state.bootstrap.user.id) { mutableStateOf<String?>(null) }
    var retry by remember(state.bootstrap.user.id) { mutableIntStateOf(0) }
    val uriHandler = LocalUriHandler.current
    val twoFactorVisible = remember(state.bootstrap.user.role, twoFactorSource) {
        twoFactorSource != null && TwoFactorEntryPolicy.visible(
            authenticated = true,
            role = state.bootstrap.user.role,
        )
    }
    WorkspaceNestedBackHandler(
        coordinator = nestedBackCoordinator,
        route = NativeComposeRoute.Settings,
        enabled = showTwoFactor,
    ) {
        showTwoFactor = false
        true
    }
    if (showTwoFactor && twoFactorSource != null && twoFactorVisible) {
        val twoFactorViewModel: TwoFactorViewModel = viewModel(
            key = "two-factor-${state.bootstrap.user.id}",
            factory = TwoFactorViewModel.factory(twoFactorSource),
        )
        TwoFactorScreen(
            state = twoFactorViewModel.state,
            onRefresh = twoFactorViewModel::refresh,
            onStartEnrollment = twoFactorViewModel::startEnrollment,
            onConfirmEnrollment = twoFactorViewModel::confirmEnrollment,
            onRegenerateCodes = twoFactorViewModel::regenerateRecoveryCodes,
            onDisable = twoFactorViewModel::disable,
            onRecoveryCodesSaved = twoFactorViewModel::acknowledgeRecoveryCodes,
            onOpenAuthenticator = { uri ->
                if (AuthenticatorUriPolicy.canOpen(uri)) runCatching { uriHandler.openUri(uri) }
                Unit
            },
            onBack = { showTwoFactor = false },
        )
        return
    }
    LaunchedEffect(state.bootstrap.user.id, retry) {
        preferencesError = null
        runCatching { selfServiceSource.loadNotificationPreferences() }
            .onSuccess { preferences = it }
            .onFailure { preferencesError = it.message?.takeIf(String::isNotBlank) ?: "تعذر تحميل إعدادات الإشعارات" }
    }

    when {
        preferences != null -> {
            val initial = remember(state.bootstrap.user.id, preferences) {
                SettingsUiState(
                    account = SettingsStateMapper.account(state.bootstrap),
                    notifications = requireNotNull(preferences),
                    biometricAvailable = biometricAvailable,
                    biometricEnabled = state.biometricEnabled,
                    appVersion = BuildConfig.VERSION_NAME,
                )
            }
            val settingsViewModel: SettingsViewModel = viewModel(
                key = "settings-${state.bootstrap.user.id}",
                factory = NativeViewModelFactory { SettingsViewModel(initial, legalSource, selfServiceSource) },
            )
            SettingsScreen(
                state = settingsViewModel.state,
                onNotificationChange = settingsViewModel::setNotification,
                onBiometricChange = { enabled ->
                    settingsViewModel.setBiometricEnabled(enabled)
                    if (enabled) onEnableBiometric() else onDisableBiometric()
                },
                onSignOut = onLogout,
                onRetryLegal = settingsViewModel::refreshLegal,
                onOpenPrivacyLink = { url ->
                    runCatching { uriHandler.openUri(url) }
                    Unit
                },
                twoFactorVisible = twoFactorVisible,
                onOpenTwoFactor = { showTwoFactor = true },
            )
        }
        preferencesError != null -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Card(shape = RoundedCornerShape(26.dp)) {
                Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(preferencesError.orEmpty(), textAlign = TextAlign.Center)
                    Button(onClick = { retry += 1 }) { Text("إعادة المحاولة") }
                }
            }
        }
        else -> LoadingScreen("جاري تحميل الإعدادات")
    }
}

private class NativeViewModelFactory(
    private val create: () -> ViewModel,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = create() as T
}

private class WorkspaceBackCoordinator {
    private data class Entry(val token: Any, val handler: () -> Boolean)
    private val entries = mutableMapOf<NativeComposeRoute, Entry>()

    fun register(route: NativeComposeRoute, token: Any, handler: () -> Boolean) {
        entries[route] = Entry(token, handler)
    }

    fun unregister(route: NativeComposeRoute, token: Any) {
        if (entries[route]?.token === token) entries.remove(route)
    }

    fun consume(route: NativeComposeRoute): Boolean = entries[route]?.handler?.invoke() == true
}

/** Native workspaces whose API contract cannot be entered without an explicit operational branch. */
internal val sessionBranchRequiredScreens: Set<NativeScreen> = setOf(
    NativeScreen.CONVERSATIONS,
    NativeScreen.COLLABORATION,
    NativeScreen.INVENTORY,
    NativeScreen.SALES,
    NativeScreen.PURCHASING,
    NativeScreen.WORK_ORDERS,
    NativeScreen.WAREHOUSE_TOOLS,
    NativeScreen.PRODUCTS,
)

/**
 * Compact screens that own at least one detail, editor, confirmation, or sub-flow layer.
 * Keeping this list explicit makes adding a native screen without an up-contract a test failure.
 */
internal val compactNestedBackRouteNames: Set<String> = setOf(
    "native-approvals",
    "native-accounting-controls",
    "native-admin",
    "native-crm",
    "native-conversations",
    "native-commerce",
    "native-collaboration",
    "native-receivables",
    "native-collections",
    "native-marketing",
    "native-operations",
    "native-inventory",
    "native-hr-admin",
    "native-sales",
    "native-purchasing",
    "native-work-orders",
    "native-warehouse-tools",
    "native-store-delivery",
    "native-store-admin",
    "native-finance",
    "native-shifts",
    "native-products",
    "native-profile",
)

@Composable
private fun WorkspaceNestedBackHandler(
    coordinator: WorkspaceBackCoordinator,
    route: NativeComposeRoute,
    enabled: Boolean = true,
    handler: () -> Boolean,
) {
    require(route.route in compactNestedBackRouteNames) {
        "Missing compact nested-back contract for ${route.route}"
    }
    val currentHandler by rememberUpdatedState(handler)
    val token = remember { Any() }
    DisposableEffect(coordinator, route, enabled) {
        if (enabled) coordinator.register(route, token) { currentHandler() }
        onDispose { coordinator.unregister(route, token) }
    }
}

private fun NativeComposeRoute.ownsWorkspaceHeader(): Boolean = this in setOf(
    NativeComposeRoute.Marketing,
    NativeComposeRoute.Operations,
    NativeComposeRoute.Purchasing,
    NativeComposeRoute.StoreDelivery,
)

private fun NavHostController.navigateNative(route: NativeComposeRoute) {
    navigate(route.route) {
        launchSingleTop = true
        if (route.primary) {
            restoreState = true
            popUpTo(NativeComposeRoute.Home.route) { saveState = true }
        }
    }
}

private fun AppBootstrap.toNavigationPrincipal(): NavigationPrincipal = NavigationPrincipal(
    authenticated = true,
    role = user.role,
    isOwner = isOwner || user.isOwner,
    hasPersonalWorkspace = hasPersonalWorkspace,
    grants = modules.mapNotNull { module ->
        val nativeModule = NativeModule.fromWireName(module.key) ?: return@mapNotNull null
        val grant = when (module.access.uppercase(Locale.ROOT)) {
            "FULL" -> ModuleGrant.FULL
            "READ" -> ModuleGrant.READ
            else -> ModuleGrant.NONE
        }
        nativeModule to grant
    }.toMap(),
)

internal fun InsightTarget.toNativeDestination(): NativeDestination.Feature? {
    if (id <= 0) return null
    val (module, entityId) = when (type) {
        SearchEntityType.INVOICE -> NativeModule.SALES to "invoice-$id"
        SearchEntityType.QUOTATION -> NativeModule.SALES to "quotation-$id"
        SearchEntityType.PURCHASE_ORDER -> NativeModule.PURCHASES to "order-$id"
        SearchEntityType.WORK_ORDER -> NativeModule.WORK_ORDERS to "order-$id"
        SearchEntityType.CUSTOMER -> NativeModule.CRM to "customer-$id"
        SearchEntityType.SUPPLIER -> NativeModule.SUPPLIERS to "supplier-$id"
        // These search records do not yet have a safe native detail lookup. Keeping them out of
        // navigation is preferable to opening an unrelated module root and pretending success.
        SearchEntityType.PRODUCT,
        SearchEntityType.EXPENSE,
        SearchEntityType.EMPLOYEE,
        SearchEntityType.USER,
        -> return null
    }
    return NativeDestination.Feature(module, NativeFeatureIntent.VIEW, entityId)
}

private fun AppBootstrap.toCrmCapabilities(): CrmCapabilities {
    val base = CrmCapabilities.fromBootstrap(this)
    if (base.customers != CrmAccess.NONE) return base
    val crmAccess = CrmAccess.fromWire(modules.firstOrNull { it.key == NativeModule.CRM.wireName }?.access)
    return base.copy(customers = crmAccess)
}

private fun AppBootstrap.toStoreCapabilities(): StoreCapabilities = StoreCapabilities.from(
    role = user.role,
    storeAccess = modules.firstOrNull { it.key == NativeModule.STORE.wireName }?.access,
    courierAccess = modules.firstOrNull { it.key == NativeModule.COURIER.wireName }?.access,
)

private fun AppBootstrap.toMarketingCapabilities(): MarketingCapabilities = MarketingCapabilities.from(
    role = user.role,
    campaignsAccess = modules.firstOrNull { it.key == NativeModule.CAMPAIGNS.wireName }?.access,
    catalogAnomaliesAccess = modules.firstOrNull { it.key == NativeModule.CATALOG_ANOMALIES.wireName }?.access,
)

private fun AppBootstrap.toOperationsCapabilities(
    effectiveBranchId: Long? = branchId,
): OperationsCapabilities = OperationsCapabilities.from(
    role = user.role,
    branchId = effectiveBranchId,
    assetsAccess = modules.firstOrNull { it.key == NativeModule.ASSETS.wireName }?.access,
    consignmentAccess = modules.firstOrNull { it.key == NativeModule.CONSIGNMENTS.wireName }?.access,
    commissionsAccess = modules.firstOrNull { it.key == NativeModule.COMMISSIONS.wireName }?.access,
    isOwner = isOwner || user.isOwner,
)

private fun marketingAccessLabel(bootstrap: AppBootstrap): ModuleGrant = listOf(
    NativeModule.CAMPAIGNS,
    NativeModule.CATALOG_ANOMALIES,
).map { module ->
    when (bootstrap.modules.firstOrNull { it.key == module.wireName }?.access?.uppercase(Locale.ROOT)) {
        "FULL" -> ModuleGrant.FULL
        "READ" -> ModuleGrant.READ
        else -> ModuleGrant.NONE
    }
}.maxBy(ModuleGrant::ordinal)

private fun crmAccessLabel(bootstrap: AppBootstrap): ModuleGrant = listOf(
    NativeModule.CRM,
    NativeModule.CAMPAIGNS,
    NativeModule.SALES,
).map { module ->
    when (bootstrap.modules.firstOrNull { it.key == module.wireName }?.access?.uppercase(Locale.ROOT)) {
        "FULL" -> ModuleGrant.FULL
        "READ" -> ModuleGrant.READ
        else -> ModuleGrant.NONE
    }
}.maxBy(ModuleGrant::ordinal)

private fun compactServiceLabel(screen: NativeScreen, fallback: String): String = when (screen) {
    NativeScreen.ACCOUNTING_CONTROLS -> "المحاسبة"
    NativeScreen.CRM -> "العملاء"
    NativeScreen.SHIFTS -> "الورديات"
    NativeScreen.WORK_ORDERS -> "الطباعة"
    NativeScreen.WAREHOUSE_TOOLS -> "المستودع"
    NativeScreen.COLLABORATION -> "الفريق"
    NativeScreen.MARKETING -> "التسويق"
    NativeScreen.OPERATIONS -> "العمليات"
    NativeScreen.RECEIVABLES -> "المستحقات"
    NativeScreen.COLLECTIONS -> "التحصيل"
    NativeScreen.SALES -> "المبيعات"
    NativeScreen.PURCHASING -> "المشتريات"
    NativeScreen.COMMERCE -> "التجارة"
    NativeScreen.SYSTEM_SETTINGS -> "النظام"
    NativeScreen.STORE_DELIVERY -> "المتجر"
    NativeScreen.HR_ADMIN -> "الموارد البشرية"
    else -> fallback
}

private fun implementedServices(
    bootstrap: AppBootstrap,
    principal: NavigationPrincipal,
    approvalPolicy: ApprovalAccessPolicy,
    installed: Set<NativeScreen>,
): List<NativeServiceEntry> = buildList {
    val tasks = bootstrap.modules.firstOrNull { it.key == NativeModule.TASKS.wireName }
    if (bootstrap.hasPersonalWorkspace) {
        add(
            NativeServiceEntry(
                key = "self-service",
                label = "مساحتي",
                accessLabel = if (tasks?.access.equals("FULL", ignoreCase = true)) "إدارة المهام" else "شخصية",
                screen = NativeScreen.SELF_SERVICE,
                destination = NativeDestination.SelfService,
                icon = Icons.Rounded.Badge,
            ),
        )
    }

    if (ApprovalKind.entries.any(approvalPolicy::canManage) &&
        NativeNavigationRegistry.Default.authorize(NativeDestination.Approvals, principal) == AccessDecision.Allowed
    ) {
        add(
            NativeServiceEntry(
                key = "approvals",
                label = "الاعتمادات",
                accessLabel = "إجراء",
                screen = NativeScreen.APPROVALS,
                destination = NativeDestination.Approvals,
                icon = Icons.Rounded.CheckCircle,
            ),
        )
    }

    if (NativeScreen.ANNOUNCEMENTS_FEED in installed) {
        add(
            NativeServiceEntry(
                key = "announcements-feed",
                label = "إعلاناتي",
                accessLabel = "عرض",
                screen = NativeScreen.ANNOUNCEMENTS_FEED,
                destination = NativeDestination.Feature(
                    NativeModule.ANNOUNCEMENTS,
                    NativeFeatureIntent.BROWSE,
                ),
                icon = Icons.Rounded.Campaign,
            ),
        )
    }

    if (NativeScreen.ANNOUNCEMENTS_ADMIN in installed) {
        add(
            NativeServiceEntry(
                key = "announcements-admin",
                label = "إدارة الإعلانات",
                accessLabel = "إدارة",
                screen = NativeScreen.ANNOUNCEMENTS_ADMIN,
                destination = NativeDestination.Module(NativeModule.ANNOUNCEMENTS),
                icon = Icons.Rounded.Campaign,
            ),
        )
    }

    if (NativeScreen.INSIGHTS in installed) {
        add(
            NativeServiceEntry(
                key = "insights",
                label = "التحليلات",
                accessLabel = "عرض",
                screen = NativeScreen.INSIGHTS,
                destination = NativeDestination.Insights,
                icon = Icons.Rounded.Schedule,
            ),
        )
    }

    if (NativeScreen.ACCOUNTING_CONTROLS in installed) {
        add(
            NativeServiceEntry(
                key = "accounting-controls",
                label = compactServiceLabel(NativeScreen.ACCOUNTING_CONTROLS, "الضبط المحاسبي"),
                accessLabel = if (bootstrap.user.role.equals("admin", ignoreCase = true)) "حوكمة" else "عرض",
                screen = NativeScreen.ACCOUNTING_CONTROLS,
                destination = NativeDestination.AccountingControls,
                icon = Icons.Rounded.Payments,
            ),
        )
    }

    if (NativeScreen.CRM in installed) {
        add(
            NativeServiceEntry(
                key = "crm",
                label = compactServiceLabel(NativeScreen.CRM, "العملاء وعروض الأسعار"),
                accessLabel = if (crmAccessLabel(bootstrap) == ModuleGrant.FULL) "إدارة" else "عرض",
                screen = NativeScreen.CRM,
                destination = NativeDestination.CrmWorkspace,
                icon = Icons.Rounded.BusinessCenter,
            ),
        )
    }

    if (NativeScreen.WORK_ORDERS in installed) {
        add(
            NativeServiceEntry(
                key = "work-orders",
                label = compactServiceLabel(NativeScreen.WORK_ORDERS, "الطباعة والإنتاج"),
                accessLabel = "تشغيل",
                screen = NativeScreen.WORK_ORDERS,
                destination = NativeDestination.WorkOrders,
                icon = Icons.Rounded.BusinessCenter,
            ),
        )
    }

    if (NativeScreen.WAREHOUSE_TOOLS in installed) {
        add(
            NativeServiceEntry(
                key = "warehouse-tools",
                label = compactServiceLabel(NativeScreen.WAREHOUSE_TOOLS, "أدوات المستودع"),
                accessLabel = "تشغيل",
                screen = NativeScreen.WAREHOUSE_TOOLS,
                destination = NativeDestination.WarehouseTools,
                icon = Icons.Rounded.Inventory2,
            ),
        )
    }

    if (NativeScreen.COLLABORATION in installed) {
        add(
            NativeServiceEntry(
                key = "collaboration",
                label = compactServiceLabel(NativeScreen.COLLABORATION, "التعاون والمهام"),
                accessLabel = "فريق",
                screen = NativeScreen.COLLABORATION,
                destination = NativeDestination.Collaboration,
                icon = Icons.AutoMirrored.Rounded.Assignment,
            ),
        )
    }

    if (NativeScreen.MARKETING in installed) {
        add(
            NativeServiceEntry(
                key = "marketing",
                label = compactServiceLabel(NativeScreen.MARKETING, "التسويق والعروض"),
                accessLabel = if (marketingAccessLabel(bootstrap) == ModuleGrant.FULL) "إدارة" else "عرض",
                screen = NativeScreen.MARKETING,
                destination = NativeDestination.Marketing,
                icon = Icons.Rounded.Campaign,
            ),
        )
    }

    if (NativeScreen.OPERATIONS in installed) {
        add(
            NativeServiceEntry(
                key = "operations",
                label = compactServiceLabel(NativeScreen.OPERATIONS, "العمليات والأداء"),
                accessLabel = "مساحتي",
                screen = NativeScreen.OPERATIONS,
                destination = NativeDestination.Operations,
                icon = Icons.Rounded.BusinessCenter,
            ),
        )
    }

    if (NativeScreen.RECEIVABLES in installed) {
        add(
            NativeServiceEntry(
                key = "receivables",
                label = compactServiceLabel(NativeScreen.RECEIVABLES, "المستحقات والمتابعة"),
                accessLabel = "حسب النطاق",
                screen = NativeScreen.RECEIVABLES,
                destination = NativeDestination.Receivables,
                icon = Icons.Rounded.Payments,
            ),
        )
    }

    if (NativeScreen.COLLECTIONS in installed) {
        add(
            NativeServiceEntry(
                key = "collections",
                label = "قرارات التحصيل",
                accessLabel = "رقابة",
                screen = NativeScreen.COLLECTIONS,
                destination = NativeDestination.Collections,
                icon = Icons.Rounded.Payments,
            ),
        )
    }

    if (NativeScreen.STORE_ADMIN in installed) {
        val access = bootstrap.modules.firstOrNull { it.key == NativeModule.STORE.wireName }?.access
        add(
            NativeServiceEntry(
                key = "store-admin",
                label = "إدارة المتجر",
                accessLabel = if (access.equals("FULL", true)) "إدارة" else "عرض",
                screen = NativeScreen.STORE_ADMIN,
                destination = NativeDestination.StoreAdmin,
                icon = Icons.Rounded.BusinessCenter,
            ),
        )
    }

    if (NativeScreen.SHIFTS in installed) {
        add(
            NativeServiceEntry(
                key = "shifts",
                label = "الورديات",
                accessLabel = "إدارة",
                screen = NativeScreen.SHIFTS,
                destination = NativeDestination.Shifts,
                icon = Icons.Rounded.Schedule,
            ),
        )
    }

    listOf(
        NativeScreen.INVENTORY,
        NativeScreen.SALES,
        NativeScreen.PURCHASING,
        NativeScreen.STORE_DELIVERY,
        NativeScreen.FINANCE,
        NativeScreen.PRODUCTS,
        NativeScreen.CONVERSATIONS,
        NativeScreen.COMMERCE,
        NativeScreen.ADMIN,
        NativeScreen.HR_ADMIN,
        NativeScreen.SYSTEM_SETTINGS,
    ).forEach { screen ->
        if (screen !in installed) return@forEach
        val definition = NativeFeatureCatalog.definition(screen)
        val destination = NativeFeatureCatalog.entryDestination(screen, principal) ?: return@forEach
        val strongest = when {
            definition.modules.any { principal.grantFor(it) == ModuleGrant.FULL } -> ModuleGrant.FULL
            definition.modules.any { principal.grantFor(it) == ModuleGrant.READ } -> ModuleGrant.READ
            else -> ModuleGrant.NONE
        }
        add(
            NativeServiceEntry(
                key = definition.key,
                label = compactServiceLabel(screen, definition.label),
                accessLabel = if (strongest == ModuleGrant.FULL) "إدارة" else "عرض",
                screen = screen,
                destination = destination,
                icon = when (screen) {
                    NativeScreen.CRM -> Icons.Rounded.BusinessCenter
                    NativeScreen.INVENTORY -> Icons.Rounded.Inventory2
                    NativeScreen.SALES -> Icons.Rounded.Payments
                    NativeScreen.PURCHASING -> Icons.Rounded.BusinessCenter
                    NativeScreen.STORE_DELIVERY -> Icons.Rounded.BusinessCenter
                    NativeScreen.FINANCE -> Icons.Rounded.Payments
                    NativeScreen.PRODUCTS -> Icons.Rounded.Inventory2
                    NativeScreen.CONVERSATIONS -> Icons.Rounded.Notifications
                    NativeScreen.COMMERCE -> Icons.Rounded.Apps
                    NativeScreen.ADMIN -> Icons.Rounded.BusinessCenter
                    NativeScreen.HR_ADMIN -> Icons.Rounded.Badge
                    NativeScreen.SYSTEM_SETTINGS -> Icons.Rounded.Apps
                    else -> Icons.Rounded.Apps
                },
            ),
        )
    }
}

private fun implementedRouteFor(
    destination: NativeDestination,
    principal: NavigationPrincipal,
    approvalPolicy: ApprovalAccessPolicy,
    installed: Set<NativeScreen>,
    notificationKind: String? = null,
): NativeComposeRoute? {
    if (notificationSelfServiceSection(notificationKind, destination) != null) {
        return NativeComposeRoute.SelfService
    }
    // تغذية الإعلانات عالميّة: يبلغها كلّ مصادَق عبر الرابط العميق (VIEW من الإشعار) أو التصفّح
    // (BROWSE من بطاقة الخدمة) — قبل بوّابة الصلاحية، لأنّ الموظّف لا يملك منح وحدة الإعلانات.
    if (
        destination is NativeDestination.Feature &&
        destination.module == NativeModule.ANNOUNCEMENTS &&
        (destination.intent == NativeFeatureIntent.VIEW || destination.intent == NativeFeatureIntent.BROWSE)
    ) {
        return NativeComposeRoute.AnnouncementsFeed
    }
    if (NativeNavigationRegistry.Default.authorize(destination, principal) != AccessDecision.Allowed) return null
    return when (destination) {
        NativeDestination.Home -> NativeComposeRoute.Home
        NativeDestination.ModuleDirectory -> NativeComposeRoute.Modules
        NativeDestination.SelfService -> NativeComposeRoute.SelfService
        NativeDestination.Tasks -> principal.teamTasksRoute(installed) ?: NativeComposeRoute.SelfService
        NativeDestination.Alerts -> NativeComposeRoute.Alerts
        NativeDestination.Profile -> NativeComposeRoute.Settings.takeIf { NativeScreen.SETTINGS in installed }
        NativeDestination.Approvals -> NativeComposeRoute.Approvals.takeIf {
            ApprovalKind.entries.any(approvalPolicy::canManage)
        }
        NativeDestination.AccountingControls -> NativeComposeRoute.AccountingControls.takeIf {
            NativeScreen.ACCOUNTING_CONTROLS in installed
        }
        NativeDestination.Collaboration -> NativeComposeRoute.Collaboration.takeIf {
            NativeScreen.COLLABORATION in installed
        }
        NativeDestination.Marketing -> NativeComposeRoute.Marketing.takeIf { NativeScreen.MARKETING in installed }
        NativeDestination.Operations -> NativeComposeRoute.Operations.takeIf { NativeScreen.OPERATIONS in installed }
        NativeDestination.CrmWorkspace -> NativeComposeRoute.Crm.takeIf { NativeScreen.CRM in installed }
        NativeDestination.Receivables -> NativeComposeRoute.Receivables.takeIf { NativeScreen.RECEIVABLES in installed }
        NativeDestination.Collections -> NativeComposeRoute.Collections.takeIf { NativeScreen.COLLECTIONS in installed }
        NativeDestination.Insights -> NativeComposeRoute.Insights.takeIf { NativeScreen.INSIGHTS in installed }
        NativeDestination.Shifts -> NativeComposeRoute.Shifts.takeIf { NativeScreen.SHIFTS in installed }
        NativeDestination.WorkOrders -> NativeComposeRoute.WorkOrders.takeIf { NativeScreen.WORK_ORDERS in installed }
        NativeDestination.WarehouseTools -> NativeComposeRoute.WarehouseTools.takeIf {
            NativeScreen.WAREHOUSE_TOOLS in installed
        }
        NativeDestination.StoreAdmin -> NativeComposeRoute.StoreAdmin.takeIf { NativeScreen.STORE_ADMIN in installed }
        is NativeDestination.Module -> if (destination.module == NativeModule.TASKS) {
            principal.teamTasksRoute(installed)
                ?: NativeFeatureCatalog.resolve(destination, principal, installed)?.toComposeRoute()
        } else {
            NativeFeatureCatalog.resolve(destination, principal, installed)?.toComposeRoute()
        }
        is NativeDestination.Feature -> when {
            destination.module == NativeModule.TASKS && principal.teamTasksRoute(installed) != null ->
                principal.teamTasksRoute(installed)
            destination.module == NativeModule.SALES &&
                destination.typedEntity("quotation", allowBare = false) != null ->
                NativeComposeRoute.Crm.takeIf { NativeScreen.CRM in installed }
            destination.intent == NativeFeatureIntent.APPROVE &&
                NativeScreen.APPROVALS in installed && approvalPolicy.canManageModule(destination.module) -> NativeComposeRoute.Approvals
            else -> NativeFeatureCatalog.resolve(destination, principal, installed)?.toComposeRoute()
        }
    }
}

private fun NavigationPrincipal.teamTasksRoute(installed: Set<NativeScreen>): NativeComposeRoute? =
    NativeComposeRoute.Collaboration.takeIf {
        NativeScreen.COLLABORATION in installed &&
            grantFor(NativeModule.TASKS).satisfies(ModuleGrant.READ)
    }

private fun NativeComposeRoute.supportsFeatureLaunch(destination: NativeDestination.Feature): Boolean =
    destination.intent == NativeFeatureIntent.VIEW && when (this) {
        NativeComposeRoute.Collaboration ->
            destination.module == NativeModule.TASKS && destination.typedEntity(null) != null
        NativeComposeRoute.Crm ->
            (destination.module == NativeModule.CRM && destination.typedEntity("customer") != null) ||
                (destination.module == NativeModule.SALES &&
                    destination.typedEntity("quotation", allowBare = false) != null)
        NativeComposeRoute.Commerce ->
            destination.module in setOf(NativeModule.GIFTS, NativeModule.RESERVATIONS) &&
                destination.typedEntity(null) != null
        NativeComposeRoute.Sales ->
            destination.module == NativeModule.SALES && destination.typedEntity("invoice") != null
        NativeComposeRoute.Purchasing -> when (destination.module) {
            NativeModule.PURCHASES -> destination.typedEntity("order") != null
            NativeModule.SUPPLIERS -> destination.typedEntity("supplier") != null
            else -> false
        }
        NativeComposeRoute.WorkOrders ->
            destination.module == NativeModule.WORK_ORDERS && destination.typedEntity("order") != null
        NativeComposeRoute.StoreDelivery ->
            destination.module == NativeModule.STORE && destination.typedEntity(null) != null
        NativeComposeRoute.StoreAdmin -> false
        else -> false
    }

private fun PendingNativeNavigation?.featureEntity(module: NativeModule, prefix: String? = null): Long? {
    val feature = this?.destination as? NativeDestination.Feature ?: return null
    if (feature.module != module || feature.intent != NativeFeatureIntent.VIEW) return null
    return feature.typedEntity(prefix)
}

private fun NativeDestination.Feature.typedEntity(prefix: String?, allowBare: Boolean = true): Long? {
    if (intent != NativeFeatureIntent.VIEW) return null
    val raw = entityId ?: return null
    val numeric = if (prefix == null) raw else raw.removePrefix("$prefix-").takeIf { raw.startsWith("$prefix-") }
        ?: raw.takeIf { value -> allowBare && value.all(Char::isDigit) }
        ?: return null
    return numeric.toLongOrNull()?.takeIf { it > 0 }
}

private fun notificationSelfServiceSection(
    kind: String?,
    destination: NativeDestination,
): SelfServiceSection? = when (kind) {
    "ATTENDANCE", "ATTENDANCE_CHECK_IN", "ATTENDANCE_CHECK_OUT" ->
        SelfServiceSection.Attendance.takeIf {
            destination is NativeDestination.Feature &&
                destination.module == NativeModule.HR &&
                destination.intent == NativeFeatureIntent.BROWSE
        }
    "PAYROLL_READY" -> SelfServiceSection.Payroll.takeIf {
        destination == NativeDestination.Profile ||
            (destination is NativeDestination.Feature &&
                destination.module == NativeModule.HR &&
                destination.intent == NativeFeatureIntent.VIEW)
    }
    "LEAVE_STATUS" -> SelfServiceSection.Leaves.takeIf {
        destination == NativeDestination.Profile ||
            (destination is NativeDestination.Feature &&
                destination.module == NativeModule.HR &&
                destination.intent == NativeFeatureIntent.VIEW)
    }
    else -> null
}

private fun NativeScreen.toComposeRoute(): NativeComposeRoute = when (this) {
    NativeScreen.SELF_SERVICE -> NativeComposeRoute.SelfService
    NativeScreen.APPROVALS -> NativeComposeRoute.Approvals
    NativeScreen.ACCOUNTING_CONTROLS -> NativeComposeRoute.AccountingControls
    NativeScreen.CRM -> NativeComposeRoute.Crm
    NativeScreen.INVENTORY -> NativeComposeRoute.Inventory
    NativeScreen.SALES -> NativeComposeRoute.Sales
    NativeScreen.PURCHASING -> NativeComposeRoute.Purchasing
    NativeScreen.STORE_DELIVERY -> NativeComposeRoute.StoreDelivery
    NativeScreen.STORE_ADMIN -> NativeComposeRoute.StoreAdmin
    NativeScreen.FINANCE -> NativeComposeRoute.Finance
    NativeScreen.RECEIVABLES -> NativeComposeRoute.Receivables
    NativeScreen.COLLECTIONS -> NativeComposeRoute.Collections
    NativeScreen.PRODUCTS -> NativeComposeRoute.Products
    NativeScreen.CONVERSATIONS -> NativeComposeRoute.Conversations
    NativeScreen.COMMERCE -> NativeComposeRoute.Commerce
    NativeScreen.COLLABORATION -> NativeComposeRoute.Collaboration
    NativeScreen.MARKETING -> NativeComposeRoute.Marketing
    NativeScreen.OPERATIONS -> NativeComposeRoute.Operations
    NativeScreen.ADMIN -> NativeComposeRoute.Admin
    NativeScreen.INSIGHTS -> NativeComposeRoute.Insights
    NativeScreen.SHIFTS -> NativeComposeRoute.Shifts
    NativeScreen.WORK_ORDERS -> NativeComposeRoute.WorkOrders
    NativeScreen.WAREHOUSE_TOOLS -> NativeComposeRoute.WarehouseTools
    NativeScreen.HR_ADMIN -> NativeComposeRoute.HrAdmin
    NativeScreen.SYSTEM_SETTINGS -> NativeComposeRoute.SystemSettings
    NativeScreen.SETTINGS -> NativeComposeRoute.Settings
    NativeScreen.ANNOUNCEMENTS_FEED -> NativeComposeRoute.AnnouncementsFeed
    NativeScreen.ANNOUNCEMENTS_ADMIN -> NativeComposeRoute.AnnouncementsAdmin
}

private fun ApprovalAccessPolicy.canManageModule(module: NativeModule): Boolean =
    ApprovalKind.entries.any { it.moduleKey == module.wireName && canManage(it) }

private fun NativeDestination.isSelfServiceDestination(): Boolean = when (this) {
    NativeDestination.SelfService,
    NativeDestination.Tasks,
    -> true
    is NativeDestination.Module -> module == NativeModule.TASKS
    is NativeDestination.Feature -> module == NativeModule.TASKS
    else -> false
}

@Composable
private fun AppBottomBar(
    tabs: List<AppTab>,
    selected: AppTab,
    onSelect: (AppTab) -> Unit,
    badge: Int,
) {
    NavigationBar(
        containerColor = Color.White,
        tonalElevation = 8.dp,
        modifier = Modifier.clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)),
        windowInsets = WindowInsets(0, 0, 0, 0),
    ) {
        tabs.forEach { tab ->
            NavigationBarItem(
                modifier = Modifier.testTag("native-tab-${tab.route.route}"),
                selected = tab == selected,
                onClick = { onSelect(tab) },
                icon = { NavIcon(tab, badge) },
                label = { Text(tab.label, style = MaterialTheme.typography.labelMedium, maxLines = 1) },
            )
        }
    }
}

@Composable
private fun AppNavigationRail(
    tabs: List<AppTab>,
    selected: AppTab,
    onSelect: (AppTab) -> Unit,
    badge: Int,
) {
    NavigationRail(
        modifier = Modifier.fillMaxHeight().width(104.dp),
        containerColor = Color.White,
    ) {
        Column(
            Modifier.fillMaxHeight().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BrandMark(58.dp)
            Spacer(Modifier.height(30.dp))
            tabs.forEach { tab ->
                NavigationRailItem(
                    modifier = Modifier.testTag("native-tab-${tab.route.route}"),
                    selected = tab == selected,
                    onClick = { onSelect(tab) },
                    icon = { NavIcon(tab, badge) },
                    label = { Text(tab.label, style = MaterialTheme.typography.labelMedium, maxLines = 1) },
                )
            }
        }
    }
}

@Composable
private fun NavIcon(tab: AppTab, badge: Int) {
    Box(
        Modifier.semantics(mergeDescendants = true) {
            contentDescription = if (tab == AppTab.Alerts && badge > 0) "${tab.label}، $badge بحاجة إلى متابعة" else tab.label
        },
    ) {
        Icon(tab.icon, null)
        if (tab == AppTab.Alerts && badge > 0) {
            Box(
                Modifier.align(Alignment.TopStart).size(16.dp).clip(CircleShape).background(Orange),
                contentAlignment = Alignment.Center,
            ) { Text(badge.coerceAtMost(9).toString(), color = Color.White, fontSize = 10.sp) }
        }
    }
}

@Composable
private fun HomeScreen(
    bootstrap: AppBootstrap,
    workspace: PersonalWorkspace,
    tablet: Boolean,
    services: List<NativeServiceEntry>,
    onOpen: (NativeDestination) -> Unit,
    onRefresh: () -> Unit,
) {
    if (tablet) {
        Row(Modifier.fillMaxSize().background(Canvas)) {
            HomeFeed(bootstrap, workspace, services, onOpen, onRefresh, Modifier.weight(1.15f))
            LazyColumn(
                Modifier.weight(.85f).fillMaxHeight(),
                contentPadding = PaddingValues(22.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item { SectionTitle("الخدمات السريعة") }
                itemsIndexed(services.chunked(2)) { rowIndex, pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEachIndexed { columnIndex, service ->
                            NativeServiceTile(
                                service = service,
                                modifier = Modifier.weight(1f),
                                emphasized = rowIndex == 0 && columnIndex == 0,
                            ) { onOpen(service.destination) }
                        }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    } else {
        HomeFeed(bootstrap, workspace, services, onOpen, onRefresh, Modifier.fillMaxSize())
    }
}

private fun AppBootstrap.hasExecutiveHome(): Boolean = (isExecutive && !roleDegraded) || isOwner || user.isOwner

@Composable
private fun HomeFeed(
    bootstrap: AppBootstrap,
    workspace: PersonalWorkspace,
    services: List<NativeServiceEntry>,
    onOpen: (NativeDestination) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier,
) {
    val density = LocalDensity.current
    val largeText = density.fontScale >= 1.5f
    var headerHeightPx by remember { mutableIntStateOf(0) }
    val measuredHeaderHeight = with(density) { headerHeightPx.toDp() }
    val feedTopPadding = maxOf(
        264.dp,
        measuredHeaderHeight.takeIf { headerHeightPx > 0 }?.minus(if (largeText) 16.dp else 62.dp) ?: 264.dp,
    )
    Box(modifier.background(Canvas)) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 326.dp)
                .onSizeChanged { headerHeightPx = it.height }
                .testTag("native-home-header")
                .clip(HomeHeaderShape).background(
                Brush.verticalGradient(
                    colors = listOf(Color(0xFF2F1A77), EmeraldDark, Color(0xFF5B36D2)),
                ),
            ),
        ) {
            Box(
                Modifier.matchParentSize().background(
                    Brush.radialGradient(
                        colors = listOf(Color(0xFF9D83FF).copy(alpha = .32f), Color.Transparent),
                        radius = 620f,
                    ),
                ),
            )
            androidx.compose.foundation.Image(
                painter = painterResource(R.drawable.ic_launcher_monochrome),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.align(Alignment.BottomEnd).size(330.dp).alpha(.075f),
            )
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        BrandMark(58.dp)
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text("سوبر العربية", style = MaterialTheme.typography.titleMedium, color = Color.White)
                            Text("منصة الأعمال", style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = .68f))
                        }
                    }
                    IconButton(
                        onClick = onRefresh,
                        modifier = Modifier.size(46.dp).clip(CircleShape).background(Color.White.copy(alpha = .12f)),
                    ) { Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White) }
                }
                Spacer(Modifier.height(16.dp))
                Text("مساء الخير", style = MaterialTheme.typography.titleLarge, color = Color.White.copy(alpha = .82f))
                Text(bootstrap.user.name, style = MaterialTheme.typography.headlineLarge, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(bootstrap.user.roleLabel, style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = .72f))
                    Box(Modifier.size(4.dp).clip(CircleShape).background(Color.White.copy(alpha = .45f)))
                    Text(workspace.date, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = .68f))
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().testTag("native-home-feed"),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = feedTopPadding, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item { PriorityCard(workspace.tasks.firstOrNull()) }
            item {
                SectionCard {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        SectionTitle("اليوم")
                        Box(Modifier.size(9.dp).clip(CircleShape).background(Emerald))
                    }
                    Spacer(Modifier.height(4.dp))
                    if (workspace.notifications.isEmpty()) {
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Mint.copy(alpha = .62f)).padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Rounded.CheckCircle, null, tint = Emerald, modifier = Modifier.size(26.dp))
                            EmptyLine("لا توجد تحديثات جديدة", compact = true)
                        }
                    }
                    else workspace.notifications.take(3).forEachIndexed { index, notification ->
                        TimelineRow(notification)
                        if (index < minOf(2, workspace.notifications.lastIndex)) HorizontalDivider(color = Stroke)
                    }
                }
            }
            item {
                SectionTitle("الخدمات السريعة", color = Color.White)
                Spacer(Modifier.height(10.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = 1.dp)) {
                    itemsIndexed(services, key = { _, service -> service.key }) { index, service ->
                        NativeServiceTile(
                            service = service,
                            modifier = Modifier.width(if (largeText) 176.dp else 132.dp),
                            emphasized = index == 0,
                        ) { onOpen(service.destination) }
                    }
                }
            }
            item { AttendanceCard(workspace) }
        }
    }
}

@Composable
private fun PriorityCard(task: TaskSummary?) {
    SectionCard(shape = RoundedCornerShape(topStart = 38.dp, topEnd = 22.dp, bottomEnd = 34.dp, bottomStart = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(Orange))
            Text("أولوية العمل", style = MaterialTheme.typography.titleLarge)
        }
        Spacer(Modifier.height(14.dp))
        if (task == null) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(19.dp)).background(Mint.copy(alpha = .62f)).padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.size(42.dp).clip(CircleShape).background(Color.White), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.CheckCircle, null, tint = Emerald, modifier = Modifier.size(28.dp))
                }
                Text("لا توجد مهام معلقة", style = MaterialTheme.typography.bodyLarge, color = Ink)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(58.dp).clip(RoundedCornerShape(19.dp)).background(OrangeSoft), contentAlignment = Alignment.Center) {
                    Icon(Icons.AutoMirrored.Rounded.Assignment, null, tint = Orange, modifier = Modifier.size(30.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(task.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(task.number, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                }
                StatusPill(priorityLabel(task.priority), if (task.priority in listOf("URGENT", "HIGH")) Orange else Emerald)
            }
        }
    }
}

@Composable
private fun TimelineRow(item: NotificationSummary) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(52.dp).clip(RoundedCornerShape(18.dp)).background(if (item.requiresAction) OrangeSoft else Mint),
            contentAlignment = Alignment.Center,
        ) { Icon(notificationIcon(item.kind), null, tint = if (item.requiresAction) Orange else Emerald) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(item.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(item.body, style = MaterialTheme.typography.bodyMedium, color = MutedInk, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (item.requiresAction) Box(Modifier.size(9.dp).clip(CircleShape).background(Orange))
    }
}

@Composable
private fun AttendanceCard(workspace: PersonalWorkspace) {
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("الدوام", style = MaterialTheme.typography.titleLarge)
                Text(workspace.date, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            }
            Box(Modifier.size(58.dp).clip(CircleShape).background(Mint), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Fingerprint, null, tint = Emerald, modifier = Modifier.size(32.dp))
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            AttendanceValue("الدخول", workspace.attendance?.checkIn ?: "—")
            AttendanceValue("الخروج", workspace.attendance?.checkOut ?: "—")
            AttendanceValue("الحالة", attendanceLabel(workspace.attendance?.status))
        }
    }
}

@Composable
private fun AttendanceValue(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MutedInk)
        Text(value, style = MaterialTheme.typography.titleMedium, color = Ink)
    }
}

@Composable
private fun ModulesScreen(
    services: List<NativeServiceEntry>,
    branchContext: SessionBranchContext,
    onChangeBranch: () -> Unit,
    onOpen: (NativeDestination) -> Unit,
) {
    AppListScaffold("الخدمات", "${services.size} متاحة") {
        if (branchContext.principal.canSelectBranch) {
            item {
                Surface(
                    modifier = Modifier.fillMaxWidth()
                        .testTag("session-branch-switcher")
                        .clickable(role = Role.Button, onClick = onChangeBranch),
                    shape = RoundedCornerShape(22.dp),
                    color = Mint,
                    contentColor = EmeraldDark,
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(Icons.Rounded.BusinessCenter, null)
                        Column(Modifier.weight(1f)) {
                            Text(
                                branchContext.selectedBranch?.name ?: "اختر الفرع",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            branchContext.selectedBranch?.code?.let { code ->
                                Text(code, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                            }
                        }
                        Icon(Icons.Rounded.ChevronLeft, null)
                    }
                }
            }
        }
        itemsIndexed(services.chunked(2)) { rowIndex, pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEachIndexed { columnIndex, service ->
                    NativeServiceTile(
                        service = service,
                        modifier = Modifier.weight(1f),
                        emphasized = rowIndex == 0 && columnIndex == 0,
                    ) { onOpen(service.destination) }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun NativeServiceTile(
    service: NativeServiceEntry,
    modifier: Modifier,
    emphasized: Boolean = false,
    onClick: () -> Unit,
) {
    val largeText = LocalDensity.current.fontScale >= 1.5f
    Card(
        modifier = modifier.heightIn(min = if (largeText) 150.dp else 130.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = "${service.label}، ${service.accessLabel}"
                role = Role.Button
            }
            .testTag("native-service-${service.key}")
            .clickable(role = Role.Button, onClick = onClick),
        shape = if (emphasized) {
            RoundedCornerShape(topStart = 38.dp, topEnd = 18.dp, bottomEnd = 38.dp, bottomStart = 18.dp)
        } else {
            RoundedCornerShape(topStart = 28.dp, topEnd = 18.dp, bottomEnd = 28.dp, bottomStart = 18.dp)
        },
        colors = CardDefaults.cardColors(containerColor = if (emphasized) Emerald else Color.White),
        elevation = CardDefaults.cardElevation(defaultElevation = if (emphasized) 5.dp else 2.dp),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(if (largeText) 12.dp else 8.dp),
        ) {
            Box(
                Modifier.size(42.dp).clip(RoundedCornerShape(topStart = 17.dp, bottomEnd = 17.dp, topEnd = 11.dp, bottomStart = 11.dp))
                    .background(if (emphasized) Color.White.copy(alpha = .17f) else Mint),
                contentAlignment = Alignment.Center,
            ) {
                Icon(service.icon, null, tint = if (emphasized) Color.White else Emerald)
            }
            Text(
                service.label,
                style = MaterialTheme.typography.titleMedium,
                color = if (emphasized) Color.White else Ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!largeText) {
                    Text(
                        service.accessLabel,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (emphasized) Color.White.copy(alpha = .72f) else MutedInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Icon(
                    Icons.Rounded.ChevronLeft,
                    null,
                    tint = if (emphasized) Color.White else Emerald,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun TasksScreen(tasks: List<TaskSummary>) {
    AppListScaffold("المهام", "${tasks.size} نشطة") {
        if (tasks.isEmpty()) item { EmptyState(Icons.Rounded.TaskAlt, "لا توجد مهام نشطة") }
        items(tasks, key = { it.id }) { task ->
            SectionCard {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(48.dp).clip(RoundedCornerShape(16.dp)).background(Mint), contentAlignment = Alignment.Center) {
                        Icon(Icons.AutoMirrored.Rounded.Assignment, null, tint = Emerald)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text(task.title, style = MaterialTheme.typography.titleMedium)
                        Text(task.number, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StatusPill(priorityLabel(task.priority), if (task.priority in listOf("URGENT", "HIGH")) Orange else Emerald)
                            StatusPill(statusLabel(task.status), MutedInk)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun NotificationsScreen(notifications: List<NotificationSummary>) {
    AppListScaffold("التنبيهات", "${notifications.size} حديثة") {
        if (notifications.isEmpty()) item { EmptyState(Icons.Rounded.Notifications, "لا توجد تنبيهات") }
        items(notifications, key = { it.id }) { TimelineRow(it) }
    }
}

@Composable
private fun ProfileScreen(
    state: AppSessionState.Ready,
    biometricAvailable: Boolean,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onLogout: () -> Unit,
) {
    val user = state.bootstrap.user
    val workspace = state.workspace
    AppListScaffold("حسابي", user.roleLabel) {
        item {
            SectionCard {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(66.dp).clip(RoundedCornerShape(22.dp)).background(EmeraldDark), contentAlignment = Alignment.Center) {
                        Text(user.name.take(1), color = Color.White, style = MaterialTheme.typography.headlineMedium)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(user.name, style = MaterialTheme.typography.titleLarge)
                        Text(workspace.employee?.position ?: user.roleLabel, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                        workspace.employee?.department?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Emerald) }
                    }
                }
            }
        }
        workspace.payroll?.let { payroll ->
            item {
                SectionCard {
                    SectionTitle("آخر كشف راتب")
                    Spacer(Modifier.height(14.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        AttendanceValue("الفترة", payroll.period)
                        AttendanceValue("الاستقطاعات", formatMoney(payroll.deductions))
                        AttendanceValue("الصافي", formatMoney(payroll.net))
                    }
                }
            }
        }
        workspace.employee?.let { employee ->
            item {
                SectionCard {
                    SectionTitle("الإجازات")
                    Spacer(Modifier.height(14.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround) {
                        AttendanceValue("سنوية", employee.annualLeaveBalance)
                        AttendanceValue("مرضية", employee.sickLeaveBalance)
                    }
                }
            }
        }
        if (biometricAvailable) {
            item {
                ActionRow(
                    icon = Icons.Rounded.Fingerprint,
                    title = "الدخول الحيوي",
                    subtitle = if (state.biometricEnabled) "مفعّل" else "غير مفعّل",
                    onClick = if (state.biometricEnabled) onDisableBiometric else onEnableBiometric,
                )
            }
        }
        item { ActionRow(Icons.AutoMirrored.Rounded.Logout, "تسجيل الخروج", "", onLogout, danger = true) }
    }
}

@Composable
private fun ActionRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    danger: Boolean = false,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Color.White)
            .clickable(role = Role.Button, onClick = onClick).padding(18.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (danger) MaterialTheme.colorScheme.error else Emerald)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = if (danger) MaterialTheme.colorScheme.error else Ink)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
        }
        Icon(Icons.Rounded.ChevronLeft, null, tint = MutedInk)
    }
}

@Composable
private fun AppListScaffold(title: String, subtitle: String, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(Canvas)) {
        Surface(
            color = Emerald,
            contentColor = Color.White,
            shape = RoundedCornerShape(bottomStart = 46.dp, bottomEnd = 20.dp),
            shadowElevation = 5.dp,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 22.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(title, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                    Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = .72f))
                }
                Box(
                    Modifier.size(58.dp).clip(RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp, topEnd = 14.dp, bottomStart = 14.dp))
                        .background(Color.White.copy(alpha = .16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    BrandMark(44.dp)
                }
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModuleSheet(state: ModuleSheetState, onClose: () -> Unit, onRetry: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose, containerColor = Canvas, shape = RoundedCornerShape(topStart = 36.dp, topEnd = 36.dp)) {
        ModuleDetailContent(
            state = state,
            onClose = null,
            onRetry = onRetry,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 34.dp),
        )
    }
}

@Composable
private fun ModuleDetailPane(state: ModuleSheetState, onClose: () -> Unit, onRetry: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxHeight().widthIn(min = 360.dp, max = 440.dp),
        color = Canvas,
        shadowElevation = 10.dp,
    ) {
        ModuleDetailContent(
            state = state,
            onClose = onClose,
            onRetry = onRetry,
            modifier = Modifier.fillMaxSize().padding(24.dp),
        )
    }
}

@Composable
private fun ModuleDetailContent(
    state: ModuleSheetState,
    onClose: (() -> Unit)?,
    onRetry: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(state.module.label, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                Text(if (state.module.access == "FULL") "صلاحية كاملة" else "صلاحية عرض", style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            }
            if (onClose != null) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "إغلاق") }
            } else {
                Box(Modifier.size(54.dp).clip(RoundedCornerShape(18.dp)).background(Mint), contentAlignment = Alignment.Center) {
                    Icon(moduleIcon(state.module.key), null, tint = Emerald)
                }
            }
        }
        when {
            state.loading -> Box(Modifier.fillMaxWidth().height(170.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    color = Emerald,
                    modifier = Modifier.semantics {
                        contentDescription = "جارٍ تحميل ${state.module.label}"
                        liveRegion = LiveRegionMode.Polite
                    },
                )
            }
            state.error != null -> Column(
                Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                EmptyState(Icons.Rounded.WarningAmber, state.error)
                Button(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text("إعادة المحاولة") }
            }
            state.metrics.isEmpty() -> EmptyState(Icons.Rounded.CheckCircle, "لا توجد مؤشرات معلقة")
            else -> state.metrics.chunked(2).forEach { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    pair.forEach { metric -> MetricCard(metric, Modifier.weight(1f)) }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun MetricCard(metric: ModuleMetric, modifier: Modifier) {
    Card(modifier, shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(metric.label, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            Text(
                if (metric.format == "money") formatMoney(metric.value.toString()) else numberFormat.format(metric.value),
                style = MaterialTheme.typography.headlineMedium,
                color = EmeraldDark,
            )
        }
    }
}

@Composable
private fun SectionCard(
    shape: Shape = RoundedCornerShape(topStart = 30.dp, topEnd = 20.dp, bottomEnd = 30.dp, bottomStart = 20.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
    ) { Column(Modifier.fillMaxWidth().padding(20.dp), content = content) }
}

@Composable
private fun SectionTitle(text: String, color: Color = Color.Unspecified) = Text(
    text,
    style = MaterialTheme.typography.titleLarge,
    color = color,
    modifier = Modifier.semantics { heading() },
)

@Composable
private fun StatusPill(label: String, color: Color) {
    Text(
        label,
        modifier = Modifier.clip(CircleShape).background(color.copy(alpha = .11f)).padding(horizontal = 11.dp, vertical = 6.dp),
        color = color,
        style = MaterialTheme.typography.labelMedium,
    )
}

@Composable
private fun EmptyLine(text: String, compact: Boolean = false) = Text(
    text,
    style = MaterialTheme.typography.bodyLarge,
    color = MutedInk,
    modifier = if (compact) Modifier else Modifier.padding(vertical = 20.dp),
)

@Composable
private fun EmptyState(icon: ImageVector, text: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 38.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(Mint), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Emerald, modifier = Modifier.size(32.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MutedInk, textAlign = TextAlign.Center)
    }
}

@Composable
private fun BrandMark(size: androidx.compose.ui.unit.Dp) {
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * .28f)).background(Color.White)
            .border(1.dp, Color.White.copy(alpha = .4f), RoundedCornerShape(size * .28f)),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Image(
            painter = painterResource(R.mipmap.ic_maskable),
            contentDescription = "سوبر العربية",
            modifier = Modifier.fillMaxSize().padding(size * .05f),
        )
    }
}

private object LoginHeaderShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline.Generic {
        val path = Path().apply {
            moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width, size.height * .78f)
            cubicTo(size.width * .78f, size.height, size.width * .42f, size.height * .72f, 0f, size.height)
            close()
        }
        return Outline.Generic(path)
    }
}

private object HomeHeaderShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline.Generic {
        val path = Path().apply {
            moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width, size.height * .84f)
            cubicTo(size.width * .78f, size.height, size.width * .56f, size.height * .78f, size.width * .32f, size.height * .9f)
            cubicTo(size.width * .18f, size.height * .97f, size.width * .08f, size.height * .94f, 0f, size.height * .86f)
            close()
        }
        return Outline.Generic(path)
    }
}

private val numberFormat = NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ")).apply { maximumFractionDigits = 0 }

private fun formatMoney(raw: String): String = runCatching {
    numberFormat.format(raw.toDouble()) + " د.ع"
}.getOrElse { raw }

private fun priorityLabel(value: String) = when (value) {
    "URGENT" -> "عاجلة"
    "HIGH" -> "عالية"
    "LOW" -> "منخفضة"
    else -> "عادية"
}

private fun statusLabel(value: String) = when (value) {
    "NEW" -> "جديدة"
    "IN_PROGRESS" -> "قيد التنفيذ"
    "WAITING_CUSTOMER" -> "بانتظار العميل"
    "COMPLETED" -> "مكتملة"
    else -> value
}

private fun attendanceLabel(value: String?) = when (value) {
    "present" -> "حاضر"
    "absent" -> "غائب"
    "late" -> "متأخر"
    "leave" -> "إجازة"
    else -> "غير مسجل"
}

private fun moduleIcon(key: String): ImageVector = when (key) {
    "inventory", "products", "warehouse", "stocktake" -> Icons.Rounded.Inventory2
    "treasury", "sales", "purchases", "accounting" -> Icons.Rounded.Payments
    "hr", "users" -> Icons.Rounded.Badge
    "tasks", "workorders" -> Icons.AutoMirrored.Rounded.Assignment
    else -> Icons.Rounded.BusinessCenter
}

private fun notificationIcon(kind: String): ImageVector = when (kind) {
    "ATTENDANCE" -> Icons.Rounded.Schedule
    "PAYROLL" -> Icons.Rounded.Payments
    "TASK" -> Icons.AutoMirrored.Rounded.Assignment
    else -> Icons.Rounded.Notifications
}

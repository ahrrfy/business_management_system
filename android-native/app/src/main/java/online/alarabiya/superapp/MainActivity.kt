package online.alarabiya.superapp

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.notifications.NativeNotificationNavigationInbox
import online.alarabiya.superapp.core.notifications.NativePushCoordinator
import online.alarabiya.superapp.core.notifications.NotificationPermissionLifecycleGuard
import online.alarabiya.superapp.core.notifications.NotificationPermissionController
import online.alarabiya.superapp.core.security.BiometricSessionInvalidatedException
import online.alarabiya.superapp.core.security.BiometricSessionOperation
import online.alarabiya.superapp.core.security.SecureSessionStore
import online.alarabiya.superapp.data.ApprovalsRepository
import online.alarabiya.superapp.data.AccountingControlsRepository
import online.alarabiya.superapp.data.AdminRepository
import online.alarabiya.superapp.data.CrmRepository
import online.alarabiya.superapp.data.ConversationsRepository
import online.alarabiya.superapp.data.CommerceRepository
import online.alarabiya.superapp.data.CollaborationRepository
import online.alarabiya.superapp.data.CollectionsRepository
import online.alarabiya.superapp.data.FinanceRepository
import online.alarabiya.superapp.data.InventoryRepository
import online.alarabiya.superapp.data.InsightsRepository
import online.alarabiya.superapp.data.HrAdminRepository
import online.alarabiya.superapp.data.LegalRepository
import online.alarabiya.superapp.data.MarketingRepository
import online.alarabiya.superapp.data.OperationsRepository
import online.alarabiya.superapp.data.PurchasingRepository
import online.alarabiya.superapp.data.ProductsRepository
import online.alarabiya.superapp.data.ReceivablesRepository
import online.alarabiya.superapp.data.SalesRepository
import online.alarabiya.superapp.data.SelfServiceRepository
import online.alarabiya.superapp.data.StoreDeliveryRepository
import online.alarabiya.superapp.data.SuperAppRepository
import online.alarabiya.superapp.data.SystemSettingsRepository
import online.alarabiya.superapp.data.WorkOrdersRepository
import online.alarabiya.superapp.data.WarehouseToolsRepository
import online.alarabiya.superapp.data.EncryptedWarehouseStore
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.accountingControls.AccountingControlsCapabilities
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.marketing.MarketingScope
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.workorders.WorkOrdersCapabilities
import online.alarabiya.superapp.model.warehouseTools.WarehouseCapabilities
import online.alarabiya.superapp.ui.AppSessionState
import online.alarabiya.superapp.ui.SuperAppRoot
import online.alarabiya.superapp.ui.SuperAppViewModel
import online.alarabiya.superapp.ui.SuperAppViewModelFactory
import online.alarabiya.superapp.ui.theme.AlrueyaTheme

class MainActivity : FragmentActivity() {
    private lateinit var viewModel: SuperAppViewModel
    private lateinit var sessionStore: SecureSessionStore
    private var biometricPrompt: BiometricPrompt? = null
    private var biometricPromptInFlight = false
    private var pushActivatedForSession = false
    private var pushRegistrationRequestedForSession = false
    private val notificationPermissionLifecycle = NotificationPermissionLifecycleGuard()
    @Volatile private var composeLaunchReady = false
    private val platformSplashExited = mutableStateOf(false)
    private val brandLaunchVisible = mutableStateOf(true)

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition { !composeLaunchReady }
        splashScreen.setOnExitAnimationListener { provider ->
            provider.remove()
            platformSplashExited.value = true
        }
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(R.color.brand_launch_background)
        NativeNotificationNavigationInbox.accept(intent)
        // Release screens can expose payroll, financial and personal data. Debug alone permits
        // emulator screenshots so the visual QA gate can compare real native pixels.
        if (!BuildConfig.DEBUG) {
            window.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE,
            )
        }
        enableEdgeToEdge()
        sessionStore = SecureSessionStore(applicationContext)
        val api = TrpcClient(sessionStore)
        val repository = SuperAppRepository(api, sessionStore) {
            NativePushCoordinator.revokeBeforeLogout(applicationContext)
        }
        val selfServiceRepository = SelfServiceRepository(api)
        val approvalsRepository = ApprovalsRepository(api)
        val adminRepository = AdminRepository(api)
        val crmRepository = CrmRepository(api)
        val conversationsRepository = ConversationsRepository(api)
        val commerceRepository = CommerceRepository(api)
        val collaborationRepository = CollaborationRepository(api)
        val receivablesRepository = ReceivablesRepository(api)
        val salesRepository = SalesRepository(api)
        val storeDeliveryRepository = StoreDeliveryRepository(api)
        val financeRepository = FinanceRepository(api)
        val insightsRepository = InsightsRepository(api)
        val productsRepository = ProductsRepository(api)
        val legalRepository = LegalRepository()
        val systemSettingsRepository = SystemSettingsRepository(api)
        viewModel = ViewModelProvider(this, SuperAppViewModelFactory(repository))[SuperAppViewModel::class.java]

        setContent {
            val state = viewModel.sessionState
            val view = LocalView.current
            val launchAnimationReady = platformSplashExited.value
            val launchOverlayVisible = brandLaunchVisible.value
            SideEffect {
                // The Compose tree has been successfully applied. Releasing the platform splash
                // here avoids the pre-draw deadlock where the splash cancels the very traversal
                // that was previously responsible for setting composeLaunchReady.
                composeLaunchReady = true
                // Some devices do not invoke the platform exit callback after a custom keep
                // condition is released. Compose is already mounted at this point, so this is a
                // safe fallback that prevents the branded hand-off from waiting forever.
                if (!platformSplashExited.value) platformSplashExited.value = true
            }
            LaunchedEffect(state is AppSessionState.Ready) {
                if (state is AppSessionState.Ready && !pushActivatedForSession) {
                    pushActivatedForSession = true
                    activateNotificationsForReadySession()
                } else if (state !is AppSessionState.Ready) {
                    pushActivatedForSession = false
                    pushRegistrationRequestedForSession = false
                }
            }
            SideEffect {
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !launchOverlayVisible &&
                        state !is AppSessionState.Locked &&
                        state !is AppSessionState.Ready
                    isAppearanceLightNavigationBars = !launchOverlayVisible
                }
            }
            AlrueyaTheme {
                SuperAppRoot(
                    viewModel = viewModel,
                    launchAnimationReady = launchAnimationReady,
                    onLaunchVisibilityChanged = { brandLaunchVisible.value = it },
                    biometricAvailable = biometricAvailable(),
                    onBiometricUnlock = ::requestSessionUnlock,
                    onEnableBiometric = ::requestBiometricEnrollment,
                    selfServiceSource = selfServiceRepository,
                    approvalsSource = approvalsRepository,
                    accountingControlsSourceFactory = { bootstrap ->
                        AccountingControlsRepository(api, AccountingControlsCapabilities.fromBootstrap(bootstrap))
                    },
                    adminSource = adminRepository,
                    crmSource = crmRepository,
                    conversationsSource = conversationsRepository,
                    commerceSource = commerceRepository,
                    collaborationSource = collaborationRepository,
                    receivablesSource = receivablesRepository,
                    collectionsSourceFactory = { bootstrap ->
                        CollectionsRepository(api, CollectionsCapabilities.fromBootstrap(bootstrap))
                    },
                    marketingSourceFactory = { bootstrap ->
                        MarketingRepository(
                            api,
                            MarketingScope(bootstrap.user.role, bootstrap.branchId),
                        )
                    },
                    operationsSourceFactory = { bootstrap ->
                        OperationsRepository(api, OperationsScope(bootstrap.user.role, bootstrap.branchId))
                    },
                    inventorySourceFactory = { bootstrap ->
                        InventoryRepository(api, InventoryCapabilities.fromBootstrap(bootstrap))
                    },
                    hrAdminSourceFactory = { bootstrap ->
                        HrAdminRepository(api, HrAdminCapabilities.fromBootstrap(bootstrap))
                    },
                    salesSource = salesRepository,
                    purchasingSourceFactory = { bootstrap ->
                        PurchasingRepository(api, PurchasingCapabilities.fromBootstrap(bootstrap))
                    },
                    workOrdersSourceFactory = { bootstrap ->
                        WorkOrdersRepository(api, WorkOrdersCapabilities.fromBootstrap(bootstrap))
                    },
                    warehouseToolsSourceFactory = { bootstrap ->
                        val capabilities = WarehouseCapabilities.fromBootstrap(bootstrap)
                        WarehouseToolsRepository(
                            api,
                            capabilities,
                            EncryptedWarehouseStore(applicationContext, bootstrap.user.id),
                        )
                    },
                    storeDeliverySource = storeDeliveryRepository,
                    financeSource = financeRepository,
                    insightsSource = insightsRepository,
                    productsSource = productsRepository,
                    legalSource = legalRepository,
                    systemSettingsSource = systemSettingsRepository,
                    notificationDestinations = NativeNotificationNavigationInbox.destinations,
                )
            }
        }
    }

    private fun biometricAvailable(): Boolean =
        BiometricManager.from(this).canAuthenticate(STRONG_BIOMETRIC) ==
            BiometricManager.BIOMETRIC_SUCCESS

    private fun requestSessionUnlock() {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || biometricPromptInFlight) return
        val operation = try {
            sessionStore.prepareBiometricUnlock()
        } catch (_: BiometricSessionInvalidatedException) {
            sessionStore.invalidateBiometricSession()
            viewModel.usePasswordInstead()
            return
        } catch (_: Exception) {
            sessionStore.invalidateBiometricSession()
            viewModel.usePasswordInstead()
            return
        }

        promptBiometric(
            operation = operation,
            promptInfo = UNLOCK_PROMPT,
            onAuthenticated = viewModel::biometricUnlocked,
            onCancel = viewModel::biometricCancelled,
            onNegative = viewModel::usePasswordInstead,
        )
    }

    private fun requestBiometricEnrollment() {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || biometricPromptInFlight) return
        val operation = try {
            sessionStore.prepareBiometricEnrollment()
        } catch (_: Exception) {
            return
        }
        promptBiometric(
            operation = operation,
            promptInfo = ENROLLMENT_PROMPT,
            onAuthenticated = viewModel::enableBiometric,
            onCancel = {},
            onNegative = {},
        )
    }

    private fun promptBiometric(
        operation: BiometricSessionOperation,
        promptInfo: BiometricPrompt.PromptInfo,
        onAuthenticated: () -> Unit,
        onCancel: () -> Unit,
        onNegative: () -> Unit,
    ) {
        if (!biometricAvailable() || biometricPromptInFlight) {
            operation.cancel()
            onCancel()
            return
        }

        biometricPromptInFlight = true
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    biometricPromptInFlight = false
                    biometricPrompt = null
                    val cipher = result.cryptoObject?.cipher
                    val completed = try {
                        if (cipher == null) {
                            operation.cancel()
                            false
                        } else {
                            sessionStore.completeBiometricOperation(operation, cipher)
                        }
                    } catch (_: BiometricSessionInvalidatedException) {
                        false
                    }
                    if (completed) onAuthenticated()
                    else {
                        sessionStore.invalidateBiometricSession()
                        viewModel.usePasswordInstead()
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    biometricPromptInFlight = false
                    biometricPrompt = null
                    operation.cancel()
                    if (errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON) onNegative()
                    else onCancel()
                }
            },
        )
        biometricPrompt = prompt
        try {
            prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(operation.cipher))
        } catch (_: Exception) {
            biometricPrompt = null
            biometricPromptInFlight = false
            operation.cancel()
            onCancel()
        }
    }

    override fun onResume() {
        super.onResume()
        if (notificationPermissionLifecycle.consumeResumeBypass()) {
            if (::viewModel.isInitialized && viewModel.sessionState is AppSessionState.Ready) {
                activateNotificationsForReadySession()
            }
        } else if (::sessionStore.isInitialized && sessionStore.isBiometricEnabled() && ::viewModel.isInitialized) {
            // Enforce the lock again on foreground so a late network callback from the previous
            // lifecycle cannot restore a Ready state while the Activity was backgrounded.
            sessionStore.lock()
            viewModel.biometricCancelled()
            window.decorView.post(::requestSessionUnlock)
        } else if (::viewModel.isInitialized && viewModel.sessionState is AppSessionState.Ready) {
            // يلتقط منح الإذن من إعدادات النظام من دون إعادة طلبه أو إعادة التسجيل في كل resume.
            activateNotificationsForReadySession()
        }
    }

    override fun onStop() {
        if (
            ::sessionStore.isInitialized &&
            sessionStore.isBiometricEnabled() &&
            !isChangingConfigurations &&
            !notificationPermissionLifecycle.onActivityStopping()
        ) {
            biometricPrompt?.cancelAuthentication()
            biometricPrompt = null
            biometricPromptInFlight = false
            sessionStore.lock()
            if (::viewModel.isInitialized) {
                viewModel.closeModule()
                viewModel.biometricCancelled()
            }
        }
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        NativeNotificationNavigationInbox.accept(intent)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NotificationPermissionController.REQUEST_CODE) {
            notificationPermissionLifecycle.permissionResultReceived()
            if (
                ::viewModel.isInitialized &&
                viewModel.sessionState is AppSessionState.Ready &&
                NotificationPermissionController.canPost(this)
            ) {
                pushRegistrationRequestedForSession = true
                NativePushCoordinator.registerExistingSession(applicationContext)
            }
        }
    }

    private fun activateNotificationsForReadySession() {
        if (!NativePushCoordinator.isConfigured(this)) return
        if (NotificationPermissionController.canPost(this)) {
            if (!pushRegistrationRequestedForSession) {
                pushRegistrationRequestedForSession = true
                NativePushCoordinator.registerExistingSession(applicationContext)
            }
        } else {
            notificationPermissionLifecycle.requestStarting()
            val requested = runCatching {
                NotificationPermissionController.requestOnceAfterAuthentication(this)
            }.getOrDefault(false)
            if (!requested) notificationPermissionLifecycle.requestDidNotStart()
        }
    }

    private companion object {
        const val STRONG_BIOMETRIC = BiometricManager.Authenticators.BIOMETRIC_STRONG
        val UNLOCK_PROMPT: BiometricPrompt.PromptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("سوبر العربية")
            .setSubtitle("تحقق للمتابعة")
            .setAllowedAuthenticators(STRONG_BIOMETRIC)
            .setNegativeButtonText("استخدام كلمة المرور")
            .build()
        val ENROLLMENT_PROMPT: BiometricPrompt.PromptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("حماية التطبيق")
            .setSubtitle("أكد هويتك لتفعيل الفتح بالبصمة")
            .setAllowedAuthenticators(STRONG_BIOMETRIC)
            .setNegativeButtonText("إلغاء")
            .build()
    }
}

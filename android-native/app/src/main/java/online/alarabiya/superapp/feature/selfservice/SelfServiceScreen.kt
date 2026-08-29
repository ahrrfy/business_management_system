package online.alarabiya.superapp.feature.selfservice

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Comment
import androidx.compose.material.icons.rounded.AccessTime
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import online.alarabiya.superapp.core.notifications.NotificationPermissionController
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.selfservice.AttendanceEntry
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.model.selfservice.PersonalLeaveRequest
import online.alarabiya.superapp.model.selfservice.PersonalEmployeeProfile
import online.alarabiya.superapp.model.selfservice.PersonalNotification
import online.alarabiya.superapp.model.selfservice.PersonalPayroll
import online.alarabiya.superapp.model.selfservice.PersonalPayslip
import online.alarabiya.superapp.model.selfservice.PersonalTask
import online.alarabiya.superapp.model.selfservice.PersonalTaskAction
import online.alarabiya.superapp.model.selfservice.SelfServiceCapabilities
import online.alarabiya.superapp.model.selfservice.SelfServicePolicies
import online.alarabiya.superapp.model.selfservice.SelfServiceSnapshot
import java.text.NumberFormat
import java.util.Locale

private val LeaveTypes = listOf("سنوية", "مرضية", "أمومة", "بدون راتب")

@Composable
fun SelfServiceRoute(
    viewModel: SelfServiceViewModel,
    capabilities: SelfServiceCapabilities,
    account: UserIdentity,
    biometricAvailable: Boolean,
    biometricEnabled: Boolean,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel) {
        if (viewModel.state.snapshot == null) viewModel.refresh()
    }
    SelfServiceScreen(
        state = viewModel.state,
        capabilities = capabilities,
        account = account,
        biometricAvailable = biometricAvailable,
        biometricEnabled = biometricEnabled,
        onSelectSection = viewModel::select,
        onRefresh = viewModel::refresh,
        onTaskAction = viewModel::performTaskAction,
        onRequestLeave = viewModel::requestLeave,
        onWithdrawLeave = viewModel::withdrawLeave,
        onMarkNotificationRead = viewModel::markNotificationRead,
        onMarkAllNotificationsRead = viewModel::markAllNotificationsRead,
        onSaveNotificationPreferences = viewModel::saveNotificationPreferences,
        onOpenPayslip = viewModel::openPayslip,
        onClosePayslip = viewModel::closePayslip,
        onEnableBiometric = onEnableBiometric,
        onDisableBiometric = onDisableBiometric,
        onClose = onClose,
        modifier = modifier,
    )
}

@Composable
fun SelfServiceScreen(
    state: SelfServiceUiState,
    capabilities: SelfServiceCapabilities,
    account: UserIdentity,
    biometricAvailable: Boolean,
    biometricEnabled: Boolean,
    onSelectSection: (SelfServiceSection) -> Unit,
    onRefresh: () -> Unit,
    onTaskAction: (Long, PersonalTaskAction, String?) -> Unit,
    onRequestLeave: (String, String, String, String?) -> Unit,
    onWithdrawLeave: (Long) -> Unit,
    onMarkNotificationRead: (Long) -> Unit,
    onMarkAllNotificationsRead: () -> Unit,
    onSaveNotificationPreferences: (NotificationPreferences) -> Unit,
    onOpenPayslip: (Long) -> Unit,
    onClosePayslip: () -> Unit,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var notificationsEnabled by remember(context) {
        mutableStateOf(NotificationPermissionController.canPost(context))
    }
    DisposableEffect(lifecycleOwner, context) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                notificationsEnabled = NotificationPermissionController.canPost(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val requestNotifications: () -> Unit = {
        (context as? Activity)?.let(NotificationPermissionController::request)
        Unit
    }

    Column(modifier.fillMaxSize().imePadding().background(SelfServiceCanvas)) {
        SelfServiceHeader(
            refreshing = state.loading,
            onRefresh = onRefresh,
            onClose = onClose,
        )
        SelfServiceTabs(
            selected = state.section,
            onSelect = onSelectSection,
        )

        state.message?.let { InlineMessage(it, false) }
        state.error?.let { InlineMessage(it, true) }

        val snapshot = state.snapshot
        when {
            snapshot == null && state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            snapshot == null -> EmptySection("حدّث المساحة لتحميل بياناتك")
            else -> SelfServiceContent(
                state = state,
                snapshot = snapshot,
                capabilities = capabilities,
                account = account,
                biometricAvailable = biometricAvailable,
                biometricEnabled = biometricEnabled,
                notificationsEnabled = notificationsEnabled,
                onSelectSection = onSelectSection,
                onTaskAction = onTaskAction,
                onRequestLeave = onRequestLeave,
                onWithdrawLeave = onWithdrawLeave,
                onMarkNotificationRead = onMarkNotificationRead,
                onMarkAllNotificationsRead = onMarkAllNotificationsRead,
                onSaveNotificationPreferences = onSaveNotificationPreferences,
                onOpenPayslip = onOpenPayslip,
                onClosePayslip = onClosePayslip,
                onEnableBiometric = onEnableBiometric,
                onDisableBiometric = onDisableBiometric,
                onEnableNotifications = requestNotifications,
            )
        }
    }
}

@Composable
private fun SelfServiceContent(
    state: SelfServiceUiState,
    snapshot: SelfServiceSnapshot,
    capabilities: SelfServiceCapabilities,
    account: UserIdentity,
    biometricAvailable: Boolean,
    biometricEnabled: Boolean,
    notificationsEnabled: Boolean,
    onSelectSection: (SelfServiceSection) -> Unit,
    onTaskAction: (Long, PersonalTaskAction, String?) -> Unit,
    onRequestLeave: (String, String, String, String?) -> Unit,
    onWithdrawLeave: (Long) -> Unit,
    onMarkNotificationRead: (Long) -> Unit,
    onMarkAllNotificationsRead: () -> Unit,
    onSaveNotificationPreferences: (NotificationPreferences) -> Unit,
    onOpenPayslip: (Long) -> Unit,
    onClosePayslip: () -> Unit,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onEnableNotifications: () -> Unit,
) {
    when (state.section) {
        SelfServiceSection.Profile -> PersonalProfileScreen(
            employee = snapshot.workspace.employee,
            account = account,
            annualLeaveBalance = snapshot.workspace.leaveBalances?.annual,
            biometricAvailable = biometricAvailable,
            biometricEnabled = biometricEnabled,
            notificationsEnabled = notificationsEnabled,
            onBiometricAction = if (biometricEnabled) onDisableBiometric else onEnableBiometric,
            onNotificationAction = if (notificationsEnabled) {
                { onSelectSection(SelfServiceSection.Notifications) }
            } else onEnableNotifications,
        )
        SelfServiceSection.Attendance -> AttendanceHistoryScreen(
            today = snapshot.workspace.todayAttendance,
            entries = snapshot.workspace.attendanceHistory,
        )
        SelfServiceSection.Payroll -> PayrollScreen(
            latestPayroll = snapshot.workspace.payroll,
            payrollHistory = snapshot.payrollHistory,
            payslip = state.selectedPayslip,
            selectedPayslipItemId = state.selectedPayslipItemId,
            busyKey = state.busyKey,
            capabilities = capabilities,
            onOpenPayslip = onOpenPayslip,
            onClosePayslip = onClosePayslip,
        )
        SelfServiceSection.Tasks -> PersonalTasksScreen(
            tasks = snapshot.workspace.tasks,
            canUpdate = capabilities.canUpdateTasks,
            busyKey = state.busyKey,
            onAction = onTaskAction,
        )
        SelfServiceSection.Leaves -> LeaveRequestsScreen(
            requests = snapshot.workspace.leaveRequests,
            annualBalance = snapshot.workspace.leaveBalances?.annual,
            sickBalance = snapshot.workspace.leaveBalances?.sick,
            busyKey = state.busyKey,
            onRequest = onRequestLeave,
            onWithdraw = onWithdrawLeave,
        )
        SelfServiceSection.Notifications -> NotificationCenterScreen(
            notifications = snapshot.notifications.rows,
            unreadCount = snapshot.notifications.unreadCount,
            preferences = snapshot.notificationPreferences,
            busyKey = state.busyKey,
            onRead = onMarkNotificationRead,
            onReadAll = onMarkAllNotificationsRead,
            onSavePreferences = onSaveNotificationPreferences,
        )
    }
}

private val SelfServiceCanvas = Color(0xFFF8F6FD)
private val SelfServiceViolet = Color(0xFF5B36D2)
private val SelfServiceVioletDark = Color(0xFF362087)
private val SelfServiceLavender = Color(0xFFF1EDFF)
private val SelfServiceStroke = Color(0xFFE5DFF3)
private val SelfServiceMuted = Color(0xFF7A7488)

private val PrimarySelfServiceSections = listOf(
    SelfServiceSection.Profile,
    SelfServiceSection.Attendance,
    SelfServiceSection.Payroll,
    SelfServiceSection.Leaves,
    SelfServiceSection.Tasks,
)

@Composable
private fun SelfServiceHeader(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onClose: () -> Unit,
) {
    Surface(
        color = Color.White,
        shape = RoundedCornerShape(topStart = 72.dp, topEnd = 30.dp, bottomEnd = 0.dp, bottomStart = 0.dp),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(top = 10.dp, bottom = 12.dp)) {
            Box(
                Modifier.align(Alignment.CenterHorizontally).width(38.dp).height(4.dp)
                    .clip(RoundedCornerShape(50)).background(SelfServiceStroke),
            )
            Spacer(Modifier.height(10.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.semantics { heading() }) {
                    Text("مساحتي", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text("بيانات حسابك فقط", style = MaterialTheme.typography.bodyMedium, color = SelfServiceMuted)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconButton(
                        onClick = onRefresh,
                        enabled = !refreshing,
                        modifier = Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(SelfServiceLavender),
                    ) { Icon(Icons.Rounded.Refresh, contentDescription = "تحديث", tint = SelfServiceViolet) }
                    IconButton(
                        onClick = onClose,
                        modifier = Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).border(1.dp, SelfServiceStroke, RoundedCornerShape(14.dp)),
                    ) { Icon(Icons.Rounded.Close, contentDescription = "إغلاق", tint = SelfServiceMuted) }
                }
            }
        }
    }
}

@Composable
private fun SelfServiceTabs(
    selected: SelfServiceSection,
    onSelect: (SelfServiceSection) -> Unit,
) {
    val largeText = LocalDensity.current.fontScale >= 1.3f
    val listState = rememberLazyListState()
    LaunchedEffect(selected) {
        val selectedIndex = PrimarySelfServiceSections.indexOf(selected).coerceAtLeast(0)
        listState.animateScrollToItem(selectedIndex)
    }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        color = SelfServiceLavender,
        shape = RoundedCornerShape(24.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, SelfServiceStroke),
    ) {
        LazyRow(
            modifier = Modifier.fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(PrimarySelfServiceSections, key = SelfServiceSection::name) { section ->
                val active = section == selected
                Surface(
                    modifier = Modifier.width(if (largeText) 104.dp else 70.dp)
                        .heightIn(min = if (largeText) 84.dp else 62.dp)
                        .clickable(role = Role.Tab) { onSelect(section) },
                    color = if (active) Color.White else Color.Transparent,
                    shape = RoundedCornerShape(18.dp),
                    shadowElevation = if (active) 4.dp else 0.dp,
                ) {
                    Column(
                        Modifier.padding(horizontal = 2.dp, vertical = 7.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(section.icon, contentDescription = null, tint = if (active) SelfServiceViolet else SelfServiceMuted, modifier = Modifier.size(20.dp))
                        Text(
                            section.label,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (active) SelfServiceVioletDark else SelfServiceMuted,
                            maxLines = if (largeText) 3 else 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PersonalProfileScreen(
    employee: PersonalEmployeeProfile?,
    account: UserIdentity,
    annualLeaveBalance: String?,
    biometricAvailable: Boolean,
    biometricEnabled: Boolean,
    notificationsEnabled: Boolean,
    onBiometricAction: () -> Unit,
    onNotificationAction: () -> Unit,
) {
    val largeText = LocalDensity.current.fontScale >= 1.3f
    LazyColumn(
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Surface(
                color = SelfServiceViolet,
                shape = RoundedCornerShape(topStart = 32.dp, topEnd = 20.dp, bottomEnd = 34.dp, bottomStart = 20.dp),
                shadowElevation = 7.dp,
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(18.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Box(
                        Modifier.size(62.dp).clip(RoundedCornerShape(50))
                            .border(2.dp, Color.White.copy(alpha = .72f), RoundedCornerShape(50)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Rounded.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(34.dp))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            employee?.name ?: account.name,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            employee?.position ?: account.roleLabel,
                            style = MaterialTheme.typography.bodyMedium,
                            color = Color.White.copy(alpha = .78f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        employee?.department?.let {
                            Text(it, style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = .66f))
                        }
                    }
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (largeText) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ProfileInfoCell(
                        label = "البريد",
                        value = employee?.email ?: account.email,
                        modifier = Modifier.fillMaxWidth(),
                        compactValue = true,
                        leftToRight = true,
                    )
                    ProfileInfoCell("الهاتف", employee?.phone, Modifier.fillMaxWidth())
                    ProfileInfoCell("تاريخ المباشرة", employee?.hireDate, Modifier.fillMaxWidth())
                    ProfileInfoCell("رصيد الإجازات", annualLeaveBalance?.let { "$it يوم" }, Modifier.fillMaxWidth())
                } else {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ProfileInfoCell(
                            label = "البريد",
                            value = employee?.email ?: account.email,
                            modifier = Modifier.weight(1f),
                            compactValue = true,
                            leftToRight = true,
                        )
                        ProfileInfoCell("الهاتف", employee?.phone, Modifier.weight(1f))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ProfileInfoCell("تاريخ المباشرة", employee?.hireDate, Modifier.weight(1f))
                        ProfileInfoCell("رصيد الإجازات", annualLeaveBalance?.let { "$it يوم" }, Modifier.weight(1f))
                    }
                }
            }
        }
        if (employee == null) item {
            Surface(
                color = SelfServiceLavender,
                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 16.dp, bottomEnd = 24.dp, bottomStart = 16.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, SelfServiceStroke),
            ) {
                Text(
                    "الملف الوظيفي غير مرتبط بالحساب",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    color = SelfServiceVioletDark,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        item {
            DeviceActionCard(
                icon = Icons.Rounded.Fingerprint,
                title = "بصمة الجهاز",
                subtitle = when {
                    !biometricAvailable -> "غير متاحة"
                    biometricEnabled -> "مضافة لهذا الحساب"
                    else -> "غير مضافة"
                },
                action = when {
                    !biometricAvailable -> null
                    biometricEnabled -> "إيقاف"
                    else -> "إضافة"
                },
                onClick = onBiometricAction,
            )
        }
        item {
            DeviceActionCard(
                icon = Icons.Rounded.Notifications,
                title = "إشعارات هذا الجهاز",
                subtitle = if (notificationsEnabled) "مفعّلة" else "غير مفعّلة",
                action = if (notificationsEnabled) "إدارة" else "تفعيل",
                onClick = onNotificationAction,
            )
        }
        item {
            Surface(
                color = Color.White,
                shape = RoundedCornerShape(topStart = 28.dp, topEnd = 18.dp, bottomEnd = 28.dp, bottomStart = 18.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, SelfServiceStroke),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("ما يصل إلى جهازك", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text("المهام والرواتب والدوام والإجازات", style = MaterialTheme.typography.bodyMedium, color = SelfServiceMuted)
                    }
                    Icon(Icons.Rounded.ChevronLeft, contentDescription = null, tint = SelfServiceViolet)
                }
            }
        }
    }
}

@Composable
private fun ProfileInfoCell(
    label: String,
    value: String?,
    modifier: Modifier = Modifier,
    compactValue: Boolean = false,
    leftToRight: Boolean = false,
) {
    val displayedValue = value
        ?.takeIf(String::isNotBlank)
        ?.let { if (leftToRight && '@' in it) it.replace("@", "@\u200B") else it }
        ?: "غير مسجل"
    Surface(
        modifier = modifier.heightIn(min = 78.dp),
        color = Color.White,
        shape = RoundedCornerShape(topStart = 22.dp, topEnd = 14.dp, bottomEnd = 22.dp, bottomStart = 14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, SelfServiceStroke),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = SelfServiceMuted)
            Text(
                displayedValue,
                modifier = Modifier.fillMaxWidth(),
                style = if (compactValue) {
                    MaterialTheme.typography.bodyMedium.copy(
                        textDirection = if (leftToRight) TextDirection.Ltr else TextDirection.ContentOrRtl,
                    )
                } else {
                    MaterialTheme.typography.titleMedium
                },
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun DeviceActionCard(
    icon: ImageVector,
    title: String,
    subtitle: String,
    action: String?,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color.White,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 18.dp, bottomEnd = 28.dp, bottomStart = 18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, SelfServiceStroke),
        shadowElevation = 2.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(48.dp).clip(RoundedCornerShape(17.dp)).background(SelfServiceLavender),
                contentAlignment = Alignment.Center,
            ) { Icon(icon, contentDescription = null, tint = SelfServiceViolet, modifier = Modifier.size(25.dp)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = SelfServiceMuted)
            }
            action?.let {
                Button(
                    onClick = onClick,
                    colors = ButtonDefaults.buttonColors(containerColor = SelfServiceViolet, contentColor = Color.White),
                    shape = RoundedCornerShape(15.dp),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                ) { Text(it, style = MaterialTheme.typography.labelLarge) }
            }
        }
    }
}

@Composable
fun AttendanceHistoryScreen(today: AttendanceEntry?, entries: List<AttendanceEntry>) {
    val previousEntries = if (today == null) entries else entries.filterNot { it.date == today.date }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { ReadOnlyNotice("السجل متزامن من جهاز البصمة داخل الشركة") }
        today?.let { entry ->
            item {
                SectionCard {
                    Text("دوام اليوم", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    AttendanceValues(entry)
                }
            }
        }
        if (previousEntries.isEmpty()) item { EmptySection("لا يوجد سجل حضور سابق متاح") }
        items(previousEntries, key = { it.id }) { entry ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(entry.date, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(attendanceLabel(entry.status), color = MaterialTheme.colorScheme.primary)
                    }
                    if (entry.needsReview) StatusText("بحاجة للمراجعة", MaterialTheme.colorScheme.error)
                }
                AttendanceValues(entry)
            }
        }
    }
}

@Composable
fun PayrollScreen(
    latestPayroll: PersonalPayroll?,
    payrollHistory: List<PersonalPayroll>,
    payslip: PersonalPayslip?,
    selectedPayslipItemId: Long?,
    busyKey: String?,
    capabilities: SelfServiceCapabilities,
    onOpenPayslip: (Long) -> Unit,
    onClosePayslip: () -> Unit,
) {
    if (selectedPayslipItemId != null) {
        LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClosePayslip, enabled = busyKey == null) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "عودة إلى سجل الرواتب")
                    }
                    Column(Modifier.weight(1f)) {
                        Text("تفاصيل القسيمة", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Text("عرض شخصي من سجل الرواتب المعتمد", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (payslip == null) {
                item { Box(Modifier.fillMaxWidth().padding(42.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            } else {
                item {
                    SectionCard {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(payslip.period, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                            StatusText(payrollStatusLabel(payslip.status), MaterialTheme.colorScheme.primary)
                        }
                        payslip.paidAt?.let { ProfileValue("تاريخ الصرف", it) }
                        payslip.hours?.let { ProfileValue("الساعات المحتسبة", it) }
                        ProfileValue("نمط الأجر", if (payslip.payType == "hourly") "بالساعة" else "شهري")
                    }
                }
                item {
                    SectionCard {
                        Text("الاستحقاقات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        MoneyRow("الإجمالي", payslip.gross)
                        MoneyRow("البدلات", payslip.allowances)
                        MoneyRow("العمل الإضافي", payslip.overtime)
                        MoneyRow("العمولة", payslip.commission)
                    }
                }
                item {
                    SectionCard {
                        Text("الاستقطاعات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        MoneyRow("إجمالي الاستقطاعات", payslip.deductions)
                        MoneyRow("سداد السلفة", payslip.advanceDeduction)
                        MoneyRow("الضمان الاجتماعي", payslip.socialSecurityEmployee)
                        MoneyRow("ضريبة الدخل", payslip.incomeTax)
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        MoneyRow("صافي الراتب", payslip.net, emphasized = true)
                        payslip.note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
        return
    }

    val rows = payrollHistory.ifEmpty { listOfNotNull(latestPayroll?.takeIf { it.itemId > 0 }) }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            ReadOnlyNotice(
                if (capabilities.payrollHistoryAvailable && capabilities.payslipDetailAvailable) {
                    "سجل رواتبك وقسائمك الشخصية فقط"
                } else {
                    "بيانات راتبك الشخصية للعرض فقط"
                },
            )
        }
        if (rows.isEmpty()) {
            item { EmptySection("لا يوجد مسير راتب معتمد متاح") }
        }
        items(rows, key = { it.itemId }) { payroll ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(payroll.period, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        payroll.paidAt?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    StatusText(payrollStatusLabel(payroll.status), MaterialTheme.colorScheme.primary)
                }
                MoneyRow("الإجمالي", payroll.gross)
                MoneyRow("الاستقطاعات", payroll.deductions)
                MoneyRow("الصافي", payroll.net, emphasized = true)
                OutlinedButton(
                    onClick = { onOpenPayslip(payroll.itemId) },
                    enabled = busyKey == null && payroll.itemId > 0,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("عرض تفاصيل القسيمة") }
            }
        }
    }
}

@Composable
fun PersonalTasksScreen(
    tasks: List<PersonalTask>,
    canUpdate: Boolean,
    busyKey: String?,
    onAction: (Long, PersonalTaskAction, String?) -> Unit,
) {
    if (tasks.isEmpty()) return EmptySection("لا توجد مهام نشطة")
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!canUpdate) item { ReadOnlyNotice("المهام متاحة للعرض وفق صلاحية الحساب") }
        items(tasks, key = { it.id }) { task ->
            var note by rememberSaveable(task.id) { mutableStateOf("") }
            val actions = task.availableActions(canUpdate)
            SectionCard {
                Text(task.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(task.number, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusText(priorityLabel(task.priority), MaterialTheme.colorScheme.primary)
                    StatusText(taskStatusLabel(task.status), MaterialTheme.colorScheme.secondary)
                }
                if (actions.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    if (PersonalTaskAction.Comment in actions || PersonalTaskAction.Wait in actions || PersonalTaskAction.Resolve in actions) {
                        OutlinedTextField(
                            value = note,
                            onValueChange = { note = it },
                            label = { Text("ملاحظة") },
                            modifier = Modifier.fillMaxWidth(),
                            minLines = 2,
                        )
                    }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(actions.toList(), key = { it.name }) { action ->
                            TextButton(
                                onClick = { onAction(task.id, action, note.takeIf(String::isNotBlank)) },
                                enabled = busyKey == null && !(action == PersonalTaskAction.Comment && note.isBlank()),
                            ) {
                                if (action == PersonalTaskAction.Comment) Icon(Icons.AutoMirrored.Rounded.Comment, null)
                                Text(action.label)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun LeaveRequestsScreen(
    requests: List<PersonalLeaveRequest>,
    annualBalance: String?,
    sickBalance: String?,
    busyKey: String?,
    onRequest: (String, String, String, String?) -> Unit,
    onWithdraw: (Long) -> Unit,
) {
    var leaveType by rememberSaveable { mutableStateOf(LeaveTypes.first()) }
    var fromDate by rememberSaveable { mutableStateOf("") }
    var toDate by rememberSaveable { mutableStateOf("") }
    var reason by rememberSaveable { mutableStateOf("") }
    var confirmRequest by rememberSaveable { mutableStateOf(false) }
    var withdrawRequestId by rememberSaveable { mutableStateOf<Long?>(null) }
    val leaveIssue = SelfServicePolicies.validateLeaveRequest(leaveType, fromDate, toDate)
    val touchedDates = fromDate.isNotBlank() || toDate.isNotBlank()
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard {
                Text("طلب إجازة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(LeaveTypes, key = { it }) { type ->
                        FilterChip(selected = leaveType == type, onClick = { leaveType = type }, label = { Text(type) })
                    }
                }
                ArabicDatePicker(fromDate, { fromDate = it }, "من")
                ArabicDatePicker(toDate, { toDate = it }, "إلى")
                OutlinedTextField(reason, { reason = it }, label = { Text("السبب (اختياري)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                if (touchedDates && leaveIssue != null) {
                    Text(leaveIssue.userMessage, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Button(
                    onClick = { confirmRequest = true },
                    enabled = busyKey == null && leaveIssue == null,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("إرسال للمراجعة") }
            }
        }
        if (annualBalance != null || sickBalance != null) item {
            SectionCard {
                Text("الأرصدة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround) {
                    Value("سنوية", annualBalance ?: "—")
                    Value("مرضية", sickBalance ?: "—")
                }
            }
        }
        items(requests, key = { it.id }) { request ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(request.leaveType, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text("${request.fromDate} — ${request.toDate}")
                    }
                    StatusText(leaveStatusLabel(request.status), MaterialTheme.colorScheme.primary)
                }
                request.reason?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (request.canWithdraw) {
                    OutlinedButton(
                        onClick = { withdrawRequestId = request.id },
                        enabled = busyKey == null,
                    ) { Text("سحب الطلب") }
                }
            }
        }
    }
    if (confirmRequest) {
        AlertDialog(
            onDismissRequest = { confirmRequest = false },
            title = { Text("تأكيد إرسال طلب الإجازة") },
            text = { Text("$leaveType من $fromDate إلى $toDate. سيُرسل الطلب لمسار المراجعة.") },
            confirmButton = {
                Button(onClick = {
                    confirmRequest = false
                    onRequest(leaveType, fromDate, toDate, reason.takeIf(String::isNotBlank))
                }) { Text("إرسال") }
            },
            dismissButton = { TextButton(onClick = { confirmRequest = false }) { Text("إلغاء") } },
        )
    }
    withdrawRequestId?.let { requestId ->
        AlertDialog(
            onDismissRequest = { withdrawRequestId = null },
            title = { Text("تأكيد سحب الطلب") },
            text = { Text("سيتم سحب طلب الإجازة من مسار المراجعة.") },
            confirmButton = {
                Button(onClick = { withdrawRequestId = null; onWithdraw(requestId) }) { Text("سحب الطلب") }
            },
            dismissButton = { TextButton(onClick = { withdrawRequestId = null }) { Text("إلغاء") } },
        )
    }
}

@Composable
fun NotificationCenterScreen(
    notifications: List<PersonalNotification>,
    unreadCount: Int,
    preferences: NotificationPreferences,
    busyKey: String?,
    onRead: (Long) -> Unit,
    onReadAll: () -> Unit,
    onSavePreferences: (NotificationPreferences) -> Unit,
) {
    var quietStart by rememberSaveable(preferences.quietHoursStart) { mutableStateOf(preferences.quietHoursStart.orEmpty()) }
    var quietEnd by rememberSaveable(preferences.quietHoursEnd) { mutableStateOf(preferences.quietHoursEnd.orEmpty()) }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("التفضيلات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    if (unreadCount > 0) TextButton(onClick = onReadAll, enabled = busyKey == null) { Text("قراءة الكل") }
                }
                PreferenceSwitch("إسناد المهام", preferences.taskAssigned, busyKey == null) { onSavePreferences(preferences.copy(taskAssigned = it)) }
                PreferenceSwitch("جاهزية الراتب", preferences.payrollReady, busyKey == null) { onSavePreferences(preferences.copy(payrollReady = it)) }
                PreferenceSwitch("تحديثات الدوام", preferences.attendance, busyKey == null) { onSavePreferences(preferences.copy(attendance = it)) }
                PreferenceSwitch("حالة الإجازة", preferences.leaveStatus, busyKey == null) { onSavePreferences(preferences.copy(leaveStatus = it)) }
                PreferenceSwitch("الموافقات", preferences.approvals, busyKey == null) { onSavePreferences(preferences.copy(approvals = it)) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(quietStart, { quietStart = it }, label = { Text("بدء الهدوء HH:mm") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(quietEnd, { quietEnd = it }, label = { Text("نهاية الهدوء HH:mm") }, modifier = Modifier.weight(1f))
                }
                Button(
                    onClick = { onSavePreferences(preferences.copy(quietHoursStart = quietStart.ifBlank { null }, quietHoursEnd = quietEnd.ifBlank { null })) },
                    enabled = busyKey == null,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("حفظ ساعات الهدوء") }
            }
        }
        if (notifications.isEmpty()) item { EmptySection("لا توجد تنبيهات") }
        items(notifications, key = { it.id }) { notification ->
            NotificationCard(notification, busyKey == null, onRead)
        }
    }
}

@Composable
private fun NotificationCard(item: PersonalNotification, enabled: Boolean, onRead: (Long) -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (item.isUnread) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .38f) else MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(item.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                if (item.requiresAction) StatusText("إجراء مطلوب", MaterialTheme.colorScheme.error)
            }
            Text(item.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
            item.createdAt?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
            if (item.isUnread) TextButton(onClick = { onRead(item.id) }, enabled = enabled) { Text("تعليم كمقروء") }
        }
    }
}

@Composable
private fun PreferenceSwitch(
    label: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
private fun SectionCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 18.dp, bottomEnd = 28.dp, bottomStart = 18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

@Composable
private fun InlineMessage(text: String, error: Boolean) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().background(
            if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
        ).padding(horizontal = 18.dp, vertical = 10.dp),
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

@Composable
private fun ReadOnlyNotice(text: String) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(18.dp)).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.DoneAll, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(text, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

@Composable
private fun EmptySection(text: String) {
    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Value(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AttendanceValues(entry: AttendanceEntry) {
    Spacer(Modifier.height(4.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Value("الدخول", displayTime(entry.checkIn))
        Value("الخروج", displayTime(entry.checkOut))
        Value("الساعات", entry.hours ?: "—")
    }
    if (entry.needsReview) {
        Text("هذا السجل يحتاج مراجعة الموارد البشرية", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun ProfileValue(label: String, value: String?) {
    if (value == null) return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun StatusText(text: String, color: Color) {
    Text(
        text,
        modifier = Modifier.background(color.copy(alpha = .11f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 5.dp),
        color = color,
        style = MaterialTheme.typography.labelMedium,
    )
}

@Composable
private fun MoneyRow(label: String, value: String, emphasized: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            formatMoney(value),
            style = if (emphasized) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = if (emphasized) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
    }
}

private val SelfServiceSection.label: String
    get() = when (this) {
        SelfServiceSection.Profile -> "ملفي"
        SelfServiceSection.Attendance -> "الحضور"
        SelfServiceSection.Payroll -> "الراتب"
        SelfServiceSection.Tasks -> "المهام"
        SelfServiceSection.Leaves -> "الإجازات"
        SelfServiceSection.Notifications -> "التنبيهات"
    }

private val SelfServiceSection.icon: ImageVector
    get() = when (this) {
        SelfServiceSection.Profile -> Icons.Rounded.Person
        SelfServiceSection.Attendance -> Icons.Rounded.AccessTime
        SelfServiceSection.Payroll -> Icons.Rounded.Payments
        SelfServiceSection.Tasks -> Icons.AutoMirrored.Rounded.Assignment
        SelfServiceSection.Leaves -> Icons.Rounded.CalendarMonth
        SelfServiceSection.Notifications -> Icons.Rounded.Notifications
    }

private val PersonalTaskAction.label: String
    get() = when (this) {
        PersonalTaskAction.Claim -> "استلام"
        PersonalTaskAction.Wait -> "انتظار"
        PersonalTaskAction.Resume -> "استئناف"
        PersonalTaskAction.Resolve -> "إنجاز"
        PersonalTaskAction.Comment -> "تعليق"
    }

private val numberFormat = NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ-u-nu-latn")).apply {
    maximumFractionDigits = 0
}
private fun formatMoney(raw: String): String = raw.toDoubleOrNull()?.let { "${numberFormat.format(it)} د.ع" } ?: raw
private fun displayTime(value: String?): String = value?.let {
    if ('T' in it) it.substringAfter('T').take(5) else it
} ?: "—"
private fun attendanceLabel(value: String?) = when (value?.uppercase()) {
    "PRESENT" -> "حاضر"
    "ABSENT" -> "غائب"
    "LATE" -> "متأخر"
    "LEAVE" -> "إجازة"
    else -> value ?: "غير مسجل"
}
private fun payrollStatusLabel(value: String) = when (value) {
    "approved" -> "معتمد"
    "paid" -> "مصروف"
    else -> value
}
private fun priorityLabel(value: String) = when (value) {
    "URGENT" -> "عاجلة"
    "HIGH" -> "عالية"
    "LOW" -> "منخفضة"
    else -> "اعتيادية"
}
private fun taskStatusLabel(value: String) = when (value) {
    "NEW" -> "جديدة"
    "IN_PROGRESS" -> "قيد التنفيذ"
    "WAITING_CUSTOMER" -> "بانتظار العميل"
    "RESOLVED" -> "منجزة"
    else -> value
}
private fun leaveStatusLabel(value: String) = when (value) {
    "pending" -> "قيد الموافقة"
    "approved" -> "موافق عليها"
    "rejected" -> "مرفوضة"
    "withdrawn" -> "مسحوبة"
    else -> value
}
private fun employmentStatusLabel(value: String) = when (value.lowercase()) {
    "active" -> "على رأس العمل"
    "inactive" -> "غير نشط"
    "terminated" -> "منتهية خدمته"
    else -> value
}

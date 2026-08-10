package online.alarabiya.superapp.feature.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AdminPanelSettings
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Business
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.VpnKey
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import online.alarabiya.superapp.model.admin.AccessLevel
import online.alarabiya.superapp.model.admin.AdminAccessPolicy
import online.alarabiya.superapp.model.admin.AdminAuditEvent
import online.alarabiya.superapp.model.admin.AdminBranch
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminSection
import online.alarabiya.superapp.model.admin.AdminUser
import online.alarabiya.superapp.model.admin.AdminUserSession
import online.alarabiya.superapp.ui.rtlIsolate
import online.alarabiya.superapp.model.admin.CreateAdminRoleCommand
import online.alarabiya.superapp.model.admin.CreateAdminUserCommand
import online.alarabiya.superapp.model.admin.RoleAssignment
import online.alarabiya.superapp.model.admin.UpdateAdminRoleCommand
import online.alarabiya.superapp.model.admin.UpdateAdminUserCommand
import online.alarabiya.superapp.model.admin.UserPermissionProfile
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.Stroke

private sealed interface AdminDialogState {
    data object CreateUser : AdminDialogState
    data class EditUser(val user: AdminUser) : AdminDialogState
    data class AssignRole(val user: AdminUser) : AdminDialogState
    data class UserStatus(val user: AdminUser, val active: Boolean) : AdminDialogState
    data class Permissions(val user: AdminUser) : AdminDialogState
    data class ResetPassword(val user: AdminUser) : AdminDialogState
    data class AccountSecurity(val user: AdminUser) : AdminDialogState
    data object CreateRole : AdminDialogState
    data class EditRole(val role: AdminRole) : AdminDialogState
    data class RoleStatus(val role: AdminRole, val active: Boolean) : AdminDialogState
}

@Composable
fun AdminRoute(viewModel: AdminViewModel, modifier: Modifier = Modifier) {
    AdminScreen(
        state = viewModel.state,
        policy = viewModel.policy,
        onSection = viewModel::setSection,
        onQuery = viewModel::setQuery,
        onSearch = viewModel::applySearch,
        onIncludeInactive = viewModel::setIncludeInactive,
        onSelectUser = viewModel::selectUser,
        onSelectRole = viewModel::selectRole,
        onRefresh = viewModel::refresh,
        onLoadMoreAudit = viewModel::loadMoreAudit,
        onRequestPassword = viewModel::requestTemporaryPassword,
        onConsumePassword = viewModel::consumeTemporaryPassword,
        onCreateUser = viewModel::createUser,
        onUpdateUser = viewModel::updateUser,
        onAssignRole = viewModel::assignRole,
        onSetUserActive = viewModel::setUserActive,
        onLoadPermissions = viewModel::loadUserPermissions,
        onClearPermissions = viewModel::clearUserPermissions,
        onUpdatePermissions = viewModel::updateUserPermissions,
        onResetPassword = viewModel::resetPassword,
        onLoadAccountSecurity = viewModel::loadAccountSecurity,
        onClearAccountSecurity = viewModel::clearAccountSecurity,
        onRevokeSession = viewModel::revokeSession,
        onRevokeAllSessions = viewModel::revokeAllSessions,
        onResetTwoFactor = viewModel::resetTwoFactor,
        onCreateRole = viewModel::createRole,
        onUpdateRole = viewModel::updateRole,
        onSetRoleActive = viewModel::setRoleActive,
        onDismissMessage = viewModel::clearMessage,
        modifier = modifier,
    )
}

@Composable
fun AdminScreen(
    state: AdminUiState,
    policy: AdminAccessPolicy,
    onSection: (AdminSection) -> Unit,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onIncludeInactive: (Boolean) -> Unit,
    onSelectUser: (Long?) -> Unit,
    onSelectRole: (String?) -> Unit,
    onRefresh: () -> Unit,
    onLoadMoreAudit: () -> Unit,
    onRequestPassword: () -> Unit,
    onConsumePassword: () -> Unit,
    onCreateUser: (CreateAdminUserCommand) -> Unit,
    onUpdateUser: (UpdateAdminUserCommand) -> Unit,
    onAssignRole: (AdminUser, RoleAssignment) -> Unit,
    onSetUserActive: (AdminUser, Boolean) -> Unit,
    onLoadPermissions: (AdminUser) -> Unit,
    onClearPermissions: () -> Unit,
    onUpdatePermissions: (AdminUser, Map<String, AccessLevel>) -> Unit,
    onResetPassword: (AdminUser, String) -> Unit,
    onLoadAccountSecurity: (AdminUser) -> Unit,
    onClearAccountSecurity: () -> Unit,
    onRevokeSession: (AdminUser, Long) -> Unit,
    onRevokeAllSessions: (AdminUser) -> Unit,
    onResetTwoFactor: (AdminUser) -> Unit,
    onCreateRole: (CreateAdminRoleCommand) -> Unit,
    onUpdateRole: (AdminRole, UpdateAdminRoleCommand) -> Unit,
    onSetRoleActive: (AdminRole, Boolean) -> Unit,
    onDismissMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var dialog by remember { mutableStateOf<AdminDialogState?>(null) }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(containerColor = Canvas, modifier = modifier.fillMaxSize()) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                AdminHeader(state, onRefresh, policy.canOpen)
                if (!policy.canOpen) {
                    AccessDenied()
                } else if (!state.overviewLoaded) {
                    if (state.loading || state.refreshing || state.busyKey != null) LoadingPane(Modifier.fillMaxSize())
                    else AdminInitialLoadFailure(state.error, state.notice, onRefresh)
                } else {
                    AdminTabs(state.section, onSection)
                    state.error?.let { MessageBanner(it, true, onDismissMessage) }
                    state.notice?.let { MessageBanner(it, false, onDismissMessage) }
                    BoxWithConstraints(Modifier.fillMaxSize()) {
                        val tablet = maxWidth >= 840.dp
                        when (state.section) {
                            AdminSection.USERS -> UsersWorkspace(
                                state, tablet, onQuery, onSearch, onIncludeInactive, onSelectUser,
                                onCreate = {
                                    onRequestPassword()
                                    dialog = AdminDialogState.CreateUser
                                },
                                onEdit = { dialog = AdminDialogState.EditUser(it) },
                                onAssign = { dialog = AdminDialogState.AssignRole(it) },
                                onStatus = { user, active -> dialog = AdminDialogState.UserStatus(user, active) },
                                policy = policy,
                                onPermissions = { user ->
                                    onLoadPermissions(user)
                                    dialog = AdminDialogState.Permissions(user)
                                },
                                onResetPassword = { user ->
                                    onRequestPassword()
                                    dialog = AdminDialogState.ResetPassword(user)
                                },
                                onAccountSecurity = { user ->
                                    onLoadAccountSecurity(user)
                                    dialog = AdminDialogState.AccountSecurity(user)
                                },
                            )
                            AdminSection.ROLES -> RolesWorkspace(
                                state, tablet, onSelectRole,
                                onCreate = { dialog = AdminDialogState.CreateRole },
                                onEdit = { dialog = AdminDialogState.EditRole(it) },
                                onStatus = { role, active -> dialog = AdminDialogState.RoleStatus(role, active) },
                            )
                            AdminSection.AUDIT -> AuditWorkspace(state, onLoadMoreAudit)
                        }
                    }
                }
            }
        }

        when (val current = dialog) {
            AdminDialogState.CreateUser -> UserEditorDialog(
                user = null,
                password = state.temporaryPassword,
                passwordLoading = state.passwordLoading,
                roles = state.roles,
                branches = state.overview?.branches.orEmpty(),
                busy = state.busyKey != null,
                onDismiss = { onConsumePassword(); dialog = null },
                onRefreshPassword = onRequestPassword,
                onCreate = { command ->
                    onCreateUser(command)
                    onConsumePassword()
                    dialog = null
                },
                onUpdate = {},
            )
            is AdminDialogState.EditUser -> UserEditorDialog(
                user = current.user,
                password = null,
                passwordLoading = false,
                roles = state.roles,
                branches = state.overview?.branches.orEmpty(),
                busy = state.busyKey != null,
                onDismiss = { dialog = null },
                onRefreshPassword = {},
                onCreate = {},
                onUpdate = { onUpdateUser(it); dialog = null },
            )
            is AdminDialogState.AssignRole -> AssignmentDialog(
                user = current.user,
                roles = state.roles,
                busy = state.busyKey != null,
                onDismiss = { dialog = null },
                onConfirm = { onAssignRole(current.user, it); dialog = null },
            )
            is AdminDialogState.UserStatus -> ConfirmDialog(
                title = if (current.active) "تفعيل الحساب" else "تعطيل الحساب",
                message = if (current.active) "سيتمكن ${current.user.name} من تسجيل الدخول مجدداً."
                else "ستنتهي صلاحية جلسات ${current.user.name} ولن يستطيع تسجيل الدخول.",
                confirm = if (current.active) "تفعيل" else "تعطيل",
                destructive = !current.active,
                onDismiss = { dialog = null },
                onConfirm = { onSetUserActive(current.user, current.active); dialog = null },
            )
            is AdminDialogState.Permissions -> PermissionOverridesDialog(
                user = current.user,
                profile = state.permissionProfile,
                loading = state.permissionLoading,
                busy = state.busyKey != null,
                onDismiss = { onClearPermissions(); dialog = null },
                onConfirm = { overrides ->
                    onUpdatePermissions(current.user, overrides)
                    dialog = null
                },
            )
            is AdminDialogState.ResetPassword -> ResetPasswordDialog(
                user = current.user,
                password = state.temporaryPassword,
                loading = state.passwordLoading,
                busy = state.busyKey != null,
                onRefresh = onRequestPassword,
                onDismiss = { onConsumePassword(); dialog = null },
                onConfirm = { password ->
                    onResetPassword(current.user, password)
                    onConsumePassword()
                    dialog = null
                },
            )
            is AdminDialogState.AccountSecurity -> AccountSecurityDialog(
                user = current.user,
                sessions = state.incidentSessions,
                loading = state.incidentLoading,
                fresh = state.incidentFresh,
                busy = state.busyKey != null,
                error = state.error,
                notice = state.notice,
                onDismiss = { onClearAccountSecurity(); dialog = null },
                onRetry = { onLoadAccountSecurity(current.user) },
                onRevokeSession = { onRevokeSession(current.user, it) },
                onRevokeAll = { onRevokeAllSessions(current.user) },
                onResetTwoFactor = { onResetTwoFactor(current.user) },
            )
            AdminDialogState.CreateRole -> RoleEditorDialog(
                role = null,
                roles = state.roles,
                busy = state.busyKey != null,
                onDismiss = { dialog = null },
                onCreate = { onCreateRole(it); dialog = null },
                onUpdate = {},
            )
            is AdminDialogState.EditRole -> RoleEditorDialog(
                role = current.role,
                roles = state.roles,
                busy = state.busyKey != null,
                onDismiss = { dialog = null },
                onCreate = {},
                onUpdate = { onUpdateRole(current.role, it); dialog = null },
            )
            is AdminDialogState.RoleStatus -> ConfirmDialog(
                title = if (current.active) "تفعيل الدور" else "تعطيل الدور",
                message = if (current.active) "سيصبح الدور متاحاً للإسناد."
                else "سيُحجب الدور وتُبطل جلسات أصحابه. يجب ألا يكون مسنداً لحسابات نشطة.",
                confirm = if (current.active) "تفعيل" else "تعطيل",
                destructive = !current.active,
                onDismiss = { dialog = null },
                onConfirm = { onSetRoleActive(current.role, current.active); dialog = null },
            )
            null -> Unit
        }
    }
}

@Composable
private fun AdminHeader(state: AdminUiState, onRefresh: () -> Unit, canOpen: Boolean) {
    Surface(
        color = EmeraldDark,
        contentColor = Color.White,
        shape = RoundedCornerShape(bottomStart = 46.dp, bottomEnd = 18.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(52.dp).clip(RoundedCornerShape(18.dp)).background(Color.White.copy(.12f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.AdminPanelSettings, null, Modifier.size(29.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("الحوكمة وإدارة الوصول", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
                Text(
                    state.overview?.takeIf { state.overviewLoaded }
                        ?.let { "${it.totalUsers} حساب • ${it.roles.count { role -> role.isCustom }} أدوار مخصّصة" }
                        ?: "إدارة الحسابات والصلاحيات",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(.72f),
                )
            }
            IconButton(onClick = onRefresh, enabled = canOpen && !state.loading && !state.refreshing && state.busyKey == null) {
                if (state.loading || state.refreshing) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
                else Icon(Icons.Rounded.Refresh, "تحديث")
            }
        }
    }
}

@Composable
private fun AdminTabs(selected: AdminSection, onSelect: (AdminSection) -> Unit) {
    val listState = rememberLazyListState()
    LaunchedEffect(selected) {
        listState.animateScrollToItem(AdminSection.entries.indexOf(selected).coerceAtLeast(0))
    }
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        state = listState,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(AdminSection.entries, key = AdminSection::name) { section ->
            val icon = when (section) {
                AdminSection.USERS -> Icons.Rounded.People
                AdminSection.ROLES -> Icons.Rounded.Security
                AdminSection.AUDIT -> Icons.Rounded.History
            }
            FilterChip(
                selected = selected == section,
                onClick = { onSelect(section) },
                label = { Text(section.label, maxLines = 1) },
                leadingIcon = { Icon(icon, null, Modifier.size(18.dp)) },
                modifier = Modifier.widthIn(min = 132.dp),
            )
        }
    }
}

@Composable
private fun UsersWorkspace(
    state: AdminUiState,
    tablet: Boolean,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onIncludeInactive: (Boolean) -> Unit,
    onSelect: (Long?) -> Unit,
    onCreate: () -> Unit,
    onEdit: (AdminUser) -> Unit,
    onAssign: (AdminUser) -> Unit,
    onStatus: (AdminUser, Boolean) -> Unit,
    policy: AdminAccessPolicy,
    onPermissions: (AdminUser) -> Unit,
    onResetPassword: (AdminUser) -> Unit,
    onAccountSecurity: (AdminUser) -> Unit,
) {
    if (tablet) {
        Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            UserDirectory(state, onQuery, onSearch, onIncludeInactive, onSelect, onCreate, Modifier.weight(.46f))
            AdminDetailSurface(Modifier.weight(.54f)) {
                state.selectedUser?.let { UserDetail(it, state, policy, onEdit, onAssign, onStatus, onPermissions, onResetPassword, onAccountSecurity) }
                    ?: EmptySelection("اختر حساباً لعرض صلاحياته وإجراءاته", Icons.Rounded.People)
            }
        }
    } else if (state.selectedUser != null) {
        val selectedUser = requireNotNull(state.selectedUser)
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
            TextButton(onClick = { onSelect(null) }) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null)
                Text("كل المستخدمين")
            }
            AdminDetailSurface(Modifier.fillMaxSize()) {
                UserDetail(selectedUser, state, policy, onEdit, onAssign, onStatus, onPermissions, onResetPassword, onAccountSecurity)
            }
        }
    } else {
        UserDirectory(state, onQuery, onSearch, onIncludeInactive, onSelect, onCreate, Modifier.fillMaxSize().padding(horizontal = 16.dp))
    }
}

@Composable
private fun UserDirectory(
    state: AdminUiState,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onIncludeInactive: (Boolean) -> Unit,
    onSelect: (Long) -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = state.query,
            onValueChange = onQuery,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("بحث بالاسم أو المعرّف") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            trailingIcon = { TextButton(onClick = onSearch) { Text("بحث") } },
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilterChip(
                selected = state.includeInactive,
                onClick = { onIncludeInactive(!state.includeInactive) },
                label = { Text("إظهار المعطّلة") },
            )
            Spacer(Modifier.weight(1f))
            Button(onClick = onCreate, shape = RoundedCornerShape(16.dp)) {
                Icon(Icons.Rounded.PersonAdd, null)
                Spacer(Modifier.width(7.dp))
                Text("حساب جديد")
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            items(state.users, key = { it.id }) { user ->
                UserRow(user, selected = state.selectedUserId == user.id, onClick = { onSelect(user.id) })
            }
            if (state.users.isEmpty()) item { EmptySelection("لا توجد حسابات مطابقة", Icons.Rounded.People) }
        }
    }
}

@Composable
private fun UserRow(user: AdminUser, selected: Boolean, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 15.dp, bottomStart = 15.dp, bottomEnd = 24.dp),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(user.name, user.isActive)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(user.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (user.isOwner) {
                        Spacer(Modifier.width(6.dp))
                        Icon(Icons.Rounded.Shield, "مالك النظام", Modifier.size(17.dp), tint = Orange)
                    }
                }
                Text(user.identifier, style = MaterialTheme.typography.bodySmall, color = MutedInk, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(user.displayRole, style = MaterialTheme.typography.labelMedium, color = EmeraldDark)
            }
            StatusPill(user.isActive)
        }
    }
}

@Composable
private fun UserDetail(
    user: AdminUser,
    state: AdminUiState,
    policy: AdminAccessPolicy,
    onEdit: (AdminUser) -> Unit,
    onAssign: (AdminUser) -> Unit,
    onStatus: (AdminUser, Boolean) -> Unit,
    onPermissions: (AdminUser) -> Unit,
    onResetPassword: (AdminUser) -> Unit,
    onAccountSecurity: (AdminUser) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize().padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(bottom = 20.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(user.name, user.isActive, 70)
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(user.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(user.identifier, color = MutedInk)
                    Text(user.displayRole, color = EmeraldDark, style = MaterialTheme.typography.titleMedium)
                }
                StatusPill(user.isActive)
            }
        }
        item {
            DetailCard("الهوية التنظيمية", Icons.Rounded.Business) {
                DetailValue("المسمّى", user.jobTitle ?: "غير محدد")
                DetailValue("الفرع", state.overview?.branches?.firstOrNull { it.id == user.branchId }?.name ?: "كل الفروع / غير محدد")
                DetailValue("القسم التشغيلي", user.effectiveStation ?: "لا يوجد")
            }
        }
        item {
            DetailCard("ضوابط الوصول", Icons.Rounded.Security) {
                DetailValue("الدور الفعلي", user.displayRole)
                DetailValue("تغيير كلمة المرور", if (user.mustChangePassword) "مطلوب عند الدخول" else "مكتمل")
                DetailValue("آخر دخول", user.lastSignedIn ?: "لا يوجد")
                if (user.isOwner) Text("صفة المالك محمية ولا تُعدّل من تطبيق الجوال.", color = Orange, style = MaterialTheme.typography.bodyMedium)
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { onEdit(user) }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Rounded.Edit, null); Spacer(Modifier.width(6.dp)); Text("تعديل")
                }
                OutlinedButton(onClick = { onAssign(user) }, modifier = Modifier.weight(1f), enabled = state.busyKey == null) {
                    Icon(Icons.Rounded.VpnKey, null); Spacer(Modifier.width(6.dp)); Text("تعيين دور")
                }
            }
        }
        if (policy.actorIsOwner && user.id != policy.actorId) item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { onPermissions(user) },
                    modifier = Modifier.weight(1f),
                    enabled = state.busyKey == null,
                ) { Icon(Icons.Rounded.Security, null); Spacer(Modifier.width(6.dp)); Text("صلاحيات فردية") }
                OutlinedButton(
                    onClick = { onResetPassword(user) },
                    modifier = Modifier.weight(1f),
                    enabled = state.busyKey == null,
                ) { Icon(Icons.Rounded.VpnKey, null); Spacer(Modifier.width(6.dp)); Text("إعادة كلمة المرور") }
            }
        }
        if (policy.canManageAccountSecurity(user, state.overview?.activeOwnerCount ?: 0).allowed) item {
            OutlinedButton(
                onClick = { onAccountSecurity(user) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = state.busyKey == null,
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(Icons.Rounded.Shield, null)
                Spacer(Modifier.width(7.dp))
                Text("استجابة حوادث الحساب")
            }
        }
        item {
            val active = !user.isActive
            Button(
                onClick = { onStatus(user, active) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = state.busyKey == null,
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(if (active) Icons.Rounded.CheckCircle else Icons.Rounded.Block, null)
                Spacer(Modifier.width(7.dp))
                Text(if (active) "تفعيل الحساب" else "تعطيل الحساب")
            }
        }
    }
}

@Composable
private fun RolesWorkspace(
    state: AdminUiState,
    tablet: Boolean,
    onSelect: (String?) -> Unit,
    onCreate: () -> Unit,
    onEdit: (AdminRole) -> Unit,
    onStatus: (AdminRole, Boolean) -> Unit,
) {
    val list: @Composable (Modifier) -> Unit = { modifier ->
        Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("مصفوفة الأدوار", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text("القوالب للعرض، والأدوار المخصّصة قابلة للإدارة", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                }
                Button(onClick = onCreate, shape = RoundedCornerShape(16.dp)) { Text("دور جديد") }
            }
            LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 20.dp)) {
                items(state.roles, key = { it.key }) { role ->
                    RoleRow(role, state.selectedRoleKey == role.key) { onSelect(role.key) }
                }
            }
        }
    }
    if (tablet) {
        Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            list(Modifier.weight(.43f))
            AdminDetailSurface(Modifier.weight(.57f)) {
                state.selectedRole?.let { RoleDetail(it, state, onEdit, onStatus) }
                    ?: EmptySelection("اختر دوراً لمراجعة مصفوفة الوصول", Icons.Rounded.Security)
            }
        }
    } else if (state.selectedRole != null) {
        val selectedRole = requireNotNull(state.selectedRole)
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
            TextButton(onClick = { onSelect(null) }) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null); Text("كل الأدوار")
            }
            AdminDetailSurface(Modifier.fillMaxSize()) { RoleDetail(selectedRole, state, onEdit, onStatus) }
        }
    } else list(Modifier.fillMaxSize().padding(horizontal = 16.dp))
}

@Composable
private fun RoleRow(role: AdminRole, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
        shape = RoundedCornerShape(21.dp),
    ) {
        Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(15.dp)).background(if (role.isCustom) Mint else Color(0xFFF0F1F3)), contentAlignment = Alignment.Center) {
                Icon(if (role.isCustom) Icons.Rounded.Security else Icons.Rounded.Shield, null, tint = if (role.isCustom) EmeraldDark else MutedInk)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(role.label, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(if (role.isCustom) "${role.userCount} مستخدم • أساس ${role.baseRole}" else "قالب نظام مدمج", color = MutedInk, style = MaterialTheme.typography.bodySmall)
            }
            StatusPill(role.isActive)
        }
    }
}

@Composable
private fun RoleDetail(role: AdminRole, state: AdminUiState, onEdit: (AdminRole) -> Unit, onStatus: (AdminRole, Boolean) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Text(role.label, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(role.description ?: "بلا وصف", color = MutedInk)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(role.isActive)
                Surface(color = Mint, shape = CircleShape) {
                    Text("أساس ${role.baseRole}", Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = EmeraldDark)
                }
            }
        }
        item { HorizontalDivider(color = Stroke) }
        item { Text("الوصول الفعلي للوحدات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        items(role.permissions.entries.sortedBy { it.key }, key = { it.key }) { (module, access) ->
            PermissionRow(module, access)
        }
        if (role.isCustom) item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { onEdit(role) }, modifier = Modifier.weight(1f), enabled = state.busyKey == null) {
                    Icon(Icons.Rounded.Edit, null); Spacer(Modifier.width(6.dp)); Text("تعديل")
                }
                Button(onClick = { onStatus(role, !role.isActive) }, modifier = Modifier.weight(1f), enabled = state.busyKey == null) {
                    Text(if (role.isActive) "تعطيل" else "تفعيل")
                }
            }
        } else item {
            Text("القالب المدمج مرجع للقراءة ولا يُغيّر من التطبيق.", color = MutedInk)
        }
    }
}

@Composable
private fun PermissionRow(module: String, access: AccessLevel) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(15.dp)).background(Color.White).padding(13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(module, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        val color = when (access) {
            AccessLevel.FULL -> Emerald
            AccessLevel.READ -> Orange
            AccessLevel.NONE -> MutedInk
        }
        Text(access.label, color = color, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AuditWorkspace(state: AdminUiState, onLoadMore: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            DetailCard("أثر غير قابل للتحرير", Icons.Rounded.History) {
                Text("يعرض التطبيق هوية المنفذ والحقول المتغيرة فقط؛ القيم الحساسة الخام لا تُحتفظ بها محلياً.", color = MutedInk)
            }
        }
        items(state.auditEvents, key = { it.id }) { AuditRow(it) }
        if (state.auditEvents.isEmpty() && !state.auditLoading) item { EmptySelection("لا توجد أحداث تدقيق", Icons.Rounded.History) }
        if (state.auditLoading) item { LoadingPane(Modifier.fillMaxWidth().height(90.dp)) }
        if (state.auditHasMore && !state.auditLoading) item {
            OutlinedButton(onClick = onLoadMore, modifier = Modifier.fillMaxWidth()) { Text("تحميل أحداث أقدم") }
        }
    }
}

@Composable
private fun AuditRow(event: AdminAuditEvent) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(38.dp).clip(RoundedCornerShape(13.dp)).background(Mint), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.History, null, tint = EmeraldDark)
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(actionLabel(event.action), fontWeight = FontWeight.Bold)
                    val entityReference = event.entityId
                        ?.let { "${rtlIsolate(event.entityType)} ${rtlIsolate("#$it")}" }
                        ?: rtlIsolate(event.entityType)
                    Text(
                        "${event.actorName} • $entityReference",
                        color = MutedInk,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    rtlIsolate(event.createdAt.take(16).replace('T', ' ')),
                    style = MaterialTheme.typography.bodySmall,
                    color = MutedInk,
                    maxLines = 1,
                )
            }
            if (event.changedFields.isNotEmpty()) {
                Text(
                    "الحقول: ${event.changedFields.joinToString("، ") { rtlIsolate(it) }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = EmeraldDark,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            event.maskedIpAddress?.let {
                Text("المصدر: ${rtlIsolate(it)}", style = MaterialTheme.typography.bodySmall, color = MutedInk)
            }
        }
    }
}

@Composable
private fun UserEditorDialog(
    user: AdminUser?,
    password: String?,
    passwordLoading: Boolean,
    roles: List<AdminRole>,
    branches: List<AdminBranch>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onRefreshPassword: () -> Unit,
    onCreate: (CreateAdminUserCommand) -> Unit,
    onUpdate: (UpdateAdminUserCommand) -> Unit,
) {
    var name by remember(user) { mutableStateOf(user?.name.orEmpty()) }
    var email by remember(user) { mutableStateOf(user?.email.orEmpty()) }
    var username by remember(user) { mutableStateOf(user?.username.orEmpty()) }
    var phone by remember(user) { mutableStateOf(user?.phone.orEmpty()) }
    var jobTitle by remember(user) { mutableStateOf(user?.jobTitle.orEmpty()) }
    var branchId by remember(user) { mutableStateOf(user?.branchId) }
    var assignment by remember(user, roles) {
        mutableStateOf<RoleAssignment>(
            roles.firstOrNull { it.key == "cashier" }?.let { RoleAssignment.BuiltIn(it.baseRole) }
                ?: RoleAssignment.BuiltIn("cashier"),
        )
    }
    FormDialog(title = if (user == null) "إنشاء حساب من النظام" else "تعديل بيانات الحساب", onDismiss = onDismiss) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("الاسم") }, singleLine = true)
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text("اسم المستخدم") }, singleLine = true)
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), label = { Text("البريد الإلكتروني") }, singleLine = true)
        OutlinedTextField(phone, { phone = it }, Modifier.fillMaxWidth(), label = { Text("الهاتف") }, singleLine = true)
        OutlinedTextField(jobTitle, { jobTitle = it }, Modifier.fillMaxWidth(), label = { Text("المسمّى الوظيفي") }, singleLine = true)
        Text("الفرع", fontWeight = FontWeight.Bold)
        ChoiceRows(
            options = listOf(null to "كل الفروع / غير محدد") + branches.filter { it.isActive }.map { it.id to it.name },
            selected = branchId,
            onSelect = { branchId = it },
        )
        if (user == null) {
            Text("الدور الأولي", fontWeight = FontWeight.Bold)
            RoleChoices(roles.filter { it.isActive }, assignment) { assignment = it }
            DetailCard("كلمة مرور مؤقتة", Icons.Rounded.VpnKey) {
                when {
                    passwordLoading -> CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    password != null -> Text(password, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    else -> Text("تعذر توليد كلمة المرور", color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClick = onRefreshPassword, enabled = !passwordLoading) { Text("توليد قيمة جديدة") }
                Text("سيُلزم المستخدم بتغييرها عند أول دخول.", color = MutedInk, style = MaterialTheme.typography.bodySmall)
            }
        }
        Button(
            onClick = {
                if (user == null) onCreate(
                    CreateAdminUserCommand(name, email.nullIfBlank(), username.nullIfBlank(), password.orEmpty(), assignment, branchId, phone.nullIfBlank(), jobTitle.nullIfBlank(), null),
                ) else onUpdate(
                    UpdateAdminUserCommand(user.id, name, email.nullIfBlank(), username.nullIfBlank(), branchId, phone.nullIfBlank(), jobTitle.nullIfBlank(), user.hiredAt),
                )
            },
            enabled = !busy && name.isNotBlank() && (email.isNotBlank() || username.isNotBlank()) && (user != null || !password.isNullOrBlank()),
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(16.dp),
        ) { Text(if (user == null) "إنشاء الحساب" else "حفظ التعديلات") }
    }
}

@Composable
private fun AssignmentDialog(
    user: AdminUser,
    roles: List<AdminRole>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (RoleAssignment) -> Unit,
) {
    val current = user.customRoleId?.let { id ->
        roles.firstOrNull { it.id == id }?.let { RoleAssignment.Custom(id, it.baseRole) }
    } ?: RoleAssignment.BuiltIn(user.role)
    var selected by remember(user.id, roles) { mutableStateOf<RoleAssignment>(current) }
    FormDialog("تعيين دور لـ ${user.name}", onDismiss) {
        Text("تغيير الدور يبطل الجلسات القديمة ويجبر الحساب على تحميل صلاحياته الجديدة.", color = MutedInk)
        RoleChoices(roles.filter { it.isActive }, selected) { selected = it }
        Button(onClick = { onConfirm(selected) }, enabled = !busy && selected != current, modifier = Modifier.fillMaxWidth()) { Text("تعيين الدور") }
    }
}

@Composable
private fun RoleEditorDialog(
    role: AdminRole?,
    roles: List<AdminRole>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onCreate: (CreateAdminRoleCommand) -> Unit,
    onUpdate: (UpdateAdminRoleCommand) -> Unit,
) {
    val templates = roles.filter { !it.isCustom && it.baseRole != "admin" }
    var label by remember(role) { mutableStateOf(role?.label.orEmpty()) }
    var description by remember(role) { mutableStateOf(role?.description.orEmpty()) }
    var baseRole by remember(role, templates) { mutableStateOf(role?.baseRole ?: templates.firstOrNull()?.baseRole ?: "user") }
    val initialPermissions = role?.permissions ?: templates.firstOrNull { it.baseRole == baseRole }?.permissions.orEmpty()
    var permissions by remember(role) { mutableStateOf(initialPermissions) }
    FormDialog(if (role == null) "دور مخصّص جديد" else "تعديل ${role.label}", onDismiss) {
        OutlinedTextField(label, { label = it }, Modifier.fillMaxWidth(), label = { Text("اسم الدور") }, singleLine = true)
        OutlinedTextField(description, { description = it }, Modifier.fillMaxWidth(), label = { Text("الوصف") }, minLines = 2)
        Text("الفئة الأساسية", fontWeight = FontWeight.Bold)
        ChoiceRows(templates.map { it.baseRole to it.label }, baseRole) { selected ->
            baseRole = selected
            permissions = templates.firstOrNull { it.baseRole == selected }?.permissions.orEmpty()
        }
        Text("مصفوفة الوحدات", fontWeight = FontWeight.Bold)
        permissions.entries.sortedBy { it.key }.forEach { (module, access) ->
            PermissionEditorRow(module, access) { permissions = permissions + (module to it) }
        }
        Text("لا يمكن استخدام admin كفئة أساسية، وتُبطل جلسات أصحاب الدور عند تعديله.", color = MutedInk, style = MaterialTheme.typography.bodySmall)
        Button(
            onClick = {
                if (role == null) onCreate(CreateAdminRoleCommand(label, description.nullIfBlank(), baseRole, permissions))
                else onUpdate(UpdateAdminRoleCommand(requireNotNull(role.id), label, description.nullIfBlank(), baseRole, permissions))
            },
            enabled = !busy && label.isNotBlank() && baseRole != "admin",
            modifier = Modifier.fillMaxWidth(),
        ) { Text("حفظ الدور") }
    }
}

@Composable
private fun AdminInitialLoadFailure(message: String?, notice: String?, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp),
            color = Color.White,
            shape = RoundedCornerShape(topStart = 30.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 30.dp),
            tonalElevation = 2.dp,
        ) {
            Column(
                Modifier.fillMaxWidth().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(Icons.Rounded.Security, null, Modifier.size(46.dp), tint = MaterialTheme.colorScheme.error)
                Text("تعذر فتح مركز الحوكمة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                notice?.let { Text(it, color = EmeraldDark, fontWeight = FontWeight.Bold) }
                Text(message ?: "تعذر تحميل الحسابات والأدوار.", color = MutedInk)
                Button(onClick = onRetry) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(7.dp))
                    Text("إعادة المحاولة")
                }
            }
        }
    }
}

private sealed interface IncidentConfirmation {
    data class RevokeOne(val session: AdminUserSession) : IncidentConfirmation
    data object RevokeAll : IncidentConfirmation
    data object ResetTwoFactor : IncidentConfirmation
}

@Composable
private fun PermissionOverridesDialog(
    user: AdminUser,
    profile: UserPermissionProfile?,
    loading: Boolean,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (Map<String, AccessLevel>) -> Unit,
) {
    var overrides by remember(profile?.userId) { mutableStateOf(profile?.individualOverrides.orEmpty()) }
    FormDialog("الصلاحيات الفردية — ${user.name}", onDismiss) {
        when {
            loading -> LoadingPane(Modifier.fillMaxWidth().height(160.dp))
            profile == null -> Text("تعذر تحميل الصلاحيات", color = MaterialTheme.colorScheme.error)
            else -> {
                Text(
                    "الدور الفعلي: ${profile.customRoleLabel ?: profile.effectiveRole}",
                    color = MutedInk,
                )
                if (profile.customRoleInactive) {
                    Text("الدور المخصّص غير نشط؛ راجع إسناد الدور قبل الحفظ.", color = Orange)
                }
                profile.modules.forEach { module ->
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(15.dp)).background(Color.White).padding(12.dp)) {
                        Text(module.label, fontWeight = FontWeight.Bold)
                        Text("الفعلي: ${module.level.label}", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            item {
                                FilterChip(
                                    selected = module.key !in overrides,
                                    onClick = { overrides = overrides - module.key },
                                    label = { Text("حسب الدور") },
                                )
                            }
                            items(AccessLevel.entries) { level ->
                                FilterChip(
                                    selected = overrides[module.key] == level,
                                    onClick = { overrides = overrides + (module.key to level) },
                                    label = { Text(level.label) },
                                )
                            }
                        }
                    }
                }
                Text("الحفظ يبطل جلسات الحساب القديمة لتطبيق الصلاحيات فوراً.", color = MutedInk, style = MaterialTheme.typography.bodySmall)
                Button(
                    onClick = { onConfirm(overrides) },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("تأكيد الصلاحيات") }
            }
        }
    }
}

@Composable
private fun ResetPasswordDialog(
    user: AdminUser,
    password: String?,
    loading: Boolean,
    busy: Boolean,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    FormDialog("إعادة كلمة المرور — ${user.name}", onDismiss) {
        Text("ستنتهي كل جلسات الحساب، وسيُلزم المستخدم بتغيير الكلمة عند أول دخول.", color = MutedInk)
        DetailCard("كلمة المرور المؤقتة", Icons.Rounded.VpnKey) {
            when {
                loading -> CircularProgressIndicator(Modifier.size(24.dp))
                password != null -> Text(password, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                else -> TextButton(onClick = onRefresh) { Text("توليد كلمة آمنة") }
            }
        }
        Button(
            onClick = { password?.let(onConfirm) },
            enabled = !busy && !loading && !password.isNullOrBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("إعادة التعيين وإبطال الجلسات") }
    }
}

@Composable
private fun RoleChoices(roles: List<AdminRole>, selected: RoleAssignment, onSelect: (RoleAssignment) -> Unit) {
    roles.forEach { role ->
        val assignment = role.id?.let { RoleAssignment.Custom(it, role.baseRole) } ?: RoleAssignment.BuiltIn(role.baseRole)
        val checked = assignment == selected
        ChoiceRow(role.label, role.description ?: role.baseRole, checked) { onSelect(assignment) }
    }
}

@Composable
private fun <T> ChoiceRows(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    options.forEach { (value, label) -> ChoiceRow(label, null, value == selected) { onSelect(value) } }
}

@Composable
private fun ChoiceRow(title: String, subtitle: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
            .background(if (selected) Mint else Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(18.dp).clip(CircleShape).background(if (selected) Emerald else Stroke))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
            subtitle?.let { Text(it, color = MutedInk, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun PermissionEditorRow(module: String, value: AccessLevel, onChange: (AccessLevel) -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(15.dp)).background(Color.White).padding(12.dp)) {
        Text(module, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            AccessLevel.entries.forEach { level ->
                FilterChip(selected = value == level, onClick = { onChange(level) }, label = { Text(level.label) })
            }
        }
    }
}

@Composable
private fun AccountSecurityDialog(
    user: AdminUser,
    sessions: List<AdminUserSession>,
    loading: Boolean,
    fresh: Boolean,
    busy: Boolean,
    error: String?,
    notice: String?,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onRevokeSession: (Long) -> Unit,
    onRevokeAll: () -> Unit,
    onResetTwoFactor: () -> Unit,
) {
    var confirmation by remember(user.id) { mutableStateOf<IncidentConfirmation?>(null) }
    FormDialog("أمان حساب ${user.name}", onDismiss) {
        Text(
            "الجلسات النشطة وإجراءات استعادة السيطرة على الحساب.",
            color = MutedInk,
            style = MaterialTheme.typography.bodyMedium,
        )
        error?.let {
            Surface(color = Color(0xFFFFECEC), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Text(it, Modifier.padding(12.dp), color = Color(0xFF9F1D1D), style = MaterialTheme.typography.bodyMedium)
            }
        }
        notice?.let {
            Surface(color = Mint, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Text(it, Modifier.padding(12.dp), color = EmeraldDark, style = MaterialTheme.typography.bodyMedium)
            }
        }
        when {
            loading -> LoadingPane(Modifier.fillMaxWidth().height(150.dp))
            !fresh -> OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Rounded.Refresh, null)
                Spacer(Modifier.width(8.dp))
                Text("إعادة المحاولة")
            }
            sessions.isEmpty() -> EmptySelection("لا توجد جلسات نشطة", Icons.Rounded.Security)
            else -> sessions.forEach { session ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = Color.White,
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.Security, null, tint = EmeraldDark)
                            Spacer(Modifier.width(8.dp))
                            Text(session.deviceLabel, Modifier.weight(1f), fontWeight = FontWeight.Bold)
                            TextButton(
                                onClick = { confirmation = IncidentConfirmation.RevokeOne(session) },
                                enabled = fresh && !busy,
                            ) { Text("إنهاء") }
                        }
                        session.maskedIpAddress?.let { DetailValue("عنوان الشبكة", rtlIsolate(it)) }
                        DetailValue("آخر نشاط", rtlIsolate(session.lastSeenAt.ifBlank { session.createdAt }))
                        DetailValue("تنتهي", rtlIsolate(session.expiresAt))
                    }
                }
            }
        }
        HorizontalDivider(color = Stroke)
        OutlinedButton(
            onClick = { confirmation = IncidentConfirmation.RevokeAll },
            modifier = Modifier.fillMaxWidth(),
            enabled = fresh && !busy && sessions.isNotEmpty(),
        ) { Text("إنهاء جميع الجلسات") }
        Button(
            onClick = { confirmation = IncidentConfirmation.ResetTwoFactor },
            modifier = Modifier.fillMaxWidth(),
            enabled = fresh && !busy,
            shape = RoundedCornerShape(16.dp),
        ) { Text("إعادة تهيئة المصادقة الثنائية") }
    }

    val pending = confirmation
    if (pending != null) {
        val title: String
        val message: String
        val confirm: String
        when (pending) {
            is IncidentConfirmation.RevokeOne -> {
                title = "إنهاء الجلسة؟"
                message = "سيُطلب من هذا الجهاز تسجيل الدخول من جديد."
                confirm = "إنهاء الجلسة"
            }
            IncidentConfirmation.RevokeAll -> {
                title = "إنهاء جميع الجلسات؟"
                message = "سيتم تسجيل خروج الحساب من جميع الأجهزة فوراً."
                confirm = "إنهاء الجميع"
            }
            IncidentConfirmation.ResetTwoFactor -> {
                title = "إعادة تهيئة المصادقة الثنائية؟"
                message = "ستُلغى وسيلة المصادقة الحالية وتنتهي جميع الجلسات. سيُلزم المستخدم بإعدادها من جديد."
                confirm = "إعادة التهيئة"
            }
        }
        ConfirmDialog(
            title = title,
            message = message,
            confirm = confirm,
            destructive = true,
            onDismiss = { confirmation = null },
            onConfirm = {
                when (pending) {
                    is IncidentConfirmation.RevokeOne -> onRevokeSession(pending.session.id)
                    IncidentConfirmation.RevokeAll -> onRevokeAll()
                    IncidentConfirmation.ResetTwoFactor -> onResetTwoFactor()
                }
                confirmation = null
            },
        )
    }
}

@Composable
private fun FormDialog(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 620.dp).wrapContentHeight(),
            color = Canvas,
            shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 34.dp),
            tonalElevation = 8.dp,
        ) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    TextButton(onClick = onDismiss) { Text("إغلاق") }
                }
                content()
            }
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    message: String,
    confirm: String,
    destructive: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
        confirmButton = {
            Button(onClick = onConfirm) { Text(confirm, color = if (destructive) Color.White else Color.Unspecified) }
        },
    )
}

@Composable
private fun AdminDetailSurface(modifier: Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier.fillMaxHeight(),
        color = Color(0xFFF9FAF8),
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 34.dp),
        tonalElevation = 2.dp,
        content = content,
    )
}

@Composable
private fun DetailCard(title: String, icon: ImageVector, content: @Composable () -> Unit) {
    Surface(color = Color.White, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, tint = EmeraldDark); Spacer(Modifier.width(8.dp))
                Text(title, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
            }
            content()
        }
    }
}

@Composable
private fun DetailValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, Modifier.weight(1f), color = MutedInk)
        Text(value, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun Avatar(name: String, active: Boolean, size: Int = 50) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size / 3).dp)).background(if (active) EmeraldDark else MutedInk),
        contentAlignment = Alignment.Center,
    ) { Text(name.trim().take(1), color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
}

@Composable
private fun StatusPill(active: Boolean) {
    Surface(color = if (active) Color(0xFFE4F4E8) else Color(0xFFF0F1F3), shape = CircleShape) {
        Text(
            if (active) "نشط" else "معطّل",
            Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            style = MaterialTheme.typography.labelMedium,
            color = if (active) Color(0xFF2E7D32) else MutedInk,
        )
    }
}

@Composable
private fun MessageBanner(message: String, error: Boolean, onDismiss: () -> Unit) {
    Surface(
        color = if (error) MaterialTheme.colorScheme.errorContainer else Mint,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onDismiss)
            .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite },
    ) { Text(message, Modifier.padding(12.dp), color = if (error) MaterialTheme.colorScheme.onErrorContainer else EmeraldDark) }
}

@Composable
private fun EmptySelection(text: String, icon: ImageVector) {
    Column(Modifier.fillMaxSize().padding(30.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(70.dp).clip(RoundedCornerShape(24.dp)).background(Mint), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(34.dp), tint = EmeraldDark)
        }
        Spacer(Modifier.height(14.dp))
        Text(text, color = MutedInk)
    }
}

@Composable
private fun LoadingPane(modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Emerald) }
}

@Composable
private fun AccessDenied() {
    EmptySelection("هذه المساحة لمدير النظام فقط", Icons.Rounded.Shield)
}

private fun actionLabel(action: String): String = when (action) {
    "user.create" -> "إنشاء حساب"
    "user.update" -> "تحديث حساب"
    "user.activate" -> "تفعيل حساب"
    "user.deactivate" -> "تعطيل حساب"
    "role.create" -> "إنشاء دور"
    "role.update" -> "تحديث دور"
    "role.activate" -> "تفعيل دور"
    "role.deactivate" -> "تعطيل دور"
    else -> action.replace('.', ' ')
}

private fun String.nullIfBlank(): String? = trim().takeIf(String::isNotEmpty)

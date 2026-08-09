package online.alarabiya.superapp.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.Badge
import androidx.compose.material.icons.rounded.Business
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.PrivacyTip
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.data.LegalDocument
import online.alarabiya.superapp.model.selfservice.NotificationPreferences
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Ink
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.Stroke

private enum class SettingsSection(
    val label: String,
    val icon: ImageVector,
) {
    Account("الحساب", Icons.Rounded.AccountCircle),
    Notifications("الإشعارات", Icons.Rounded.Notifications),
    Security("الأمان والجلسة", Icons.Rounded.VerifiedUser),
    Privacy("الخصوصية", Icons.Rounded.PrivacyTip),
    About("عن التطبيق", Icons.Rounded.Info),
}

@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onNotificationChange: (NotificationSettingKey, Boolean) -> Unit,
    onBiometricChange: (Boolean) -> Unit,
    onSignOut: () -> Unit,
    onRetryLegal: () -> Unit,
    onOpenPrivacyLink: (String) -> Unit,
    twoFactorVisible: Boolean,
    onOpenTwoFactor: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(
        modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        if (maxWidth >= 840.dp) {
            TabletSettings(
                state,
                onNotificationChange,
                onBiometricChange,
                onSignOut,
                onRetryLegal,
                onOpenPrivacyLink,
                twoFactorVisible,
                onOpenTwoFactor,
            )
        } else {
            PhoneSettings(
                state,
                onNotificationChange,
                onBiometricChange,
                onSignOut,
                onRetryLegal,
                onOpenPrivacyLink,
                twoFactorVisible,
                onOpenTwoFactor,
            )
        }
    }
}

@Composable
private fun PhoneSettings(
    state: SettingsUiState,
    onNotificationChange: (NotificationSettingKey, Boolean) -> Unit,
    onBiometricChange: (Boolean) -> Unit,
    onSignOut: () -> Unit,
    onRetryLegal: () -> Unit,
    onOpenPrivacyLink: (String) -> Unit,
    twoFactorVisible: Boolean,
    onOpenTwoFactor: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item { ScreenTitle() }
        item { AccountSection(state.account) }
        item {
            NotificationsSection(
                state.notifications,
                state.notificationsSaving,
                state.notificationsError,
                onNotificationChange,
            )
        }
        item { SecuritySection(state, onBiometricChange, onSignOut, twoFactorVisible, onOpenTwoFactor) }
        item { PrivacySection(state.legal, onRetryLegal, onOpenPrivacyLink) }
        item { AboutSection(state.appVersion) }
    }
}

@Composable
private fun TabletSettings(
    state: SettingsUiState,
    onNotificationChange: (NotificationSettingKey, Boolean) -> Unit,
    onBiometricChange: (Boolean) -> Unit,
    onSignOut: () -> Unit,
    onRetryLegal: () -> Unit,
    onOpenPrivacyLink: (String) -> Unit,
    twoFactorVisible: Boolean,
    onOpenTwoFactor: () -> Unit,
) {
    var selected by rememberSaveable { mutableStateOf(SettingsSection.Account) }
    Row(Modifier.fillMaxSize().padding(24.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
        Surface(
            modifier = Modifier.width(288.dp).fillMaxHeight(),
            color = Color.White,
            shape = RoundedCornerShape(30.dp),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { ScreenTitle() }
                item { Spacer(Modifier.height(10.dp)) }
                items(SettingsSection.entries, key = { it.name }) { section ->
                    SectionNavigationRow(
                        section = section,
                        selected = selected == section,
                        onClick = { selected = section },
                    )
                }
            }
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxHeight().widthIn(max = 780.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            item {
                when (selected) {
                    SettingsSection.Account -> AccountSection(state.account)
                    SettingsSection.Notifications -> NotificationsSection(
                        state.notifications,
                        state.notificationsSaving,
                        state.notificationsError,
                        onNotificationChange,
                    )
                    SettingsSection.Security -> SecuritySection(state, onBiometricChange, onSignOut, twoFactorVisible, onOpenTwoFactor)
                    SettingsSection.Privacy -> PrivacySection(state.legal, onRetryLegal, onOpenPrivacyLink)
                    SettingsSection.About -> AboutSection(state.appVersion)
                }
            }
        }
    }
}

@Composable
private fun ScreenTitle() {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Emerald,
        contentColor = Color.White,
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomEnd = 34.dp, bottomStart = 18.dp),
        shadowElevation = 4.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                color = Color.White.copy(alpha = .16f),
                shape = RoundedCornerShape(topStart = 18.dp, bottomEnd = 18.dp, topEnd = 10.dp, bottomStart = 10.dp),
            ) {
                Icon(Icons.Rounded.VerifiedUser, null, Modifier.padding(11.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("الإعدادات", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text("الحساب والتفضيلات", style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = .72f))
            }
        }
    }
}

@Composable
private fun SectionNavigationRow(section: SettingsSection, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp))
            .background(if (selected) Mint else Color.Transparent)
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(section.icon, null, tint = if (selected) EmeraldDark else MutedInk)
        Text(
            section.label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium,
            color = if (selected) EmeraldDark else Ink,
        )
        if (selected) Box(Modifier.size(7.dp).clip(CircleShape).background(Emerald))
    }
}

@Composable
private fun AccountSection(account: SettingsAccount) {
    SettingsCard("معلومات الحساب", Icons.Rounded.Badge) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(
                Modifier.size(62.dp).clip(RoundedCornerShape(21.dp)).background(EmeraldDark),
                contentAlignment = Alignment.Center,
            ) {
                Text(account.name.take(1), color = Color.White, style = MaterialTheme.typography.headlineMedium)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(account.name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(account.identifier, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            }
        }
        HorizontalDivider(color = Stroke)
        ValueRow(Icons.Rounded.Badge, "الدور", account.role)
        ValueRow(Icons.Rounded.Business, "الفرع", account.branch)
    }
}

@Composable
private fun NotificationsSection(
    preferences: NotificationPreferences,
    saving: Boolean,
    error: String?,
    onChange: (NotificationSettingKey, Boolean) -> Unit,
) {
    SettingsCard("الإشعارات", Icons.Rounded.Notifications) {
        val rows = listOf(
            Triple(NotificationSettingKey.Tasks, "المهام", Icons.Rounded.TaskAlt),
            Triple(NotificationSettingKey.Payroll, "الراتب", Icons.Rounded.Payments),
            Triple(NotificationSettingKey.Attendance, "الحضور", Icons.Rounded.Schedule),
            Triple(NotificationSettingKey.Leave, "الإجازات", Icons.Rounded.Notifications),
            Triple(NotificationSettingKey.Approvals, "الموافقات", Icons.Rounded.VerifiedUser),
        )
        rows.forEachIndexed { index, (key, label, icon) ->
            val checked = SettingsStateMapper.notificationValue(preferences, key)
            ToggleRow(
                icon = icon,
                title = label,
                checked = checked,
                enabled = !saving,
                testTag = "notification_${key.name.lowercase()}",
                onChange = { onChange(key, it) },
            )
            if (index < rows.lastIndex) HorizontalDivider(color = Stroke)
        }
        if (saving) {
            Row(
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Emerald)
                Text("جارٍ الحفظ", style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            }
        }
        error?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }
                    .testTag("notifications_error"),
            )
        }
    }
}

@Composable
private fun SecuritySection(
    state: SettingsUiState,
    onBiometricChange: (Boolean) -> Unit,
    onSignOut: () -> Unit,
    twoFactorVisible: Boolean,
    onOpenTwoFactor: () -> Unit,
) {
    SettingsCard("الأمان والجلسة", Icons.Rounded.Lock) {
        if (state.biometricAvailable) {
            ToggleRow(
                icon = Icons.Rounded.Fingerprint,
                title = "القفل الحيوي",
                checked = state.biometricEnabled,
                enabled = true,
                testTag = "biometric_lock",
                onChange = onBiometricChange,
            )
            HorizontalDivider(color = Stroke)
        }
        ValueRow(Icons.Rounded.VerifiedUser, "الجلسة", "نشطة")
        if (twoFactorVisible) {
            OutlinedButton(
                onClick = onOpenTwoFactor,
                modifier = Modifier.fillMaxWidth().height(54.dp).testTag("open_two_factor"),
                shape = RoundedCornerShape(18.dp),
            ) {
                Icon(Icons.Rounded.Security, null)
                Spacer(Modifier.width(8.dp))
                Text("المصادقة الثنائية", style = MaterialTheme.typography.labelLarge)
            }
        }
        Button(
            onClick = onSignOut,
            modifier = Modifier.fillMaxWidth().height(54.dp).testTag("sign_out"),
            shape = RoundedCornerShape(18.dp),
        ) {
            Icon(Icons.AutoMirrored.Rounded.Logout, null)
            Spacer(Modifier.width(8.dp))
            Text("تسجيل الخروج", style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun PrivacySection(
    legal: LegalUiState,
    onRetry: () -> Unit,
    onOpenPrivacyLink: (String) -> Unit,
) {
    SettingsCard("سياسة الخصوصية", Icons.Rounded.PrivacyTip) {
        when (legal) {
            LegalUiState.Loading -> {
                Row(
                    Modifier.fillMaxWidth().semantics {
                        contentDescription = "جارٍ تحميل سياسة الخصوصية"
                        liveRegion = LiveRegionMode.Polite
                    },
                    horizontalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator(color = Emerald) }
            }
            is LegalUiState.Error -> {
                Column(
                    Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(legal.message, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                    TextButton(onClick = onRetry) {
                        Icon(Icons.Rounded.Refresh, null)
                        Spacer(Modifier.width(6.dp))
                        Text("إعادة المحاولة")
                    }
                }
            }
            is LegalUiState.Content -> LegalDocumentContent(legal.document, onOpenPrivacyLink)
        }
    }
}

@Composable
private fun LegalDocumentContent(document: LegalDocument, onOpenPrivacyLink: (String) -> Unit) {
    Text(
        document.config.dataControllerName,
        style = MaterialTheme.typography.titleMedium,
        color = EmeraldDark,
    )
    document.sections.forEach { section ->
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(section.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Text(section.body, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
        }
    }
    document.config.privacyContactEmail?.let { email ->
        ValueRow(Icons.Rounded.PrivacyTip, "التواصل", email)
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            "نسخة ${document.config.privacyPolicyVersion}",
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = MutedInk,
        )
        document.publicUrl?.let { url ->
            TextButton(onClick = { onOpenPrivacyLink(url) }, modifier = Modifier.testTag("open_public_privacy")) {
                Text("عرض النسخة العامة")
                Icon(Icons.Rounded.ChevronLeft, null)
            }
        }
    }
}

@Composable
private fun AboutSection(version: String) {
    SettingsCard("عن التطبيق", Icons.Rounded.Info) {
        ValueRow(Icons.Rounded.Info, "التطبيق", "سوبر العربية")
        ValueRow(Icons.Rounded.VerifiedUser, "الإصدار", version)
    }
}

@Composable
private fun SettingsCard(title: String, icon: ImageVector, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        shape = RoundedCornerShape(26.dp),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(42.dp).clip(RoundedCornerShape(14.dp)).background(Mint), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = EmeraldDark)
                }
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            }
            content()
        }
    }
}

@Composable
private fun ValueRow(icon: ImageVector, label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = Emerald)
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyLarge, color = MutedInk, textAlign = TextAlign.End)
    }
}

@Composable
private fun ToggleRow(
    icon: ImageVector,
    title: String,
    checked: Boolean,
    enabled: Boolean,
    testTag: String,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onChange,
            )
            .semantics(mergeDescendants = true) {
                stateDescription = if (checked) "مفعّل" else "غير مفعّل"
            }
            .testTag(testTag)
            .padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = if (checked) Emerald else MutedInk)
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

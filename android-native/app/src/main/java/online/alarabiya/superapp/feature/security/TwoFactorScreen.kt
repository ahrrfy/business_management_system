package online.alarabiya.superapp.feature.security

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.LayoutDirection.Rtl
import androidx.compose.ui.unit.LayoutDirection.Ltr
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.runtime.CompositionLocalProvider
import online.alarabiya.superapp.data.TwoFactorVerification
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Ink
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk

@Composable
fun TwoFactorScreen(
    state: TwoFactorUiState,
    onRefresh: () -> Unit,
    onStartEnrollment: (String) -> Unit,
    onConfirmEnrollment: (String) -> Unit,
    onRegenerateCodes: (String, String) -> Unit,
    onDisable: (String, TwoFactorVerification) -> Unit,
    onRecoveryCodesSaved: () -> Unit,
    onOpenAuthenticator: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides Rtl) {
        Box(modifier.fillMaxSize().background(Canvas)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(18.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item { SecurityHeader(onBack) }
                when (val content = state.content) {
                    TwoFactorContent.Loading -> item { LoadingCard() }
                    is TwoFactorContent.Failed -> item { ErrorCard(content.message, onRefresh) }
                    is TwoFactorContent.Ready -> {
                        item {
                            StatusCard(
                                status = content.status,
                                busy = state.busy,
                                onStartEnrollment = onStartEnrollment,
                                onRegenerateCodes = onRegenerateCodes,
                                onDisable = onDisable,
                            )
                        }
                        state.enrollment?.let { enrollment ->
                            item {
                                EnrollmentCard(
                                    secret = enrollment.secretBase32,
                                    uri = enrollment.otpauthUri,
                                    busy = state.busy,
                                    onOpenAuthenticator = onOpenAuthenticator,
                                    onConfirm = onConfirmEnrollment,
                                )
                            }
                        }
                    }
                }
                state.message?.let { message ->
                    item {
                        Text(
                            message,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive }
                                .testTag("two_factor_message"),
                        )
                    }
                }
            }
        }
        if (state.recoveryCodes.isNotEmpty()) {
            RecoveryCodesDialog(state.recoveryCodes, onRecoveryCodesSaved)
        }
    }
}

@Composable
private fun SecurityHeader(onBack: () -> Unit) {
    Surface(
        color = EmeraldDark,
        contentColor = androidx.compose.ui.graphics.Color.White,
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomEnd = 34.dp, bottomStart = 18.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            IconButton(onClick = onBack, modifier = Modifier.testTag("two_factor_back")) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع")
            }
            Icon(Icons.Rounded.Security, null)
            Column {
                Text("المصادقة الثنائية", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text("حماية الحساب ورموز الاسترداد", color = androidx.compose.ui.graphics.Color.White.copy(alpha = .76f))
            }
        }
    }
}

@Composable
private fun LoadingCard() = Card(shape = RoundedCornerShape(26.dp)) {
    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Emerald)
    }
}

@Composable
private fun ErrorCard(message: String, onRefresh: () -> Unit) = Card(shape = RoundedCornerShape(26.dp)) {
    Column(
        Modifier.fillMaxWidth().padding(22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Rounded.Warning, null, tint = MaterialTheme.colorScheme.error)
        Text(message, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyLarge)
        OutlinedButton(onClick = onRefresh, modifier = Modifier.testTag("two_factor_retry")) {
            Icon(Icons.Rounded.Refresh, null)
            Text("إعادة المحاولة")
        }
    }
}

@Composable
private fun StatusCard(
    status: online.alarabiya.superapp.data.TwoFactorAccountStatus,
    busy: Boolean,
    onStartEnrollment: (String) -> Unit,
    onRegenerateCodes: (String, String) -> Unit,
    onDisable: (String, TwoFactorVerification) -> Unit,
) {
    var action by rememberSaveable { mutableStateOf<SecurityAction?>(null) }
    Card(
        colors = CardDefaults.cardColors(containerColor = androidx.compose.ui.graphics.Color.White),
        shape = RoundedCornerShape(26.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(if (status.enabled) Icons.Rounded.CheckCircle else Icons.Rounded.Lock, null, tint = Emerald)
                Column(Modifier.weight(1f)) {
                    Text(if (status.enabled) "الحماية مفعّلة" else "الحماية غير مفعّلة", style = MaterialTheme.typography.titleLarge)
                    Text(
                        when {
                            !status.cryptoReady -> "الخدمة غير متاحة حالياً"
                            status.pending -> "يوجد إعداد غير مكتمل"
                            status.enabled -> "رموز الاسترداد المتبقية: ${status.recoveryCodesRemaining}"
                            else -> "استخدم تطبيق مصادقة لحماية الحساب"
                        },
                        color = MutedInk,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            if (!status.enabled) {
                Button(
                    onClick = { action = SecurityAction.Enable },
                    enabled = status.cryptoReady && !busy,
                    modifier = Modifier.fillMaxWidth().testTag("two_factor_enable"),
                ) { Text(if (status.pending) "متابعة الإعداد" else "تفعيل المصادقة الثنائية") }
            } else {
                OutlinedButton(
                    onClick = { action = SecurityAction.Regenerate },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("two_factor_regenerate"),
                ) {
                    Icon(Icons.Rounded.Key, null)
                    Text("إصدار رموز استرداد جديدة")
                }
                TextButton(
                    onClick = { action = SecurityAction.Disable },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("two_factor_disable"),
                ) { Text("تعطيل المصادقة الثنائية", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    action?.let { selected ->
        CredentialsDialog(
            action = selected,
            onDismiss = { action = null },
            onSubmit = { password, code, recoveryMode ->
                action = null
                when (selected) {
                    SecurityAction.Enable -> onStartEnrollment(password)
                    SecurityAction.Regenerate -> onRegenerateCodes(password, code)
                    SecurityAction.Disable -> onDisable(
                        password,
                        if (recoveryMode) TwoFactorVerification.RecoveryCode(code)
                        else TwoFactorVerification.AuthenticatorCode(code),
                    )
                }
            },
        )
    }
}

private enum class SecurityAction { Enable, Regenerate, Disable }

@Composable
private fun CredentialsDialog(
    action: SecurityAction,
    onDismiss: () -> Unit,
    onSubmit: (String, String, Boolean) -> Unit,
) {
    var password by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var recoveryMode by rememberSaveable { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(when (action) {
            SecurityAction.Enable -> "تأكيد الهوية"
            SecurityAction.Regenerate -> "إصدار رموز جديدة"
            SecurityAction.Disable -> "تعطيل المصادقة الثنائية"
        }) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = password,
                    onValueChange = { if (it.length <= 128) password = it },
                    label = { Text("كلمة المرور الحالية") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("two_factor_password"),
                )
                if (action != SecurityAction.Enable) {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { if (it.length <= 64) code = it },
                        label = { Text(if (recoveryMode) "رمز الاسترداد" else "رمز المصادقة") },
                        keyboardOptions = KeyboardOptions(keyboardType = if (recoveryMode) KeyboardType.Ascii else KeyboardType.NumberPassword),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("two_factor_verification"),
                    )
                    if (action == SecurityAction.Disable) {
                        TextButton(onClick = { recoveryMode = !recoveryMode }) {
                            Text(if (recoveryMode) "استخدام رمز تطبيق المصادقة" else "استخدام رمز استرداد")
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onSubmit(password, code, recoveryMode) }, modifier = Modifier.testTag("two_factor_submit")) {
                Text("متابعة")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun EnrollmentCard(
    secret: String,
    uri: String,
    busy: Boolean,
    onOpenAuthenticator: (String) -> Unit,
    onConfirm: (String) -> Unit,
) {
    var code by rememberSaveable { mutableStateOf("") }
    Card(colors = CardDefaults.cardColors(containerColor = Mint), shape = RoundedCornerShape(26.dp)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("ربط تطبيق المصادقة", style = MaterialTheme.typography.titleLarge, color = Ink)
            Text("افتح تطبيق المصادقة أو أدخل المفتاح يدوياً، ثم أكد الرمز الظاهر.", style = MaterialTheme.typography.bodyLarge)
            OutlinedButton(onClick = { onOpenAuthenticator(uri) }, modifier = Modifier.fillMaxWidth()) {
                Text("فتح تطبيق المصادقة")
            }
            CompositionLocalProvider(LocalLayoutDirection provides Ltr) {
                Surface(color = androidx.compose.ui.graphics.Color.White, shape = RoundedCornerShape(14.dp)) {
                    Text(
                        secret.chunked(4).joinToString(" "),
                        modifier = Modifier.fillMaxWidth().padding(16.dp).testTag("two_factor_secret"),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 18.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            OutlinedTextField(
                value = code,
                onValueChange = { value -> code = value.filter(Char::isDigit).take(6) },
                label = { Text("رمز المصادقة") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("two_factor_confirm_code"),
            )
            Button(
                onClick = { onConfirm(code) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().testTag("two_factor_confirm"),
            ) { Text("تأكيد التفعيل") }
        }
    }
}

@Composable
private fun RecoveryCodesDialog(codes: List<String>, onSaved: () -> Unit) {
    AlertDialog(
        onDismissRequest = {},
        title = { Text("رموز الاسترداد") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("احفظ هذه الرموز في مكان آمن. لن تظهر مرة أخرى.")
                LazyColumn(Modifier.heightIn(max = 320.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(codes) { code ->
                        CompositionLocalProvider(LocalLayoutDirection provides Ltr) {
                            Text(
                                code,
                                modifier = Modifier.fillMaxWidth().background(Canvas, RoundedCornerShape(10.dp)).padding(10.dp),
                                fontFamily = FontFamily.Monospace,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = onSaved, modifier = Modifier.testTag("recovery_codes_saved")) {
                Text("حفظت الرموز")
            }
        },
    )
}

package online.alarabiya.superapp.feature.approvals

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CardGiftcard
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.EventAvailable
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Verified
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalKey
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.approvals.RejectionReasonPolicy
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

private val ApprovalOrange = Color(0xFFD66B1F)

@Composable
fun ApprovalsRoute(viewModel: ApprovalsViewModel, modifier: Modifier = Modifier) {
    ApprovalsScreen(
        state = viewModel.state,
        onRefresh = viewModel::refresh,
        onSelect = viewModel::select,
        onFilter = viewModel::setFilter,
        onRequestDecision = viewModel::requestDecision,
        onCancelDecision = viewModel::cancelDecision,
        onConfirmDecision = viewModel::confirmDecision,
        onDismissNotice = viewModel::clearNotice,
        modifier = modifier,
    )
}

@Composable
fun ApprovalsScreen(
    state: ApprovalsUiState,
    onRefresh: () -> Unit,
    onSelect: (ApprovalKey?) -> Unit,
    onFilter: (ApprovalFilter) -> Unit,
    onRequestDecision: (ApprovalKey, ApprovalDecision) -> Unit,
    onCancelDecision: () -> Unit,
    onConfirmDecision: (ApprovalDecision) -> Unit,
    onDismissNotice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(modifier = modifier.fillMaxSize()) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                ApprovalsHeader(
                    count = state.requests.size,
                    refreshing = state.refreshing,
                    onRefresh = onRefresh,
                )
                AnimatedVisibility(state.notice != null) {
                    NoticeBanner(state.notice.orEmpty(), onDismissNotice)
                }
                AnimatedVisibility(state.error != null && state.requests.isNotEmpty()) {
                    InlineError(
                        message = state.error.orEmpty(),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val wide = maxWidth >= 760.dp
                    when {
                        state.loading -> LoadingState()
                        state.error != null && state.requests.isEmpty() -> ErrorState(state.error, onRefresh)
                        wide -> WideApprovalsLayout(
                            state = state,
                            onSelect = onSelect,
                            onFilter = onFilter,
                            onRequestDecision = onRequestDecision,
                        )
                        else -> CompactApprovalsLayout(
                            state = state,
                            onSelect = onSelect,
                            onFilter = onFilter,
                            onRequestDecision = onRequestDecision,
                        )
                    }
                }
            }
        }
        state.confirmation?.let { pending ->
            val request = state.requests.firstOrNull { it.key == pending.requestKey }
            if (request != null) DecisionDialog(
                request = request,
                initialDecision = pending.decision,
                onDismiss = onCancelDecision,
                onConfirm = onConfirmDecision,
            )
        }
    }
}

@Composable
private fun ApprovalsHeader(count: Int, refreshing: Boolean, onRefresh: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = RoundedCornerShape(bottomStart = 42.dp, bottomEnd = 16.dp),
        tonalElevation = 5.dp,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(50.dp)
                    .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = .12f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.Verified, contentDescription = null)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("مركز الاعتمادات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    if (count == 0) "لا قرارات معلّقة" else "$count قرارات تحتاج المراجعة",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .76f),
                )
            }
            IconButton(onClick = onRefresh, enabled = !refreshing) {
                if (refreshing) CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                ) else Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
            }
        }
    }
}

@Composable
private fun WideApprovalsLayout(
    state: ApprovalsUiState,
    onSelect: (ApprovalKey?) -> Unit,
    onFilter: (ApprovalFilter) -> Unit,
    onRequestDecision: (ApprovalKey, ApprovalDecision) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        ApprovalList(
            state = state,
            onSelect = onSelect,
            onFilter = onFilter,
            modifier = Modifier.weight(.44f),
        )
        Surface(
            modifier = Modifier.weight(.56f).fillMaxSize(),
            shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 34.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            tonalElevation = 2.dp,
        ) {
            val selected = state.selectedRequest
            if (selected == null) SelectionHint()
            else ApprovalDetail(selected, state.submittingKey, onRequestDecision, Modifier.padding(24.dp))
        }
    }
}

@Composable
private fun CompactApprovalsLayout(
    state: ApprovalsUiState,
    onSelect: (ApprovalKey?) -> Unit,
    onFilter: (ApprovalFilter) -> Unit,
    onRequestDecision: (ApprovalKey, ApprovalDecision) -> Unit,
) {
    AnimatedContent(targetState = state.selectedRequest, label = "approval-navigation") { selected ->
        if (selected == null) {
            ApprovalList(
                state = state,
                onSelect = onSelect,
                onFilter = onFilter,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 14.dp),
            )
        } else {
            Column(Modifier.fillMaxSize().padding(18.dp)) {
                TextButton(onClick = { onSelect(null) }) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("كل الطلبات")
                }
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    shape = RoundedCornerShape(topStart = 34.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 34.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                ) {
                    ApprovalDetail(selected, state.submittingKey, onRequestDecision, Modifier.padding(22.dp))
                }
            }
        }
    }
}

@Composable
private fun ApprovalList(
    state: ApprovalsUiState,
    onSelect: (ApprovalKey?) -> Unit,
    onFilter: (ApprovalFilter) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        val availableKinds = state.requests.mapTo(mutableSetOf()) { it.kind }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 4.dp),
        ) {
            items(ApprovalFilter.entries.filter { filter ->
                filter == ApprovalFilter.ALL || availableKinds.any(filter::accepts)
            }) { filter ->
                FilterChip(
                    selected = state.filter == filter,
                    onClick = { onFilter(filter) },
                    label = { Text(filter.label) },
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        if (state.visibleRequests.isEmpty()) EmptyState(Modifier.fillMaxSize())
        else LazyColumn(
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            items(state.visibleRequests, key = { "${it.kind.apiValue}-${it.id}" }) { request ->
                ApprovalListCard(
                    request = request,
                    selected = request.key == state.selectedKey,
                    pending = request.key == state.submittingKey,
                    onClick = { onSelect(request.key) },
                )
            }
        }
    }
}

@Composable
private fun ApprovalListCard(
    request: ApprovalRequest,
    selected: Boolean,
    pending: Boolean,
    onClick: () -> Unit,
) {
    val colors = kindColors(request.kind)
    Card(
        modifier = Modifier.fillMaxWidth().clickable(enabled = !pending, role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 12.dp, bottomStart = 12.dp, bottomEnd = 24.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) colors.first.copy(alpha = .10f) else MaterialTheme.colorScheme.surface,
        ),
        border = CardDefaults.outlinedCardBorder().takeIf { selected },
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KindIcon(request.kind, 46.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(request.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(request.reference, style = MaterialTheme.typography.labelMedium, color = colors.first)
                Text(
                    request.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (pending) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun ApprovalDetail(
    request: ApprovalRequest,
    submittingKey: ApprovalKey?,
    onRequestDecision: (ApprovalKey, ApprovalDecision) -> Unit,
    modifier: Modifier = Modifier,
) {
    val submitting = submittingKey == request.key
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                KindIcon(request.kind, 58.dp)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(request.kind.title, style = MaterialTheme.typography.labelLarge, color = kindColors(request.kind).first)
                    Text(request.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(request.reference, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        item { HorizontalDivider() }
        item { DetailLine("التفاصيل", request.detail) }
        request.amount?.let { amount -> item { DetailLine("القيمة", amount) } }
        if (request.currentQuantity != null && request.targetQuantity != null) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    MetricTile("الرصيد الحالي", request.currentQuantity.pretty(), Modifier.weight(1f))
                    MetricTile("الرصيد المطلوب", request.targetQuantity.pretty(), Modifier.weight(1f))
                }
            }
        }
        item { DetailLine("وقت الطلب", formatDate(request.createdAt)) }
        item {
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = .55f),
                shape = RoundedCornerShape(18.dp),
            ) {
                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Verified, contentDescription = null, tint = MaterialTheme.colorScheme.secondary)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        "سيُسجّل القرار باسم حسابك وتعيد الخدمة التحقق من الصلاحية ونطاق الفرع.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = { onRequestDecision(request.key, ApprovalDecision.Approve) },
                    modifier = Modifier.weight(1f),
                    enabled = !submitting && request.capabilities.canApprove,
                ) {
                    if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Rounded.CheckCircle, contentDescription = null)
                    Spacer(Modifier.width(7.dp))
                    Text("اعتماد")
                }
                if (request.capabilities.canReject) {
                    OutlinedButton(
                        onClick = { onRequestDecision(request.key, ApprovalDecision.Reject()) },
                        modifier = Modifier.weight(1f),
                        enabled = !submitting,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) {
                        Text("رفض")
                    }
                }
            }
        }
    }
}

@Composable
private fun DecisionDialog(
    request: ApprovalRequest,
    initialDecision: ApprovalDecision,
    onDismiss: () -> Unit,
    onConfirm: (ApprovalDecision) -> Unit,
) {
    key(request.id, initialDecision::class) {
        val rejecting = initialDecision is ApprovalDecision.Reject
        val reasonRequired = rejecting &&
            request.capabilities.rejectionReasonPolicy == RejectionReasonPolicy.REQUIRED
        var reason by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = onDismiss,
            icon = {
                Icon(
                    if (rejecting) Icons.Rounded.WarningAmber else Icons.Rounded.Verified,
                    contentDescription = null,
                    tint = if (rejecting) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            },
            title = { Text(if (rejecting) "تأكيد الرفض" else "تأكيد الاعتماد") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("${request.title} · ${request.reference}")
                    if (reasonRequired) {
                        OutlinedTextField(
                            value = reason,
                            onValueChange = { if (it.length <= 500) reason = it },
                            label = { Text("سبب الرفض") },
                            supportingText = { Text("مطلوب · حتى 500 حرف") },
                            minLines = 3,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        onConfirm(if (rejecting) ApprovalDecision.Reject(reason.trim().takeIf { it.isNotEmpty() }) else ApprovalDecision.Approve)
                    },
                    enabled = !reasonRequired || reason.isNotBlank(),
                    colors = if (rejecting) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                    else ButtonDefaults.buttonColors(),
                ) { Text(if (rejecting) "رفض الطلب" else "اعتماد الطلب") }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
        )
    }
}

@Composable
private fun KindIcon(kind: ApprovalKind, size: androidx.compose.ui.unit.Dp) {
    val (color, container) = kindColors(kind)
    Box(Modifier.size(size).background(container, RoundedCornerShape(size / 3)), contentAlignment = Alignment.Center) {
        Icon(kindIcon(kind), contentDescription = null, tint = color)
    }
}

private fun kindIcon(kind: ApprovalKind): ImageVector = when (kind) {
    ApprovalKind.INVENTORY -> Icons.Rounded.Inventory2
    ApprovalKind.LEAVE -> Icons.Rounded.EventAvailable
    ApprovalKind.VOUCHER -> Icons.Rounded.Payments
    ApprovalKind.GIFT -> Icons.Rounded.CardGiftcard
}

@Composable
private fun kindColors(kind: ApprovalKind): Pair<Color, Color> = when (kind) {
    ApprovalKind.INVENTORY -> Color(0xFF087F6B) to Color(0xFFE4F5F1)
    ApprovalKind.LEAVE -> Color(0xFF5267B3) to Color(0xFFEBEEFF)
    ApprovalKind.VOUCHER -> Color(0xFF8B5A00) to Color(0xFFFFF0D1)
    ApprovalKind.GIFT -> ApprovalOrange to Color(0xFFFFEBDD)
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(modifier, color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.padding(14.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun NoticeBanner(message: String, onDismiss: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onDismiss)
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
            Text(message, Modifier.weight(1f))
            Text("إخفاء", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun InlineError(message: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.errorContainer,
        shape = RoundedCornerShape(14.dp),
    ) { Text(message, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer) }
}

@Composable
private fun LoadingState() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.WarningAmber, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(12.dp))
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(14.dp))
        Button(onClick = onRetry) { Text("إعادة المحاولة") }
    }
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    Column(
        modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(50.dp))
        Spacer(Modifier.height(12.dp))
        Text("لا توجد طلبات معلّقة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("ستظهر القرارات هنا فور وصولها", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SelectionHint() {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.Verified, contentDescription = null, modifier = Modifier.size(56.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(14.dp))
        Text("اختر طلبًا لمراجعته", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("ستظهر التفاصيل وإجراءات القرار هنا", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun Double.pretty(): String = if (this % 1.0 == 0.0) toLong().toString() else toString()

private fun formatDate(value: String): String = runCatching {
    OffsetDateTime.parse(value).format(DateTimeFormatter.ofPattern("d MMM yyyy، h:mm a", Locale.forLanguageTag("ar")))
}.getOrDefault(value)

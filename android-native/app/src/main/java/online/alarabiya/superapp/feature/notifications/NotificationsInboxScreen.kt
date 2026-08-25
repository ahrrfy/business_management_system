package online.alarabiya.superapp.feature.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.NotificationsNone
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.data.NotificationFilter
import online.alarabiya.superapp.model.selfservice.PersonalNotification
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Ink
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange

/**
 * ن-١ (٢٤/٨) — شاشة الإشعارات الأصيلة داخل التطبيق.
 *
 * تنويه UX: يُستدعى [onOpenRoute] حين ينقر المستخدم صفّاً يحمل route خادميّ آمناً؛
 * التنقّل الفعليّ يبقى مسؤوليّة SuperAppRoot لأنّه صاحبُ NavController، فتبقى الشاشة
 * محايدةً معمارياً وقابلةً للاختبار بلا كتلة تنقّلٍ خاصّة.
 */
@Composable
fun NotificationsInboxScreen(
    state: NotificationsInboxUiState,
    onRefresh: () -> Unit,
    onFilterChange: (NotificationFilter) -> Unit,
    onOpenRoute: (String) -> Unit,
    onMarkRead: (Long) -> Unit,
    onMarkAllRead: () -> Unit,
    onDismissBanner: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(Unit) { onRefresh() }
    Column(
        modifier
            .fillMaxSize()
            .background(Canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        Header(
            unreadCount = state.unreadCount,
            busy = state.busyKey != null,
            refreshing = state.refreshing,
            hasUnread = state.unreadCount > 0,
            onRefresh = onRefresh,
            onMarkAllRead = onMarkAllRead,
        )
        FilterBar(state.filter, onFilterChange, enabled = state.busyKey == null)
        Banner(message = state.message, error = state.error, onDismiss = onDismissBanner)
        when {
            state.loading && state.rows.isEmpty() -> LoadingContent()
            state.isEmpty -> EmptyContent(state.filter)
            else -> InboxList(state, onOpenRoute, onMarkRead)
        }
    }
}

@Composable
private fun Header(
    unreadCount: Int,
    busy: Boolean,
    refreshing: Boolean,
    hasUnread: Boolean,
    onRefresh: () -> Unit,
    onMarkAllRead: () -> Unit,
) {
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
            BadgedBox(
                badge = {
                    if (unreadCount > 0) Badge(containerColor = Orange, contentColor = Color.White) {
                        Text(unreadCount.coerceAtMost(99).toString())
                    }
                },
            ) {
                Surface(
                    color = Color.White.copy(alpha = .16f),
                    shape = RoundedCornerShape(topStart = 18.dp, bottomEnd = 18.dp, topEnd = 10.dp, bottomStart = 10.dp),
                ) {
                    Icon(Icons.Rounded.NotificationsActive, null, Modifier.padding(11.dp))
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("الإشعارات", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text(
                    if (unreadCount > 0) "$unreadCount غير مقروء" else "لا جديد",
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color.White.copy(alpha = .78f),
                )
            }
            IconButtonWithLabel(
                icon = Icons.Rounded.Refresh,
                label = "تحديث",
                enabled = !refreshing && !busy,
                testTag = "notifications_refresh",
                onClick = onRefresh,
            )
        }
    }
    if (hasUnread) {
        TextButton(
            onClick = onMarkAllRead,
            enabled = !busy,
            modifier = Modifier.padding(end = 18.dp, top = 6.dp).testTag("notifications_mark_all_read"),
        ) {
            Icon(Icons.Rounded.DoneAll, null, tint = EmeraldDark)
            Spacer(Modifier.width(6.dp))
            Text("قراءة الكل", style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun FilterBar(
    filter: NotificationFilter,
    onFilterChange: (NotificationFilter) -> Unit,
    enabled: Boolean,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterOption("الكل", filter == NotificationFilter.All, enabled, "notifications_filter_all") {
            onFilterChange(NotificationFilter.All)
        }
        FilterOption("غير المقروء", filter == NotificationFilter.UnreadOnly, enabled, "notifications_filter_unread") {
            onFilterChange(NotificationFilter.UnreadOnly)
        }
        FilterOption("يتطلّب إجراء", filter == NotificationFilter.RequiresActionOnly, enabled, "notifications_filter_action") {
            onFilterChange(NotificationFilter.RequiresActionOnly)
        }
    }
}

@Composable
private fun FilterOption(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    testTag: String,
    onSelect: () -> Unit,
) {
    FilterChip(
        selected = selected,
        onClick = onSelect,
        enabled = enabled,
        label = { Text(label) },
        modifier = Modifier.testTag(testTag),
        colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = Mint,
            selectedLabelColor = EmeraldDark,
        ),
    )
}

@Composable
private fun Banner(message: String?, error: String?, onDismiss: () -> Unit) {
    val text = error ?: message
    if (text == null) return
    val bg = if (error != null) MaterialTheme.colorScheme.errorContainer else Mint
    val fg = if (error != null) MaterialTheme.colorScheme.onErrorContainer else EmeraldDark
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 4.dp)
            .semantics { liveRegion = if (error != null) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        color = bg,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(if (error != null) Icons.Rounded.Warning else Icons.Rounded.CheckCircle, null, tint = fg)
            Text(text, color = fg, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onDismiss) { Text("إخفاء") }
        }
    }
}

@Composable
private fun LoadingContent() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Emerald)
    }
}

@Composable
private fun EmptyContent(filter: NotificationFilter) {
    val label = when (filter) {
        NotificationFilter.All -> "لا توجد إشعارات بعد"
        NotificationFilter.UnreadOnly -> "لا يوجد غير مقروء"
        NotificationFilter.RequiresActionOnly -> "لا يوجد ما يتطلّب إجراءً"
    }
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Rounded.NotificationsNone, null, tint = MutedInk, modifier = Modifier.size(56.dp))
            Text(label, style = MaterialTheme.typography.titleMedium, color = MutedInk, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun InboxList(
    state: NotificationsInboxUiState,
    onOpenRoute: (String) -> Unit,
    onMarkRead: (Long) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("notifications_list"),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(state.rows, key = { it.id }) { row ->
            NotificationRow(
                item = row,
                busyForRow = state.busyKey == "read:${row.id}",
                onOpen = { row.route?.let(onOpenRoute); if (row.isUnread) onMarkRead(row.id) },
                onMarkRead = { onMarkRead(row.id) },
            )
        }
    }
}

@Composable
private fun NotificationRow(
    item: PersonalNotification,
    busyForRow: Boolean,
    onOpen: () -> Unit,
    onMarkRead: () -> Unit,
) {
    val bg = if (item.isUnread) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .38f)
    else MaterialTheme.colorScheme.surfaceContainerLow
    Card(
        modifier = Modifier.fillMaxWidth().testTag("notification_row_${item.id}"),
        colors = CardDefaults.cardColors(containerColor = bg),
        shape = RoundedCornerShape(22.dp),
        onClick = onOpen,
        enabled = !busyForRow,
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                UnreadDot(item.isUnread)
                Text(
                    item.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                    color = Ink,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (item.requiresAction) ActionRequiredChip()
            }
            Text(item.body, style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            item.createdAt?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = MutedInk)
            }
            if (item.isUnread) {
                TextButton(
                    onClick = onMarkRead,
                    enabled = !busyForRow,
                    modifier = Modifier.testTag("notifications_mark_read_${item.id}"),
                ) {
                    Icon(Icons.Rounded.CheckCircle, null, tint = EmeraldDark)
                    Spacer(Modifier.width(6.dp))
                    Text("تعليم كمقروء")
                }
            }
        }
    }
}

@Composable
private fun UnreadDot(unread: Boolean) {
    Box(
        Modifier
            .padding(top = 6.dp)
            .size(10.dp)
            .clip(CircleShape)
            .background(if (unread) Orange else Color.Transparent),
    )
}

@Composable
private fun ActionRequiredChip() {
    Surface(color = Orange.copy(alpha = .18f), shape = RoundedCornerShape(999.dp)) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.Rounded.Info, null, tint = Orange, modifier = Modifier.size(14.dp))
            Text("إجراء", style = MaterialTheme.typography.labelSmall, color = Orange)
        }
    }
}

@Composable
private fun IconButtonWithLabel(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.height(40.dp).testTag(testTag),
    ) {
        Icon(icon, null)
        Spacer(Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

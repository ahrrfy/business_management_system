package online.alarabiya.superapp.feature.announcements

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.announcements.Announcement
import online.alarabiya.superapp.model.announcements.AnnouncementPriority
import online.alarabiya.superapp.ui.rtlIsolate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun AnnouncementsFeedRoute(
    viewModel: AnnouncementsFeedViewModel,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel) {
        if (viewModel.state.feed == null) viewModel.refresh()
    }
    AnnouncementsFeedScreen(
        state = viewModel.state,
        onRefresh = viewModel::refresh,
        onOpen = viewModel::openDetail,
        onClose = viewModel::closeDetail,
        onAcknowledge = viewModel::acknowledge,
        onMarkRead = viewModel::markRead,
        modifier = modifier,
    )
}

@Composable
fun AnnouncementsFeedScreen(
    state: AnnouncementsFeedUiState,
    onRefresh: () -> Unit,
    onOpen: (Long) -> Unit,
    onClose: () -> Unit,
    onAcknowledge: (Long) -> Unit,
    onMarkRead: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val feed = state.feed
    Column(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface)
            .testTag("native-route-announcements"),
    ) {
        AnnouncementsHeader(
            unreadCount = feed?.unreadCount ?: 0,
            refreshing = state.loading,
            onRefresh = onRefresh,
        )

        state.message?.let { InlineMessage(it, error = false) }
        state.error?.let { InlineMessage(it, error = true) }

        when {
            feed == null && state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            feed == null -> EmptyFeed("حدّث الصفحة لتحميل الإعلانات")
            feed.rows.isEmpty() -> EmptyFeed("لا إعلانات")
            else -> LazyColumn(
                contentPadding = PaddingValues(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(feed.rows, key = { it.id }) { announcement ->
                    AnnouncementCard(
                        announcement = announcement,
                        busy = state.busyKey != null,
                        onOpen = onOpen,
                        onAcknowledge = onAcknowledge,
                        onMarkRead = onMarkRead,
                    )
                }
            }
        }
    }

    state.selected?.let { selected ->
        AnnouncementDetailDialog(
            announcement = selected,
            busy = state.busyKey != null,
            onAcknowledge = onAcknowledge,
            onClose = onClose,
        )
    }
}

@Composable
private fun AnnouncementsHeader(
    unreadCount: Int,
    refreshing: Boolean,
    onRefresh: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(44.dp).clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.Campaign,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
                Column(Modifier.semantics { heading() }) {
                    Text("الإعلانات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(
                        "إعلانات الشركة الموجّهة إليك",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (unreadCount > 0) UnreadBadge(unreadCount)
                IconButton(
                    onClick = onRefresh,
                    enabled = !refreshing,
                    modifier = Modifier.testTag("announcement_refresh"),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "تحديث", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun UnreadBadge(count: Int) {
    Box(
        Modifier.clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.error)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            rtlIsolate(count.toString()),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onError,
        )
    }
}

@Composable
private fun AnnouncementCard(
    announcement: Announcement,
    busy: Boolean,
    onOpen: (Long) -> Unit,
    onAcknowledge: (Long) -> Unit,
    onMarkRead: (Long) -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpen(announcement.id) }
            .testTag("announcement_card_${announcement.id}"),
        colors = CardDefaults.cardColors(
            containerColor = if (!announcement.isRead) {
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = .38f)
            } else {
                MaterialTheme.colorScheme.surfaceContainerLow
            },
        ),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    announcement.title,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                PriorityChip(announcement.priority)
            }
            Text(
                announcement.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    rtlIsolate(formatDate(announcement.createdAt)),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!announcement.isRead) UnreadDot()
            }
            if (announcement.needsAcknowledgement || !announcement.isRead) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (announcement.needsAcknowledgement) {
                        Button(
                            onClick = { onAcknowledge(announcement.id) },
                            enabled = !busy,
                            modifier = Modifier.weight(1f).testTag("announcement_ack_${announcement.id}"),
                            shape = RoundedCornerShape(15.dp),
                        ) {
                            Icon(Icons.Rounded.DoneAll, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("إقرار بالقراءة")
                        }
                    }
                    if (!announcement.isRead) {
                        TextButton(
                            onClick = { onMarkRead(announcement.id) },
                            enabled = !busy,
                            modifier = Modifier.testTag("announcement_read_${announcement.id}"),
                        ) { Text("تعليم كمقروء") }
                    }
                }
            }
        }
    }
}

@Composable
private fun AnnouncementDetailDialog(
    announcement: Announcement,
    busy: Boolean,
    onAcknowledge: (Long) -> Unit,
    onClose: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onClose,
        modifier = Modifier.testTag("announcement_detail_${announcement.id}"),
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                IconButton(onClick = onClose, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "عودة")
                }
                Text(
                    announcement.title,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
            }
        },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PriorityChip(announcement.priority)
                    Text(
                        rtlIsolate(formatDate(announcement.createdAt)),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(announcement.body, style = MaterialTheme.typography.bodyMedium)
                if (announcement.isAcknowledged) {
                    Text(
                        "تم الإقرار بهذا الإعلان",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        },
        confirmButton = {
            if (announcement.needsAcknowledgement) {
                Button(
                    onClick = { onAcknowledge(announcement.id) },
                    enabled = !busy,
                    modifier = Modifier.testTag("announcement_detail_ack_${announcement.id}"),
                ) { Text("إقرار بالقراءة") }
            } else {
                TextButton(onClick = onClose, enabled = !busy) { Text("إغلاق") }
            }
        },
        dismissButton = if (announcement.needsAcknowledgement) {
            { TextButton(onClick = onClose, enabled = !busy) { Text("إغلاق") } }
        } else {
            null
        },
    )
}

@Composable
private fun PriorityChip(priority: AnnouncementPriority) {
    val color = when (priority) {
        AnnouncementPriority.CRITICAL -> MaterialTheme.colorScheme.error
        AnnouncementPriority.IMPORTANT -> MaterialTheme.colorScheme.tertiary
        AnnouncementPriority.NORMAL -> MaterialTheme.colorScheme.primary
    }
    AssistChip(
        onClick = {},
        enabled = false,
        label = { Text(priority.label, style = MaterialTheme.typography.labelMedium) },
        colors = AssistChipDefaults.assistChipColors(
            containerColor = color.copy(alpha = .12f),
            labelColor = color,
            disabledContainerColor = color.copy(alpha = .12f),
            disabledLabelColor = color,
        ),
        border = null,
        shape = RoundedCornerShape(50),
    )
}

@Composable
private fun UnreadDot() {
    Box(
        Modifier.size(10.dp).clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.primary),
    )
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
private fun EmptyFeed(text: String) {
    Box(Modifier.fillMaxSize().padding(40.dp), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                Icons.Rounded.Campaign,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(40.dp),
            )
            Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private val announcementDateFormatter: DateTimeFormatter =
    DateTimeFormatter.ofPattern("d MMM yyyy، h:mm a", Locale.forLanguageTag("ar-IQ-u-nu-latn"))

private fun formatDate(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return runCatching { OffsetDateTime.parse(iso).format(announcementDateFormatter) }.getOrDefault(iso)
}

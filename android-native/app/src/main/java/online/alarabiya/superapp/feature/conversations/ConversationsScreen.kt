package online.alarabiya.superapp.feature.conversations

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Storefront
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import online.alarabiya.superapp.model.conversations.ApprovedWhatsappTemplate
import online.alarabiya.superapp.model.conversations.ConversationCapabilities
import online.alarabiya.superapp.model.conversations.ConversationChannel
import online.alarabiya.superapp.model.conversations.ConversationFilter
import online.alarabiya.superapp.model.conversations.ConversationMessage
import online.alarabiya.superapp.model.conversations.ConversationSendPolicy
import online.alarabiya.superapp.model.conversations.ConversationSummary
import online.alarabiya.superapp.model.conversations.DeliveryStatus
import online.alarabiya.superapp.model.conversations.MessageDirection
import online.alarabiya.superapp.model.conversations.WhatsappLaunchTarget
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun ConversationsRoute(
    viewModel: ConversationsViewModel,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    ConversationsScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = ConversationsActions(
            refresh = viewModel::refresh,
            setQuery = viewModel::setQuery,
            search = viewModel::applySearch,
            setFilter = viewModel::setFilter,
            setChannel = viewModel::setChannel,
            select = viewModel::select,
            loadMore = viewModel::loadMore,
            updateDraft = viewModel::updateDraft,
            sendText = viewModel::sendText,
            requestWhatsapp = viewModel::requestWhatsappHandoff,
            dismissWhatsapp = viewModel::dismissWhatsappHandoff,
            openWhatsapp = { target ->
                if (WhatsappAppLauncher.open(context, target)) viewModel.whatsappOpened()
            },
            loadTemplates = viewModel::loadTemplates,
            selectTemplate = viewModel::selectTemplate,
            updateTemplateParameter = viewModel::updateTemplateParameter,
            sendTemplate = viewModel::sendTemplate,
            retry = viewModel::retry,
            clearNotice = viewModel::clearNotice,
        ),
        modifier = modifier,
    )
}

data class ConversationsActions(
    val refresh: () -> Unit,
    val setQuery: (String) -> Unit,
    val search: () -> Unit,
    val setFilter: (ConversationFilter) -> Unit,
    val setChannel: (ConversationChannel?) -> Unit,
    val select: (Long?) -> Unit,
    val loadMore: () -> Unit,
    val updateDraft: (String) -> Unit,
    val sendText: () -> Unit,
    val requestWhatsapp: () -> Unit,
    val dismissWhatsapp: () -> Unit,
    val openWhatsapp: (WhatsappLaunchTarget) -> Unit,
    val loadTemplates: () -> Unit,
    val selectTemplate: (ApprovedWhatsappTemplate?) -> Unit,
    val updateTemplateParameter: (Int, String) -> Unit,
    val sendTemplate: () -> Unit,
    val retry: (Long) -> Unit,
    val clearNotice: () -> Unit,
)

@Composable
fun ConversationsScreen(
    state: ConversationsUiState,
    capabilities: ConversationCapabilities,
    actions: ConversationsActions,
    modifier: Modifier = Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        BoxWithConstraints(modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
            val expanded = maxWidth >= 840.dp
            when {
                !capabilities.access.canRead -> AccessDenied()
                capabilities.allBranches && state.branchId == null -> BranchRequired()
                expanded -> Row(Modifier.fillMaxSize()) {
                    ConversationListPane(state, actions, Modifier.width(380.dp).fillMaxHeight())
                    Surface(Modifier.width(1.dp).fillMaxHeight(), color = MaterialTheme.colorScheme.outlineVariant) {}
                    ConversationDetailPane(state, capabilities, actions, Modifier.weight(1f).fillMaxHeight(), showBack = false)
                }
                state.selectedConversation != null -> ConversationDetailPane(
                    state,
                    capabilities,
                    actions,
                    Modifier.fillMaxSize(),
                    showBack = true,
                )
                else -> ConversationListPane(state, actions, Modifier.fillMaxSize())
            }
        }
        state.pendingWhatsapp?.let { target ->
            AlertDialog(
                onDismissRequest = actions.dismissWhatsapp,
                title = { Text("فتح واتساب") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("سيُفتح تطبيق واتساب الرسمي بهذا النص. راجع الرسالة ثم أرسلها من داخل واتساب.")
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainer,
                            shape = RoundedCornerShape(16.dp),
                        ) {
                            Text(target.messagePreview, Modifier.padding(14.dp), maxLines = 8, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                confirmButton = { Button(onClick = { actions.openWhatsapp(target) }) { Text("فتح واتساب") } },
                dismissButton = { TextButton(onClick = actions.dismissWhatsapp) { Text("إلغاء") } },
            )
        }
    }
}

@Composable
private fun ConversationListPane(
    state: ConversationsUiState,
    actions: ConversationsActions,
    modifier: Modifier,
) {
    Column(modifier.background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("المحادثات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("قنوات العملاء", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = actions.refresh, enabled = !state.loading && !state.refreshing) {
                Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
            }
        }
        OutlinedTextField(
            value = state.query,
            onValueChange = actions.setQuery,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("اسم أو رقم") },
            leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { actions.search() }),
            shape = RoundedCornerShape(18.dp),
        )
        LazyColumn(
            modifier = Modifier.fillMaxWidth().height(108.dp),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ConversationFilter.entries.forEach { filter ->
                        FilterChip(
                            selected = state.filter == filter,
                            onClick = { actions.setFilter(filter) },
                            label = { Text(filter.label) },
                        )
                    }
                }
            }
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = state.channel == null,
                        onClick = { actions.setChannel(null) },
                        label = { Text("كل القنوات") },
                    )
                    ConversationChannel.entries.forEach { channel ->
                        FilterChip(
                            selected = state.channel == channel,
                            onClick = { actions.setChannel(channel) },
                            label = { Text(channel.label) },
                        )
                    }
                }
            }
        }
        state.error?.let { InlineMessage(it, error = true) }
        state.notice?.let { InlineMessage(it, error = false, onClick = actions.clearNotice) }
        when {
            state.loading && state.conversations.isEmpty() -> Loading(Modifier.weight(1f))
            state.conversations.isEmpty() -> Empty("لا توجد محادثات", Modifier.weight(1f))
            else -> {
                val listState = rememberLazyListState()
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    items(state.conversations, key = ConversationSummary::id) { conversation ->
                        ConversationRow(
                            conversation = conversation,
                            selected = state.selectedId == conversation.id,
                            onClick = { actions.select(conversation.id) },
                        )
                    }
                    if (state.nextCursor != null) {
                        item {
                            OutlinedButton(
                                onClick = actions.loadMore,
                                enabled = !state.loadingMore,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.loadingMore) CircularProgressIndicator(Modifier.size(18.dp)) else Text("عرض المزيد")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(conversation: ConversationSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 26.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            ChannelIcon(conversation.channel)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        conversation.title,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (conversation.unreadCount > 0) {
                        Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(50)) {
                            Text(
                                conversation.unreadCount.toString(),
                                Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                color = MaterialTheme.colorScheme.onPrimary,
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }
                Text(
                    conversation.lastMessagePreview ?: "لا رسائل بعد",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${conversation.channel.label} · ${formatTime(conversation.lastMessageAt)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ConversationDetailPane(
    state: ConversationsUiState,
    capabilities: ConversationCapabilities,
    actions: ConversationsActions,
    modifier: Modifier,
    showBack: Boolean,
) {
    val conversation = state.selectedConversation
    if (conversation == null) {
        Empty("اختر محادثة لعرض الرسائل", modifier)
        return
    }
    Column(modifier.background(MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showBack) {
                IconButton(onClick = { actions.select(null) }) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "العودة")
                }
            }
            ChannelIcon(conversation.channel)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(conversation.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    conversation.channelHandle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (conversation.apiActive) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(50)) {
                    Text("API", Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        state.error?.let { InlineMessage(it, error = true) }
        state.notice?.let { InlineMessage(it, error = false, onClick = actions.clearNotice) }
        when {
            state.loadingMessages -> Loading(Modifier.weight(1f))
            state.messages.isEmpty() -> Empty("لا توجد رسائل في هذه المحادثة", Modifier.weight(1f))
            else -> LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp),
                reverseLayout = false,
            ) {
                items(state.messages, key = ConversationMessage::id) { message ->
                    MessageBubble(message, retrying = state.busyKey == "retry:${message.pending?.outboxId}", onRetry = actions.retry)
                }
            }
        }
        Composer(state, conversation, capabilities, actions)
    }
}

@Composable
private fun Composer(
    state: ConversationsUiState,
    conversation: ConversationSummary,
    capabilities: ConversationCapabilities,
    actions: ConversationsActions,
) {
    val canSendText = ConversationSendPolicy.canSendFreeText(conversation, capabilities)
    val canOpenWhatsapp = ConversationSendPolicy.canOpenExternalWhatsapp(conversation, capabilities)
    val canTemplate = ConversationSendPolicy.canUseApprovedTemplate(conversation, capabilities)
    Surface(shadowElevation = 8.dp, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (capabilities.access.canManage && conversation.channel == ConversationChannel.WHATSAPP && conversation.apiActive) {
                Text(
                    if (canSendText) "الرد المباشر متاح" else "انتهت نافذة الرد المباشر",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (canSendText) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedTextField(
                value = state.draft,
                onValueChange = actions.updateDraft,
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(if (canSendText) "اكتب رسالة" else "اكتب نصاً لفتحه في واتساب") },
                minLines = 2,
                maxLines = 5,
                enabled = capabilities.access.canManage && conversation.channel == ConversationChannel.WHATSAPP,
                shape = RoundedCornerShape(18.dp),
            )
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (canSendText) {
                    Button(onClick = actions.sendText, enabled = state.draft.isNotBlank() && state.busyKey == null) {
                        Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("إرسال")
                    }
                }
                if (canOpenWhatsapp) {
                    OutlinedButton(onClick = actions.requestWhatsapp, enabled = state.draft.isNotBlank() && state.busyKey == null) {
                        Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("فتح واتساب")
                    }
                }
                if (canTemplate) {
                    OutlinedButton(onClick = actions.loadTemplates, enabled = !state.templatesLoading) {
                        if (state.templatesLoading) CircularProgressIndicator(Modifier.size(18.dp)) else Text("قالب معتمد")
                    }
                }
            }
            if (canTemplate && state.templates.isNotEmpty()) TemplateComposer(state, actions)
        }
    }
}

@Composable
private fun TemplateComposer(state: ConversationsUiState, actions: ConversationsActions) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box {
            OutlinedButton(onClick = { expanded = true }) {
                Text(state.selectedTemplate?.name ?: "اختر القالب")
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                state.templates.forEach { template ->
                    DropdownMenuItem(
                        text = { Text("${template.name} · ${template.language}") },
                        onClick = {
                            actions.selectTemplate(template)
                            expanded = false
                        },
                    )
                }
            }
        }
        state.selectedTemplate?.let { template ->
            template.bodyText?.let {
                Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(14.dp)) {
                    Text(it, Modifier.fillMaxWidth().padding(12.dp))
                }
            }
            state.templateParameters.forEachIndexed { index, value ->
                OutlinedTextField(
                    value = value,
                    onValueChange = { actions.updateTemplateParameter(index, it) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("متغير ${index + 1}") },
                    singleLine = true,
                )
            }
            Button(
                onClick = actions.sendTemplate,
                enabled = state.templateParameters.all(String::isNotBlank) && state.busyKey == null,
            ) { Text("إرسال القالب") }
        }
    }
}

@Composable
private fun MessageBubble(message: ConversationMessage, retrying: Boolean, onRetry: (Long) -> Unit) {
    val outgoing = message.direction == MessageDirection.OUT
    val note = message.direction == MessageDirection.NOTE
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (note) Arrangement.Center else if (outgoing) Arrangement.Start else Arrangement.End,
    ) {
        Surface(
            color = when {
                note -> MaterialTheme.colorScheme.secondaryContainer
                outgoing -> MaterialTheme.colorScheme.primaryContainer
                else -> MaterialTheme.colorScheme.surfaceContainerHigh
            },
            shape = if (note) RoundedCornerShape(14.dp) else RoundedCornerShape(
                topStart = 22.dp,
                topEnd = 22.dp,
                bottomStart = if (outgoing) 6.dp else 22.dp,
                bottomEnd = if (outgoing) 22.dp else 6.dp,
            ),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp).widthIn(min = 120.dp, max = 560.dp)) {
                if (note) Text("ملاحظة داخلية", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                message.body?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                if (message.mediaType != null) {
                    Text("مرفق · ${message.mediaType}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        formatTime(message.createdAt),
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    DeliveryMark(message)
                }
                message.pending?.takeIf { it.status == "FAILED" }?.let { pending ->
                    TextButton(onClick = { onRetry(pending.outboxId) }, enabled = !retrying) {
                        Text(if (retrying) "جارٍ المحاولة" else "إعادة المحاولة")
                    }
                }
            }
        }
    }
}

@Composable
private fun DeliveryMark(message: ConversationMessage) {
    val icon: ImageVector
    val color: Color
    when {
        message.pending?.status == "FAILED" || message.deliveryStatus == DeliveryStatus.FAILED -> {
            icon = Icons.Rounded.ErrorOutline
            color = MaterialTheme.colorScheme.error
        }
        message.deliveryStatus == DeliveryStatus.READ || message.deliveryStatus == DeliveryStatus.DELIVERED -> {
            icon = Icons.Rounded.DoneAll
            color = MaterialTheme.colorScheme.primary
        }
        message.deliveryStatus == DeliveryStatus.SENT -> {
            icon = Icons.Rounded.Check
            color = MaterialTheme.colorScheme.onSurfaceVariant
        }
        message.pending != null || message.deliveryStatus == DeliveryStatus.PENDING -> {
            icon = Icons.Rounded.MoreHoriz
            color = MaterialTheme.colorScheme.onSurfaceVariant
        }
        else -> return
    }
    Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(17.dp))
}

@Composable
private fun ChannelIcon(channel: ConversationChannel) {
    val icon = when (channel) {
        ConversationChannel.WHATSAPP -> Icons.AutoMirrored.Rounded.Chat
        ConversationChannel.STORE -> Icons.Rounded.Storefront
        ConversationChannel.PHONE -> Icons.Rounded.Phone
        else -> Icons.AutoMirrored.Rounded.Chat
    }
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(16.dp)) {
        Icon(icon, contentDescription = channel.label, Modifier.padding(10.dp), tint = MaterialTheme.colorScheme.secondary)
    }
}

@Composable
private fun InlineMessage(text: String, error: Boolean, onClick: (() -> Unit)? = null) {
    val modifier = Modifier.fillMaxWidth()
        .background(if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer)
        .heightIn(min = 48.dp)
        .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
        .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite }
        .padding(horizontal = 16.dp, vertical = 10.dp)
    Text(
        text,
        modifier,
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

@Composable
private fun Loading(modifier: Modifier) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun Empty(text: String, modifier: Modifier) {
    Column(
        modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(10.dp))
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun AccessDenied() {
    Empty("لا توجد صلاحية لعرض المحادثات", Modifier.fillMaxSize())
}

@Composable
private fun BranchRequired() {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.WarningAmber, contentDescription = null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(12.dp))
        Text("اختر الفرع", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("تعرض المحادثات ضمن فرع واحد في كل مرة", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

internal object WhatsappAppLauncher {
    private val packageNames = listOf("com.whatsapp", "com.whatsapp.w4b")

    fun open(context: Context, target: WhatsappLaunchTarget): Boolean {
        packageNames.forEach { packageName ->
            val intent = Intent(Intent.ACTION_VIEW, target.uri.toUri()).apply {
                setPackage(packageName)
            }
            try {
                context.startActivity(intent)
                return true
            } catch (_: ActivityNotFoundException) {
                // Try the other official package. There is deliberately no browser fallback.
            }
        }
        Toast.makeText(context, "واتساب غير مثبت على الجهاز", Toast.LENGTH_SHORT).show()
        return false
    }
}

private fun formatTime(value: String?): String {
    if (value.isNullOrBlank()) return "—"
    return runCatching {
        val instant = runCatching { Instant.parse(value) }
            .getOrElse { OffsetDateTime.parse(value).toInstant() }
        DateTimeFormatter.ofPattern("d MMM، h:mm a", Locale.forLanguageTag("ar-IQ-u-nu-latn"))
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }.getOrDefault(value.take(16))
}

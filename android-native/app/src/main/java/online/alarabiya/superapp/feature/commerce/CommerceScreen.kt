package online.alarabiya.superapp.feature.commerce

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.CardGiftcard
import androidx.compose.material.icons.rounded.CreditCard
import androidx.compose.material.icons.rounded.EventAvailable
import androidx.compose.material.icons.rounded.Refresh
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
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardAvailability
import online.alarabiya.superapp.model.commerce.DigitalSubscription
import online.alarabiya.superapp.model.commerce.GiftDetail
import online.alarabiya.superapp.model.commerce.GiftDirection
import online.alarabiya.superapp.model.commerce.GiftSummary
import online.alarabiya.superapp.model.commerce.ReservationDetail
import online.alarabiya.superapp.model.commerce.ReservationConversion
import online.alarabiya.superapp.model.commerce.ReservationSummary
import online.alarabiya.superapp.ui.rtlIsolate
import java.text.NumberFormat
import java.util.Locale

@Composable
fun CommerceRoute(
    viewModel: CommerceViewModel,
    capabilities: CommerceCapabilities,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel, capabilities.branchId) {
        viewModel.initialize(capabilities.branchId, capabilities)
        if (viewModel.state.section !in viewModel.state.loadedSections) viewModel.refresh(capabilities)
    }
    CommerceScreen(
        state = viewModel.state,
        capabilities = capabilities,
        onSelect = { viewModel.select(it, capabilities) },
        onQueryChange = viewModel::changeQuery,
        onBranchChange = {
            viewModel.changeBranch(it)
            viewModel.refresh(capabilities)
        },
        onRefresh = { viewModel.refresh(capabilities) },
        onOpenGift = viewModel::openGift,
        onCloseGift = viewModel::closeGift,
        onApproveGift = { viewModel.approveGift(it, capabilities) },
        onOpenReservation = viewModel::openReservation,
        onCloseReservation = viewModel::closeReservation,
        onCancelReservation = { id, reason -> viewModel.cancelReservation(id, reason, capabilities) },
        onExtendReservation = { id, hours -> viewModel.extendReservation(id, hours, capabilities) },
        onConvertReservation = { viewModel.convertReservation(it, capabilities) },
        onConfirmCard = { viewModel.confirmCard(it, capabilities) },
        modifier = modifier,
    )
}

@Composable
fun CommerceScreen(
    state: CommerceUiState,
    capabilities: CommerceCapabilities,
    onSelect: (CommerceSection) -> Unit,
    onQueryChange: (String) -> Unit,
    onBranchChange: (Long) -> Unit,
    onRefresh: () -> Unit,
    onOpenGift: (Long) -> Unit,
    onCloseGift: () -> Unit,
    onApproveGift: (Long) -> Unit,
    onOpenReservation: (Long) -> Unit,
    onCloseReservation: () -> Unit,
    onCancelReservation: (Long, String?) -> Unit,
    onExtendReservation: (Long, Int) -> Unit,
    onConvertReservation: (Long) -> Unit,
    onConfirmCard: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val readableSections = capabilities.readableSections()
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        Surface(
            color = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
            shape = RoundedCornerShape(bottomStart = 44.dp, bottomEnd = 18.dp),
            shadowElevation = 5.dp,
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 22.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("التجارة والخدمات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("الهدايا والحجوزات والبطاقات", color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .72f))
                }
                IconButton(
                    onClick = onRefresh,
                    enabled = !state.loading && state.busyKey == null,
                    modifier = Modifier.clip(RoundedCornerShape(topStart = 18.dp, bottomEnd = 18.dp, topEnd = 11.dp, bottomStart = 11.dp))
                        .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = .14f)),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
                }
            }
        }
        if (readableSections.isNotEmpty()) ScrollableTabRow(
            selectedTabIndex = readableSections.indexOf(state.section).coerceAtLeast(0),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)
                .clip(RoundedCornerShape(28.dp)),
            edgePadding = 4.dp,
            containerColor = MaterialTheme.colorScheme.primaryContainer,
            indicator = {},
            divider = {},
        ) {
            readableSections.forEach { section ->
                Tab(
                    selected = section == state.section,
                    onClick = { onSelect(section) },
                    enabled = state.busyKey == null && !state.loading,
                    modifier = Modifier.padding(4.dp).clip(RoundedCornerShape(22.dp))
                        .background(if (section == state.section) Color.White else Color.Transparent),
                    text = { Text(section.label) },
                    icon = { Icon(section.icon, contentDescription = null) },
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(
                value = state.query,
                onValueChange = onQueryChange,
                label = { Text("بحث") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        if (capabilities.allBranches && state.branches.isNotEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.branches, key = { it.id }) { branch ->
                    FilterChip(
                        selected = state.branchId == branch.id,
                        onClick = { onBranchChange(branch.id) },
                        label = { Text(branch.name) },
                    )
                }
            }
        }
        state.message?.let { InlineMessage(it, false) }
        state.error?.let { InlineMessage(it, true) }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            } else {
                when (state.section) {
                    CommerceSection.Gifts -> GiftsContent(
                        detail = state.giftDetail,
                        rows = state.gifts?.rows.orEmpty(),
                        capabilities = capabilities,
                        busy = state.busyKey != null,
                        onOpen = onOpenGift,
                        onClose = onCloseGift,
                        onApprove = onApproveGift,
                    )
                    CommerceSection.Reservations -> ReservationsContent(
                        detail = state.reservationDetail,
                        rows = state.reservations?.rows.orEmpty(),
                        conversion = state.lastConversion,
                        capabilities = capabilities,
                        busy = state.busyKey != null,
                        onOpen = onOpenReservation,
                        onClose = onCloseReservation,
                        onCancel = onCancelReservation,
                        onExtend = onExtendReservation,
                        onConvert = onConvertReservation,
                    )
                    CommerceSection.DigitalCards -> DigitalCardsContent(
                        cards = state.digitalCards,
                        confirmed = state.confirmedCard,
                        busy = state.busyKey != null,
                        onConfirm = onConfirmCard,
                    )
                    CommerceSection.Subscriptions -> SubscriptionsContent(state.subscriptions)
                }
            }
        }
    }
}

@Composable
private fun GiftsContent(
    detail: GiftDetail?,
    rows: List<GiftSummary>,
    capabilities: CommerceCapabilities,
    busy: Boolean,
    onOpen: (Long) -> Unit,
    onClose: () -> Unit,
    onApprove: (Long) -> Unit,
) {
    if (detail != null) {
        GiftDetailContent(detail, capabilities, busy, onClose, onApprove)
        return
    }
    if (rows.isEmpty()) return Empty("لا توجد سندات هدايا ضمن النطاق")
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(rows, key = { it.id }) { gift ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(gift.number, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(gift.partyName ?: "بلا طرف محدد", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Status(giftStatusLabel(gift.status.name), if (gift.direction == GiftDirection.IN) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary)
                }
                gift.reason?.let { Text(it) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { onOpen(gift.id) }, enabled = !busy) { Text("التفاصيل") }
                }
            }
        }
    }
}

@Composable
private fun GiftDetailContent(
    detail: GiftDetail,
    capabilities: CommerceCapabilities,
    busy: Boolean,
    onClose: () -> Unit,
    onApprove: (Long) -> Unit,
) {
    var confirmApproval by rememberSaveable(detail.id) { mutableStateOf(false) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { BackHeader("سند ${detail.number}", onClose) }
        item {
            SectionCard {
                Status(giftStatusLabel(detail.status.name), MaterialTheme.colorScheme.primary)
                DetailRow("الطرف", detail.partyName ?: "—")
                DetailRow("الهاتف", detail.partyPhone ?: "—")
                DetailRow("النوع", detail.type ?: "—")
                DetailRow("الغرض", if (detail.sellable) "قابل للبيع" else "استخدام داخلي")
                detail.reason?.let { DetailRow("السبب", it) }
                if (detail.direction == GiftDirection.OUT && detail.status.name == "PENDING_APPROVAL" && capabilities.canApproveGifts) {
                    Button(onClick = { confirmApproval = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text("اعتماد الهدية")
                    }
                }
            }
        }
        items(detail.lines, key = { "${it.sku}:${it.productName}:${it.unitName}" }) { line ->
            SectionCard {
                Text(line.productName, fontWeight = FontWeight.Bold)
                DetailRow("الوحدة", line.unitName ?: "—")
                DetailRow("الكمية", line.quantity)
                line.sku?.let { DetailRow("SKU", it) }
            }
        }
    }
    if (confirmApproval) {
        ConfirmDialog(
            title = "اعتماد سند الهدية؟",
            text = "سيطبق الخادم فصل الصلاحيات ويمنع اعتماد منشئ السند لنفسه.",
            onDismiss = { confirmApproval = false },
            onConfirm = { confirmApproval = false; onApprove(detail.id) },
        )
    }
}

@Composable
private fun ReservationsContent(
    detail: ReservationDetail?,
    rows: List<ReservationSummary>,
    conversion: ReservationConversion?,
    capabilities: CommerceCapabilities,
    busy: Boolean,
    onOpen: (Long) -> Unit,
    onClose: () -> Unit,
    onCancel: (Long, String?) -> Unit,
    onExtend: (Long, Int) -> Unit,
    onConvert: (Long) -> Unit,
) {
    if (detail != null) {
        ReservationDetailContent(detail, conversion, capabilities, busy, onClose, onCancel, onExtend, onConvert)
        return
    }
    if (rows.isEmpty()) return Empty("لا توجد حجوزات ضمن النطاق")
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(rows, key = { it.id }) { reservation ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(reservation.number, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(reservation.contactName ?: reservation.contactPhone ?: "عميل نقدي")
                    }
                    Status(reservationStatusLabel(reservation.status.name), MaterialTheme.colorScheme.primary)
                }
                DetailRow("ينتهي", reservation.expiresAt ?: "—")
                TextButton(onClick = { onOpen(reservation.id) }, enabled = !busy, modifier = Modifier.align(Alignment.End)) {
                    Text("فتح الحجز")
                }
            }
        }
    }
}

@Composable
private fun ReservationDetailContent(
    detail: ReservationDetail,
    conversion: ReservationConversion?,
    capabilities: CommerceCapabilities,
    busy: Boolean,
    onClose: () -> Unit,
    onCancel: (Long, String?) -> Unit,
    onExtend: (Long, Int) -> Unit,
    onConvert: (Long) -> Unit,
) {
    var action by rememberSaveable(detail.summary.id) { mutableStateOf<String?>(null) }
    var reason by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var hours by rememberSaveable(detail.summary.id) { mutableStateOf("24") }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { BackHeader("الحجز ${detail.summary.number}", onClose) }
        if (conversion?.reservationId == detail.summary.id) {
            item {
                SectionCard {
                    Text("نتيجة التحويل", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    DetailRow("الفاتورة", conversion.invoiceNumber)
                    MoneyRow("الإجمالي", conversion.total)
                    if (conversion.idempotentReplay) Text("تم استرجاع النتيجة السابقة بأمان")
                }
            }
        }
        item {
            SectionCard {
                Status(reservationStatusLabel(detail.summary.status.name), MaterialTheme.colorScheme.primary)
                DetailRow("العميل", detail.summary.contactName ?: "—")
                DetailRow("الهاتف", detail.summary.contactPhone ?: "—")
                DetailRow("الانتهاء", detail.summary.expiresAt ?: "—")
                MoneyRow("الإجمالي", detail.total)
                if (detail.hasUnpriced) Text("الإجمالي جزئي لوجود بند بلا سعر", color = MaterialTheme.colorScheme.error)
            }
        }
        items(detail.lines, key = { it.id }) { line ->
            SectionCard {
                Text(line.productName, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(line.variantName, line.unitName).joinToString(" · "))
                DetailRow("الكمية", line.quantity)
                line.lineTotal?.let { MoneyRow("الإجمالي", it) }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (detail.canCancel(capabilities)) OutlinedButton(onClick = { action = "cancel" }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("إلغاء") }
                if (detail.canExtend(capabilities)) OutlinedButton(onClick = { action = "extend" }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("تمديد") }
            }
            if (detail.canConvert(capabilities)) {
                Button(onClick = { action = "convert" }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text("تحويل إلى فاتورة")
                }
            }
        }
    }
    when (action) {
        "cancel" -> AlertDialog(
            onDismissRequest = { action = null },
            title = { Text("إلغاء الحجز") },
            text = { OutlinedTextField(reason, { reason = it }, label = { Text("سبب الإلغاء (اختياري)") }) },
            confirmButton = { TextButton(onClick = { action = null; onCancel(detail.summary.id, reason) }) { Text("تأكيد الإلغاء") } },
            dismissButton = { TextButton(onClick = { action = null }) { Text("رجوع") } },
        )
        "extend" -> AlertDialog(
            onDismissRequest = { action = null },
            title = { Text("تمديد الحجز") },
            text = { OutlinedTextField(hours, { hours = it.filter(Char::isDigit).take(2) }, label = { Text("الساعات 1–72") }) },
            confirmButton = {
                TextButton(
                    onClick = { hours.toIntOrNull()?.takeIf { it in 1..72 }?.let { value -> action = null; onExtend(detail.summary.id, value) } },
                    enabled = hours.toIntOrNull()?.let { it in 1..72 } == true,
                ) { Text("تمديد") }
            },
            dismissButton = { TextButton(onClick = { action = null }) { Text("رجوع") } },
        )
        "convert" -> ConfirmDialog(
            title = "تحويل كامل الحجز؟",
            text = "سينشئ الخادم فاتورة دون تحصيل، ويحرر الكمية المحجوزة داخل معاملة واحدة قابلة لإعادة المحاولة بأمان.",
            onDismiss = { action = null },
            onConfirm = { action = null; onConvert(detail.summary.id) },
        )
    }
}

@Composable
private fun DigitalCardsContent(
    cards: List<DigitalCard>,
    confirmed: DigitalCard?,
    busy: Boolean,
    onConfirm: (Long) -> Unit,
) {
    if (cards.isEmpty()) return Empty("لا توجد بطاقات متاحة لهذا الفرع")
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        confirmed?.let { card ->
            item {
                SectionCard {
                    Text("تم تثبيت السعر", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    Text(card.name)
                    MoneyRow("السعر الحالي", card.sellPrice ?: "0")
                    Text("هذه الخطوة لا تصدر بطاقة ولا تنشئ فاتورة.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        items(cards, key = { it.offeringId }) { card ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(card.name, fontWeight = FontWeight.Bold)
                        Text(card.providerName, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Status(cardAvailabilityLabel(card.availability), availabilityColor(card.availability))
                }
                card.sellPrice?.let { MoneyRow("سعر البيع", it) }
                if (card.requiresStudentData) Text("يتطلب بيانات الطالب", color = MaterialTheme.colorScheme.secondary)
                OutlinedButton(
                    onClick = { onConfirm(card.offeringId) },
                    enabled = !busy && card.canConfirm,
                    modifier = Modifier.align(Alignment.End),
                ) { Text("تأكيد السعر") }
            }
        }
    }
}

@Composable
private fun SubscriptionsContent(rows: List<DigitalSubscription>) {
    if (rows.isEmpty()) return Empty("لا توجد اشتراكات ضمن النطاق")
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(rows, key = { it.id }) { subscription ->
            SectionCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text(subscription.studentName, fontWeight = FontWeight.Bold)
                        Text(subscription.offeringName, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Status(subscriptionStatusLabel(subscription.status), MaterialTheme.colorScheme.primary)
                }
                DetailRow("البداية", subscription.startsAt ?: "—")
                DetailRow("الانتهاء", subscription.expiresAt ?: "—")
                DetailRow("الفاتورة", subscription.invoiceId.toString())
            }
        }
    }
}

@Composable
private fun BackHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع") }
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
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
private fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(rtlIsolate(value), Modifier.weight(.58f), fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MoneyRow(label: String, raw: String) {
    HorizontalDivider()
    DetailRow(label, formatMoney(raw))
}

@Composable
private fun Status(text: String, color: Color) {
    Text(
        text,
        modifier = Modifier.background(color.copy(alpha = .12f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 5.dp),
        color = color,
        style = MaterialTheme.typography.labelMedium,
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
private fun Empty(text: String) {
    Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ConfirmDialog(title: String, text: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onConfirm) { Text("تأكيد") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } },
    )
}

private val CommerceSection.label: String
    get() = when (this) {
        CommerceSection.Gifts -> "الهدايا"
        CommerceSection.Reservations -> "الحجوزات"
        CommerceSection.DigitalCards -> "البطاقات"
        CommerceSection.Subscriptions -> "الاشتراكات"
    }

private val CommerceSection.icon: ImageVector
    get() = when (this) {
        CommerceSection.Gifts -> Icons.Rounded.CardGiftcard
        CommerceSection.Reservations -> Icons.Rounded.EventAvailable
        CommerceSection.DigitalCards -> Icons.Rounded.CreditCard
        CommerceSection.Subscriptions -> Icons.AutoMirrored.Rounded.ReceiptLong
    }

private val moneyFormat = NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ")).apply { maximumFractionDigits = 0 }
private fun formatMoney(raw: String): String = raw.toDoubleOrNull()?.let { "${moneyFormat.format(it)} د.ع" } ?: raw
private fun giftStatusLabel(value: String) = when (value) {
    "PENDING_APPROVAL" -> "بانتظار الاعتماد"
    "APPROVED" -> "معتمدة"
    "DELIVERED" -> "مسلّمة"
    "CANCELLED" -> "ملغاة"
    "REVERSED" -> "معكوسة"
    else -> value
}
private fun reservationStatusLabel(value: String) = when (value) {
    "ACTIVE" -> "نشط"
    "PARTIALLY_FULFILLED" -> "منفذ جزئياً"
    "FULFILLED" -> "محوّل لفاتورة"
    "EXPIRED" -> "منتهي"
    "CANCELLED" -> "ملغى"
    "RELEASED" -> "محرر"
    else -> value
}
private fun cardAvailabilityLabel(value: DigitalCardAvailability) = when (value) {
    DigitalCardAvailability.READY -> "جاهزة"
    DigitalCardAvailability.STALE_PRICE -> "سعر منتهي"
    DigitalCardAvailability.NO_PRICE -> "بلا سعر"
    DigitalCardAvailability.UNKNOWN -> "غير متاحة"
}
@Composable
private fun availabilityColor(value: DigitalCardAvailability): Color = when (value) {
    DigitalCardAvailability.READY -> MaterialTheme.colorScheme.primary
    DigitalCardAvailability.STALE_PRICE, DigitalCardAvailability.NO_PRICE -> MaterialTheme.colorScheme.error
    DigitalCardAvailability.UNKNOWN -> MaterialTheme.colorScheme.outline
}
private fun subscriptionStatusLabel(value: String) = when (value) {
    "ACTIVE" -> "نشط"
    "EXPIRED" -> "منتهي"
    "CANCELLED" -> "ملغى"
    else -> value
}

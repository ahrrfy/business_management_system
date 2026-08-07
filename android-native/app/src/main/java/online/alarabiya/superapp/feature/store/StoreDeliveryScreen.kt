package online.alarabiya.superapp.feature.store

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AssignmentTurnedIn
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.LocalShipping
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.WarningAmber
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import online.alarabiya.superapp.model.store.CourierDelivery
import online.alarabiya.superapp.model.store.DeliveryPartyOption
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderDetail
import online.alarabiya.superapp.model.store.StoreOrderPolicy
import online.alarabiya.superapp.model.store.StoreOrderStatus
import online.alarabiya.superapp.model.store.StoreOrderSummary
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Ink
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.OrangeSoft
import online.alarabiya.superapp.ui.theme.Stroke
import java.text.NumberFormat
import java.util.Locale

@Composable
fun StoreDeliveryScreen(
    viewModel: StoreDeliveryViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = viewModel.state
    var externalError by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val launchContact: (String?, Boolean) -> Unit = { phone, whatsapp ->
        val uri = if (whatsapp) StoreContactActions.whatsappUri(phone) else StoreContactActions.callUri(phone)
        val action = if (whatsapp) Intent.ACTION_VIEW else Intent.ACTION_DIAL
        externalError = if (uri == null || !context.openExternal(action, uri)) "رقم التواصل غير صالح" else null
    }

    BoxWithConstraints(
        modifier.fillMaxSize().background(Canvas).windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        val tablet = maxWidth >= 840.dp
        Column(Modifier.fillMaxSize()) {
            StoreHeader(
                title = if (state.mode == StoreDeliveryMode.Courier) "توصيلاتي" else "طلبات المتجر",
                onBack = if (!tablet && state.selectedOrderId != null) ({ viewModel.selectOrder(null) }) else onBack,
                onRefresh = viewModel::refresh,
                refreshing = state.loading,
            )
            MessageStrip(state.error ?: externalError, state.notice) {
                externalError = null
                viewModel.clearMessage()
            }
            if (tablet) {
                Row(
                    Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    StoreListPane(state, viewModel, Modifier.width(390.dp).fillMaxHeight())
                    StoreDetailPane(
                        state = state,
                        viewModel = viewModel,
                        onCall = { launchContact(it, false) },
                        onWhatsapp = { launchContact(it, true) },
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                }
            } else if (state.selectedOrderId == null) {
                StoreListPane(state, viewModel, Modifier.fillMaxSize())
            } else {
                StoreDetailPane(
                    state = state,
                    viewModel = viewModel,
                    onCall = { launchContact(it, false) },
                    onWhatsapp = { launchContact(it, true) },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }

    state.pendingAction?.let { pending ->
        StoreActionConfirmation(
            pending = pending,
            onDismiss = viewModel::dismissConfirmation,
            onConfirm = viewModel::confirmPendingAction,
        )
    }
}

@Composable
private fun StoreHeader(title: String, onBack: () -> Unit, onRefresh: () -> Unit, refreshing: Boolean) {
    Row(
        Modifier.fillMaxWidth().background(EmeraldDark).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع", tint = Color.White) }
        Text(
            title,
            modifier = Modifier.weight(1f).semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
            color = Color.White,
        )
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White)
        }
    }
}

@Composable
private fun MessageStrip(error: String?, notice: String?, onClear: () -> Unit) {
    val message = error ?: notice ?: return
    val isError = error != null
    Row(
        modifier = Modifier.fillMaxWidth()
            .background(if (isError) Color(0xFFFFEDEA) else Mint)
            .clickable(role = Role.Button, onClick = onClear)
            .semantics { liveRegion = if (isError) LiveRegionMode.Assertive else LiveRegionMode.Polite }
            .padding(horizontal = 18.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(if (isError) Icons.Rounded.WarningAmber else Icons.Rounded.CheckCircle, null, tint = if (isError) Orange else Emerald)
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun StoreListPane(state: StoreDeliveryUiState, viewModel: StoreDeliveryViewModel, modifier: Modifier) {
    var showDateFilters by rememberSaveable { mutableStateOf(state.filter.from != null || state.filter.to != null) }
    var fromDate by rememberSaveable { mutableStateOf(state.filter.from.orEmpty()) }
    var toDate by rememberSaveable { mutableStateOf(state.filter.to.orEmpty()) }
    val datePattern = remember { Regex("^\\d{4}-\\d{2}-\\d{2}$") }
    val datesValid = (fromDate.isBlank() || datePattern.matches(fromDate)) &&
        (toDate.isBlank() || datePattern.matches(toDate))
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = state.filter.query,
            onValueChange = viewModel::setQuery,
            modifier = Modifier.fillMaxWidth().testTag("store_search"),
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            label = { Text("بحث") },
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
        )
        if (state.mode == StoreDeliveryMode.Orders) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 1.dp)) {
                item {
                    FilterChip(
                        selected = state.filter.status == null,
                        onClick = { viewModel.setStatus(null) },
                        label = { Text("الكل") },
                    )
                }
                items(StoreOrderStatus.filterable) { status ->
                    FilterChip(
                        selected = state.filter.status == status,
                        onClick = { viewModel.setStatus(status) },
                        label = { Text("${status.label} ${state.counts[status] ?: 0}") },
                    )
                }
                item {
                    FilterChip(
                        selected = showDateFilters || state.filter.from != null || state.filter.to != null,
                        onClick = { showDateFilters = !showDateFilters },
                        label = { Text("التاريخ") },
                    )
                }
            }
            if (showDateFilters) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = fromDate,
                        onValueChange = { fromDate = it.take(10) },
                        modifier = Modifier.weight(1f).testTag("store_from_date"),
                        label = { Text("من") },
                        placeholder = { Text("YYYY-MM-DD") },
                        singleLine = true,
                        isError = fromDate.isNotBlank() && !datePattern.matches(fromDate),
                    )
                    OutlinedTextField(
                        value = toDate,
                        onValueChange = { toDate = it.take(10) },
                        modifier = Modifier.weight(1f).testTag("store_to_date"),
                        label = { Text("إلى") },
                        placeholder = { Text("YYYY-MM-DD") },
                        singleLine = true,
                        isError = toDate.isNotBlank() && !datePattern.matches(toDate),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = {
                            fromDate = ""
                            toDate = ""
                            viewModel.setDateRange(null, null)
                        },
                        enabled = state.busyAction == null,
                        modifier = Modifier.weight(1f),
                    ) { Text("مسح") }
                    Button(
                        onClick = {
                            viewModel.setDateRange(fromDate.ifBlank { null }, toDate.ifBlank { null })
                        },
                        enabled = datesValid && state.busyAction == null,
                        modifier = Modifier.weight(1f).testTag("apply_store_dates"),
                    ) { Text("تطبيق") }
                }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = !state.courierShowDelivered,
                    onClick = { viewModel.showDeliveredCourierOrders(false) },
                    label = { Text("قيد التوصيل") },
                )
                FilterChip(
                    selected = state.courierShowDelivered,
                    onClick = { viewModel.showDeliveredCourierOrders(true) },
                    label = { Text("المسلّمة") },
                )
            }
            state.courier?.let { CourierBalanceCard(it.partyName, it.custodyBalance) }
        }
        when {
            state.loading -> LoadingPane()
            state.error != null && state.orders.isEmpty() && state.courier == null -> RetryPane(viewModel::refresh)
            state.mode == StoreDeliveryMode.Courier -> CourierList(state, viewModel)
            else -> OrdersList(state, viewModel)
        }
    }
}

@Composable
private fun ColumnScope.OrdersList(state: StoreDeliveryUiState, viewModel: StoreDeliveryViewModel) {
    val rows = StoreDeliveryStateFilter.orders(state)
    if (rows.isEmpty()) {
        EmptyPane("لا توجد طلبات")
        return
    }
    LazyColumn(
        modifier = Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(rows, key = { it.id }) { order ->
            OrderRow(order, selected = state.selectedOrderId == order.id) { viewModel.selectOrder(order.id) }
        }
        if (state.hasMore) {
            item {
                OutlinedButton(
                    onClick = viewModel::loadMore,
                    enabled = !state.loadingMore,
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) {
                    if (state.loadingMore) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Text("تحميل المزيد")
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.CourierList(state: StoreDeliveryUiState, viewModel: StoreDeliveryViewModel) {
    val workspace = state.courier
    if (workspace == null || !workspace.linked) {
        EmptyPane("الحساب غير مرتبط بجهة توصيل")
        return
    }
    val rows = StoreDeliveryStateFilter.courierDeliveries(state)
    if (rows.isEmpty()) {
        EmptyPane(if (state.courierShowDelivered) "لا توجد طلبات مسلّمة" else "لا توجد توصيلات حالية")
        return
    }
    LazyColumn(
        modifier = Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(rows, key = { it.id }) { delivery ->
            CourierRow(delivery, selected = state.selectedOrderId == delivery.id) { viewModel.selectOrder(delivery.id) }
        }
    }
}

@Composable
private fun OrderRow(order: StoreOrderSummary, selected: Boolean, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
        shape = RoundedCornerShape(20.dp),
    ) {
        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.orderNumber, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                StatusPill(order.status)
            }
            Text(order.customerName ?: "عميل المتجر", style = MaterialTheme.typography.bodyLarge)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${order.itemCount} أصناف", style = MaterialTheme.typography.bodyMedium, color = MutedInk)
                Text(formatMoney(order.total), style = MaterialTheme.typography.titleMedium, color = EmeraldDark)
            }
        }
    }
}

@Composable
private fun CourierRow(delivery: CourierDelivery, selected: Boolean, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = if (selected) Mint else Color.White),
        shape = RoundedCornerShape(20.dp),
    ) {
        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(delivery.orderNumber, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                StatusPill(delivery.status)
            }
            Text(delivery.customerName ?: "عميل المتجر", style = MaterialTheme.typography.bodyLarge)
            Text(delivery.address ?: delivery.governorate ?: "—", maxLines = 2, overflow = TextOverflow.Ellipsis, color = MutedInk)
            Text("التحصيل ${formatMoney(delivery.codDue)}", style = MaterialTheme.typography.titleMedium, color = Orange)
        }
    }
}

@Composable
private fun StoreDetailPane(
    state: StoreDeliveryUiState,
    viewModel: StoreDeliveryViewModel,
    onCall: (String?) -> Unit,
    onWhatsapp: (String?) -> Unit,
    modifier: Modifier,
) {
    Surface(modifier, color = Color.White, shape = RoundedCornerShape(28.dp)) {
        Box(Modifier.fillMaxSize()) {
            when {
                state.selectedOrderId == null -> EmptyPane("اختر طلباً لعرض التفاصيل")
                state.mode == StoreDeliveryMode.Courier -> {
                    val delivery = (state.courier?.toDeliver.orEmpty() + state.courier?.delivered.orEmpty())
                        .firstOrNull { it.id == state.selectedOrderId }
                    if (delivery == null) EmptyPane("الطلب غير متاح")
                    else CourierDetail(delivery, state, viewModel, onCall, onWhatsapp)
                }
                state.detail == StoreDetailState.Loading -> LoadingPane()
                state.detail is StoreDetailState.Error -> RetryPane { viewModel.selectOrder(state.selectedOrderId) }
                state.detail is StoreDetailState.Content -> OrderDetail(
                    state.detail.order,
                    state,
                    viewModel,
                    onCall,
                    onWhatsapp,
                )
                else -> EmptyPane("تعذر عرض التفاصيل")
            }
        }
    }
}

@Composable
private fun OrderDetail(
    detail: StoreOrderDetail,
    state: StoreDeliveryUiState,
    viewModel: StoreDeliveryViewModel,
    onCall: (String?) -> Unit,
    onWhatsapp: (String?) -> Unit,
) {
    var partyId by rememberSaveable(detail.summary.id) { mutableStateOf<Long?>(null) }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            DetailHeading(detail.summary.orderNumber, detail.summary.status)
            Spacer(Modifier.height(14.dp))
            ContactCard(
                detail.summary.customerName,
                detail.summary.customerPhone,
                detail.address ?: detail.summary.governorate,
                onCall,
                onWhatsapp,
            )
        }
        item {
            DetailCard("ملخص الطلب", Icons.Rounded.Inventory2) {
                ValueLine("الإجمالي", formatMoney(detail.summary.total))
                ValueLine("التوصيل", formatMoney(detail.summary.deliveryFee))
                ValueLine("الفرع", detail.branchId.toString())
                detail.deliveryPartyName?.let { ValueLine("المندوب", it) }
                detail.summary.cancelReason?.let { ValueLine("سبب الإلغاء", it) }
            }
        }
        item {
            DetailCard("الأصناف", Icons.Rounded.AssignmentTurnedIn) {
                detail.items.forEachIndexed { index, line ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(line.productName, style = MaterialTheme.typography.titleMedium)
                        line.variantLabel?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MutedInk) }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${line.quantity} ${line.unitName.orEmpty()}", color = MutedInk)
                            Text(formatMoney(line.total), fontWeight = FontWeight.Bold)
                        }
                    }
                    if (index < detail.items.lastIndex) HorizontalDivider(color = Stroke)
                }
            }
        }
        val actions = StoreOrderPolicy.allowedActions(detail.summary.status, state.capabilities)
        if (StoreOrderAction.Dispatch in actions && state.parties.isNotEmpty()) {
            item {
                DetailCard("إسناد التوصيل", Icons.Rounded.LocalShipping) {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.parties.filter(DeliveryPartyOption::isActive), key = { it.id }) { party ->
                            FilterChip(
                                selected = partyId == party.id,
                                onClick = { partyId = party.id },
                                label = { Text(party.name) },
                            )
                        }
                    }
                    Button(
                        onClick = { partyId?.let { viewModel.requestAction(StoreOrderAction.Dispatch, detail.summary.id, it) } },
                        enabled = partyId != null && state.busyAction == null,
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) { Text("إسناد وإرسال") }
                }
            }
        }
        if (actions.any { it != StoreOrderAction.Dispatch }) {
            item {
                ActionButtons(
                    actions = actions - StoreOrderAction.Dispatch,
                    busy = state.busyAction != null,
                    onAction = { viewModel.requestAction(it, detail.summary.id) },
                )
            }
        }
    }
}

@Composable
private fun CourierDetail(
    delivery: CourierDelivery,
    state: StoreDeliveryUiState,
    viewModel: StoreDeliveryViewModel,
    onCall: (String?) -> Unit,
    onWhatsapp: (String?) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { DetailHeading(delivery.orderNumber, delivery.status) }
        item {
            ContactCard(delivery.customerName, delivery.customerPhone, delivery.address ?: delivery.governorate, onCall, onWhatsapp)
        }
        item {
            DetailCard("التحصيل", Icons.Rounded.Payments) {
                ValueLine("المطلوب", formatMoney(delivery.codDue))
                ValueLine("إجمالي الطلب", formatMoney(delivery.orderTotal))
            }
        }
        val actions = StoreOrderPolicy.allowedActions(delivery.status, state.capabilities)
        if (actions.isNotEmpty()) {
            item {
                ActionButtons(actions, state.busyAction != null) { viewModel.requestAction(it, delivery.id) }
            }
        }
    }
}

@Composable
private fun ContactCard(
    name: String?,
    phone: String?,
    address: String?,
    onCall: (String?) -> Unit,
    onWhatsapp: (String?) -> Unit,
) {
    DetailCard("العميل", Icons.Rounded.Person) {
        Text(name ?: "عميل المتجر", style = MaterialTheme.typography.titleLarge)
        address?.let {
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.Top) {
                Icon(Icons.Rounded.LocationOn, null, tint = Emerald, modifier = Modifier.size(20.dp))
                Text(it, style = MaterialTheme.typography.bodyLarge, color = MutedInk)
            }
        }
        if (phone != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                OutlinedButton(onClick = { onCall(phone) }, modifier = Modifier.weight(1f).height(50.dp)) {
                    Icon(Icons.Rounded.Call, null)
                    Spacer(Modifier.width(6.dp))
                    Text("اتصال")
                }
                OutlinedButton(onClick = { onWhatsapp(phone) }, modifier = Modifier.weight(1f).height(50.dp)) {
                    Text("واتساب")
                }
            }
        }
    }
}

@Composable
private fun ActionButtons(actions: Set<StoreOrderAction>, busy: Boolean, onAction: (StoreOrderAction) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        actions.forEach { action ->
            val danger = action == StoreOrderAction.Cancel || action == StoreOrderAction.CourierFailed
            if (danger) {
                OutlinedButton(
                    onClick = { onAction(action) },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    Icon(Icons.Rounded.Cancel, null)
                    Spacer(Modifier.width(7.dp))
                    Text(actionLabel(action))
                }
            } else {
                Button(
                    onClick = { onAction(action) },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                    else Text(actionLabel(action))
                }
            }
        }
    }
}

@Composable
private fun StoreActionConfirmation(
    pending: PendingStoreAction,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit,
) {
    var reason by rememberSaveable(pending.orderId, pending.action) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(actionLabel(pending.action), modifier = Modifier.semantics { heading() }) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(confirmationText(pending.action), style = MaterialTheme.typography.bodyLarge)
                if (pending.requiresReason) {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it.take(500) },
                        modifier = Modifier.fillMaxWidth().testTag("action_reason"),
                        label = { Text("السبب") },
                        minLines = 2,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(reason) },
                enabled = !pending.requiresReason || reason.trim().length >= 2,
                modifier = Modifier.testTag("confirm_store_action"),
            ) { Text("تأكيد") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } },
    )
}

@Composable
private fun DetailHeading(number: String, status: StoreOrderStatus) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f)) {
            Text("الطلب", style = MaterialTheme.typography.bodyMedium, color = MutedInk)
            Text(number, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        }
        StatusPill(status)
    }
}

@Composable
private fun DetailCard(title: String, icon: ImageVector, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Canvas), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(icon, null, tint = Emerald)
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            }
            content()
        }
    }
}

@Composable
private fun ValueLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = MutedInk)
        Text(value, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
    }
}

@Composable
private fun StatusPill(status: StoreOrderStatus) {
    val color = when (status) {
        StoreOrderStatus.Pending -> Orange
        StoreOrderStatus.Confirmed,
        StoreOrderStatus.Processing,
        StoreOrderStatus.Shipped,
        -> Emerald
        StoreOrderStatus.Delivered -> Color(0xFF2E7D32)
        StoreOrderStatus.Cancelled,
        StoreOrderStatus.Unknown,
        -> MaterialTheme.colorScheme.error
    }
    Text(
        status.label,
        modifier = Modifier.clip(CircleShape).background(color.copy(alpha = .12f)).padding(horizontal = 11.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelMedium,
        color = color,
    )
}

@Composable
private fun CourierBalanceCard(partyName: String?, balance: String) {
    Card(colors = CardDefaults.cardColors(containerColor = EmeraldDark), shape = RoundedCornerShape(20.dp)) {
        Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(partyName ?: "مندوب التوصيل", color = Color.White, style = MaterialTheme.typography.titleMedium)
                Text("العهدة الحالية", color = Color.White.copy(alpha = .72f), style = MaterialTheme.typography.bodyMedium)
            }
            Text(formatMoney(balance), color = Color.White, style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun ColumnScope.LoadingPane() {
    Box(
        Modifier.fillMaxWidth().weight(1f).semantics {
            contentDescription = "جارٍ تحميل الطلبات"
            liveRegion = LiveRegionMode.Polite
        },
        contentAlignment = Alignment.Center,
    ) { CircularProgressIndicator(color = Emerald) }
}

@Composable
private fun ColumnScope.EmptyPane(message: String) {
    Box(Modifier.fillMaxWidth().weight(1f).padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Rounded.LocalShipping, null, tint = MutedInk, modifier = Modifier.size(42.dp))
            Text(message, style = MaterialTheme.typography.bodyLarge, color = MutedInk, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun ColumnScope.RetryPane(onRetry: () -> Unit) {
    Box(Modifier.fillMaxWidth().weight(1f).padding(24.dp), contentAlignment = Alignment.Center) {
        Button(onClick = onRetry, modifier = Modifier.height(52.dp)) {
            Icon(Icons.Rounded.Refresh, null)
            Spacer(Modifier.width(7.dp))
            Text("إعادة المحاولة")
        }
    }
}

@Composable
private fun BoxScope.EmptyPane(message: String) {
    Column(
        modifier = Modifier.align(Alignment.Center).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Rounded.LocalShipping, null, tint = MutedInk, modifier = Modifier.size(42.dp))
        Text(message, style = MaterialTheme.typography.bodyLarge, color = MutedInk, textAlign = TextAlign.Center)
    }
}

@Composable
private fun BoxScope.LoadingPane() {
    CircularProgressIndicator(Modifier.align(Alignment.Center), color = Emerald)
}

@Composable
private fun BoxScope.RetryPane(onRetry: () -> Unit) {
    Button(onClick = onRetry, modifier = Modifier.align(Alignment.Center).height(52.dp)) {
        Icon(Icons.Rounded.Refresh, null)
        Spacer(Modifier.width(7.dp))
        Text("إعادة المحاولة")
    }
}

private fun Context.openExternal(action: String, uri: String): Boolean = runCatching {
    val intent = Intent(action, uri.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
    startActivity(intent)
}.isSuccess

private fun actionLabel(action: StoreOrderAction): String = when (action) {
    StoreOrderAction.Confirm -> "تأكيد الطلب"
    StoreOrderAction.StartProcessing -> "بدء التجهيز"
    StoreOrderAction.Cancel -> "إلغاء الطلب"
    StoreOrderAction.Dispatch -> "إسناد وإرسال"
    StoreOrderAction.MarkDelivered -> "تسجيل التسليم"
    StoreOrderAction.CourierDelivered -> "تم التسليم والتحصيل"
    StoreOrderAction.CourierFailed -> "تعذّر التسليم"
}

private fun confirmationText(action: StoreOrderAction): String = when (action) {
    StoreOrderAction.Confirm -> "تأكيد استلام الطلب؟"
    StoreOrderAction.StartProcessing -> "بدء تجهيز الطلب؟"
    StoreOrderAction.Cancel -> "إلغاء الطلب؟"
    StoreOrderAction.Dispatch -> "إصدار الفاتورة وإرسال الطلب مع المندوب المختار؟"
    StoreOrderAction.MarkDelivered -> "تسجيل الطلب كمسلّم؟"
    StoreOrderAction.CourierDelivered -> "تأكيد التسليم وتحصيل كامل المبلغ؟"
    StoreOrderAction.CourierFailed -> "تسجيل تعذّر التسليم وعكس الطلب؟"
}

private fun formatMoney(value: String): String {
    val amount = value.toDoubleOrNull() ?: return "$value د.ع"
    return "${NumberFormat.getNumberInstance(Locale.forLanguageTag("ar-IQ")).format(amount)} د.ع"
}

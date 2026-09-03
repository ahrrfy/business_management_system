package online.alarabiya.superapp.feature.purchasing

import androidx.compose.animation.AnimatedContent
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Business
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.LocalShipping
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraft
import online.alarabiya.superapp.model.purchasing.PurchaseOrderDraftLine
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseReturnDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnLineDraft
import online.alarabiya.superapp.model.purchasing.PurchaseReturnSummary
import online.alarabiya.superapp.model.purchasing.PurchasingCapabilities
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import online.alarabiya.superapp.model.purchasing.ReminderQueueItem
import online.alarabiya.superapp.model.purchasing.SupplierDetail
import online.alarabiya.superapp.model.purchasing.SupplierDraft
import online.alarabiya.superapp.model.purchasing.SupplierSummary
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

private val PurchaseInk = Color(0xFF362087)
private val PurchaseGreen = Color(0xFF5B36D2)
private val PurchaseOrange = Color(0xFFEC2F86)
private val PurchaseMist = Color(0xFFF0ECFF)

private sealed interface PurchasingComposer {
    data class Supplier(val draft: SupplierDraft) : PurchasingComposer
    data class Order(val draft: PurchaseOrderDraft) : PurchasingComposer
    data class Return(val draft: PurchaseReturnDraft) : PurchasingComposer
    data class Skip(val item: ReminderQueueItem, val reason: String = "", val promisedDate: String = "") : PurchasingComposer
}

@Composable
fun PurchasingRoute(viewModel: PurchasingViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    PurchasingScreen(
        state = viewModel.state, capabilities = viewModel.capabilities, onBack = onBack,
        onSection = viewModel::selectSection, onQuery = viewModel::setQuery, onSearch = viewModel::search,
        onOrder = viewModel::selectOrder, onSupplier = viewModel::selectSupplier,
        onConfirmOrder = viewModel::requestConfirmOrder, onCancelOrder = viewModel::requestCancelOrder,
        onSupplierActivation = viewModel::requestSupplierActivation, onSendReminder = viewModel::requestSendReminder,
        onConfirm = viewModel::confirmPending, onDismissConfirmation = viewModel::dismissConfirmation,
        onCreateSupplier = viewModel::createSupplier, onUpdateSupplier = viewModel::updateSupplier,
        onCatalogBranch = viewModel::loadCatalog,
        onCreateOrder = viewModel::createOrder,
        onCreateReturn = viewModel::createReturn, onSkip = viewModel::skipReminder,
        modifier = modifier,
    )
}

@Composable
fun PurchasingScreen(
    state: PurchasingUiState,
    capabilities: PurchasingCapabilities,
    onBack: () -> Unit,
    onSection: (PurchasingSection) -> Unit,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onOrder: (Long) -> Unit,
    onSupplier: (Long) -> Unit,
    onConfirmOrder: () -> Unit,
    onCancelOrder: () -> Unit,
    onSupplierActivation: (Long, String, Boolean) -> Unit,
    onSendReminder: (ReminderQueueItem) -> Unit,
    onConfirm: () -> Unit,
    onDismissConfirmation: () -> Unit,
    onCreateSupplier: (SupplierDraft) -> Unit,
    onUpdateSupplier: (SupplierDraft) -> Unit,
    onCatalogBranch: (Long) -> Unit,
    onCreateOrder: (PurchaseOrderDraft) -> Unit,
    onCreateReturn: (PurchaseReturnDraft) -> Unit,
    onSkip: (ReminderQueueItem, String, String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var composer by remember { mutableStateOf<PurchasingComposer?>(null) }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Scaffold(
            modifier = modifier.fillMaxSize(),
            floatingActionButton = {
                val canCreate = when (state.section) {
                    PurchasingSection.ORDERS -> capabilities.canWriteOrders
                    PurchasingSection.SUPPLIERS -> capabilities.canWriteSuppliers
                    PurchasingSection.RETURNS -> capabilities.canWriteReturns
                    PurchasingSection.REMINDERS -> false
                }
                if (canCreate && !state.locked) FloatingActionButton(
                    onClick = {
                        composer = when (state.section) {
                            PurchasingSection.ORDERS -> PurchasingComposer.Order(PurchaseOrderDraft(branchId = capabilities.branchId))
                            PurchasingSection.SUPPLIERS -> PurchasingComposer.Supplier(SupplierDraft())
                            PurchasingSection.RETURNS -> PurchasingComposer.Return(PurchaseReturnDraft(branchId = capabilities.branchId))
                            PurchasingSection.REMINDERS -> null
                        }
                    }, containerColor = PurchaseOrange, contentColor = Color.White,
                ) { Icon(Icons.Rounded.Add, contentDescription = "إضافة") }
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                PurchasingHeader(onBack, onSearch, state.locked)
                PurchasingTabs(capabilities.visibleSections, state.section, onSection)
                SearchBar(state.query, onQuery, onSearch)
                state.error?.let { MessageStrip(it, true) }
                state.notice?.let { MessageStrip(it, false) }
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val wide = maxWidth >= 760.dp
                    if (state.busyKey == "initial") Loading()
                    else if (wide) Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                        ListPane(state, onOrder, onSupplier, onSendReminder, onSkip = { composer = PurchasingComposer.Skip(it) }, Modifier.weight(.46f))
                        DetailPane(state, capabilities, onConfirmOrder, onCancelOrder, onSupplierActivation, onEditSupplier = { composer = PurchasingComposer.Supplier(it) }, Modifier.weight(.54f))
                    } else AnimatedContent(state.selectedOrder != null || state.selectedSupplier != null, label = "purchasing-detail") { detailed ->
                        if (detailed) DetailPane(state, capabilities, onConfirmOrder, onCancelOrder, onSupplierActivation, onEditSupplier = { composer = PurchasingComposer.Supplier(it) }, Modifier.padding(14.dp))
                        else ListPane(state, onOrder, onSupplier, onSendReminder, onSkip = { composer = PurchasingComposer.Skip(it) }, Modifier.padding(horizontal = 14.dp))
                    }
                }
            }
        }

        state.confirmation?.let { pending ->
            AlertDialog(
                onDismissRequest = onDismissConfirmation,
                title = { Text(pending.title) }, text = { Text(pending.explanation) },
                confirmButton = { Button(onClick = onConfirm, enabled = !state.locked) { Text("تأكيد") } },
                dismissButton = { TextButton(onClick = onDismissConfirmation) { Text("رجوع") } },
            )
        }
        composer?.let { draft ->
            PurchasingComposerDialog(
                composer = draft, capabilities = capabilities, catalog = state.catalog, onCatalogBranch = onCatalogBranch,
                onChange = { composer = it }, onDismiss = { composer = null },
                onSubmit = {
                    when (val current = composer) {
                        is PurchasingComposer.Supplier -> if (current.draft.id == null) onCreateSupplier(current.draft) else onUpdateSupplier(current.draft)
                        is PurchasingComposer.Order -> onCreateOrder(current.draft)
                        is PurchasingComposer.Return -> onCreateReturn(current.draft)
                        is PurchasingComposer.Skip -> onSkip(current.item, current.reason, current.promisedDate.trim().takeIf(String::isNotEmpty))
                        null -> Unit
                    }
                    composer = null
                },
            )
        }
    }
}

@Composable
private fun PurchasingHeader(onBack: () -> Unit, onRefresh: () -> Unit, busy: Boolean) {
    Box(Modifier.fillMaxWidth().heightIn(min = 134.dp).background(PurchaseInk).clip(RoundedCornerShape(bottomStart = 44.dp))) {
        Box(Modifier.size(180.dp).align(Alignment.TopStart).background(PurchaseGreen.copy(alpha = .25f), CircleShape))
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 22.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع", tint = Color.White) }
            Column(Modifier.weight(1f)) {
                Text("المشتريات والموردون", color = Color.White, style = MaterialTheme.typography.titleLarge)
                Text("الفواتير · المخزون الآلي · الذمم", color = Color.White.copy(alpha = .7f))
            }
            IconButton(onClick = onRefresh, enabled = !busy) { Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White) }
        }
    }
}

@Composable
private fun PurchasingTabs(sections: List<PurchasingSection>, selected: PurchasingSection, onSection: (PurchasingSection) -> Unit) {
    LazyRow(contentPadding = PaddingValues(14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(sections) { section ->
            val active = section == selected
            Surface(onClick = { onSection(section) }, color = if (active) PurchaseGreen else MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(18.dp)) {
                Text(section.label, Modifier.padding(horizontal = 18.dp, vertical = 10.dp), color = if (active) Color.White else MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}

@Composable
private fun SearchBar(query: String, onQuery: (String) -> Unit, onSearch: () -> Unit) {
    OutlinedTextField(
        value = query, onValueChange = onQuery, singleLine = true, placeholder = { Text("بحث موحد داخل القسم") },
        trailingIcon = {
            Row {
                NativeScannerAction(NativeScanField.DOCUMENT_REFERENCE, { scanned -> onQuery(scanned); onSearch() })
                IconButton(onClick = onSearch) { Icon(Icons.Rounded.Search, "بحث") }
            }
        },
        shape = RoundedCornerShape(22.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
    )
}

@Composable
private fun ListPane(
    state: PurchasingUiState,
    onOrder: (Long) -> Unit,
    onSupplier: (Long) -> Unit,
    onSendReminder: (ReminderQueueItem) -> Unit,
    onSkip: (ReminderQueueItem) -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier.fillMaxHeight(), contentPadding = PaddingValues(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (state.section) {
            PurchasingSection.ORDERS -> items(state.orders, key = { it.id }) { OrderCard(it, { onOrder(it.id) }) }
            PurchasingSection.SUPPLIERS -> items(state.suppliers.rows, key = { it.id }) { SupplierCard(it, { onSupplier(it.id) }) }
            PurchasingSection.RETURNS -> items(state.returns.rows, key = { it.id }) { ReturnCard(it) }
            PurchasingSection.REMINDERS -> {
                item { SectionTitle("مستحق اليوم", "${state.reminderQueue.size} مورد") }
                items(state.reminderQueue, key = { "q-${it.supplierId}" }) { ReminderCard(it, onSendReminder, onSkip) }
                item { SectionTitle("السجل", "${state.reminderHistory.size} إجراء") }
                items(state.reminderHistory, key = { "h-${it.id}" }) { item ->
                    CompactCard(Icons.Rounded.CheckCircle, item.supplierName, "${item.status} · ${item.totalUnpaidSnapshot} د.ع", item.createdAt)
                }
            }
        }
        if (state.section != PurchasingSection.REMINDERS && when (state.section) { PurchasingSection.ORDERS -> state.orders.isEmpty(); PurchasingSection.SUPPLIERS -> state.suppliers.rows.isEmpty(); PurchasingSection.RETURNS -> state.returns.rows.isEmpty(); else -> false }) {
            item { EmptyState() }
        }
    }
}

@Composable
private fun DetailPane(
    state: PurchasingUiState,
    capabilities: PurchasingCapabilities,
    onConfirmOrder: () -> Unit,
    onCancelOrder: () -> Unit,
    onSupplierActivation: (Long, String, Boolean) -> Unit,
    onEditSupplier: (SupplierDraft) -> Unit,
    modifier: Modifier,
) {
    when {
        state.selectedOrder != null -> OrderDetail(state.selectedOrder, capabilities, onConfirmOrder, onCancelOrder, modifier)
        state.selectedSupplier != null -> SupplierDetail(state.selectedSupplier, capabilities, onSupplierActivation, onEditSupplier, modifier)
        else -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("اختر سجلاً لعرض التفاصيل", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun OrderCard(item: PurchaseOrderSummary, onClick: () -> Unit) = Card(
    onClick = onClick, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 14.dp, bottomEnd = 28.dp, bottomStart = 14.dp),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
) {
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        RoundIcon(Icons.Rounded.Inventory2, PurchaseGreen)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.number, fontWeight = FontWeight.Bold)
            Text(item.supplierName ?: "مورد غير مسمى", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(item.orderDate.orEmpty(), style = MaterialTheme.typography.labelMedium)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(item.status.label, color = PurchaseGreen, fontWeight = FontWeight.SemiBold)
            item.total?.let { Text("$it د.ع", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun SupplierCard(item: SupplierSummary, onClick: () -> Unit) = Card(onClick = onClick, shape = RoundedCornerShape(24.dp)) {
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        RoundIcon(Icons.Rounded.Business, if (item.active) PurchaseGreen else Color.Gray)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) { Text(item.name, fontWeight = FontWeight.Bold); Text(listOfNotNull(item.city, item.phone).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item.currentBalance?.let { Text("$it د.ع", color = PurchaseOrange, fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun ReturnCard(item: PurchaseReturnSummary) = CompactCard(Icons.Rounded.LocalShipping, "مرتجع #${item.id}", "${item.amount} د.ع · مورد ${item.supplierId}", item.date)

@Composable
private fun ReminderCard(item: ReminderQueueItem, onSend: (ReminderQueueItem) -> Unit, onSkip: (ReminderQueueItem) -> Unit) {
    Card(shape = RoundedCornerShape(26.dp), colors = CardDefaults.cardColors(containerColor = if (item.promiseDue) Color(0xFFFFF2E8) else PurchaseMist)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.Rounded.NotificationsActive, if (item.promiseDue) PurchaseOrange else PurchaseGreen)
                Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) { Text(item.supplierName, fontWeight = FontWeight.Bold); Text("متأخر ${item.daysOverdue} يوماً") }
                Text("${item.totalUnpaid} د.ع", fontWeight = FontWeight.Bold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onSend(item) }, modifier = Modifier.weight(1f)) { Text("إرسال عبر المزود") }
                OutlinedButton(onClick = { onSkip(item) }) { Text("تأجيل") }
            }
        }
    }
}

@Composable
private fun OrderDetail(order: PurchaseOrderDetail, capabilities: PurchasingCapabilities, onConfirm: () -> Unit, onCancel: () -> Unit, modifier: Modifier) {
    LazyColumn(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 20.dp)) {
        item { DetailHero(order.summary.number, order.summary.supplierName ?: "مورد", order.summary.status.label, order.summary.total?.let { "$it د.ع" }) }
        items(order.lines, key = { it.id }) { line -> CompactCard(Icons.Rounded.Inventory2, line.productName, "${line.quantity} ${line.unitName.orEmpty()} · مستلم ${line.receivedBaseQuantity}/${line.baseQuantity}", line.total?.let { "$it د.ع" }) }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (capabilities.canConfirm(order)) Button(onClick = onConfirm, modifier = Modifier.weight(1f)) { Text("إرسال للاعتماد") }
                if (capabilities.canCancel(order)) OutlinedButton(onClick = onCancel) { Text("إلغاء") }
            }
        }
    }
}

@Composable
private fun SupplierDetail(detail: SupplierDetail, capabilities: PurchasingCapabilities, onActivation: (Long, String, Boolean) -> Unit, onEdit: (SupplierDraft) -> Unit, modifier: Modifier) {
    val supplier = detail.summary
    LazyColumn(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 20.dp)) {
        item { DetailHero(supplier.name, supplier.city ?: "مورد", if (supplier.active) "نشط" else "معطل", supplier.currentBalance?.let { "$it د.ع" }) }
        item { DetailField("الهاتف", supplier.phone); DetailField("البريد", detail.email); DetailField("العنوان", detail.address); DetailField("شروط الدفع", supplier.paymentTerms); DetailField("الفئة", detail.category); DetailField("ملاحظات", detail.notes) }
        if (capabilities.canWriteSuppliers) item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onEdit(SupplierDraft(id = supplier.id, name = supplier.name, phone = supplier.phone.orEmpty(), email = detail.email.orEmpty(), whatsapp = supplier.whatsapp.orEmpty(), address = detail.address.orEmpty(), city = supplier.city.orEmpty(), paymentTerms = supplier.paymentTerms.orEmpty(), category = detail.category.orEmpty(), notes = detail.notes.orEmpty(), kind = supplier.kind)) }) { Text("تعديل") }
                OutlinedButton(onClick = { onActivation(supplier.id, supplier.name, !supplier.active) }) { Text(if (supplier.active) "تعطيل" else "تفعيل") }
            }
        }
    }
}

@Composable
private fun PurchasingComposerDialog(composer: PurchasingComposer, capabilities: PurchasingCapabilities, catalog: List<online.alarabiya.superapp.model.purchasing.PurchaseCatalogItem>, onCatalogBranch: (Long) -> Unit, onChange: (PurchasingComposer) -> Unit, onDismiss: () -> Unit, onSubmit: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(when (composer) { is PurchasingComposer.Supplier -> if (composer.draft.id == null) "مورد جديد" else "تعديل المورد"; is PurchasingComposer.Order -> "فاتورة شراء جديدة"; is PurchasingComposer.Return -> "مرتجع شراء"; is PurchasingComposer.Skip -> "تأجيل التذكير" }) },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (composer) {
                    is PurchasingComposer.Supplier -> item { SupplierFields(composer.draft, if (composer.draft.id == null) capabilities.canSetOpeningBalanceOnCreate else capabilities.canEditOpeningBalance) { onChange(PurchasingComposer.Supplier(it)) } }
                    is PurchasingComposer.Order -> item { OrderFields(composer.draft, catalog, onCatalogBranch) { onChange(PurchasingComposer.Order(it)) } }
                    is PurchasingComposer.Return -> item { ReturnFields(composer.draft) { onChange(PurchasingComposer.Return(it)) } }
                    is PurchasingComposer.Skip -> item {
                        OutlinedTextField(composer.reason, { onChange(composer.copy(reason = it.take(255))) }, label = { Text("سبب التأجيل") })
                        ArabicDatePicker(composer.promisedDate, { onChange(composer.copy(promisedDate = it)) }, "تاريخ الوعد")
                    }
                }
            }
        },
        confirmButton = { Button(onClick = onSubmit) { Text(if (composer is PurchasingComposer.Order) "حفظ وإرسال للاعتماد" else "حفظ") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

@Composable
private fun SupplierFields(draft: SupplierDraft, canOpening: Boolean, onChange: (SupplierDraft) -> Unit) {
    TextInput("اسم المورد", draft.name) { onChange(draft.copy(name = it)) }
    TextInput("الهاتف", draft.phone, KeyboardType.Phone) { onChange(draft.copy(phone = it)) }
    TextInput("واتساب", draft.whatsapp, KeyboardType.Phone) { onChange(draft.copy(whatsapp = it)) }
    TextInput("البريد", draft.email, KeyboardType.Email) { onChange(draft.copy(email = it)) }
    TextInput("المدينة", draft.city) { onChange(draft.copy(city = it)) }
    TextInput("العنوان", draft.address) { onChange(draft.copy(address = it)) }
    TextInput("شروط الدفع", draft.paymentTerms) { onChange(draft.copy(paymentTerms = it)) }
    TextInput("ملاحظات", draft.notes) { onChange(draft.copy(notes = it)) }
    if (canOpening) TextInput("الرصيد الافتتاحي", draft.openingBalance, KeyboardType.Decimal) { onChange(draft.copy(openingBalance = it)) }
}

@Composable
private fun OrderFields(draft: PurchaseOrderDraft, catalog: List<online.alarabiya.superapp.model.purchasing.PurchaseCatalogItem>, onCatalogBranch: (Long) -> Unit, onChange: (PurchaseOrderDraft) -> Unit) {
    val line = draft.items.first()
    Text("تُحفظ الفاتورة وتُرسل لمراجع مستقل؛ عند اعتماده تُضاف كامل الكميات إلى المخزون تلقائياً.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    TextInput("معرّف المورد", draft.supplierId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(supplierId = it.toLongOrNull() ?: 0)) }
    TextInput("معرّف الفرع", draft.branchId?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(branchId = it.toLongOrNull())) }
    if (draft.branchId != null) OutlinedButton(onClick = { onCatalogBranch(draft.branchId) }) { Text("تحميل أصناف الفرع") }
    if (catalog.isNotEmpty()) {
        Text("اختر الصنف", fontWeight = FontWeight.Bold)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(catalog.take(20), key = { it.productUnitId }) { item ->
                Surface(
                    onClick = { onChange(draft.copy(items = listOf(line.copy(variantId = item.variantId, productUnitId = item.productUnitId)))) },
                    color = if (line.productUnitId == item.productUnitId) PurchaseMist else MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(14.dp),
                ) { Text("${item.label}\nكلفة الأساس ${item.costPriceBase}", Modifier.padding(10.dp), maxLines = 2) }
            }
        }
    } else {
        TextInput("معرّف الصنف", line.variantId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(items = listOf(line.copy(variantId = it.toLongOrNull() ?: 0)))) }
        TextInput("معرّف الوحدة", line.productUnitId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(items = listOf(line.copy(productUnitId = it.toLongOrNull() ?: 0)))) }
    }
    TextInput("الكمية", line.quantity, KeyboardType.Decimal) { onChange(draft.copy(items = listOf(line.copy(quantity = it)))) }
    TextInput("سعر الوحدة", line.unitPrice, KeyboardType.Decimal) { onChange(draft.copy(items = listOf(line.copy(unitPrice = it)))) }
    TextInput("تكلفة الشحن", draft.shippingCost, KeyboardType.Decimal) { onChange(draft.copy(shippingCost = it)) }
    TextInput("الجمارك", draft.customsCost, KeyboardType.Decimal) { onChange(draft.copy(customsCost = it)) }
    val hasShipping = (draft.shippingCost.toBigDecimalOrNull()?.signum() ?: 0) > 0 ||
        (draft.customsCost.toBigDecimalOrNull()?.signum() ?: 0) > 0
    if (hasShipping) {
        Text("أداة تسوية الشحن", fontWeight = FontWeight.Bold)
        val methods = listOf(
            "CASH" to "نقدي",
            "TRANSFER" to "تحويل",
            "CHECK" to "صك",
            "CARD" to "بطاقة",
            "WALLET" to "محفظة",
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(methods, key = { it.first }) { method ->
                Surface(
                    onClick = { onChange(draft.copy(shippingPaymentMethod = method.first)) },
                    color = if (draft.shippingPaymentMethod == method.first) PurchaseMist else MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(14.dp),
                ) { Text(method.second, Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) }
            }
        }
        if (draft.shippingPaymentMethod in setOf("TRANSFER", "CHECK")) {
            TextInput(
                if (draft.shippingPaymentMethod == "CHECK") "رقم الصك" else "مرجع التحويل",
                draft.shippingPaymentReference,
            ) { onChange(draft.copy(shippingPaymentReference = it)) }
        }
        if (draft.shippingPaymentMethod == "CARD") {
            TextInput("آخر أربعة أرقام للبطاقة", draft.shippingCardLastFour, KeyboardType.Number) {
                onChange(draft.copy(shippingCardLastFour = it.filter(Char::isDigit).take(4)))
            }
        }
        TextInput("اسم الناقل (اختياري)", draft.shippingBeneficiaryName) {
            onChange(draft.copy(shippingBeneficiaryName = it))
        }
        TextInput("فاتورة/وصل الشحن (اختياري)", draft.shippingEvidenceReference) {
            onChange(draft.copy(shippingEvidenceReference = it))
        }
        Text("يُثبت المصروف الآن، ويظل الصرف معلّقاً حتى اعتماد شخص آخر.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    TextInput("ملاحظات", draft.notes) { onChange(draft.copy(notes = it)) }
}

@Composable
private fun ReturnFields(draft: PurchaseReturnDraft, onChange: (PurchaseReturnDraft) -> Unit) {
    val line = draft.items.first()
    TextInput("معرّف المورد", draft.supplierId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(supplierId = it.toLongOrNull() ?: 0)) }
    TextInput("مرجع أمر الشراء", draft.purchaseOrderRefId?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(purchaseOrderRefId = it.toLongOrNull())) }
    TextInput("معرّف الصنف", line.variantId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(items = listOf(line.copy(variantId = it.toLongOrNull() ?: 0)))) }
    TextInput("معرّف الوحدة", line.productUnitId.takeIf { it > 0 }?.toString().orEmpty(), KeyboardType.Number) { onChange(draft.copy(items = listOf(line.copy(productUnitId = it.toLongOrNull() ?: 0)))) }
    TextInput("الكمية", line.quantity, KeyboardType.Decimal) { onChange(draft.copy(items = listOf(line.copy(quantity = it)))) }
    TextInput("سعر الوحدة", line.unitPrice, KeyboardType.Decimal) { onChange(draft.copy(items = listOf(line.copy(unitPrice = it)))) }
    TextInput("سبب المرتجع", draft.reason) { onChange(draft.copy(reason = it)) }
}

@Composable private fun TextInput(label: String, value: String, keyboardType: KeyboardType = KeyboardType.Text, onValue: (String) -> Unit) { OutlinedTextField(value, { onValue(it.take(500)) }, label = { Text(label) }, keyboardOptions = KeyboardOptions(keyboardType = keyboardType), modifier = Modifier.fillMaxWidth()) }
@Composable private fun DetailHero(title: String, subtitle: String, badge: String, amount: String?) { Card(shape = RoundedCornerShape(topStart = 38.dp, topEnd = 16.dp, bottomEnd = 38.dp, bottomStart = 16.dp), colors = CardDefaults.cardColors(containerColor = PurchaseInk)) { Column(Modifier.fillMaxWidth().padding(22.dp)) { Text(badge, color = Color(0xFF80E2CD)); Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge); Text(subtitle, color = Color.White.copy(alpha = .7f)); amount?.let { Text(it, color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium) } } } }
@Composable private fun DetailField(label: String, value: String?) { if (!value.isNullOrBlank()) { Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) { Text(label, Modifier.width(100.dp), color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, Modifier.weight(1f)); }; HorizontalDivider() } }
@Composable private fun CompactCard(icon: ImageVector, title: String, subtitle: String, tail: String?) { Card(shape = RoundedCornerShape(22.dp)) { Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically) { RoundIcon(icon, PurchaseGreen); Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) { Text(title, fontWeight = FontWeight.Bold); Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }; tail?.let { Text(it, style = MaterialTheme.typography.labelMedium) } } } }
@Composable private fun RoundIcon(icon: ImageVector, color: Color) { Box(Modifier.size(44.dp).background(color.copy(alpha = .1f), CircleShape), contentAlignment = Alignment.Center) { Icon(icon, null, tint = color) } }
@Composable private fun SectionTitle(title: String, count: String) { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Text(count, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable private fun MessageStrip(text: String, error: Boolean) { Surface(color = if (error) MaterialTheme.colorScheme.errorContainer else PurchaseMist, modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), shape = RoundedCornerShape(14.dp)) { Text(text, Modifier.padding(12.dp), color = if (error) MaterialTheme.colorScheme.onErrorContainer else PurchaseGreen) } }
@Composable private fun Loading() { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
@Composable private fun EmptyState() { Box(Modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Rounded.Person, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.outline); Text("لا توجد سجلات مطابقة") } } }

private val PurchasingSection.label get() = when (this) { PurchasingSection.ORDERS -> "الأوامر"; PurchasingSection.SUPPLIERS -> "الموردون"; PurchasingSection.RETURNS -> "المرتجعات"; PurchasingSection.REMINDERS -> "الذمم" }
private val online.alarabiya.superapp.model.purchasing.PurchaseStatus.label get() = when (this) { online.alarabiya.superapp.model.purchasing.PurchaseStatus.DRAFT -> "مسودة"; online.alarabiya.superapp.model.purchasing.PurchaseStatus.SENT -> "مرسل"; online.alarabiya.superapp.model.purchasing.PurchaseStatus.CONFIRMED -> "بانتظار الترحيل (قديم)"; online.alarabiya.superapp.model.purchasing.PurchaseStatus.RECEIVED -> "معتمدة ومضافة للمخزون"; online.alarabiya.superapp.model.purchasing.PurchaseStatus.CANCELLED -> "ملغي"; else -> "غير معروف" }

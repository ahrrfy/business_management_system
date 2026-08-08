package online.alarabiya.superapp.feature.workorders

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.workorders.*
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

private val WorkGreen = Color(0xFF5B36D2)
private val WorkOrange = Color(0xFFEC2F86)
private val PAPER_SIZES = (0..10).map { "A$it" } + (0..10).map { "B$it" }

@Composable
fun WorkOrdersRoute(viewModel: WorkOrdersViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    WorkOrdersScreen(viewModel.state, viewModel.capabilities, viewModel, modifier)
}

@Composable
fun WorkOrdersScreen(state: WorkOrdersUiState, capabilities: WorkOrdersCapabilities, actions: WorkOrdersViewModel, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(bottomStart = 38.dp)) {
            Row(Modifier.fillMaxWidth().padding(22.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column { Text("الطباعة والإنتاج", style = MaterialTheme.typography.headlineMedium, color = Color.White, fontWeight = FontWeight.Bold); Text("أوامر العمل والإنتاج", color = Color.White.copy(alpha = .72f)) }
                IconButton(actions::initialize, enabled = state.busyKey == null) { Icon(Icons.Rounded.Refresh, "تحديث", tint = Color.White) }
            }
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(capabilities.sections) { section -> FilterChip(selected = state.section == section, onClick = { actions.selectSection(section) }, label = { Text(section.label()) }, leadingIcon = { Icon(section.icon(), null) }) }
        }
        state.message?.let { Feedback(it, false, actions::clearFeedback) }
        state.error?.let { Feedback(it, true, actions::clearFeedback) }
        if (state.initializing) LinearProgressIndicator(Modifier.fillMaxWidth())
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val tablet = maxWidth >= 840.dp
            when (state.section) {
                WorkOrdersSection.ORDERS -> OrdersPane(state, capabilities, actions, tablet)
                WorkOrdersSection.PRINT_SERVICES -> ServicesPane(state, actions)
                WorkOrdersSection.PRICING -> PricingPane(state, actions, tablet)
                WorkOrdersSection.PRODUCTION -> ProductionPane(state, actions, tablet)
            }
            if (state.busyKey != null) Surface(Modifier.align(Alignment.BottomCenter).padding(18.dp), color = MaterialTheme.colorScheme.inverseSurface, shape = RoundedCornerShape(22.dp)) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp)); Text("جارٍ تنفيذ العملية", color = MaterialTheme.colorScheme.inverseOnSurface) }
            }
        }
    }
}

@Composable
private fun OrdersPane(state: WorkOrdersUiState, caps: WorkOrdersCapabilities, actions: WorkOrdersViewModel, tablet: Boolean) {
    val detail: @Composable () -> Unit = { when { state.orderDraft != null -> OrderEditor(state, actions); state.selectedOrder != null -> OrderDetailPane(state, caps, actions); else -> Empty("اختر أمر شغل لعرض تفاصيله") } }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) { Box(Modifier.weight(.9f)) { OrdersList(state, caps, actions) }; Box(Modifier.weight(1.1f)) { detail() } }
    else if (state.orderDraft != null || state.selectedOrder != null) Box(Modifier.fillMaxSize().padding(18.dp)) { detail() }
    else OrdersList(state, caps, actions)
}

@Composable
private fun OrdersList(state: WorkOrdersUiState, caps: WorkOrdersCapabilities, actions: WorkOrdersViewModel) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { Stats(state.counts) }
        item { Search(state.orderQuery, actions::setOrderQuery, actions::refreshOrders, "رقم الأمر، العميل أو العنوان", NativeScanField.DOCUMENT_REFERENCE) }
        item { Chips(listOf(null, WorkOrderStatus.RECEIVED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.READY, WorkOrderStatus.DELIVERED), state.orderStatus, actions::setOrderStatus) { it?.label() ?: "الكل" } }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Chips(WorkQueue.entries, state.queue, actions::setQueue) { it.label() }; if (caps.canCreateOrders) IconButton(actions::beginOrder) { Icon(Icons.Rounded.Add, "أمر جديد") } } }
        if (state.orders.isEmpty()) item { Empty("لا توجد أوامر مطابقة") }
        items(state.orders, key = { it.id }) { order ->
            CurvedCard(statusColor(order.status)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(order.number, fontWeight = FontWeight.Bold); Pill(order.status.label(), statusColor(order.status)) }
                Text(order.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(order.customerName, order.assigneeName, order.dueDate).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text("${order.quantity} وحدة · ${order.salePrice} د.ع"); TextButton({ actions.selectOrder(order.id) }) { Text("التفاصيل") } }
            }
        }
        if (state.ordersHasMore) item { OutlinedButton(actions::loadMoreOrders, Modifier.fillMaxWidth()) { Text("عرض المزيد") } }
    }
}

@Composable
private fun OrderEditor(state: WorkOrdersUiState, actions: WorkOrdersViewModel) {
    val draft = requireNotNull(state.orderDraft)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PaneTitle("أمر شغل جديد", actions::closeOrderDraft) }
        item { Field("عنوان العمل", draft.title) { actions.updateOrderDraft(draft.copy(title = it)) } }
        item { Field("تفاصيل التخصيص", draft.customizationText, 3) { actions.updateOrderDraft(draft.copy(customizationText = it)) } }
        item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Box(Modifier.weight(1f)) { Field("الكمية", draft.quantity) { actions.updateOrderDraft(draft.copy(quantity = it)) } }; Box(Modifier.weight(1f)) { Field("سعر البيع", draft.salePrice) { actions.updateOrderDraft(draft.copy(salePrice = it)) } } } }
        item { Field("تاريخ الاستحقاق YYYY-MM-DD", draft.dueDate) { actions.updateOrderDraft(draft.copy(dueDate = it)) } }
        item { Text("الأولوية", fontWeight = FontWeight.SemiBold); Chips(listOf(WorkOrderPriority.LOW, WorkOrderPriority.NORMAL, WorkOrderPriority.URGENT), draft.priority, { actions.updateOrderDraft(draft.copy(priority = it)) }) { it.label() } }
        item { Text("قناة الاستلام", fontWeight = FontWeight.SemiBold); Chips(ReceptionChannel.entries, draft.channel, { actions.updateOrderDraft(draft.copy(channel = it)) }) { it.label() } }
        if (state.staff.isNotEmpty()) item { Text("المنفذ", fontWeight = FontWeight.SemiBold); Chips(listOf<StaffOption?>(null) + state.staff, state.staff.firstOrNull { it.id == draft.assignedTo }, { actions.updateOrderDraft(draft.copy(assignedTo = it?.id)) }) { it?.name ?: "غير مسند" } }
        item { FilterChip(draft.hasDelivery, { actions.updateOrderDraft(draft.copy(hasDelivery = !draft.hasDelivery)) }, { Text("توصيل للعميل") }, leadingIcon = { Icon(Icons.Rounded.LocalShipping, null) }) }
        if (draft.hasDelivery) { item { Field("عنوان التوصيل", draft.deliveryAddress, 2) { actions.updateOrderDraft(draft.copy(deliveryAddress = it)) } }; item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Box(Modifier.weight(1f)) { Field("الهاتف", draft.deliveryPhone) { actions.updateOrderDraft(draft.copy(deliveryPhone = it)) } }; Box(Modifier.weight(1f)) { Field("كلفة التوصيل", draft.deliveryCost) { actions.updateOrderDraft(draft.copy(deliveryCost = it)) } } } } }
        item { Field("ملاحظات", draft.notes, 2) { actions.updateOrderDraft(draft.copy(notes = it)) } }
        item { Info("ينشئ هذا المسار خدمة تخصيص خالصة دون خامات أو عربون؛ لا يخصم مخزوناً غير موثق.") }
        item { Button(actions::saveOrder, Modifier.fillMaxWidth()) { Text("إنشاء أمر الشغل") } }
    }
}

@Composable
private fun OrderDetailPane(state: WorkOrdersUiState, caps: WorkOrdersCapabilities, actions: WorkOrdersViewModel) {
    val order = requireNotNull(state.selectedOrder)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { PaneTitle(order.number, actions::closeOrder) }
        item { CurvedCard(statusColor(order.status)) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(order.title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Pill(order.status.label(), statusColor(order.status)) }; order.customizationText?.let { Text(it) }; Text("${order.customerName ?: "خدمة مباشرة"} · ${order.quantity} وحدة"); Text("السعر ${order.salePrice} · العربون ${order.deposit} د.ع", fontWeight = FontWeight.SemiBold) } }
        if (order.materials.isNotEmpty()) { item { Label("الخامات") }; items(order.materials, key = { it.id }) { material -> CurvedCard(WorkGreen) { Text(material.label, fontWeight = FontWeight.Bold); Text("${material.sku} · ${material.baseQuantity} وحدة"); material.unitCost?.let { Text("كلفة الوحدة $it") } } } }
        if (order.hasDelivery) item { Info("توصيل · ${order.deliveryAddress ?: "العنوان غير مكتمل"} · ${order.deliveryPhone ?: "—"}") }
        item { OrderActions(order, state, caps, actions) }
        if (order.timeline.isNotEmpty()) { item { Label("السجل التشغيلي") }; items(order.timeline, key = { it.id }) { event -> Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) { Text(event.action.actionLabel(), fontWeight = FontWeight.SemiBold); Text("${event.userName ?: "النظام"} · ${date(event.at)}", color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
    }
}

@Composable
private fun OrderActions(order: WorkOrderDetail, state: WorkOrdersUiState, caps: WorkOrdersCapabilities, actions: WorkOrdersViewModel) {
    val allowed = caps.actionsFor(order)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (WorkOrderAction.ASSIGN in allowed) {
            Text("إسناد المنفذ", fontWeight = FontWeight.SemiBold); Chips(listOf<StaffOption?>(null) + state.staff, state.staff.firstOrNull { it.id == order.assignedTo }, { actions.assign(it?.id) }) { it?.name ?: "إلغاء الإسناد" }
        }
        if (WorkOrderAction.CLAIM in allowed) OutlinedButton(actions::claim, Modifier.fillMaxWidth()) { Text("سحب الأمر") }
        if (WorkOrderAction.START in allowed) Button(actions::start, Modifier.fillMaxWidth()) { Text("بدء التنفيذ") }
        if (WorkOrderAction.MARK_READY in allowed) Button(actions::markReady, Modifier.fillMaxWidth()) { Text("اعتماد الجاهزية") }
        if (WorkOrderAction.DELIVER in allowed && state.deliveryDraft == null) Button(actions::beginDelivery, Modifier.fillMaxWidth()) { Text("استلام وتسليم") }
        state.deliveryDraft?.let { draft ->
            Field("المبلغ المقبوض الآن", draft.amount) { actions.updateDeliveryDraft(draft.copy(amount = it)) }
            Text("طريقة الدفع", fontWeight = FontWeight.SemiBold); Chips(listOf(PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER, PaymentMethod.WALLET), draft.method, { actions.updateDeliveryDraft(draft.copy(method = it)) }) { it.label() }
            if (draft.method != PaymentMethod.CASH) Field("مرجع الدفع", draft.reference) { actions.updateDeliveryDraft(draft.copy(reference = it)) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton(actions::closeDelivery, Modifier.weight(1f)) { Text("رجوع") }; Button(actions::deliver, Modifier.weight(1f)) { Text("تأكيد التسليم") } }
        }
        if (WorkOrderAction.CANCEL in allowed) TextButton(actions::cancelOrder, Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("إلغاء الأمر") }
    }
}

@Composable
private fun ServicesPane(state: WorkOrdersUiState, actions: WorkOrdersViewModel) {
    val rows = state.printServices.filter { state.printQuery.isBlank() || listOf(it.productName, it.sku, it.categoryName).any { value -> value?.contains(state.printQuery, true) == true } }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { Search(state.printQuery, actions::setPrintQuery, {}, "خدمة أو SKU", NativeScanField.SKU_OR_BARCODE) }
        item { Chips(PriceTier.entries, state.printTier, actions::setPrintTier) { it.label() } }
        if (rows.isEmpty()) item { Empty("لا توجد خدمات طباعة في هذه الفئة") }
        items(rows, key = { "${it.variantId}:${it.productUnitId}" }) { service -> CurvedCard(MaterialTheme.colorScheme.primary) { Text(service.productName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold); Text("${service.categoryName ?: "خدمات"} · ${service.unitName} · ${service.sku}"); Text(service.price?.let { "$it د.ع" } ?: "سعر يحدده الكاشير في نقطة البيع", color = if (service.price == null) WorkOrange else WorkGreen, fontWeight = FontWeight.Bold) } }
    }
}

@Composable
private fun PricingPane(state: WorkOrdersUiState, actions: WorkOrdersViewModel, tablet: Boolean) {
    val draft = state.pricingDraft; val bundle = state.pricingBundle
    val form: @Composable () -> Unit = {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Label("التسعير") }
            item { Chips(listOf("SMALL", "WIDE"), draft.category, { actions.updatePricingDraft(draft.copy(category = it)) }) { if (it == "SMALL") "رقمي صغير" else "طباعة عريضة" } }
            if (draft.category == "SMALL") {
                item { Text("المقاس", fontWeight = FontWeight.SemiBold); Chips(PAPER_SIZES, draft.paperSize, { actions.updatePricingDraft(draft.copy(paperSize = it)) }) { it } }
                item { Chips(listOf("BW", "COLOR"), draft.colorMode, { actions.updatePricingDraft(draft.copy(colorMode = it)) }) { if (it == "BW") "أبيض وأسود" else "ملون" } }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Box(Modifier.weight(1f)) { Field("النسخ", draft.copies) { actions.updatePricingDraft(draft.copy(copies = it)) } }; Box(Modifier.weight(1f)) { Field("صفحات النسخة", draft.pagesPerCopy) { actions.updatePricingDraft(draft.copy(pagesPerCopy = it)) } } } }
                item { Chips(listOf(1, 2), draft.sides, { actions.updatePricingDraft(draft.copy(sides = it)) }) { if (it == 1) "وجه واحد" else "وجهان" } }
                if (bundle?.paperUpcharges?.isNotEmpty() == true) item { Text("الورق", fontWeight = FontWeight.SemiBold); Chips(listOf<PricingOption?>(null) + bundle.paperUpcharges, bundle.paperUpcharges.firstOrNull { it.id == draft.paperUpchargeId }, { actions.updatePricingDraft(draft.copy(paperUpchargeId = it?.id)) }) { it?.name ?: "قياسي" } }
            } else {
                if (bundle?.wideMedia?.isNotEmpty() == true) item { Text("الوسيط", fontWeight = FontWeight.SemiBold); Chips(listOf<PricingOption?>(null) + bundle.wideMedia, bundle.wideMedia.firstOrNull { it.id == draft.mediaId }, { actions.updatePricingDraft(draft.copy(mediaId = it?.id)) }) { it?.name ?: "اختر الوسيط" } }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Box(Modifier.weight(1f)) { Field("العرض م", draft.width) { actions.updatePricingDraft(draft.copy(width = it)) } }; Box(Modifier.weight(1f)) { Field("الارتفاع م", draft.height) { actions.updatePricingDraft(draft.copy(height = it)) } }; Box(Modifier.weight(1f)) { Field("العدد", draft.quantity) { actions.updatePricingDraft(draft.copy(quantity = it)) } } } }
            }
            if (bundle?.finishings?.isNotEmpty() == true) item { Text("التشطيب", fontWeight = FontWeight.SemiBold); LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(bundle.finishings) { option -> FilterChip(option.id in draft.finishingIds, { actions.updatePricingDraft(draft.copy(finishingIds = if (option.id in draft.finishingIds) draft.finishingIds - option.id else draft.finishingIds + option.id)) }, { Text(option.name) }) } } }
            item { FilterChip(draft.applySetupFee, { actions.updatePricingDraft(draft.copy(applySetupFee = !draft.applySetupFee)) }, { Text("رسم التجهيز") }) }
            item { Button(actions::estimate, Modifier.fillMaxWidth()) { Text("احسب التقدير") } }
        }
    }
    val result: @Composable () -> Unit = { state.estimate?.let { estimate -> LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) { item { CurvedCard(WorkGreen) { Text("السعر المقترح", color = MaterialTheme.colorScheme.onSurfaceVariant); Text("${estimate.suggestedPrice} د.ع", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = WorkGreen); Text("سعر الوحدة ${estimate.unitPrice} · الكلفة ${estimate.totalCost}") } }; items(estimate.lines) { line -> CurvedCard(MaterialTheme.colorScheme.primary) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(line.label, fontWeight = FontWeight.Bold); Text(line.amount) }; line.detail?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) } } } } } ?: Empty("أدخل مواصفات الشغلة لعرض التقدير") }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) { Box(Modifier.weight(1f)) { form() }; Box(Modifier.weight(1f)) { result() } }
    else Column(Modifier.fillMaxSize().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { Box(Modifier.weight(1f)) { form() }; Box(Modifier.weight(1f)) { result() } }
}

@Composable
private fun ProductionPane(state: WorkOrdersUiState, actions: WorkOrdersViewModel, tablet: Boolean) {
    val detail: @Composable () -> Unit = { when { state.runDraft != null -> RunEditor(state, actions); state.selectedProduction != null -> ProductionDetailPane(state.selectedProduction, actions); else -> Empty("اختر مستند إنتاج") } }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) { Box(Modifier.weight(.9f)) { ProductionList(state, actions) }; Box(Modifier.weight(1.1f)) { detail() } }
    else if (state.runDraft != null || state.selectedProduction != null) Box(Modifier.fillMaxSize().padding(18.dp)) { detail() } else ProductionList(state, actions)
}

@Composable
private fun ProductionList(state: WorkOrdersUiState, actions: WorkOrdersViewModel) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Search(state.productionQuery, actions::setProductionQuery, actions::refreshProductions, "رقم المستند أو الناتج", NativeScanField.DOCUMENT_REFERENCE) }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Chips(listOf(null, ProductionStatus.CONFIRMED, ProductionStatus.CANCELLED), state.productionStatus, actions::setProductionStatus) { it?.label() ?: "الكل" }; IconButton(actions::beginRun) { Icon(Icons.Rounded.Add, "تشغيل وصفة") } } }
        if (state.productions.isEmpty()) item { Empty("لا توجد مستندات إنتاج") }
        items(state.productions, key = { it.id }) { production -> CurvedCard(if (production.status == ProductionStatus.CONFIRMED) WorkGreen else Color.Gray) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(production.number, fontWeight = FontWeight.Bold); Pill(production.status.label(), if (production.status == ProductionStatus.CONFIRMED) WorkGreen else Color.Gray) }; Text("${production.outputQty} ناتج · ${production.totalCost} د.ع"); TextButton({ actions.selectProduction(production.id) }, Modifier.align(Alignment.End)) { Text("التفاصيل") } } }
        if (state.productionHasMore) item { OutlinedButton(actions::loadMoreProductions, Modifier.fillMaxWidth()) { Text("عرض المزيد") } }
    }
}

@Composable
private fun RunEditor(state: WorkOrdersUiState, actions: WorkOrdersViewModel) {
    val draft = requireNotNull(state.runDraft)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { PaneTitle("تشغيل وصفة", actions::closeRun) }
        item { Text("الوصفة", fontWeight = FontWeight.SemiBold); Chips(listOf<RecipeSummary?>(null) + state.recipes, state.recipes.firstOrNull { it.id == draft.recipeId }, { actions.updateRunDraft(draft.copy(recipeId = it?.id)) }) { it?.name ?: "اختر وصفة" } }
        item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Box(Modifier.weight(1f)) { Field("حجم الدفعة", draft.batchQty) { actions.updateRunDraft(draft.copy(batchQty = it)) } }; Box(Modifier.weight(1f)) { Field("الهدر", draft.scrapQty) { actions.updateRunDraft(draft.copy(scrapQty = it)) } } } }
        item { Field("عمل لكل وحدة (اختياري)", draft.laborPerUnit) { actions.updateRunDraft(draft.copy(laborPerUnit = it)) } }
        item { OutlinedButton(actions::previewRun, Modifier.fillMaxWidth()) { Text("معاينة الاستهلاك والكلفة") } }
        state.runPreview?.let { preview -> item { CurvedCard(if (preview.anyShort) WorkOrange else WorkGreen) { Text(preview.outputName, fontWeight = FontWeight.Bold); Text("سليم ${preview.outputBase} · كلفة ${preview.totalCost}"); preview.inputs.forEach { line -> Text("${line.label}: ${line.required} / متاح ${line.available ?: "—"}", color = if (line.available != null && line.required > line.available) WorkOrange else MaterialTheme.colorScheme.onSurfaceVariant) } } }; item { Button(actions::createRun, Modifier.fillMaxWidth(), enabled = !preview.anyShort) { Text("ترحيل الإنتاج") } } }
    }
}

@Composable
private fun ProductionDetailPane(detail: ProductionDetail?, actions: WorkOrdersViewModel) {
    requireNotNull(detail)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { PaneTitle(detail.number, actions::closeProduction) }
        item { CurvedCard(if (detail.status == ProductionStatus.CONFIRMED) WorkGreen else Color.Gray) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(detail.recipeName ?: "إنتاج يدوي", fontWeight = FontWeight.Bold); Pill(detail.status.label(), if (detail.status == ProductionStatus.CONFIRMED) WorkGreen else Color.Gray) }; Text("الكلفة ${detail.totalCost} · السليم ${detail.goodQty ?: "—"} · الهدر ${detail.scrapQty ?: "—"}") } }
        item { Label("المدخلات") }; items(detail.inputs, key = { it.id }) { line -> ProductionLineCard(line) }
        item { Label("المخرجات") }; items(detail.outputs, key = { it.id }) { line -> ProductionLineCard(line) }
        if (detail.status == ProductionStatus.CONFIRMED) item { TextButton(actions::cancelProduction, Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("عكس مستند الإنتاج") } }
    }
}

@Composable private fun ProductionLineCard(line: ProductionLine) { CurvedCard(MaterialTheme.colorScheme.primary) { Text(line.label, fontWeight = FontWeight.Bold); Text("${line.sku} · ${line.baseQuantity} وحدة"); line.lineCost?.let { Text("الكلفة $it") } } }
@Composable private fun Stats(c: WorkOrderCounts) { LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(listOf("وارد" to c.received, "تنفيذ" to c.inProgress, "جاهز" to c.ready, "متأخر" to c.late)) { (label, value) -> Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(20.dp)) { Column(Modifier.width(108.dp).padding(14.dp)) { Text(value.toString(), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary); Text(label) } } } } }
@Composable private fun Search(value: String, change: (String) -> Unit, search: () -> Unit, label: String, scanField: NativeScanField) {
    OutlinedTextField(
        value,
        change,
        Modifier.fillMaxWidth(),
        label = { Text(label) },
        trailingIcon = {
            Row {
                NativeScannerAction(scanField, { scanned -> change(scanned); search() })
                IconButton(search) { Icon(Icons.Rounded.Search, "بحث") }
            }
        },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { search() }),
        singleLine = true,
        shape = RoundedCornerShape(18.dp),
    )
}
@Composable private fun Field(label: String, value: String, lines: Int = 1, change: (String) -> Unit) { OutlinedTextField(value, change, Modifier.fillMaxWidth(), label = { Text(label) }, minLines = lines, maxLines = lines, shape = RoundedCornerShape(16.dp)) }
@Composable private fun <T> Chips(values: List<T>, selected: T, choose: (T) -> Unit, label: (T) -> String) { LazyRow(horizontalArrangement = Arrangement.spacedBy(7.dp)) { items(values) { value -> FilterChip(selected == value, { choose(value) }, { Text(label(value)) }) } } }
@Composable private fun CurvedCard(accent: Color, content: @Composable ColumnScope.() -> Unit) { Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 28.dp, topEnd = 14.dp, bottomEnd = 28.dp, bottomStart = 14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) { Box { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp), content = content); Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(4.dp).background(accent)) } } }
@Composable private fun Pill(text: String, color: Color) { Surface(color = color.copy(alpha = .12f), shape = RoundedCornerShape(14.dp)) { Text(text, Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = color, fontWeight = FontWeight.Bold) } }
@Composable private fun PaneTitle(text: String, back: () -> Unit) { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { IconButton(back) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع") }; Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) } }
@Composable private fun Empty(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .55f), shape = RoundedCornerShape(24.dp)) { Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Rounded.Print, null, tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.height(8.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun Info(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(18.dp)) { Text(text, Modifier.padding(14.dp)) } }
@Composable private fun Label(text: String) { Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
@Composable private fun Feedback(text: String, error: Boolean, close: () -> Unit) { Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp), color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp)) { Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) { Icon(if (error) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle, null); Spacer(Modifier.width(8.dp)); Text(text, Modifier.weight(1f)); IconButton(close) { Icon(Icons.Rounded.Close, "إغلاق") } } } }

private fun WorkOrdersSection.label() = when (this) { WorkOrdersSection.ORDERS -> "أوامر الشغل"; WorkOrdersSection.PRINT_SERVICES -> "الخدمات"; WorkOrdersSection.PRICING -> "التسعير"; WorkOrdersSection.PRODUCTION -> "الإنتاج" }
private fun WorkOrdersSection.icon(): ImageVector = when (this) { WorkOrdersSection.ORDERS -> Icons.AutoMirrored.Rounded.Assignment; WorkOrdersSection.PRINT_SERVICES -> Icons.Rounded.Print; WorkOrdersSection.PRICING -> Icons.Rounded.Calculate; WorkOrdersSection.PRODUCTION -> Icons.Rounded.PrecisionManufacturing }
private fun WorkOrderStatus.label() = when (this) { WorkOrderStatus.RECEIVED -> "وارد"; WorkOrderStatus.IN_PROGRESS -> "قيد التنفيذ"; WorkOrderStatus.READY -> "جاهز"; WorkOrderStatus.DELIVERED -> "مسلّم"; WorkOrderStatus.CANCELLED -> "ملغي"; WorkOrderStatus.UNKNOWN -> "غير معروف" }
private fun WorkOrderPriority.label() = when (this) { WorkOrderPriority.LOW -> "منخفضة"; WorkOrderPriority.NORMAL -> "عادية"; WorkOrderPriority.URGENT -> "عاجلة"; WorkOrderPriority.UNKNOWN -> "غير معروفة" }
private fun WorkQueue.label() = when (this) { WorkQueue.ALL -> "الكل"; WorkQueue.MINE -> "أوامري"; WorkQueue.UNASSIGNED -> "غير مسند" }
private fun ReceptionChannel.label() = when (this) { ReceptionChannel.WALK_IN -> "حضوري"; ReceptionChannel.WHATSAPP -> "واتساب"; ReceptionChannel.INSTAGRAM -> "إنستغرام"; ReceptionChannel.TIKTOK -> "تيك توك"; ReceptionChannel.PHONE -> "هاتف"; ReceptionChannel.OTHER -> "أخرى" }
private fun PaymentMethod.label() = when (this) { PaymentMethod.CASH -> "نقدي"; PaymentMethod.CARD -> "بطاقة"; PaymentMethod.CHECK -> "شيك"; PaymentMethod.TRANSFER -> "تحويل"; PaymentMethod.WALLET -> "محفظة" }
private fun PriceTier.label() = when (this) { PriceTier.RETAIL -> "تجزئة"; PriceTier.WHOLESALE -> "جملة"; PriceTier.GOVERNMENT -> "حكومي" }
private fun ProductionStatus.label() = if (this == ProductionStatus.CONFIRMED) "مرحّل" else if (this == ProductionStatus.CANCELLED) "معكوس" else "غير معروف"
private fun statusColor(status: WorkOrderStatus) = when (status) { WorkOrderStatus.RECEIVED -> Color(0xFF4968A5); WorkOrderStatus.IN_PROGRESS -> WorkOrange; WorkOrderStatus.READY, WorkOrderStatus.DELIVERED -> WorkGreen; else -> Color.Gray }
private fun String.actionLabel() = when (this) { "workOrder.create" -> "استلام الأمر"; "workOrder.claim" -> "سحب للتنفيذ"; "workOrder.start" -> "بدء التنفيذ"; "workOrder.markReady" -> "اعتماد الجاهزية"; "workOrder.deliver" -> "التسليم والفوترة"; "workOrder.cancel" -> "إلغاء الأمر"; "workOrder.assign" -> "تحديث المنفذ"; else -> this }
private fun date(value: String?) = value?.replace('T', ' ')?.take(16) ?: "—"

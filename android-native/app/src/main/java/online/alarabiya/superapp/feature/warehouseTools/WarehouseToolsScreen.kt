package online.alarabiya.superapp.feature.warehouseTools

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.FactCheck
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.warehouseTools.*

private val WarehouseBlue = Color(0xFF5B36D2)
private val WarehouseTeal = Color(0xFF7254DB)
private val WarehouseAmber = Color(0xFFEC2F86)

@Composable
fun WarehouseToolsRoute(viewModel: WarehouseToolsViewModel, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    WarehouseToolsScreen(viewModel.state, viewModel.capabilities, viewModel, modifier)
}

@Composable
fun WarehouseToolsScreen(
    state: WarehouseToolsUiState,
    capabilities: WarehouseCapabilities,
    actions: WarehouseToolsViewModel,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(bottomStart = 42.dp, bottomEnd = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Surface(color = Color.White.copy(alpha = .13f), shape = RoundedCornerShape(22.dp)) { Icon(Icons.Rounded.Warehouse, null, Modifier.padding(13.dp), tint = Color.White) }
                Spacer(Modifier.width(13.dp))
                Column(Modifier.weight(1f)) { Text("أدوات المخزن", color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold); Text("المسح والعدّ المخزني", color = Color.White.copy(alpha = .72f)) }
                if (state.busyKey != null) CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
            }
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(capabilities.sections) { section -> FilterChip(state.section == section, { actions.selectSection(section) }, { Text(section.label()) }, leadingIcon = { Icon(section.icon(), null) }) }
        }
        state.message?.let { Feedback(it, false, actions::clearFeedback) }
        state.error?.let { Feedback(it, true, actions::clearFeedback) }
        if (state.initializing) LinearProgressIndicator(Modifier.fillMaxWidth())
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val tablet = maxWidth >= 840.dp
            when (state.section) {
                WarehouseSection.SCANNER -> ScannerPane(state, actions, tablet)
                WarehouseSection.COUNTS -> CountsPane(state, actions, tablet)
                WarehouseSection.OFFLINE -> OfflinePane(state, actions)
            }
        }
    }
}

@Composable
private fun ScannerPane(state: WarehouseToolsUiState, actions: WarehouseToolsViewModel, tablet: Boolean) {
    val input: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SectionTitle("قارئ الإدخال", "USB · Bluetooth · لوحة النظام", Icons.Rounded.Scanner)
            WedgeInput(state.scanInput, actions::setScanInput, actions::scan)
            Text("يبقى الحقل جاهزاً لاستقبال قارئ HID وينفّذ القراءة عند Enter.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            state.selectedCount?.let { session -> Info("المسح يبحث أولاً داخل جرد ${session.code} ثم اللقطة المحلية.") }
            state.snapshot?.let { snapshot -> Text("لقطة الفرع: ${snapshot.items.size} وحدة · ${compact(snapshot.syncedAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
    val result: @Composable () -> Unit = {
        when {
            state.catalogResult != null -> CatalogResult(state.catalogResult)
            state.signedResult != null -> SignedResult(state.signedResult)
            else -> Empty("امسح باركود صنف، SKU، أو QR مستند موقّع")
        }
    }
    if (tablet) Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) { Box(Modifier.weight(1f)) { input() }; Box(Modifier.weight(1f)) { result() } }
    else LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) { item { input() }; item { result() } }
}

@Composable
private fun WedgeInput(value: String, change: (String) -> Unit, submit: () -> Unit) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focus.requestFocus() }
    OutlinedTextField(
        value = value,
        onValueChange = change,
        modifier = Modifier.fillMaxWidth().focusRequester(focus).onPreviewKeyEvent { event ->
            if (event.key == Key.Enter && event.type == KeyEventType.KeyUp) { submit(); true } else false
        },
        label = { Text("امسح أو أدخل الرمز") },
        leadingIcon = { Icon(Icons.Rounded.QrCodeScanner, null) },
        trailingIcon = { FilledIconButton({ keyboard?.hide(); submit() }) { Icon(Icons.AutoMirrored.Rounded.ArrowForward, "تنفيذ") } },
        singleLine = true,
        shape = RoundedCornerShape(20.dp),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { keyboard?.hide(); submit() }),
    )
}

@Composable
private fun CatalogResult(item: WarehouseCatalogItem) {
    CurvedCard(WarehouseTeal) {
        Pill("مطابقة محلية مشفرة", WarehouseTeal)
        Text(item.label, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("${item.sku} · ${item.unitName} × ${item.conversionFactor}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        Text(item.stockBase?.let { "رصيد الفرع في آخر مزامنة: $it وحدة أساس" } ?: "لا يوجد رصيد في اللقطة", fontWeight = FontWeight.SemiBold)
        if (item.barcodes.isNotEmpty()) Text(item.barcodes.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SignedResult(result: SignedBarcodeResult) {
    CurvedCard(if (result.valid) WarehouseTeal else MaterialTheme.colorScheme.error) {
        Pill(if (result.valid) "توقيع صحيح" else "رمز غير موثوق", if (result.valid) WarehouseTeal else MaterialTheme.colorScheme.error)
        if (result.valid) {
            Text("${result.documentType ?: "مستند"} · ${result.number ?: "—"}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(listOfNotNull(result.date, result.amount, result.branchId?.let { "فرع $it" }).joinToString(" · "))
        } else Text("لم يثبت الخادم صحة التوقيع. لا تُنفذ أي حركة بناءً على هذا الرمز.")
    }
}

@Composable
private fun CountsPane(state: WarehouseToolsUiState, actions: WarehouseToolsViewModel, tablet: Boolean) {
    val session = state.selectedCount
    if (session == null) {
        LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            item { SectionTitle("تكليفاتي", "جلسات USER المسندة إلى حسابك", Icons.AutoMirrored.Rounded.FactCheck) }
            if (state.assignments.isEmpty()) item { Empty("لا توجد جلسات عد مسندة للحساب") }
            items(state.assignments, key = { it.assignmentId }) { assignment -> AssignmentCard(assignment) { actions.selectAssignment(assignment) } }
        }
        return
    }
    val list: @Composable () -> Unit = { CountItems(state, actions) }
    val detail: @Composable () -> Unit = { state.selectedItem?.let { CountEditor(session, it, requireNotNull(state.countDraft), actions) } ?: CountSummary(session, state.pending, actions) }
    if (tablet) Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) { Box(Modifier.weight(.9f)) { list() }; Box(Modifier.weight(1.1f)) { detail() } }
    else if (state.selectedItem != null) Box(Modifier.fillMaxSize().padding(18.dp)) { detail() } else list()
}

@Composable
private fun AssignmentCard(value: CountAssignment, open: () -> Unit) {
    CurvedCard(if (value.status == "ACTIVE") WarehouseBlue else Color.Gray) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(value.sessionCode, fontWeight = FontWeight.Bold); Pill(if (value.status == "ACTIVE") "نشط" else "مسلّم", if (value.status == "ACTIVE") WarehouseTeal else Color.Gray) }
        Text(value.sessionName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(listOfNotNull(value.zone, compact(value.lastActivityAt)).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(open, Modifier.align(Alignment.End)) { Text("فتح بوابة العد") }
    }
}

@Composable
private fun CountItems(state: WarehouseToolsUiState, actions: WarehouseToolsViewModel) {
    val session = requireNotNull(state.selectedCount)
    val query = state.countQuery.trim()
    val rows = session.items.filter { query.isEmpty() || it.label.contains(query, true) || it.units.any { unit -> unit.barcodes.any { code -> code.contains(query, true) } } }
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { IconButton(actions::closeCount) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع") }; Column(Modifier.weight(1f)) { Text(session.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text("${session.mineCounted}/${session.mineTotal} · ${session.zone ?: session.assignmentName}") }; IconButton(actions::refreshCount) { Icon(Icons.Rounded.Refresh, "تحديث") } } }
        item { LinearProgressIndicator(progress = { if (session.mineTotal == 0) 0f else (session.mineCounted.toFloat() / session.mineTotal).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(state.countQuery, actions::setCountQuery, Modifier.fillMaxWidth(), label = { Text("الصنف أو SKU أو الباركود") }, leadingIcon = { Icon(Icons.Rounded.Search, null) }, singleLine = true, shape = RoundedCornerShape(18.dp)) }
        if (rows.isEmpty()) item { Empty("لا توجد أصناف مطابقة") }
        items(rows, key = { it.variantId }) { item -> CurvedCard(if (item.myCount != null) WarehouseTeal else if (item.recountReason != null) WarehouseAmber else WarehouseBlue) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(item.label, Modifier.weight(1f), fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis); item.myCount?.let { Pill(it.quantity.toString(), WarehouseTeal) } }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { if (item.recountReason != null) Pill("إعادة عد", WarehouseAmber); if (item.colleagueCounted) Pill("معدود من زميل", WarehouseBlue) }
            TextButton({ actions.beginCount(item) }, Modifier.align(Alignment.End), enabled = session.canCount(item)) { Text(if (item.myCount == null) "تسجيل العد" else "تعديل عدّي") }
        } }
    }
}

@Composable
private fun CountSummary(session: CountSession, pending: List<PendingCount>, actions: WarehouseToolsViewModel) {
    var confirmFinish by remember(session.code) { mutableStateOf(false) }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("ملخص العد", session.code, Icons.Rounded.Inventory) }
        item { CurvedCard(WarehouseTeal) { Text("تقدمي", color = MaterialTheme.colorScheme.onSurfaceVariant); Text("${session.mineCounted} / ${session.mineTotal}", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold); Text("الجلسة ${session.sessionCounted} / ${session.sessionTotal}") } }
        if (pending.isNotEmpty()) item { Info("توجد ${pending.count { it.status == PendingCountStatus.QUEUED }} عدّات مشفرة بانتظار المزامنة.") }
        item { Button({ confirmFinish = true }, Modifier.fillMaxWidth(), enabled = session.active && session.sessionCounted == session.sessionTotal && pending.isEmpty()) { Text("رفع الجرد للمراجعة") } }
    }
    ConfirmationDialog(
        visible = confirmFinish,
        title = "رفع الجرد للمراجعة؟",
        body = "سيُنهي هذا الإجراء تكليف العد الحالي ويرفع الجلسة المكتملة للمراجعة.",
        confirmLabel = "رفع للمراجعة",
        onConfirm = { confirmFinish = false; actions.finishCount() },
        onDismiss = { confirmFinish = false },
    )
}

@Composable
private fun CountEditor(session: CountSession, item: CountItem, draft: CountDraft, actions: WarehouseToolsViewModel) {
    var confirmSubmit by remember(session.code, item.variantId, draft.clientRequestId) { mutableStateOf(false) }
    val quantityBase = runCatching { WarehouseValidation.submission(draft).quantityBase }.getOrNull()
    LazyColumn(verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { IconButton(actions::closeCountEntry) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع") }; Column { Text(item.label, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text("يُرسل الإجمالي بالوحدة الأساس", color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
        item { CurvedCard(WarehouseBlue) { draft.entries.forEachIndexed { index, entry -> OutlinedTextField(entry.quantity, { actions.updateUnitQuantity(index, it) }, Modifier.fillMaxWidth(), label = { Text("${entry.unitName} × ${entry.factor}") }, singleLine = true, shape = RoundedCornerShape(16.dp)) } } }
        item { Info(if (session.blind) "الجرد أعمى؛ لا يعرض التطبيق الرصيد الدفتري أو كمية الزميل." else "تُرسل العدّة ضمن جلسة ${session.code}.") }
        item { Button({ confirmSubmit = true }, Modifier.fillMaxWidth(), enabled = session.active) { Text("تسجيل العد") } }
    }
    ConfirmationDialog(
        visible = confirmSubmit,
        title = "تسجيل العدّة؟",
        body = quantityBase?.let { "سيُسجل إجمالي $it وحدة أساس لهذا الصنف، ويمكن تعديل العد قبل رفع الجرد." }
            ?: "سيتم التحقق من الوحدات المدخلة قبل تسجيل العد.",
        confirmLabel = "تسجيل",
        onConfirm = { confirmSubmit = false; actions.submitCount() },
        onDismiss = { confirmSubmit = false },
    )
}

@Composable
private fun OfflinePane(state: WarehouseToolsUiState, actions: WarehouseToolsViewModel) {
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("الاستمرارية", "بيانات العمل محفوظة بأمان على هذا الجهاز", Icons.Rounded.OfflineBolt) }
        item { CurvedCard(WarehouseBlue) { Text("لقطة القراءة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(state.snapshot?.let { "${it.items.size} وحدة · ${compact(it.syncedAt)}" } ?: "لم تُنزّل لقطة بعد"); Button(actions::syncSnapshot, Modifier.fillMaxWidth()) { Text("تحديث الكتالوج ورصيد الفرع") } } }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Column { Text("طابور العد", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text("إرسال مرتب دون تكرار", color = MaterialTheme.colorScheme.onSurfaceVariant) }; if (state.pending.any { it.status == PendingCountStatus.QUEUED }) FilledTonalButton(actions::replayPending) { Text("مزامنة") } } }
        if (state.pending.isEmpty()) item { Empty("لا توجد عمليات معلقة") }
        items(state.pending, key = { it.clientRequestId }) { pending ->
            var confirmDiscard by remember(pending.clientRequestId) { mutableStateOf(false) }
            CurvedCard(if (pending.status == PendingCountStatus.QUEUED) WarehouseAmber else MaterialTheme.colorScheme.error) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(pending.sessionCode, fontWeight = FontWeight.Bold); Pill(if (pending.status == PendingCountStatus.QUEUED) "بانتظار الإرسال" else "مرفوضة", if (pending.status == PendingCountStatus.QUEUED) WarehouseAmber else MaterialTheme.colorScheme.error) }
                Text("صنف ${pending.variantId} · ${pending.quantityBase} وحدة أساس")
                pending.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (pending.status == PendingCountStatus.REJECTED) TextButton({ confirmDiscard = true }, Modifier.align(Alignment.End)) { Text("حذف الإدخال") }
            }
            ConfirmationDialog(
                visible = confirmDiscard,
                title = "حذف الإدخال المحلي؟",
                body = "لن يُرسل هذا العد إلى الخادم بعد الحذف، ولا يمكن التراجع عن هذا الإجراء.",
                confirmLabel = "حذف",
                destructive = true,
                onConfirm = { confirmDiscard = false; actions.discardPending(pending.clientRequestId) },
                onDismiss = { confirmDiscard = false },
            )
        }
        item { Info("إنهاء الجرد والتحقق من المستندات وعمليات البيع تحتاج اتصالاً مباشراً.") }
    }
}

@Composable private fun SectionTitle(title: String, subtitle: String, icon: ImageVector) { Row(verticalAlignment = Alignment.CenterVertically) { Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(18.dp)) { Icon(icon, null, Modifier.padding(11.dp), tint = MaterialTheme.colorScheme.primary) }; Spacer(Modifier.width(11.dp)); Column { Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun CurvedCard(accent: Color, content: @Composable ColumnScope.() -> Unit) { Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 30.dp, topEnd = 14.dp, bottomEnd = 30.dp, bottomStart = 14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) { Box { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content); Box(Modifier.align(Alignment.CenterStart).width(4.dp).height(58.dp).background(accent, RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp))) } } }
@Composable private fun Pill(text: String, color: Color) { Surface(color = color.copy(alpha = .12f), shape = RoundedCornerShape(14.dp)) { Text(text, Modifier.padding(horizontal = 9.dp, vertical = 5.dp), color = color, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium) } }
@Composable private fun Info(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(18.dp)) { Text(text, Modifier.padding(14.dp)) } }
@Composable private fun Empty(text: String) { Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .5f), shape = RoundedCornerShape(24.dp)) { Column(Modifier.padding(28.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Rounded.Inventory2, null, tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.height(8.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable
private fun ConfirmationDialog(
    visible: Boolean,
    title: String,
    body: String,
    confirmLabel: String,
    destructive: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = if (destructive) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error) else ButtonDefaults.buttonColors(),
            ) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onDismiss) { Text("رجوع") } },
    )
}

@Composable private fun Feedback(text: String, error: Boolean, close: () -> Unit) { Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite }, color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp)) { Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) { Icon(if (error) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle, null); Spacer(Modifier.width(8.dp)); Text(text, Modifier.weight(1f)); IconButton(close) { Icon(Icons.Rounded.Close, "إغلاق") } } } }

private fun WarehouseSection.label() = when (this) { WarehouseSection.SCANNER -> "المسح"; WarehouseSection.COUNTS -> "العد"; WarehouseSection.OFFLINE -> "دون اتصال" }
private fun WarehouseSection.icon() = when (this) { WarehouseSection.SCANNER -> Icons.Rounded.QrCodeScanner; WarehouseSection.COUNTS -> Icons.AutoMirrored.Rounded.FactCheck; WarehouseSection.OFFLINE -> Icons.Rounded.OfflineBolt }
private fun compact(value: String?) = value?.replace('T', ' ')?.take(16) ?: "—"

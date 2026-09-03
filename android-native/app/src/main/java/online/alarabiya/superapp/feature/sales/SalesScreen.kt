package online.alarabiya.superapp.feature.sales

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.PersonSearch
import androidx.compose.material.icons.rounded.PointOfSale
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.ScrollableTabRow
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.sales.CartLine
import online.alarabiya.superapp.model.sales.CatalogSaleItem
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.ReturnableInvoice
import online.alarabiya.superapp.model.sales.SaleDetail
import online.alarabiya.superapp.model.sales.SaleSummary
import online.alarabiya.superapp.model.sales.SalesCapabilities
import online.alarabiya.superapp.model.sales.SalesCustomer
import online.alarabiya.superapp.model.sales.SalesSection
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

@Composable
fun SalesRoute(viewModel: SalesViewModel, capabilities: SalesCapabilities, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    SalesScreen(
        state = viewModel.state,
        capabilities = capabilities,
        actions = SalesActions(
            section = viewModel::section,
            catalogQuery = viewModel::catalogQuery,
            searchCatalog = viewModel::searchCatalog,
            add = viewModel::add,
            quantity = viewModel::quantity,
            remove = viewModel::remove,
            customerQuery = viewModel::customerQuery,
            searchCustomers = viewModel::searchCustomers,
            selectCustomer = viewModel::selectCustomer,
            collectedAmount = viewModel::collectedAmount,
            paymentMethod = viewModel::paymentMethod,
            paymentReference = viewModel::paymentReference,
            notes = viewModel::notes,
            submitSale = viewModel::submitSale,
            salesQuery = viewModel::salesQuery,
            searchSales = viewModel::searchSales,
            loadMore = viewModel::loadMoreSales,
            saleDetail = viewModel::saleDetail,
            closeSale = viewModel::closeSale,
            beginReturn = viewModel::beginReturn,
            returnQuantity = viewModel::returnQuantity,
            returnRefundAmount = viewModel::returnRefundAmount,
            returnMethod = viewModel::returnMethod,
            returnShift = viewModel::returnShift,
            returnRestock = viewModel::returnRestock,
            submitReturn = viewModel::submitReturn,
            retry = viewModel::initialize,
        ),
        modifier = modifier,
    )
}

data class SalesActions(
    val section: (SalesSection) -> Unit,
    val catalogQuery: (String) -> Unit,
    val searchCatalog: () -> Unit,
    val add: (CatalogSaleItem) -> Unit,
    val quantity: (Long, String) -> Unit,
    val remove: (Long) -> Unit,
    val customerQuery: (String) -> Unit,
    val searchCustomers: () -> Unit,
    val selectCustomer: (SalesCustomer?) -> Unit,
    val collectedAmount: (String) -> Unit,
    val paymentMethod: (PaymentMethod) -> Unit,
    val paymentReference: (String) -> Unit,
    val notes: (String) -> Unit,
    val submitSale: () -> Unit,
    val salesQuery: (String) -> Unit,
    val searchSales: () -> Unit,
    val loadMore: () -> Unit,
    val saleDetail: (Long) -> Unit,
    val closeSale: () -> Unit,
    val beginReturn: (Long) -> Unit,
    val returnQuantity: (Long, Int) -> Unit,
    val returnRefundAmount: (String) -> Unit,
    val returnMethod: (PaymentMethod) -> Unit,
    val returnShift: (Long?) -> Unit,
    val returnRestock: (Boolean) -> Unit,
    val submitReturn: () -> Unit,
    val retry: () -> Unit,
)

private enum class SalesSensitiveAction { SALE, RETURN }

@Composable
fun SalesScreen(state: SalesUiState, capabilities: SalesCapabilities, actions: SalesActions, modifier: Modifier = Modifier) {
    var pendingAction by rememberSaveable { mutableStateOf<SalesSensitiveAction?>(null) }
    val guardedActions = actions.copy(
        submitSale = { pendingAction = SalesSensitiveAction.SALE },
        submitReturn = { pendingAction = SalesSensitiveAction.RETURN },
    )
    val sections = buildList {
        if (capabilities.canCreateSale) add(SalesSection.CHECKOUT)
        if (capabilities.canReadSales) add(SalesSection.HISTORY)
        if (capabilities.canCreateReturn) add(SalesSection.RETURNS)
    }
    Scaffold(modifier.fillMaxSize().imePadding(), containerColor = MaterialTheme.colorScheme.surface) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            SalesHeader(state.cart.size)
            if (sections.isNotEmpty()) {
                ScrollableTabRow(
                    selectedTabIndex = sections.indexOf(state.section).coerceAtLeast(0),
                    edgePadding = 14.dp,
                ) {
                    sections.forEach { section ->
                        Tab(
                            selected = state.section == section,
                            onClick = { actions.section(section) },
                            enabled = !state.locked,
                            text = { Text(section.label) },
                            icon = { Icon(section.icon, contentDescription = null) },
                        )
                    }
                }
            }
            state.error?.let { Banner(it, true, actions.retry) }
            state.notice?.let { Banner(it, false) }
            if (state.busy == SalesBusy.INITIAL) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else when (state.section) {
                SalesSection.CHECKOUT -> CheckoutWorkspace(state, guardedActions)
                SalesSection.HISTORY -> HistoryWorkspace(state, capabilities, guardedActions)
                SalesSection.RETURNS -> ReturnsWorkspace(state, guardedActions)
            }
        }
    }
    pendingAction?.let { action ->
        val sale = action == SalesSensitiveAction.SALE
        AlertDialog(
            onDismissRequest = { pendingAction = null },
            // نصُّ المرتجع يتفرّع على من ينفّذه (تدقيق ١/٩/٢٦): كان يَعِد الجميع بإثبات
            // المرتجع والاسترداد وحركة المخزون، بينما هو **طلبٌ صفريّ الأثر** لغير المالك —
            // فيسلّم الموظّف البضاعة والنقد على وعدٍ لا يقع.
            title = {
                Text(
                    when {
                        sale -> "تأكيد حفظ عملية البيع"
                        capabilities.returnExecutesImmediately -> "تأكيد تنفيذ المرتجع الآن"
                        else -> "تأكيد إرسال طلب المرتجع"
                    },
                )
            },
            text = {
                Text(
                    when {
                        sale -> "سيتم إنشاء فاتورة وإثبات حركة الدفع والمخزون."
                        capabilities.returnExecutesImmediately ->
                            "سيتم إثبات المرتجع والاسترداد وحركة المخزون وفق البيانات المعروضة."
                        else ->
                            "سيُرسَل طلبٌ للاعتماد فقط. لا يتغيّر المخزون ولا المال الآن — " +
                                "لا تسلّم الزبون نقوداً ولا تستلم البضاعة حتى يعتمده مديرٌ مستقل."
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingAction = null
                        if (sale) actions.submitSale() else actions.submitReturn()
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("تأكيد") }
            },
            dismissButton = { TextButton({ pendingAction = null }, Modifier.heightIn(min = 48.dp)) { Text("إلغاء") } },
        )
    }
}

@Composable
private fun SalesHeader(cartCount: Int) {
    Box(
        Modifier.fillMaxWidth().background(
            Brush.horizontalGradient(listOf(MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.tertiary)),
            RoundedCornerShape(bottomStart = 38.dp, bottomEnd = 18.dp),
        ).padding(horizontal = 22.dp, vertical = 18.dp),
    ) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Column {
                Text("المبيعات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold, color = Color.White)
                Text("المبيعات والمرتجعات", color = Color.White.copy(alpha = .78f))
            }
            Box(Modifier.size(48.dp).clip(CircleShape).background(Color.White.copy(alpha = .14f)), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Rounded.PointOfSale, null, tint = Color.White, modifier = Modifier.size(21.dp))
                    if (cartCount > 0) Text(cartCount.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun CheckoutWorkspace(state: SalesUiState, actions: SalesActions) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        if (maxWidth >= 760.dp) {
            Row(Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                CatalogPane(state, actions, Modifier.weight(1.12f).fillMaxHeight())
                CartPane(state, actions, Modifier.weight(.88f).fillMaxHeight())
            }
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                item { CatalogPane(state, actions, Modifier.fillMaxWidth(), compact = true) }
                item { CartPane(state, actions, Modifier.fillMaxWidth(), compact = true) }
            }
        }
    }
}

@Composable
private fun CatalogPane(state: SalesUiState, actions: SalesActions, modifier: Modifier, compact: Boolean = false) {
    SalesCard(modifier) {
        SectionTitle("الكتالوج", "الأسعار والتوفر", Icons.Rounded.Inventory2)
        SearchField(state.catalogQuery, actions.catalogQuery, actions.searchCatalog, "اسم، رمز أو باركود", state.locked, scanField = NativeScanField.SKU_OR_BARCODE)
        if (state.catalog.isEmpty()) EmptyText("لا توجد نتائج متاحة لهذا الفرع") else {
            val listModifier = if (compact) Modifier.fillMaxWidth().height(320.dp) else Modifier.fillMaxSize()
            LazyColumn(listModifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.catalog, key = { it.productUnitId }) { ProductRow(it, state.locked, actions.add) }
            }
        }
    }
}

@Composable
private fun ProductRow(item: CatalogSaleItem, locked: Boolean, onAdd: (CatalogSaleItem) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp, topEnd = 10.dp, bottomStart = 10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(enabled = item.sellable && !locked, role = Role.Button) { onAdd(item) }
            .padding(13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(42.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Add, null, tint = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.label, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("${item.sku} • المتاح ${item.availableBase}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
        Text(item.serverPrice?.let { "$it د.ع" } ?: "غير مسعّر", color = if (item.sellable) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun CartPane(state: SalesUiState, actions: SalesActions, modifier: Modifier, compact: Boolean = false) {
    SalesCard(modifier) {
        SectionTitle("السلة", "${state.cart.size} بنود", Icons.AutoMirrored.Rounded.ReceiptLong)
        CustomerPicker(state, actions)
        val cartModifier = if (compact) Modifier.fillMaxWidth().height(240.dp) else Modifier.weight(1f)
        if (state.cart.isEmpty()) Box(cartModifier, contentAlignment = Alignment.Center) { EmptyText("اختر صنفاً لبدء الفاتورة") }
        else LazyColumn(cartModifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.cart, key = { it.item.productUnitId }) { CartRow(it, state.locked, actions) }
        }
        PaymentPanel(state, actions)
    }
}

@Composable
private fun CustomerPicker(state: SalesUiState, actions: SalesActions) {
    SearchField(state.customerQuery, actions.customerQuery, actions.searchCustomers, "بحث العميل (اختياري)", state.locked, Icons.Rounded.PersonSearch)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = state.selectedCustomer == null, onClick = { actions.selectCustomer(null) }, enabled = !state.locked, label = { Text("بيع مباشر") })
        state.customers.forEach { customer ->
            FilterChip(
                selected = state.selectedCustomer?.id == customer.id,
                onClick = { actions.selectCustomer(customer) },
                enabled = !state.locked,
                label = { Text(customer.name, maxLines = 1) },
            )
        }
    }
}

@Composable
private fun CartRow(line: CartLine, locked: Boolean, actions: SalesActions) {
    CartLineCard(line, locked, actions.quantity, actions.remove)
}

/** Visible to the narrow large-text instrumentation contract without exposing the whole screen. */
@Composable
internal fun CartLineCard(
    line: CartLine,
    locked: Boolean,
    onQuantity: (Long, String) -> Unit,
    onRemove: (Long) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                // Product identity is never ellipsized: with large accessibility fonts it wraps
                // vertically instead of competing horizontally with quantity controls.
                Text(line.item.label, fontWeight = FontWeight.SemiBold)
                Text(
                    "السعر المرجعي ${line.item.serverPrice ?: "—"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(
                onClick = { onRemove(line.item.productUnitId) },
                enabled = !locked,
            ) {
                Icon(
                    Icons.Rounded.Close,
                    "إزالة ${line.item.label} من السلة",
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }

        // A dedicated full-width control row remains usable at 320dp and fontScale 2.0. The input
        // takes the remaining width instead of imposing the former fixed 72dp bottleneck.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = {
                    onQuantity(
                        line.item.productUnitId,
                        ((line.quantity.toDoubleOrNull() ?: 1.0) - 1.0).coerceAtLeast(1.0).asQuantity(),
                    )
                },
                enabled = !locked,
            ) { Icon(Icons.Rounded.Remove, "تقليل كمية ${line.item.label}") }
            OutlinedTextField(
                value = line.quantity,
                onValueChange = { onQuantity(line.item.productUnitId, it) },
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                enabled = !locked,
                singleLine = true,
                label = { Text("الكمية") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            IconButton(
                onClick = {
                    onQuantity(
                        line.item.productUnitId,
                        ((line.quantity.toDoubleOrNull() ?: 0.0) + 1.0).asQuantity(),
                    )
                },
                enabled = !locked,
            ) { Icon(Icons.Rounded.Add, "زيادة كمية ${line.item.label}") }
        }
    }
}

@Composable
private fun PaymentPanel(state: SalesUiState, actions: SalesActions) {
    Text("الدفع", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        PaymentMethod.entries.forEach { method ->
            FilterChip(selected = state.paymentMethod == method, onClick = { actions.paymentMethod(method) }, enabled = !state.locked, label = { Text(method.label) })
        }
    }
    OutlinedTextField(
        value = state.collectedAmount,
        onValueChange = actions.collectedAmount,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("المبلغ المحصل") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        enabled = !state.locked,
        singleLine = true,
    )
    if (state.paymentMethod != PaymentMethod.CASH) {
        OutlinedTextField(state.paymentReference, actions.paymentReference, Modifier.fillMaxWidth(), label = { Text("مرجع الدفع") }, enabled = !state.locked, singleLine = true)
    }
    OutlinedTextField(state.notes, actions.notes, Modifier.fillMaxWidth(), label = { Text("ملاحظات الفاتورة (اختياري)") }, enabled = !state.locked, maxLines = 2)
    Text(
        "الإجمالي والضريبة والخصومات تُثبت عند الحفظ.",
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(14.dp)).padding(11.dp),
        color = MaterialTheme.colorScheme.onSecondaryContainer,
        style = MaterialTheme.typography.bodySmall,
    )
    if (state.paymentMethod == PaymentMethod.CASH && state.selectedSaleShiftId == null) {
        Text("لا توجد وردية نقدية مفتوحة لهذا المستخدم.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    Button(
        onClick = actions.submitSale,
        modifier = Modifier.fillMaxWidth().height(54.dp),
        enabled = !state.locked && state.checkoutDependenciesLoaded && state.cart.isNotEmpty() &&
            (state.paymentMethod != PaymentMethod.CASH || state.selectedSaleShiftId != null),
        shape = RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp, topEnd = 12.dp, bottomStart = 12.dp),
    ) {
        if (state.busy == SalesBusy.SALE) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Text("تأكيد البيع", fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun HistoryWorkspace(state: SalesUiState, capabilities: SalesCapabilities, actions: SalesActions) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            HistoryList(state, actions, Modifier.weight(.9f).fillMaxHeight())
            DetailPane(state.selectedSale, capabilities.canCreateReturn, actions, Modifier.weight(1.1f).fillMaxHeight())
        } else if (state.selectedSale != null) DetailPane(state.selectedSale, capabilities.canCreateReturn, actions, Modifier.fillMaxSize(), true)
        else HistoryList(state, actions, Modifier.fillMaxSize())
    }
}

@Composable
private fun HistoryList(state: SalesUiState, actions: SalesActions, modifier: Modifier) {
    SalesCard(modifier) {
        SectionTitle("سجل المبيعات", "نتائج خاضعة للفرع والصلاحية", Icons.AutoMirrored.Rounded.ReceiptLong)
        SearchField(state.salesQuery, actions.salesQuery, actions.searchSales, "رقم فاتورة أو عميل", state.locked, scanField = NativeScanField.DOCUMENT_REFERENCE)
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.salesPage.rows, key = SaleSummary::id) { sale ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(MaterialTheme.colorScheme.surfaceContainer)
                        .clickable(enabled = !state.locked, role = Role.Button) { actions.saleDetail(sale.id) }.padding(14.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                        Text(sale.invoiceNumber, fontWeight = FontWeight.Bold)
                        Text("${sale.total} د.ع", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    }
                    Text(listOfNotNull(sale.customerName, sale.invoiceDate, sale.status).joinToString(" • "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (state.salesPage.hasMore) item { Button(actions.loadMore, Modifier.fillMaxWidth(), enabled = !state.locked) { Text("المزيد") } }
        }
    }
}

@Composable
private fun DetailPane(detail: SaleDetail?, canReturn: Boolean, actions: SalesActions, modifier: Modifier, showBack: Boolean = false) {
    SalesCard(modifier) {
        if (detail == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { EmptyText("اختر فاتورة لعرض تفاصيلها") }
            return@SalesCard
        }
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            if (showBack) IconButton(actions.closeSale) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
            Column(Modifier.weight(1f)) {
                Text(detail.invoiceNumber, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(detail.customerName ?: "بيع مباشر", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("${detail.total} د.ع", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.ExtraBold)
        }
        Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
            Metric("الإجمالي", detail.total, Modifier.weight(1f)); Metric("المدفوع", detail.paidAmount, Modifier.weight(1f)); Metric("المرتجع", detail.returnedTotal, Modifier.weight(1f))
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(detail.items, key = { it.id }) { line ->
                Row(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)).padding(12.dp), Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) { Text(line.productName, fontWeight = FontWeight.SemiBold); Text("${line.quantity} ${line.unitName.orEmpty()}", style = MaterialTheme.typography.bodySmall) }
                    Text(line.total, fontWeight = FontWeight.Bold)
                }
            }
        }
        if (canReturn) Button(onClick = { actions.beginReturn(detail.id) }, modifier = Modifier.fillMaxWidth()) { Text("إنشاء طلب مرتجع") }
    }
}

@Composable
private fun ReturnsWorkspace(state: SalesUiState, actions: SalesActions) {
    val invoice = state.returnInvoice
    if (invoice == null) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { Text("المرتجعات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
            item { Text("اختر فاتورة من سجل المبيعات لبدء مرتجع موثّق.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(state.salesPage.rows.take(12), key = SaleSummary::id) { sale ->
                Button(onClick = { actions.beginReturn(sale.id) }, modifier = Modifier.fillMaxWidth(), enabled = !state.locked) { Text("${sale.invoiceNumber}  •  ${sale.total} د.ع") }
            }
        }
        return
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        ReturnEditor(invoice, state, actions, Modifier.widthIn(max = 920.dp).fillMaxWidth())
    }
}

@Composable
private fun ReturnEditor(invoice: ReturnableInvoice, state: SalesUiState, actions: SalesActions, modifier: Modifier = Modifier) {
    LazyColumn(modifier.fillMaxHeight(), contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SalesCard(Modifier.fillMaxWidth()) {
                SectionTitle("مرتجع ${invoice.invoiceNumber}", "المتبقي القابل للإرجاع فقط", Icons.Rounded.Sync)
                Text("قيمة الفاتورة ${invoice.total} د.ع • ${invoice.customerName ?: "بيع مباشر"}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        items(invoice.items, key = { it.invoiceItemId }) { line ->
            SalesCard(Modifier.fillMaxWidth()) {
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(line.productName, fontWeight = FontWeight.Bold)
                        Text("متاح للإرجاع ${line.remaining} ${line.unitName}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton({ actions.returnQuantity(line.invoiceItemId, (state.returnQuantities[line.invoiceItemId] ?: 0) - 1) }, enabled = !state.locked) { Icon(Icons.Rounded.Remove, "تقليل مرتجع ${line.productName}") }
                    Text((state.returnQuantities[line.invoiceItemId] ?: 0).toString(), fontWeight = FontWeight.Bold)
                    IconButton({ actions.returnQuantity(line.invoiceItemId, (state.returnQuantities[line.invoiceItemId] ?: 0) + 1) }, enabled = !state.locked) { Icon(Icons.Rounded.Add, "زيادة مرتجع ${line.productName}") }
                }
            }
        }
        item {
            SalesCard(Modifier.fillMaxWidth()) {
                Text("الاسترداد", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                OutlinedTextField(state.returnRefundAmount, actions.returnRefundAmount, Modifier.fillMaxWidth(), label = { Text("مبلغ الاسترداد") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), enabled = !state.locked)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PaymentMethod.entries.forEach { method -> FilterChip(state.returnMethod == method, { actions.returnMethod(method) }, label = { Text(method.label) }, enabled = !state.locked) }
                }
                if (state.returnMethod == PaymentMethod.CASH && state.returnRefundAmount.toDoubleOrNull()?.let { it > 0 } == true) {
                    Text("درج الاسترداد", fontWeight = FontWeight.SemiBold)
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(state.openShifts, key = { it.id }) { shift ->
                            FilterChip(
                                state.returnShiftId == shift.id,
                                { actions.returnShift(shift.id) },
                                label = { Text(shift.userName ?: "وردية ${shift.id}") },
                                enabled = !state.locked,
                            )
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(state.returnRestock, actions.returnRestock, enabled = !state.locked); Text("إعادة الكمية للمخزون") }
                Text("تُراجع القيمة النهائية مع الفاتورة والكميات.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                Button(actions.submitReturn, Modifier.fillMaxWidth().height(52.dp), enabled = !state.locked) { Text("تسجيل المرتجع") }
            }
        }
    }
}

@Composable
private fun SearchField(
    value: String,
    onValue: (String) -> Unit,
    search: () -> Unit,
    label: String,
    locked: Boolean,
    icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Rounded.Search,
    scanField: NativeScanField? = null,
) {
    OutlinedTextField(
        value, onValue, Modifier.fillMaxWidth(), label = { Text(label) },
        leadingIcon = if (icon == Icons.Rounded.Search) null else ({ Icon(icon, null) }),
        trailingIcon = {
            Row {
                scanField?.let { field ->
                    NativeScannerAction(field, { scanned -> onValue(scanned); search() }, enabled = !locked)
                }
                IconButton(search, enabled = !locked) { Icon(Icons.Rounded.Search, "بحث") }
            }
        },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { search() }),
        enabled = !locked, singleLine = true, shape = RoundedCornerShape(18.dp),
    )
}

@Composable
private fun SalesCard(modifier: Modifier, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 34.dp, topEnd = 18.dp, bottomEnd = 34.dp, bottomStart = 18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) { Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content) }
}

@Composable private fun SectionTitle(title: String, subtitle: String, icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(topStart = 17.dp, bottomEnd = 17.dp)), contentAlignment = Alignment.Center) { Icon(icon, null, tint = MaterialTheme.colorScheme.primary) }
        Spacer(Modifier.width(10.dp)); Column { Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun Metric(label: String, value: String, modifier: Modifier) {
    Column(modifier.background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp)).padding(10.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable private fun Banner(text: String, error: Boolean, retry: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth()
            .background(if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            Modifier.weight(1f).padding(vertical = 10.dp),
            color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
        )
        if (error && retry != null) TextButton(retry, Modifier.heightIn(min = 48.dp)) { Text("إعادة المحاولة") }
    }
}

@Composable private fun EmptyText(text: String) { Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) }

private val SalesSection.label get() = when (this) { SalesSection.CHECKOUT -> "بيع جديد"; SalesSection.HISTORY -> "الفواتير"; SalesSection.RETURNS -> "المرتجعات" }
private val SalesSection.icon get() = when (this) { SalesSection.CHECKOUT -> Icons.Rounded.PointOfSale; SalesSection.HISTORY -> Icons.AutoMirrored.Rounded.ReceiptLong; SalesSection.RETURNS -> Icons.Rounded.Sync }
private val PaymentMethod.label get() = when (this) { PaymentMethod.CASH -> "نقدي"; PaymentMethod.CARD -> "بطاقة"; PaymentMethod.CHECK -> "شيك"; PaymentMethod.TRANSFER -> "تحويل"; PaymentMethod.WALLET -> "محفظة" }
private fun Double.asQuantity(): String = if (this % 1.0 == 0.0) toLong().toString() else toString()

package online.alarabiya.superapp.feature.products

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Calculate
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.PriceChange
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Edit
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.products.PriceChangeType
import online.alarabiya.superapp.model.products.PriceWaveDraft
import online.alarabiya.superapp.model.products.PrintCategory
import online.alarabiya.superapp.model.products.PrintEstimateDraft
import online.alarabiya.superapp.model.products.ProductDetails
import online.alarabiya.superapp.model.products.ProductRow
import online.alarabiya.superapp.model.products.ProductTier
import online.alarabiya.superapp.model.products.ProductsCapabilities
import online.alarabiya.superapp.model.products.ProductsSection
import online.alarabiya.superapp.model.products.ProductCategory
import online.alarabiya.superapp.model.products.ProductEditorDraft
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.rtlIsolate
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

@Composable
fun ProductsRoute(viewModel: ProductsViewModel, capabilities: ProductsCapabilities, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    ProductsScreen(
        state = viewModel.state,
        capabilities = capabilities,
        actions = ProductsActions(
            section = viewModel::section, query = viewModel::query, search = viewModel::search, more = viewModel::more,
            includeInactive = viewModel::includeInactive, tier = viewModel::tier, select = viewModel::select,
            closeDetails = viewModel::closeDetails, barcode = viewModel::barcode, lookupBarcode = viewModel::lookupBarcode,
            setActive = viewModel::setActive, waveDraft = viewModel::waveDraft, previewWave = viewModel::previewWave,
            applyWave = viewModel::applyWave, reconcileWaves = viewModel::reconcileWaves,
            printDraft = viewModel::printDraft, estimatePrint = viewModel::estimatePrint,
            newProduct = viewModel::newProduct, editProduct = viewModel::editProduct, editorDraft = viewModel::editorDraft,
            saveProduct = viewModel::saveProduct, closeEditor = viewModel::closeEditor,
            createCategory = viewModel::createCategory, updateCategory = viewModel::updateCategory,
            openBarcodes = viewModel::openBarcodes, closeBarcodes = viewModel::closeBarcodes,
            addBarcodeAlias = viewModel::addBarcodeAlias, removeBarcodeAlias = viewModel::removeBarcodeAlias,
            retry = viewModel::initialize,
        ),
        modifier = modifier,
    )
}

data class ProductsActions(
    val section: (ProductsSection) -> Unit,
    val query: (String) -> Unit,
    val search: () -> Unit,
    val more: () -> Unit,
    val includeInactive: (Boolean) -> Unit,
    val tier: (ProductTier) -> Unit,
    val select: (ProductRow) -> Unit,
    val closeDetails: () -> Unit,
    val barcode: (String) -> Unit,
    val lookupBarcode: () -> Unit,
    val setActive: (Boolean) -> Unit,
    val waveDraft: (PriceWaveDraft) -> Unit,
    val previewWave: () -> Unit,
    val applyWave: () -> Unit,
    val reconcileWaves: () -> Unit,
    val printDraft: (PrintEstimateDraft) -> Unit,
    val estimatePrint: () -> Unit,
    val newProduct: () -> Unit,
    val editProduct: (Long) -> Unit,
    val editorDraft: (ProductEditorDraft) -> Unit,
    val saveProduct: () -> Unit,
    val closeEditor: () -> Unit,
    val createCategory: (String, Long?) -> Unit,
    val updateCategory: (ProductCategory) -> Unit,
    val openBarcodes: (Long) -> Unit,
    val closeBarcodes: () -> Unit,
    val addBarcodeAlias: (String, String) -> Unit,
    val removeBarcodeAlias: (Long) -> Unit,
    val retry: () -> Unit,
)

@Composable
fun ProductsScreen(state: ProductsUiState, capabilities: ProductsCapabilities, actions: ProductsActions, modifier: Modifier = Modifier) {
    var confirmWave by remember { mutableStateOf(false) }
    val catalogBlocked = capabilities.canBrowse && !state.catalogLoaded && state.section == ProductsSection.CATALOG
    val guardedActions = actions.copy(applyWave = { confirmWave = true })
    val sections = buildList {
        if (capabilities.canBrowse) add(ProductsSection.CATALOG)
        if (capabilities.canManage) add(ProductsSection.PRICE_WAVES)
        if (capabilities.canUsePrintPricing) add(ProductsSection.PRINT_PRICING)
    }
    Scaffold(modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.surface) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ProductsHeader()
            if (sections.isNotEmpty()) ScrollableTabRow(
                selectedTabIndex = sections.indexOf(state.section).coerceAtLeast(0),
                edgePadding = 14.dp,
            ) {
                sections.forEach { section -> Tab(state.section == section, { actions.section(section) }, enabled = !state.locked, text = { Text(section.label) }, icon = { Icon(section.icon, null) }) }
            }
            if (!catalogBlocked) state.error?.let { Banner(it, true, actions.retry) }
            state.notice?.let { Banner(it, false) }
            if (state.busy == ProductsBusy.INITIAL) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else if (catalogBlocked) CatalogRetryGate(state.error, actions.retry)
            else when (state.section) {
                ProductsSection.CATALOG -> CatalogWorkspace(state, capabilities, guardedActions)
                ProductsSection.PRICE_WAVES -> WaveWorkspace(state, guardedActions)
                ProductsSection.PRINT_PRICING -> PrintWorkspace(state, guardedActions)
            }
        }
    }
    if (confirmWave) {
        AlertDialog(
            onDismissRequest = { confirmWave = false },
            title = { Text("تأكيد تطبيق موجة الأسعار") },
            text = { Text("ستُحدّث الأسعار المشمولة وفق المعاينة المعروضة، وسيُسجّل النظام العملية للمراجعة.") },
            confirmButton = {
                Button(onClick = { confirmWave = false; actions.applyWave() }, enabled = state.canApplyWave) { Text("تطبيق") }
            },
            dismissButton = { TextButton(onClick = { confirmWave = false }) { Text("إلغاء") } },
        )
    }
    state.editor?.let { ProductEditorDialog(it, state.categories, !state.canMutateCatalog, actions) }
    state.barcodeUnitId?.let { BarcodeAliasesDialog(state, actions) }
}

@Composable private fun ProductsHeader() {
    Box(Modifier.fillMaxWidth().background(Brush.horizontalGradient(listOf(MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.tertiary)), RoundedCornerShape(bottomStart = 36.dp, bottomEnd = 18.dp)).padding(20.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Column { Text("المنتجات والأسعار", color = Color.White, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.headlineSmall); Text("الكتالوج والتسعير", color = Color.White.copy(alpha = .78f)) }
            Box(Modifier.size(48.dp).background(Color.White.copy(alpha = .14f), CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Inventory2, null, tint = Color.White) }
        }
    }
}

@Composable
private fun CatalogRetryGate(error: String?, retry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 520.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Rounded.Inventory2, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(44.dp))
            Text("الكتالوج غير متاح", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            error?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Button(retry, Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("إعادة المحاولة") }
        }
    }
}

@Composable private fun CatalogWorkspace(state: ProductsUiState, capabilities: ProductsCapabilities, actions: ProductsActions) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            ProductList(state, actions, Modifier.weight(.95f).fillMaxHeight())
            ProductDetail(state.selected, state.tier, capabilities.canManage, !state.canMutateCatalog, actions, Modifier.weight(1.05f).fillMaxHeight())
        } else if (state.selected != null) ProductDetail(state.selected, state.tier, capabilities.canManage, !state.canMutateCatalog, actions, Modifier.fillMaxSize(), true)
        else ProductList(state, actions, Modifier.fillMaxSize())
    }
}

@Composable private fun ProductList(state: ProductsUiState, actions: ProductsActions, modifier: Modifier) {
    ProductsCard(modifier) {
        Button(actions.newProduct, Modifier.fillMaxWidth(), enabled = state.canMutateCatalog) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("إضافة منتج") }
        SectionTitle("الكتالوج", "${state.page.total} صف منتج ووحدة", Icons.Rounded.Inventory2)
        SearchField(state.query, actions.query, actions.search, "اسم أو SKU أو باركود", state.locked)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ProductTier.entries.forEach { tier -> FilterChip(state.tier == tier, { actions.tier(tier) }, label = { Text(tier.label) }, enabled = !state.locked) }
            FilterChip(state.includeInactive, { actions.includeInactive(!state.includeInactive) }, label = { Text("المعطلة") }, enabled = !state.locked)
        }
        OutlinedTextField(
            state.barcodeInput, actions.barcode, Modifier.fillMaxWidth(), label = { Text("مسح/إدخال باركود") },
            leadingIcon = { Icon(Icons.Rounded.QrCodeScanner, null) },
            trailingIcon = {
                Row {
                    NativeScannerAction(NativeScanField.BARCODE, actions.barcode, enabled = !state.locked)
                    IconButton(actions.lookupBarcode, enabled = !state.locked) { Icon(Icons.Rounded.Search, "بحث الباركود") }
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { actions.lookupBarcode() }), singleLine = true,
        )
        state.barcodeResult?.let { found ->
            TextButton({ actions.openBarcodes(found.productUnitId) }, enabled = state.canMutateCatalog) { Text("إدارة الباركودات البديلة والملصقات") }
            Text("${found.label} • ${found.price ?: "بلا سعر"} • المتاح ${found.availableBase}", Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(14.dp)).padding(10.dp), color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.page.rows, key = { "${it.productId}:${it.variantId}:${it.productUnitId}" }) { ProductListRow(it, state.tier, state.locked, actions.select) }
            if (state.page.rows.size < state.page.total) item { Button(actions.more, Modifier.fillMaxWidth(), enabled = !state.locked) { Text("تحميل المزيد") } }
        }
    }
}

@Composable private fun ProductListRow(row: ProductRow, tier: ProductTier, locked: Boolean, select: (ProductRow) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 22.dp, bottomEnd = 22.dp, topEnd = 10.dp, bottomStart = 10.dp)).background(MaterialTheme.colorScheme.surfaceContainer).clickable(enabled = !locked, role = Role.Button) { select(row) }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(42.dp).background(if (row.productActive) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Inventory2, null, tint = if (row.productActive) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }
        Spacer(Modifier.width(11.dp)); Column(Modifier.weight(1f)) { Text(row.label, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis); Text(listOfNotNull(row.sku, row.barcode, row.categoryName).joinToString(" • "), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        Column(horizontalAlignment = Alignment.End) { Text(row.price(tier)?.let { "$it د.ع" } ?: "غير مسعّر", color = if (row.price(tier) == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold); Text("رصيد ${row.stockBase}", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun ProductDetail(detail: ProductDetails?, tier: ProductTier, canManage: Boolean, locked: Boolean, actions: ProductsActions, modifier: Modifier, back: Boolean = false) {
    ProductsCard(modifier) {
        if (detail == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("اختر منتجاً لعرض تفاصيله", color = MaterialTheme.colorScheme.onSurfaceVariant) }; return@ProductsCard }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (back) IconButton(actions.closeDetails) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
            Column(Modifier.weight(1f)) { Text(detail.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold); Text(listOfNotNull(detail.brand, detail.modelName, detail.categoryName).joinToString(" • "), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Status(if (detail.active) "نشط" else "معطل", if (detail.active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
        }
        detail.description?.let { Text(it) }
        if (canManage) OutlinedButton({ actions.editProduct(detail.productId) }, enabled = !locked) { Icon(Icons.Rounded.Edit, null); Spacer(Modifier.width(8.dp)); Text("تعديل بيانات المنتج") }
        if (canManage) Row(Modifier.fillMaxWidth(), Arrangement.End, Alignment.CenterVertically) { Text(if (detail.active) "تعطيل المنتج" else "تفعيل المنتج"); Spacer(Modifier.width(8.dp)); Switch(detail.active, { actions.setActive(it) }, enabled = !locked) }
        Text("الوحدات والأسعار", fontWeight = FontWeight.Bold)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(detail.rows, key = { "detail:${it.variantId}:${it.productUnitId}" }) { row ->
                Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(row.label, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            row.price(tier)?.let { "${rtlIsolate(it.toString())} د.ع" } ?: "غير مسعّر",
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 1,
                        )
                    }
                    Text(
                        "SKU ${rtlIsolate(row.sku ?: "—")} • باركود ${rtlIsolate(row.barcode ?: "—")}",
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (row.barcodeAliases.isNotEmpty()) Text(
                        "بدائل: ${rtlIsolate(row.barcodeAliases.joinToString())}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (canManage) Text(
                        "تجزئة ${rtlIsolate(row.retailPrice?.toString() ?: "—")} • جملة ${rtlIsolate(row.wholesalePrice?.toString() ?: "—")} • حكومي ${rtlIsolate(row.governmentPrice?.toString() ?: "—")} • كلفة ${rtlIsolate(row.costPrice?.toString() ?: "—")}",
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            detail.bundle?.let { bundle -> item {
                Text("مكوّنات البكج", fontWeight = FontWeight.Bold)
                Text("${bundle.components.size} مكونات • ${bundle.affectedInvoiceLines} أسطر فواتير ما زالت قابلة للإرجاع", color = if (bundle.affectedInvoiceLines > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                bundle.components.forEach { component -> Text("${component.productName} (${component.sku}) × ${component.quantityBase}${if (!component.active) " — معطل" else ""}") }
            } }
        }
    }
}

@Composable private fun WaveWorkspace(state: ProductsUiState, actions: ProductsActions) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) { WaveForm(state, actions, Modifier.weight(.85f).fillMaxHeight()); WavePreview(state, actions, Modifier.weight(1.15f).fillMaxHeight()) }
        else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) { item { WaveForm(state, actions, Modifier.fillMaxWidth()) }; item { WavePreview(state, actions, Modifier.fillMaxWidth().height(480.dp)) } }
    }
}

@Composable private fun WaveForm(state: ProductsUiState, actions: ProductsActions, modifier: Modifier) {
    val draft = state.waveDraft
    ProductsCard(modifier) {
        SectionTitle("موجة أسعار", "معاينة خادمية قبل الالتزام", Icons.Rounded.PriceChange)
        OutlinedTextField(draft.name, { actions.waveDraft(draft.copy(name = it)) }, Modifier.fillMaxWidth(), label = { Text("اسم الموجة") }, enabled = !state.locked, singleLine = true)
        OutlinedTextField(draft.productSearch, { actions.waveDraft(draft.copy(productSearch = it)) }, Modifier.fillMaxWidth(), label = { Text("تصفية باسم المنتج أو SKU") }, enabled = !state.locked, singleLine = true)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            FilterChip(draft.tier == null, { actions.waveDraft(draft.copy(tier = null)) }, label = { Text("كل الفئات") }, enabled = !state.locked)
            ProductTier.entries.forEach { tier -> FilterChip(draft.tier == tier, { actions.waveDraft(draft.copy(tier = tier)) }, label = { Text(tier.label) }, enabled = !state.locked) }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) { PriceChangeType.entries.forEach { type -> FilterChip(draft.changeType == type, { actions.waveDraft(draft.copy(changeType = type)) }, label = { Text(type.label) }, enabled = !state.locked) } }
        OutlinedTextField(draft.changeValue, { actions.waveDraft(draft.copy(changeValue = it)) }, Modifier.fillMaxWidth(), label = { Text("قيمة التغيير") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), enabled = !state.locked, singleLine = true)
        OutlinedTextField(draft.reason, { actions.waveDraft(draft.copy(reason = it)) }, Modifier.fillMaxWidth(), label = { Text("سبب التغيير") }, enabled = !state.locked)
        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(draft.allowBelowCost, { actions.waveDraft(draft.copy(allowBelowCost = it)) }, enabled = !state.locked); Text("السماح بما دون الكلفة — قرار صريح") }
        Button(actions.previewWave, Modifier.fillMaxWidth(), enabled = state.canMutateCatalog && !state.waveOutcomeUnknown) { Text("معاينة الأسعار") }
        if (state.waveOutcomeUnknown) {
            Text("نتيجة آخر تطبيق غير محسومة. إعادة التطبيق مقفلة حتى مطابقة السجل.", color = MaterialTheme.colorScheme.error)
            OutlinedButton(actions.reconcileWaves, Modifier.fillMaxWidth(), enabled = !state.locked) { Text("مطابقة السجل") }
        }
    }
}

@Composable private fun WavePreview(state: ProductsUiState, actions: ProductsActions, modifier: Modifier) {
    ProductsCard(modifier) {
        SectionTitle("نتيجة المعاينة", "لا تُحسب أي قيمة على الجهاز", Icons.Rounded.Calculate)
        val preview = state.wavePreview
        if (preview == null) Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Text("حدّد القاعدة ثم اطلب المعاينة", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        else {
            Text("${preview.rows.size} أسعار متأثرة • ${preview.belowCostCount} دون الكلفة", color = if (preview.belowCostCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                items(preview.rows, key = { "${it.productUnitId}:${it.tier}" }) { row ->
                    Row(Modifier.fillMaxWidth().background(if (row.belowCost) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp)).padding(11.dp), Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f)) { Text("${row.productName} • ${row.unitName}", fontWeight = FontWeight.SemiBold); Text("${row.sku} • ${row.tier.label}", style = MaterialTheme.typography.bodySmall) }
                        Text("${row.oldPrice} ← ${row.newPrice}", fontWeight = FontWeight.Bold)
                    }
                }
            }
            Button(actions.applyWave, Modifier.fillMaxWidth().height(52.dp), enabled = state.canApplyWave) { Text("تطبيق الموجة") }
        }
        if (state.waves.isNotEmpty()) Text("آخر تطبيق: ${state.waves.first().name} • ${state.waves.first().totalRows} سعر", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable private fun PrintWorkspace(state: ProductsUiState, actions: ProductsActions) {
    val settings = state.printSettings
    if (settings == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("إعدادات تسعير الطباعة غير متاحة") }; return }
    BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) { PrintForm(state, actions, Modifier.weight(.9f).fillMaxHeight()); PrintResult(state, Modifier.weight(1.1f).fillMaxHeight()) }
        else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) { item { PrintForm(state, actions, Modifier.fillMaxWidth()) }; item { PrintResult(state, Modifier.fillMaxWidth()) } }
    }
}

@Composable private fun PrintForm(state: ProductsUiState, actions: ProductsActions, modifier: Modifier) {
    val draft = state.printDraft; val settings = requireNotNull(state.printSettings)
    ProductsCard(modifier) {
        SectionTitle("حاسبة الطباعة", "${settings.pricingMode} • هامش ${settings.defaultMarginPercent}%", Icons.Rounded.Calculate)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { PrintCategory.entries.forEach { category -> FilterChip(draft.category == category, { actions.printDraft(draft.copy(category = category)) }, label = { Text(if (category == PrintCategory.SMALL) "صغير" else "عريض") }, enabled = !state.locked) } }
        if (draft.category == PrintCategory.SMALL) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) { settings.facePrices.map { it.paperSize }.distinct().forEach { size -> FilterChip(draft.paperSize == size, { actions.printDraft(draft.copy(paperSize = size)) }, label = { Text(size) }, enabled = !state.locked) } }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("COLOR", "BW").forEach { mode -> FilterChip(draft.colorMode == mode, { actions.printDraft(draft.copy(colorMode = mode)) }, label = { Text(if (mode == "COLOR") "ملون" else "أبيض وأسود") }, enabled = !state.locked) } }
            NumberField("النسخ", draft.copies, { actions.printDraft(draft.copy(copies = it)) }, state.locked)
            NumberField("صفحات كل نسخة", draft.pagesPerCopy, { actions.printDraft(draft.copy(pagesPerCopy = it)) }, state.locked)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf(1, 2).forEach { sides -> FilterChip(draft.sides == sides, { actions.printDraft(draft.copy(sides = sides)) }, label = { Text("$sides وجه") }, enabled = !state.locked) } }
            Text("الورق المميز", fontWeight = FontWeight.SemiBold)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                FilterChip(draft.paperUpchargeId == null, { actions.printDraft(draft.copy(paperUpchargeId = null)) }, label = { Text("قياسي") }, enabled = !state.locked)
                settings.paperUpcharges.filter { it.active }.forEach { option -> FilterChip(draft.paperUpchargeId == option.id, { actions.printDraft(draft.copy(paperUpchargeId = option.id)) }, label = { Text(option.name) }, enabled = !state.locked) }
            }
        } else {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) { settings.wideMedia.filter { it.active }.forEach { media -> FilterChip(draft.mediaId == media.id, { actions.printDraft(draft.copy(mediaId = media.id)) }, label = { Text(media.name) }, enabled = !state.locked) } }
            NumberField("العرض بالمتر", draft.width, { actions.printDraft(draft.copy(width = it)) }, state.locked)
            NumberField("الارتفاع بالمتر", draft.height, { actions.printDraft(draft.copy(height = it)) }, state.locked)
            NumberField("الكمية", draft.quantity, { actions.printDraft(draft.copy(quantity = it)) }, state.locked)
        }
        Text("التشطيب", fontWeight = FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) { settings.finishings.filter { it.active }.forEach { option -> FilterChip(option.id in draft.finishingIds, { actions.printDraft(draft.copy(finishingIds = if (option.id in draft.finishingIds) draft.finishingIds - option.id else draft.finishingIds + option.id)) }, label = { Text(option.name) }, enabled = !state.locked) } }
        if (settings.pricingMode == "MARGIN") NumberField("تجاوز الهامش % (اختياري)", draft.marginOverride, { actions.printDraft(draft.copy(marginOverride = it)) }, state.locked)
        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(draft.applySetupFee, { actions.printDraft(draft.copy(applySetupFee = it)) }, enabled = !state.locked); Text("إضافة رسم التجهيز") }
        Button(actions.estimatePrint, Modifier.fillMaxWidth().height(52.dp), enabled = !state.locked) { Text("احسب التكلفة") }
    }
}

@Composable private fun PrintResult(state: ProductsUiState, modifier: Modifier) {
    ProductsCard(modifier) {
        SectionTitle("عرض السعر", "نتيجة خادمية دون تقريب محلي", Icons.Rounded.PriceChange)
        val result = state.printEstimate
        if (result == null) { Box(Modifier.weight(1f, fill = false).fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) { Text("أكمل المواصفات لعرض التسعير", color = MaterialTheme.colorScheme.onSurfaceVariant) }; return@ProductsCard }
        Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) { Metric("السعر المقترح", result.suggestedPrice, Modifier.weight(1f)); Metric("سعر الوحدة", result.unitPrice, Modifier.weight(1f)); Metric("الكلفة", result.totalCost, Modifier.weight(1f)) }
        result.lines.forEach { line -> Row(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)).padding(11.dp), Arrangement.SpaceBetween) { Column(Modifier.weight(1f)) { Text(line.label, fontWeight = FontWeight.SemiBold); line.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }; Text(line.amount, fontWeight = FontWeight.Bold) } }
        Text("الهامش المطبق ${result.marginPercent}% • الوحدات ${result.units}", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun SearchField(value: String, onValue: (String) -> Unit, search: () -> Unit, label: String, locked: Boolean) = OutlinedTextField(
    value,
    onValue,
    Modifier.fillMaxWidth(),
    label = { Text(label) },
    trailingIcon = {
        Row {
            NativeScannerAction(NativeScanField.SKU_OR_BARCODE, { scanned -> onValue(scanned); search() }, enabled = !locked)
            IconButton(search, enabled = !locked) { Icon(Icons.Rounded.Search, "بحث") }
        }
    },
    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    keyboardActions = KeyboardActions(onSearch = { search() }),
    enabled = !locked,
    singleLine = true,
    shape = RoundedCornerShape(18.dp),
)
@Composable private fun NumberField(label: String, value: String, onValue: (String) -> Unit, locked: Boolean) = OutlinedTextField(value, onValue, Modifier.fillMaxWidth(), label = { Text(label) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), enabled = !locked, singleLine = true)
@Composable private fun ProductsCard(modifier: Modifier, content: @Composable ColumnScope.() -> Unit) = Card(modifier, shape = RoundedCornerShape(topStart = 32.dp, topEnd = 18.dp, bottomEnd = 32.dp, bottomStart = 18.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), elevation = CardDefaults.cardElevation(2.dp)) { Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content) }
@Composable private fun SectionTitle(title: String, subtitle: String, icon: ImageVector) = Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(44.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(topStart = 17.dp, bottomEnd = 17.dp)), contentAlignment = Alignment.Center) { Icon(icon, null, tint = MaterialTheme.colorScheme.primary) }; Spacer(Modifier.width(10.dp)); Column { Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable private fun Status(text: String, color: Color) = Text(text, Modifier.background(color.copy(alpha = .12f), RoundedCornerShape(30.dp)).padding(horizontal = 10.dp, vertical = 5.dp), color = color, style = MaterialTheme.typography.labelMedium)
@Composable private fun Metric(label: String, value: String, modifier: Modifier) = Column(modifier.background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp)).padding(10.dp)) { Text(label, style = MaterialTheme.typography.bodySmall); Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis) }
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

@Composable
private fun ProductEditorDialog(draft: ProductEditorDraft, categories: List<ProductCategory>, locked: Boolean, actions: ProductsActions) {
    var newCategory by remember { mutableStateOf("") }
    val variant = draft.variants.firstOrNull() ?: online.alarabiya.superapp.model.products.ProductVariantDraft()
    val unit = variant.units.firstOrNull() ?: online.alarabiya.superapp.model.products.ProductUnitDraft()
    fun variantChanged(value: online.alarabiya.superapp.model.products.ProductVariantDraft) = actions.editorDraft(draft.copy(variants = listOf(value)))
    fun unitChanged(value: online.alarabiya.superapp.model.products.ProductUnitDraft) = variantChanged(variant.copy(units = listOf(value)))
    AlertDialog(
        onDismissRequest = actions.closeEditor,
        title = { Text(if (draft.productId == null) "إضافة منتج" else "تعديل المنتج", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 590.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item { OutlinedTextField(draft.name, { actions.editorDraft(draft.copy(name = it)) }, Modifier.fillMaxWidth(), label = { Text("اسم المنتج") }, singleLine = true) }
                item { OutlinedTextField(draft.description, { actions.editorDraft(draft.copy(description = it)) }, Modifier.fillMaxWidth(), label = { Text("الوصف") }, minLines = 2) }
                item {
                    Text("الفئة", fontWeight = FontWeight.SemiBold)
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(draft.categoryId == null, { actions.editorDraft(draft.copy(categoryId = null)) }, label = { Text("بلا فئة") })
                        categories.forEach { category -> FilterChip(draft.categoryId == category.id, { actions.editorDraft(draft.copy(categoryId = category.id)) }, label = { Text(category.name) }) }
                    }
                }
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(newCategory, { newCategory = it }, Modifier.weight(1f), label = { Text("فئة جديدة") }, singleLine = true)
                        Spacer(Modifier.width(8.dp))
                        Button({ actions.createCategory(newCategory, null); newCategory = "" }, enabled = newCategory.isNotBlank() && !locked) { Text("إضافة") }
                    }
                }
                item { OutlinedTextField(variant.sku, { variantChanged(variant.copy(sku = it)) }, Modifier.fillMaxWidth(), label = { Text("SKU") }, singleLine = true) }
                item { OutlinedTextField(variant.costPrice, { variantChanged(variant.copy(costPrice = it)) }, Modifier.fillMaxWidth(), label = { Text("التكلفة") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true) }
                item { OutlinedTextField(unit.name, { unitChanged(unit.copy(name = it)) }, Modifier.fillMaxWidth(), label = { Text("اسم الوحدة") }, singleLine = true) }
                item {
                    OutlinedTextField(
                        unit.barcode, { unitChanged(unit.copy(barcode = it)) }, Modifier.fillMaxWidth(), label = { Text("الباركود") }, singleLine = true,
                        trailingIcon = { NativeScannerAction(NativeScanField.BARCODE, { unitChanged(unit.copy(barcode = it)) }, enabled = !locked) },
                    )
                }
                item { OutlinedTextField(unit.retailPrice, { unitChanged(unit.copy(retailPrice = it)) }, Modifier.fillMaxWidth(), label = { Text("سعر التجزئة") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true) }
                item { OutlinedTextField(unit.wholesalePrice, { unitChanged(unit.copy(wholesalePrice = it)) }, Modifier.fillMaxWidth(), label = { Text("سعر الجملة") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true) }
                item { OutlinedTextField(unit.governmentPrice, { unitChanged(unit.copy(governmentPrice = it)) }, Modifier.fillMaxWidth(), label = { Text("السعر الحكومي") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true) }
                if (draft.productId != null) item { OutlinedTextField(variant.costChangeReason, { variantChanged(variant.copy(costChangeReason = it)) }, Modifier.fillMaxWidth(), label = { Text("سبب تغيير التكلفة عند التغيير الكبير") }) }
            }
        },
        confirmButton = { Button(actions.saveProduct, enabled = !locked) { Text("حفظ") } },
        dismissButton = { TextButton(actions.closeEditor, enabled = !locked) { Text("إلغاء") } },
    )
}

@Composable
private fun BarcodeAliasesDialog(state: ProductsUiState, actions: ProductsActions) {
    var barcode by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    val mutationEnabled = state.canMutateBarcodeAliases
    AlertDialog(
        onDismissRequest = actions.closeBarcodes,
        title = { Text("الباركودات البديلة والملصقات", fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    barcode,
                    { barcode = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("باركود بديل") },
                    singleLine = true,
                    enabled = mutationEnabled,
                    trailingIcon = { NativeScannerAction(NativeScanField.BARCODE, { barcode = it }, enabled = mutationEnabled) },
                )
                OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text("ملاحظة الملصق") }, singleLine = true, enabled = mutationEnabled)
                Button({ actions.addBarcodeAlias(barcode, note); barcode = ""; note = "" }, Modifier.fillMaxWidth(), enabled = barcode.isNotBlank() && mutationEnabled) { Text("إضافة") }
                LazyColumn(Modifier.heightIn(max = 260.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(state.barcodeAliases, key = { it.id }) { alias ->
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp)).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) { Text(rtlIsolate(alias.barcode), fontWeight = FontWeight.Bold); alias.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) } }
                            TextButton({ actions.removeBarcodeAlias(alias.id) }, enabled = mutationEnabled) { Text("حذف", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(actions.closeBarcodes, enabled = !state.locked) { Text("تم") } },
    )
}

private val ProductsSection.label get() = when (this) { ProductsSection.CATALOG -> "الكتالوج"; ProductsSection.PRICE_WAVES -> "موجات الأسعار"; ProductsSection.PRINT_PRICING -> "تسعير الطباعة" }
private val ProductsSection.icon get() = when (this) { ProductsSection.CATALOG -> Icons.Rounded.Inventory2; ProductsSection.PRICE_WAVES -> Icons.Rounded.PriceChange; ProductsSection.PRINT_PRICING -> Icons.Rounded.Calculate }
private val ProductTier.label get() = when (this) { ProductTier.RETAIL -> "تجزئة"; ProductTier.WHOLESALE -> "جملة"; ProductTier.GOVERNMENT -> "حكومي" }
private val PriceChangeType.label get() = when (this) { PriceChangeType.INCREASE_PERCENT -> "زيادة %"; PriceChangeType.DECREASE_PERCENT -> "خفض %"; PriceChangeType.INCREASE_AMOUNT -> "زيادة مبلغ"; PriceChangeType.DECREASE_AMOUNT -> "خفض مبلغ"; PriceChangeType.SET_MARGIN -> "هامش" }

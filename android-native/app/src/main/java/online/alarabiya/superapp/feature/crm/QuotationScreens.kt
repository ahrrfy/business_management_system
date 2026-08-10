package online.alarabiya.superapp.feature.crm

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.crm.BranchOption
import online.alarabiya.superapp.model.crm.CatalogOption
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CustomerSummary
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.model.crm.QuotationDetail
import online.alarabiya.superapp.model.crm.QuotationDraft
import online.alarabiya.superapp.model.crm.QuotationLineDraft
import online.alarabiya.superapp.model.crm.QuotationStatus
import online.alarabiya.superapp.model.crm.QuotationSummary
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.rtlIsolate
import online.alarabiya.superapp.ui.scanner.NativeScannerAction

@Composable
internal fun QuotationsWorkspace(state: CrmUiState, capabilities: CrmCapabilities, actions: CrmActions) {
    if (!state.quotationsLoaded) {
        CrmRetryGate(
            title = if (state.pendingQuotationRefreshId != null) "عرض السعر يحتاج تحديثاً" else "عروض الأسعار غير متاحة",
            retryEnabled = !state.initializing && state.busyKey == null,
            onRetry = actions.refresh,
        )
        return
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val secondary: (@Composable () -> Unit)? = when {
            state.quotationEditor != null -> ({
                QuotationEditorPane(
                    editor = state.quotationEditor,
                    state = state,
                    capabilities = capabilities,
                    actions = actions,
                )
            })
            state.selectedQuotation != null -> ({
                QuotationDetailPane(
                    quotation = state.selectedQuotation,
                    canWrite = capabilities.sales.canWrite,
                    busy = !state.canMutateSelectedQuotation,
                    onEdit = actions.beginEditQuotation,
                    onStatus = actions.setQuotationStatus,
                    onBack = actions.closeQuotationDetail,
                )
            })
            else -> null
        }
        val list: @Composable () -> Unit = {
            QuotationListPane(state, capabilities.sales.canWrite, actions)
        }
        if (maxWidth >= 840.dp) {
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.weight(.43f).fillMaxHeight()) { list() }
                VerticalDivider()
                Box(Modifier.weight(.57f).fillMaxHeight()) {
                    secondary?.invoke() ?: EmptyCrmState("اختر عرض سعر لعرض تفاصيله")
                }
            }
        } else {
            secondary?.invoke() ?: list()
        }
    }
}

@Composable
private fun QuotationListPane(state: CrmUiState, canWrite: Boolean, actions: CrmActions) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = state.quotationQuery,
                    onValueChange = actions.setQuotationQuery,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text("رقم العرض أو العميل") },
                    trailingIcon = {
                        IconButton(onClick = actions.searchQuotations, enabled = state.canCreateQuotation) {
                            Icon(Icons.Rounded.Search, contentDescription = "بحث")
                        }
                    },
                )
                if (canWrite) {
                    IconButton(onClick = actions.beginCreateQuotation, enabled = state.canCreateQuotation) {
                        Icon(Icons.Rounded.Add, contentDescription = "عرض جديد")
                    }
                }
            }
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    FilterChip(
                        selected = state.quotationStatus == null,
                        onClick = { actions.setQuotationFilter(null) },
                        enabled = state.canCreateQuotation,
                        label = { Text("الكل") },
                    )
                }
                items(QuotationStatus.entries, key = { it.name }) { status ->
                    FilterChip(
                        selected = state.quotationStatus == status,
                        onClick = { actions.setQuotationFilter(status) },
                        enabled = state.canCreateQuotation,
                        label = { Text(status.label) },
                    )
                }
            }
        }
        if (state.quotationPage.rows.isEmpty()) item { EmptyCrmState("لا توجد عروض مطابقة") }
        items(state.quotationPage.rows, key = { it.id }) { quotation ->
            QuotationSummaryCard(quotation, state.canCreateQuotation) { actions.selectQuotation(quotation.id) }
        }
        if (state.quotationPage.hasMore) item {
            OutlinedButton(
                onClick = actions.loadMoreQuotations,
                enabled = state.canCreateQuotation,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("تحميل المزيد") }
        }
    }
}

@Composable
private fun QuotationSummaryCard(quotation: QuotationSummary, enabled: Boolean, onClick: () -> Unit) {
    CrmCard {
        Column(
            Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(quotation.quoteNumber, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                CrmStatus(quotation.status.label)
            }
            Text(quotation.customerName ?: "عميل نقدي", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(quotation.validUntil ?: quotation.quoteDate.orEmpty(), style = MaterialTheme.typography.bodySmall)
                Text("${quotation.total} د.ع", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun QuotationDetailPane(
    quotation: QuotationDetail,
    canWrite: Boolean,
    busy: Boolean,
    onEdit: () -> Unit,
    onStatus: (QuotationStatus) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "رجوع") }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(quotation.quoteNumber, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    CrmStatus(quotation.status.label)
                }
                if (canWrite && quotation.canEdit) {
                    IconButton(onClick = onEdit, enabled = !busy) { Icon(Icons.Rounded.Edit, contentDescription = "تعديل") }
                } else Box(Modifier.padding(24.dp))
            }
        }
        item {
            CrmCard {
                DetailRow("العميل", quotation.customerName ?: "عميل نقدي")
                DetailRow("فئة السعر", quotation.priceTier.label)
                DetailRow("الصلاحية", quotation.validUntil ?: "غير محددة")
                DetailRow("قبل الضريبة", quotation.subtotal)
                DetailRow("الخصم", quotation.discountAmount)
                DetailRow("الضريبة", quotation.taxAmount)
                DetailRow("الإجمالي", "${quotation.total} د.ع", emphasized = true)
                quotation.notes?.let { DetailRow("ملاحظات", it) }
            }
        }
        item { Text("البنود", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        items(quotation.items, key = { it.id }) { line ->
            CrmCard {
                Text(line.productName, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(line.variantName, line.unitName, line.sku).joinToString(" · "))
                DetailRow("الكمية", line.quantity)
                DetailRow("سعر الوحدة", line.unitPrice)
                DetailRow("الإجمالي", line.total, emphasized = true)
            }
        }
        if (quotation.customerPhone != null) item {
            OutlinedButton(
                onClick = {
                    launchExternalWhatsApp(
                        context,
                        quotation.customerPhone,
                        "مرحباً ${quotation.customerName.orEmpty()}، بخصوص عرض السعر ${quotation.quoteNumber}",
                    )
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null)
                Text(" مراسلة العميل عبر واتساب")
            }
        }
        if (canWrite) item {
            val transitions = quotation.status.allowedTransitions()
            if (transitions.isNotEmpty()) {
                Text("تحديث الحالة", fontWeight = FontWeight.Bold)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(transitions, key = { it.name }) { status ->
                        Button(onClick = { onStatus(status) }, enabled = !busy) { Text(status.label) }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuotationEditorPane(
    editor: QuotationEditor,
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    val draft = editor.draft
    val busy = state.busyKey != null ||
        (editor.quotationId != null && !state.canMutateSelectedQuotation)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = actions.closeQuotationEditor, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "إغلاق")
                }
                Text(
                    if (editor.quotationId == null) "عرض سعر جديد" else "تعديل عرض السعر",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Box(Modifier.padding(24.dp))
            }
        }
        item {
            CrmCard {
                BranchSelector(draft, state.branches, capabilities, actions.updateQuotationDraft)
                Text("العميل", style = MaterialTheme.typography.labelLarge)
                CustomerSelector(draft, state.customerPage.rows, actions.updateQuotationDraft)
                Text("فئة السعر", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(PriceTier.entries, key = { it.name }) { tier ->
                        FilterChip(
                            selected = draft.priceTier == tier,
                            onClick = { actions.updateQuotationDraft(draft.copy(priceTier = tier)) },
                            label = { Text(tier.label) },
                        )
                    }
                }
                QuoteField(draft.validUntil, { actions.updateQuotationDraft(draft.copy(validUntil = it)) }, "صالح حتى YYYY-MM-DD")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        draft.invoiceDiscount,
                        { actions.updateQuotationDraft(draft.copy(invoiceDiscount = it)) },
                        label = { Text("خصم العرض") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        draft.taxRatePercent,
                        { actions.updateQuotationDraft(draft.copy(taxRatePercent = it)) },
                        label = { Text("الضريبة %") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                    )
                }
                QuoteField(draft.notes, { actions.updateQuotationDraft(draft.copy(notes = it)) }, "ملاحظات", singleLine = false)
            }
        }
        item {
            Text("إضافة أصناف", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            if (!capabilities.products.canRead) {
                Text("لا توجد صلاحية كتالوج؛ لا يمكن إنشاء أو تعديل بنود العرض من هذا الحساب.", color = MaterialTheme.colorScheme.error)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        state.catalogQuery,
                        actions.setCatalogQuery,
                        modifier = Modifier.weight(1f),
                        label = { Text("اسم أو SKU أو باركود") },
                        singleLine = true,
                        trailingIcon = {
                            NativeScannerAction(
                                NativeScanField.SKU_OR_BARCODE,
                                { scanned -> actions.setCatalogQuery(scanned); actions.searchCatalog() },
                                enabled = !busy && draft.branchId != null,
                            )
                        },
                    )
                    IconButton(onClick = actions.searchCatalog, enabled = !busy && draft.branchId != null) {
                        Icon(Icons.Rounded.Search, contentDescription = "بحث في الأصناف")
                    }
                }
            }
        }
        if (state.catalogResults.isNotEmpty()) item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.catalogResults, key = { it.productUnitId }) { option ->
                    CatalogOptionCard(option, !busy) { actions.addCatalogOption(option) }
                }
            }
        }
        item { Text("بنود العرض (${draft.lines.size})", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        itemsIndexed(draft.lines, key = { _, line -> line.productUnitId }) { index, line ->
            QuotationLineEditor(
                line = line,
                enabled = !busy,
                onChange = { actions.updateQuotationLine(index, it) },
                onRemove = { actions.removeQuotationLine(index) },
            )
        }
        item {
            Button(
                onClick = actions.saveQuotation,
                enabled = !busy && draft.branchId != null && draft.lines.isNotEmpty() && capabilities.products.canRead,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("حفظ عرض السعر") }
        }
    }
}

@Composable
private fun BranchSelector(
    draft: QuotationDraft,
    branches: List<BranchOption>,
    capabilities: CrmCapabilities,
    onChange: (QuotationDraft) -> Unit,
) {
    Text("الفرع", style = MaterialTheme.typography.labelLarge)
    when {
        capabilities.branchId != null -> Text(branches.firstOrNull { it.id == capabilities.branchId }?.name ?: "فرع الحساب")
        branches.isEmpty() -> Text("لا توجد فروع متاحة", color = MaterialTheme.colorScheme.error)
        else -> LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(branches, key = { it.id }) { branch ->
                FilterChip(
                    selected = draft.branchId == branch.id,
                    onClick = { onChange(draft.copy(branchId = branch.id)) },
                    label = { Text(branch.name) },
                )
            }
        }
    }
}

@Composable
private fun CustomerSelector(draft: QuotationDraft, customers: List<CustomerSummary>, onChange: (QuotationDraft) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            FilterChip(
                selected = draft.customerId == null,
                onClick = { onChange(draft.copy(customerId = null)) },
                label = { Text("عميل نقدي") },
            )
        }
        items(customers, key = { it.id }) { customer ->
            FilterChip(
                selected = draft.customerId == customer.id,
                onClick = { onChange(draft.copy(customerId = customer.id, priceTier = customer.priceTier)) },
                label = { Text(customer.name) },
            )
        }
    }
}

@Composable
private fun CatalogOptionCard(option: CatalogOption, enabled: Boolean, onAdd: () -> Unit) {
    CrmCard(Modifier.width(280.dp)) {
        Column(Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onAdd), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(option.productName, fontWeight = FontWeight.Bold)
            Text(listOfNotNull(option.variantName, option.unitName, option.sku).joinToString(" · "))
            Text(option.effectivePrice?.let { "$it د.ع" } ?: "بلا سعر", color = MaterialTheme.colorScheme.primary)
            if (!option.isService) Text("المتاح: ${option.availableBase}", style = MaterialTheme.typography.bodySmall)
            Text("إضافة +", fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun QuotationLineEditor(
    line: QuotationLineDraft,
    enabled: Boolean,
    onChange: (QuotationLineDraft) -> Unit,
    onRemove: () -> Unit,
) {
    CrmCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(line.label, modifier = Modifier.weight(1f), fontWeight = FontWeight.Bold)
            IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Rounded.DeleteOutline, contentDescription = "حذف البند") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                line.quantity,
                { onChange(line.copy(quantity = it)) },
                label = { Text("الكمية") },
                modifier = Modifier.weight(1f),
                enabled = enabled,
                singleLine = true,
            )
            OutlinedTextField(
                line.unitPriceOverride,
                { onChange(line.copy(unitPriceOverride = it)) },
                label = { Text("السعر") },
                modifier = Modifier.weight(1f),
                enabled = enabled,
                singleLine = true,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                line.discountPercent,
                { onChange(line.copy(discountPercent = it)) },
                label = { Text("خصم %") },
                modifier = Modifier.weight(1f),
                enabled = enabled,
                singleLine = true,
            )
            OutlinedTextField(
                line.discountAmount,
                { onChange(line.copy(discountAmount = it)) },
                label = { Text("خصم مبلغ") },
                modifier = Modifier.weight(1f),
                enabled = enabled,
                singleLine = true,
            )
        }
    }
}

@Composable
private fun QuoteField(value: String, onChange: (String) -> Unit, label: String, singleLine: Boolean = true) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 2,
    )
}

@Composable
private fun DetailRow(label: String, value: String, emphasized: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.42f), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            rtlIsolate(value),
            modifier = Modifier.weight(.58f),
            fontWeight = if (emphasized) FontWeight.Bold else FontWeight.Normal,
            color = if (emphasized) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
    HorizontalDivider()
}

private fun QuotationStatus.allowedTransitions(): List<QuotationStatus> = when (this) {
    QuotationStatus.DRAFT -> listOf(QuotationStatus.SENT, QuotationStatus.ACCEPTED, QuotationStatus.REJECTED, QuotationStatus.EXPIRED)
    QuotationStatus.SENT -> listOf(QuotationStatus.ACCEPTED, QuotationStatus.REJECTED, QuotationStatus.EXPIRED)
    QuotationStatus.ACCEPTED -> listOf(QuotationStatus.REJECTED, QuotationStatus.EXPIRED)
    QuotationStatus.REJECTED, QuotationStatus.CONVERTED, QuotationStatus.EXPIRED -> emptyList()
}

internal val QuotationStatus.label: String
    get() = when (this) {
        QuotationStatus.DRAFT -> "مسودة"
        QuotationStatus.SENT -> "مرسل"
        QuotationStatus.ACCEPTED -> "مقبول"
        QuotationStatus.REJECTED -> "مرفوض"
        QuotationStatus.CONVERTED -> "محوّل لفاتورة"
        QuotationStatus.EXPIRED -> "منتهي"
    }

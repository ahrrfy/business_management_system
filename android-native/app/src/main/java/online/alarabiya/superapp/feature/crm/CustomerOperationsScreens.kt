package online.alarabiya.superapp.feature.crm

import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.crm.CatalogOption
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CustomerContractPrice
import online.alarabiya.superapp.model.crm.CustomerDetail
import online.alarabiya.superapp.model.crm.CustomerFollowUp
import online.alarabiya.superapp.ui.ltrInputTextStyle
import online.alarabiya.superapp.ui.rtlIsolate

@Composable
internal fun FollowUpsWorkspace(
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    if (!state.customerOperations.dueFresh) {
        CrmRetryGate(
            title = "تعذر تحميل المتابعات المستحقة",
            retryEnabled = !state.initializing && state.busyKey == null,
            onRetry = actions.refreshDueFollowUps,
        )
        return
    }
    val context = LocalContext.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("المتابعات المستحقة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(
                        "${state.customerOperations.dueTotal} متابعة",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = actions.refreshDueFollowUps, enabled = state.busyKey == null) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "تحديث المتابعات")
                }
            }
        }
        if (state.customerOperations.dueRows.isEmpty()) {
            item { EmptyCrmState("لا توجد متابعات مستحقة") }
        }
        items(state.customerOperations.dueRows, key = { it.id }) { row ->
            FollowUpCard(
                row = row,
                busy = state.busyKey != null,
                showCustomer = true,
                onOpenCustomer = { actions.openFollowUpCustomer(row.customerId) },
                onWhatsapp = {
                    launchExternalWhatsApp(context, row.customerPhone, "مرحباً ${row.customerName.orEmpty()}،")
                },
                onEdit = null,
                onResolve = if (capabilities.customers.canWrite) ({ actions.resolveDueFollowUp(row) }) else null,
                onDelete = null,
            )
        }
        if (state.customerOperations.dueRows.size < state.customerOperations.dueTotal) {
            item {
                OutlinedButton(
                    onClick = actions.loadMoreDueFollowUps,
                    enabled = state.busyKey == null && state.customerOperations.dueFresh,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("تحميل المزيد") }
            }
        }
    }
}

@Composable
internal fun CustomerOperationsPanel(
    customer: CustomerDetail,
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    val fontScale = LocalDensity.current.fontScale
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("تشغيل العميل", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            IconButton(onClick = actions.refreshCustomerOperations, enabled = state.busyKey == null) {
                Icon(Icons.Rounded.Refresh, contentDescription = "تحديث تشغيل العميل")
            }
        }
        if (!capabilities.customers.canWrite) {
            FollowUpPanel(customer, state, capabilities, actions)
        } else {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                if (customerOperationsUseTwoPane(maxWidth.value.toInt(), fontScale)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Box(Modifier.weight(1f)) {
                            FollowUpPanel(customer, state, capabilities, actions)
                        }
                        Box(Modifier.weight(1f)) {
                            ContractPricePanel(customer, state, capabilities, actions)
                        }
                    }
                } else {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        FollowUpPanel(customer, state, capabilities, actions)
                        ContractPricePanel(customer, state, capabilities, actions)
                    }
                }
            }
        }
    }
    FollowUpEditorDialog(state, actions)
    ContractPriceEditorDialog(state, actions)
    DeleteConfirmations(state, actions)
}

@Composable
private fun FollowUpPanel(
    customer: CustomerDetail,
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    val operations = state.customerOperations
    val context = LocalContext.current
    CrmCard {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("المتابعات", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (capabilities.customers.canWrite) {
                IconButton(onClick = actions.beginCreateFollowUp, enabled = state.canMutateCustomerFollowUps) {
                    Icon(Icons.Rounded.Add, contentDescription = "متابعة جديدة")
                }
            }
        }
        FilterChip(
            selected = operations.includeResolved,
            onClick = actions.toggleResolvedFollowUps,
            enabled = operations.notesFresh && state.busyKey == null,
            label = { Text("إظهار المنجزة") },
        )
        if (!operations.notesFresh) {
            OutlinedButton(
                onClick = actions.refreshCustomerOperations,
                enabled = state.busyKey == null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("تحديث المتابعات") }
        } else if (operations.notesPage.rows.isEmpty()) {
            Text("لا توجد متابعات", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            operations.notesPage.rows.forEach { row ->
                FollowUpCard(
                    row = row,
                    busy = state.busyKey != null,
                    showCustomer = false,
                    onOpenCustomer = null,
                    onWhatsapp = {
                        launchExternalWhatsApp(context, customer.whatsapp ?: customer.phone, "مرحباً ${customer.name}،")
                    },
                    onEdit = if (capabilities.customers.canWrite) ({ actions.beginEditFollowUp(row) }) else null,
                    onResolve = if (capabilities.customers.canWrite) ({ actions.setFollowUpResolved(row, !row.isResolved) }) else null,
                    onDelete = if (capabilities.customers.canWrite) ({ actions.requestDeleteFollowUp(row.id) }) else null,
                )
            }
            if (operations.notesPage.rows.size < operations.notesPage.total) {
                OutlinedButton(
                    onClick = actions.loadMoreCustomerFollowUps,
                    enabled = state.busyKey == null && operations.notesFresh,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("تحميل المزيد") }
            }
        }
    }
}

@Composable
private fun FollowUpCard(
    row: CustomerFollowUp,
    busy: Boolean,
    showCustomer: Boolean,
    onOpenCustomer: (() -> Unit)?,
    onWhatsapp: (() -> Unit)?,
    onEdit: (() -> Unit)?,
    onResolve: (() -> Unit)?,
    onDelete: (() -> Unit)?,
) {
    Column(
        Modifier.fillMaxWidth().clickable(enabled = onOpenCustomer != null && !busy) { onOpenCustomer?.invoke() }
            .padding(vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (showCustomer) {
            Text(row.customerName ?: "عميل #${row.customerId}", fontWeight = FontWeight.Bold)
        }
        Text(row.note, style = MaterialTheme.typography.bodyLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            CrmStatus(if (row.isResolved) "منجزة" else "مفتوحة")
            row.followUpDate?.let { CrmStatus(rtlIsolate(it), MaterialTheme.colorScheme.tertiary) }
            row.branchId?.let { CrmStatus(rtlIsolate("فرع #$it"), MaterialTheme.colorScheme.secondary) }
            row.createdByName?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (onWhatsapp != null) TextButton(onClick = onWhatsapp, enabled = !busy) {
                Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null)
                Text("واتساب")
            }
            if (onResolve != null) TextButton(onClick = onResolve, enabled = !busy) {
                Text(if (row.isResolved) "إعادة فتح" else "إنجاز")
            }
            if (onEdit != null) IconButton(onClick = onEdit, enabled = !busy) {
                Icon(Icons.Rounded.Edit, contentDescription = "تعديل المتابعة")
            }
            if (onDelete != null) IconButton(onClick = onDelete, enabled = !busy) {
                Icon(Icons.Rounded.Delete, contentDescription = "حذف المتابعة")
            }
        }
    }
}

@Composable
private fun ContractPricePanel(
    customer: CustomerDetail,
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    val operations = state.customerOperations
    CrmCard {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("أسعار العقود", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(
                    "${customer.priceTier.label} · ${operations.contractTotal} سعر",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            if (capabilities.customers.canWrite && capabilities.products.canRead) {
                IconButton(onClick = actions.beginCreateContractPrice, enabled = state.canMutateCustomerContracts) {
                    Icon(Icons.Rounded.Add, contentDescription = "سعر تعاقدي جديد")
                }
            }
        }
        if (!operations.contractsFresh) {
            OutlinedButton(
                onClick = actions.refreshCustomerOperations,
                enabled = state.busyKey == null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("تحديث الأسعار") }
        } else if (operations.contracts.isEmpty()) {
            Text("لا توجد أسعار تعاقدية", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            operations.contracts.forEach { row ->
                ContractPriceCard(
                    row = row,
                    busy = state.busyKey != null,
                    onEdit = { actions.beginEditContractPrice(row) },
                    onToggle = { actions.setContractPriceActive(row, !row.isActive) },
                    onDelete = { actions.requestDeleteContractPrice(row.id) },
                )
            }
            if (operations.contractHasMore) {
                OutlinedButton(
                    onClick = actions.loadMoreContractPrices,
                    enabled = state.busyKey == null && operations.contractsFresh,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("تحميل المزيد") }
            }
        }
    }
}

@Composable
private fun ContractPriceCard(
    row: CustomerContractPrice,
    busy: Boolean,
    onEdit: () -> Unit,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(row.productLabel, modifier = Modifier.weight(1f), fontWeight = FontWeight.Bold)
            CrmStatus(if (row.isActive) "نشط" else "معطّل")
        }
        if (row.sku.isNotBlank()) Text(rtlIsolate(row.sku), style = MaterialTheme.typography.labelMedium)
        Text(rtlIsolate("${row.price} د.ع"), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        row.note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            TextButton(onClick = onToggle, enabled = !busy) { Text(if (row.isActive) "تعطيل" else "تفعيل") }
            IconButton(onClick = onEdit, enabled = !busy) {
                Icon(Icons.Rounded.Edit, contentDescription = "تعديل السعر التعاقدي")
            }
            IconButton(onClick = onDelete, enabled = !busy) {
                Icon(Icons.Rounded.Delete, contentDescription = "حذف السعر التعاقدي")
            }
        }
    }
}

@Composable
private fun FollowUpEditorDialog(state: CrmUiState, actions: CrmActions) {
    val draft = state.customerOperations.followUpEditor ?: return
    AlertDialog(
        onDismissRequest = actions.closeFollowUpEditor,
        title = { Text(if (draft.noteId == null) "متابعة جديدة" else "تعديل المتابعة") },
        text = {
            Column(
                Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = draft.note,
                    onValueChange = { actions.updateFollowUpDraft(draft.copy(note = it.take(2000))) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("نص المتابعة") },
                    minLines = 3,
                )
                ArabicDatePicker(
                    value = draft.followUpDate,
                    onValue = { actions.updateFollowUpDraft(draft.copy(followUpDate = it)) },
                    label = "تاريخ المتابعة",
                )
            }
        },
        confirmButton = {
            Button(onClick = actions.saveFollowUp, enabled = state.busyKey == null && draft.note.isNotBlank()) { Text("حفظ") }
        },
        dismissButton = { TextButton(onClick = actions.closeFollowUpEditor, enabled = state.busyKey == null) { Text("إلغاء") } },
    )
}

@Composable
private fun ContractPriceEditorDialog(state: CrmUiState, actions: CrmActions) {
    val draft = state.customerOperations.contractEditor ?: return
    AlertDialog(
        onDismissRequest = actions.closeContractPriceEditor,
        title = { Text(if (draft.priceId == null) "سعر تعاقدي جديد" else "تعديل السعر التعاقدي") },
        text = {
            Column(
                Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (draft.priceId == null) {
                    OutlinedTextField(
                        value = state.customerOperations.contractCatalogQuery,
                        onValueChange = actions.setContractCatalogQuery,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("بحث الصنف") },
                        singleLine = true,
                        trailingIcon = {
                            IconButton(onClick = actions.searchContractCatalog, enabled = state.busyKey == null) {
                                Icon(Icons.Rounded.Search, contentDescription = "بحث")
                            }
                        },
                    )
                    state.customerOperations.contractCatalogResults.take(8).forEach { option ->
                        ContractCatalogOption(option) { actions.selectContractCatalogOption(option) }
                    }
                }
                if (draft.productLabel.isNotBlank()) {
                    Text(draft.productLabel, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                OutlinedTextField(
                    value = draft.price,
                    onValueChange = { actions.updateContractPriceDraft(draft.copy(price = it.take(18))) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("السعر التعاقدي") },
                    suffix = { Text("د.ع") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    textStyle = ltrInputTextStyle(),
                )
                OutlinedTextField(
                    value = draft.note,
                    onValueChange = { actions.updateContractPriceDraft(draft.copy(note = it.take(255))) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("مرجع العقد") },
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = actions.saveContractPrice,
                enabled = state.busyKey == null && draft.productUnitId != null && draft.price.isNotBlank(),
            ) { Text("حفظ") }
        },
        dismissButton = { TextButton(onClick = actions.closeContractPriceEditor, enabled = state.busyKey == null) { Text("إلغاء") } },
    )
}

@Composable
private fun ContractCatalogOption(option: CatalogOption, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(option.label, fontWeight = FontWeight.Bold)
            Text(
                rtlIsolate(
                    listOfNotNull(option.sku.takeIf(String::isNotBlank), option.effectivePrice?.let { "$it د.ع" })
                        .joinToString(" · "),
                ),
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun DeleteConfirmations(state: CrmUiState, actions: CrmActions) {
    if (state.customerOperations.pendingDeleteFollowUpId != null) {
        AlertDialog(
            onDismissRequest = { actions.requestDeleteFollowUp(null) },
            title = { Text("حذف المتابعة؟") },
            text = { Text("سيُحذف السجل نهائياً.") },
            confirmButton = {
                Button(onClick = actions.confirmDeleteFollowUp, enabled = state.busyKey == null) { Text("حذف") }
            },
            dismissButton = {
                TextButton(onClick = { actions.requestDeleteFollowUp(null) }, enabled = state.busyKey == null) { Text("إلغاء") }
            },
        )
    }
    if (state.customerOperations.pendingDeleteContractId != null) {
        AlertDialog(
            onDismissRequest = { actions.requestDeleteContractPrice(null) },
            title = { Text("حذف السعر التعاقدي؟") },
            text = { Text("لن يسري هذا السعر على المبيعات الجديدة.") },
            confirmButton = {
                Button(onClick = actions.confirmDeleteContractPrice, enabled = state.busyKey == null) { Text("حذف") }
            },
            dismissButton = {
                TextButton(onClick = { actions.requestDeleteContractPrice(null) }, enabled = state.busyKey == null) { Text("إلغاء") }
            },
        )
    }
}

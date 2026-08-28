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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CustomerDetail
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerSummary
import online.alarabiya.superapp.model.crm.CustomerType
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.ui.ltrInputTextStyle
import online.alarabiya.superapp.ui.rtlIsolate

@Composable
internal fun CustomersWorkspace(state: CrmUiState, capabilities: CrmCapabilities, actions: CrmActions) {
    if (!state.customersLoaded) {
        CrmRetryGate(
            title = if (state.pendingCustomerRefreshId != null) "بيانات العميل تحتاج تحديثاً" else "بيانات العملاء غير متاحة",
            retryEnabled = !state.initializing && state.busyKey == null,
            onRetry = actions.refresh,
        )
        return
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val secondary: (@Composable () -> Unit)? = when {
            state.customerEditor != null -> ({
                CustomerEditorPane(
                    editor = state.customerEditor,
                    busy = state.busyKey != null ||
                        (state.customerEditor.customerId != null && !state.canMutateSelectedCustomer),
                    onChange = actions.updateCustomerDraft,
                    onSave = actions.saveCustomer,
                    onClose = actions.closeCustomerEditor,
                )
            })
            state.selectedCustomer != null -> ({
                CustomerDetailPane(
                    customer = state.selectedCustomer,
                    state = state,
                    capabilities = capabilities,
                    actions = actions,
                )
            })
            else -> null
        }
        val list: @Composable () -> Unit = {
            CustomerListPane(
                state = state,
                canWrite = capabilities.customers.canWrite,
                actions = actions,
            )
        }
        if (maxWidth >= 840.dp) {
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.weight(.43f).fillMaxHeight()) { list() }
                VerticalDivider()
                Box(Modifier.weight(.57f).fillMaxHeight()) {
                    secondary?.invoke() ?: EmptyCrmState("اختر عميلاً لعرض بطاقته")
                }
            }
        } else {
            secondary?.invoke() ?: list()
        }
    }
}

@Composable
private fun CustomerListPane(state: CrmUiState, canWrite: Boolean, actions: CrmActions) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = state.customerQuery,
                    onValueChange = actions.setCustomerQuery,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text("اسم أو هاتف أو رقم قديم") },
                    trailingIcon = {
                        IconButton(onClick = actions.searchCustomers, enabled = state.canCreateCustomer) {
                            Icon(Icons.Rounded.Search, contentDescription = "بحث")
                        }
                    },
                )
                if (canWrite) {
                    IconButton(onClick = actions.beginCreateCustomer, enabled = state.canCreateCustomer) {
                        Icon(Icons.Rounded.Add, contentDescription = "عميل جديد")
                    }
                }
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${state.customerPage.total} عميل", fontWeight = FontWeight.Bold)
                FilterChip(
                    selected = state.includeInactiveCustomers,
                    onClick = actions.toggleInactiveCustomers,
                    enabled = state.canCreateCustomer,
                    label = { Text("إظهار المعطّلين") },
                )
            }
        }
        if (state.customerPage.rows.isEmpty()) item { EmptyCrmState("لا توجد نتائج مطابقة") }
        items(state.customerPage.rows, key = { it.id }) { customer ->
            CustomerSummaryCard(customer, state.canCreateCustomer) { actions.selectCustomer(customer.id) }
        }
        if (state.customerPage.rows.size < state.customerPage.total) item {
            OutlinedButton(
                onClick = actions.loadMoreCustomers,
                enabled = state.canCreateCustomer,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("تحميل المزيد") }
        }
    }
}

@Composable
private fun CustomerSummaryCard(customer: CustomerSummary, enabled: Boolean, onClick: () -> Unit) {
    CrmCard {
        Column(
            Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(customer.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                CrmStatus(if (customer.isActive) "نشط" else "معطّل")
            }
            customer.phone?.let { Text(rtlIsolate(it), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(
                listOfNotNull(customer.customerType.wire, customer.city, customer.district).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
            customer.currentBalance?.let { Text(rtlIsolate("الرصيد: $it د.ع"), color = MaterialTheme.colorScheme.primary) }
        }
    }
}

@Composable
private fun CustomerDetailPane(
    customer: CustomerDetail,
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
) {
    val context = LocalContext.current
    val busy = !state.canMutateSelectedCustomer
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = actions.closeCustomerDetail) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "رجوع") }
                Text(customer.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                if (capabilities.customers.canWrite) IconButton(onClick = actions.beginEditCustomer, enabled = !busy) { Icon(Icons.Rounded.Edit, contentDescription = "تعديل") }
            }
        }
        item {
            CrmCard {
                DetailValue("النوع", customer.customerType.wire)
                DetailValue("فئة السعر", customer.priceTier.label)
                DetailValue("الهاتف", customer.phone?.let(::rtlIsolate) ?: "—")
                customer.phone2?.let { DetailValue("هاتف إضافي", rtlIsolate(it)) }
                customer.phone3?.let { DetailValue("هاتف إضافي", rtlIsolate(it)) }
                DetailValue("واتساب", customer.whatsapp?.let(::rtlIsolate) ?: "—")
                DetailValue("العنوان", listOfNotNull(customer.city, customer.district, customer.address).joinToString("، ").ifBlank { "—" })
                customer.notes?.let { DetailValue("ملاحظات", it) }
                customer.currentBalance?.let { DetailValue("الرصيد الجاري", rtlIsolate("$it د.ع")) }
                customer.creditLimit?.let { DetailValue("سقف الائتمان", rtlIsolate("$it د.ع")) }
                customer.waConsent?.let { DetailValue("موافقة واتساب", it) }
            }
        }
        item {
            Button(
                onClick = {
                    launchExternalWhatsApp(
                        context,
                        customer.whatsapp ?: customer.phone,
                        "مرحباً ${customer.name}،",
                    )
                },
                enabled = !busy && (customer.whatsapp != null || customer.phone != null),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null)
                Spacer(Modifier.padding(horizontal = 4.dp))
                Text("فتح محادثة واتساب")
            }
        }
        item {
            CustomerOperationsPanel(
                customer = customer,
                state = state,
                capabilities = capabilities,
                actions = actions,
            )
        }
        if (capabilities.customers.canWrite) item {
            OutlinedButton(
                onClick = { actions.setCustomerActive(!customer.isActive) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (customer.isActive) "تعطيل العميل" else "تفعيل العميل") }
        }
    }
}

@Composable
private fun CustomerEditorPane(
    editor: CustomerEditor,
    busy: Boolean,
    onChange: (CustomerDraft) -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
) {
    val draft = editor.draft
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose, enabled = !busy) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "إغلاق") }
                Text(
                    if (editor.customerId == null) "عميل جديد" else "تعديل العميل",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Box(Modifier.padding(24.dp))
            }
        }
        item {
            CrmCard {
                EditorField(draft.name, { onChange(draft.copy(name = it)) }, "اسم العميل *")
                EditorField(draft.phone, { onChange(draft.copy(phone = it)) }, "الهاتف", leftToRight = true, keyboardType = KeyboardType.Phone)
                EditorField(draft.whatsapp, { onChange(draft.copy(whatsapp = it)) }, "واتساب", leftToRight = true, keyboardType = KeyboardType.Phone)
                EditorField(draft.city, { onChange(draft.copy(city = it)) }, "المدينة")
                EditorField(draft.district, { onChange(draft.copy(district = it)) }, "المنطقة")
                EditorField(draft.address, { onChange(draft.copy(address = it)) }, "العنوان", singleLine = false)
                Text("نوع العميل", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(CustomerType.entries, key = { it.name }) { type ->
                        FilterChip(
                            selected = draft.customerType == type,
                            onClick = { onChange(draft.copy(customerType = type)) },
                            label = { Text(type.wire) },
                        )
                    }
                }
                Text("فئة السعر", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(PriceTier.entries, key = { it.name }) { tier ->
                        FilterChip(
                            selected = draft.priceTier == tier,
                            onClick = { onChange(draft.copy(priceTier = tier)) },
                            label = { Text(tier.label) },
                        )
                    }
                }
                EditorField(draft.notes, { onChange(draft.copy(notes = it)) }, "ملاحظات", singleLine = false)
            }
        }
        item {
            Button(onClick = onSave, enabled = !busy && draft.name.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                Text("حفظ")
            }
        }
    }
}

@Composable
private fun EditorField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    singleLine: Boolean = true,
    leftToRight: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 2,
        textStyle = if (leftToRight) ltrInputTextStyle() else LocalTextStyle.current,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
    )
}

@Composable
private fun DetailValue(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
    HorizontalDivider()
}

internal val PriceTier.label: String
    get() = when (this) {
        PriceTier.RETAIL -> "تجزئة"
        PriceTier.WHOLESALE -> "جملة"
        PriceTier.GOVERNMENT -> "حكومي"
    }

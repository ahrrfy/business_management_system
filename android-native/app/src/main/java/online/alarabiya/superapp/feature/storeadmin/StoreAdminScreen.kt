package online.alarabiya.superapp.feature.storeadmin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.storeadmin.*
import online.alarabiya.superapp.ui.ArabicDatePicker

@Composable
fun StoreAdminRoute(viewModel: StoreAdminViewModel, capabilities: StoreAdminCapabilities, modifier: Modifier = Modifier) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    StoreAdminScreen(viewModel.state, capabilities, viewModel, modifier)
}

@Composable
fun StoreAdminScreen(state: StoreAdminState, capabilities: StoreAdminCapabilities, actions: StoreAdminViewModel, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize()) {
        Text("إدارة المتجر", Modifier.padding(20.dp), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
        TabRow(state.section.ordinal) {
            Tab(state.section == StoreAdminSection.SETTINGS, { actions.section(StoreAdminSection.SETTINGS) }, text = { Text("الإعدادات") })
            Tab(state.section == StoreAdminSection.BANNERS, { actions.section(StoreAdminSection.BANNERS) }, text = { Text("البنرات") })
        }
        state.notice?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.primary) }
        if (!capabilities.canRead) Box(Modifier.fillMaxSize()) { Text("لا تملك صلاحية إدارة المتجر", Modifier.padding(24.dp)) }
        else if (state.loading || (!state.initialized && state.error == null)) LinearProgressIndicator(Modifier.fillMaxWidth())
        else if (!state.initialized) InitialLoadError(state.error, actions::initialize)
        else when (state.section) {
            StoreAdminSection.SETTINGS -> SettingsPane(state.settings, state.canMutate(capabilities.canManage), state.error, actions)
            StoreAdminSection.BANNERS -> BannersPane(state.banners, state.canMutate(capabilities.canManage), state.error, actions)
        }
    }
    state.editor?.let { BannerEditor(it, state.loading, actions) }
    state.pendingDelete?.let { banner -> AlertDialog(
        onDismissRequest = { if (!state.loading) actions.cancelDelete() }, title = { Text("حذف البنر؟") },
        text = { Text("سيُحذف «${banner.title}» من المتجر نهائياً.") },
        confirmButton = { Button(actions::confirmDelete, enabled = !state.loading, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("حذف") } },
        dismissButton = { TextButton(actions::cancelDelete, enabled = !state.loading) { Text("إلغاء") } },
    ) }
}

@Composable
private fun InitialLoadError(message: String?, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("تعذر تحميل إعدادات المتجر", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                message?.takeIf(String::isNotBlank)?.let {
                    Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Button(onRetry, Modifier.fillMaxWidth()) { Text("إعادة المحاولة") }
            }
        }
    }
}

@Composable private fun SettingsPane(value: StoreSettingsDraft, editable: Boolean, error: String?, actions: StoreAdminViewModel) {
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("المتجر مفتوح", fontWeight = FontWeight.Bold); Switch(value.isOpen, { actions.settings(value.copy(isOpen = it)) }, enabled = editable) } }
        item { OutlinedTextField(value.announcement, { actions.settings(value.copy(announcement = it)) }, Modifier.fillMaxWidth(), label = { Text("الإعلان") }, enabled = editable, minLines = 2) }
        item { OutlinedTextField(value.whatsappNumber, { actions.settings(value.copy(whatsappNumber = it)) }, Modifier.fillMaxWidth(), label = { Text("رقم واتساب") }, enabled = editable, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone)) }
        item { OutlinedTextField(value.freeShippingThreshold, { actions.settings(value.copy(freeShippingThreshold = it)) }, Modifier.fillMaxWidth(), label = { Text("حد التوصيل المجاني") }, enabled = editable, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)) }
        if (editable) item { Button(actions::saveSettings, Modifier.fillMaxWidth()) { Text("حفظ الإعدادات") } }
    }
}

@Composable private fun BannersPane(values: List<StoreBannerDraft>, editable: Boolean, error: String?, actions: StoreAdminViewModel) {
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        if (editable) item { Button(actions::newBanner, Modifier.fillMaxWidth()) { Text("إضافة بنر") } }
        items(values, key = { it.id ?: it.title }) { banner -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(banner.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                if (banner.subtitle.isNotBlank()) Text(banner.subtitle)
                Text("${banner.placement.label} • ${if (banner.active) "نشط" else "متوقف"}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (editable) Row { TextButton({ actions.editBanner(banner) }) { Text("تعديل") }; TextButton({ actions.askDelete(banner) }) { Text("حذف", color = MaterialTheme.colorScheme.error) } }
            }
        } }
        if (values.isEmpty()) item { Text("لا توجد بنرات") }
    }
}

@Composable private fun BannerEditor(value: StoreBannerDraft, locked: Boolean, actions: StoreAdminViewModel) {
    AlertDialog(onDismissRequest = actions::closeEditor, title = { Text(if (value.id == null) "إضافة بنر" else "تعديل البنر") }, text = {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { OutlinedTextField(value.title, { actions.editor(value.copy(title = it)) }, Modifier.fillMaxWidth(), label = { Text("العنوان") }, enabled = !locked) }
            item { OutlinedTextField(value.subtitle, { actions.editor(value.copy(subtitle = it)) }, Modifier.fillMaxWidth(), label = { Text("النص الفرعي") }, enabled = !locked) }
            item { OutlinedTextField(value.ctaLabel, { actions.editor(value.copy(ctaLabel = it)) }, Modifier.fillMaxWidth(), label = { Text("عنوان الإجراء") }, enabled = !locked) }
            item { OutlinedTextField(value.ctaUrl, { actions.editor(value.copy(ctaUrl = it)) }, Modifier.fillMaxWidth(), label = { Text("المسار الداخلي، مثال /store") }, enabled = !locked) }
            item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) { BannerPlacement.entries.forEach { p -> FilterChip(value.placement == p, { actions.editor(value.copy(placement = p)) }, label = { Text(p.label) }, enabled = !locked) } } }
            item { OutlinedTextField(value.sortOrder, { actions.editor(value.copy(sortOrder = it)) }, Modifier.fillMaxWidth(), label = { Text("الترتيب") }, enabled = !locked, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) }
            item { ArabicDatePicker(value.effectiveFrom, { actions.editor(value.copy(effectiveFrom = it)) }, "البداية", enabled = !locked) }
            item { ArabicDatePicker(value.effectiveTo, { actions.editor(value.copy(effectiveTo = it)) }, "النهاية", enabled = !locked) }
            item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("نشط"); Switch(value.active, { actions.editor(value.copy(active = it)) }, enabled = !locked) } }
        }
    }, confirmButton = { Button(actions::saveBanner, enabled = !locked) { Text("حفظ") } }, dismissButton = { TextButton(actions::closeEditor, enabled = !locked) { Text("إلغاء") } })
}

private val BannerPlacement.label get() = when (this) { BannerPlacement.HERO -> "رئيسي"; BannerPlacement.SIDE -> "جانبي"; BannerPlacement.INLINE -> "بين المنتجات" }

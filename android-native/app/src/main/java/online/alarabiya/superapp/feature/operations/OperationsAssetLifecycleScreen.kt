package online.alarabiya.superapp.feature.operations

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AssignmentInd
import androidx.compose.material.icons.rounded.AssignmentReturn
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.Calculate
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteForever
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Inventory2
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.UploadFile
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.YearMonth
import online.alarabiya.superapp.core.time.baghdadToday
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.operations.AssetCategory
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetDisposalInput
import online.alarabiya.superapp.model.operations.AssetDocument
import online.alarabiya.superapp.model.operations.AssetDocumentEncoding
import online.alarabiya.superapp.model.operations.AssetFormOption
import online.alarabiya.superapp.model.operations.AssetFormOptions
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetUpsertInput
import online.alarabiya.superapp.model.operations.DepreciationMethod
import online.alarabiya.superapp.model.operations.OperationsPolicy
import online.alarabiya.superapp.model.operations.OperationsValidation
import online.alarabiya.superapp.ui.scanner.NativeScannerAction
import online.alarabiya.superapp.ui.theme.Canvas
import online.alarabiya.superapp.ui.theme.Emerald
import online.alarabiya.superapp.ui.theme.EmeraldDark
import online.alarabiya.superapp.ui.theme.Mint
import online.alarabiya.superapp.ui.theme.MutedInk
import online.alarabiya.superapp.ui.theme.Orange
import online.alarabiya.superapp.ui.theme.Stroke

@Composable
internal fun AssetRegisterActions(state: OperationsUiState, viewModel: OperationsViewModel) {
    if (!state.capabilities.canCreateAssets && !state.capabilities.canPostDepreciation &&
        state.outcomeUnknownAction == null
    ) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.outcomeUnknownAction?.let {
            OutcomeUnknownGate(state, viewModel)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.capabilities.canCreateAssets) {
                Button(
                    onClick = viewModel::openCreateAsset,
                    enabled = !state.assetMutationLocked,
                    modifier = Modifier.weight(1f).heightIn(min = 50.dp).testTag("asset-create-open"),
                ) {
                    Icon(Icons.Rounded.Add, null)
                    Spacer(Modifier.width(6.dp))
                    Text("إضافة أصل")
                }
            }
            if (state.capabilities.canPostDepreciation) {
                OutlinedButton(
                    onClick = viewModel::openDepreciationPosting,
                    enabled = !state.assetMutationLocked,
                    modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                ) {
                    Icon(Icons.Rounded.Calculate, null)
                    Spacer(Modifier.width(6.dp))
                    Text("ترحيل الإهلاك", maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun OutcomeUnknownGate(state: OperationsUiState, viewModel: OperationsViewModel) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF1E8)),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Rounded.WarningAmber, null, tint = Orange)
                Text("نتيجة عملية تحتاج مراجعة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            Text(
                "أوقفت إجراءات الأصول لمنع تكرار كتابة قد يكون الخادم نفّذها. حدّث السجل، راجع الأصل، ثم افتح الإجراءات.",
                color = MutedInk,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = viewModel::refresh, enabled = !state.loading && state.busyKey == null) {
                    Icon(Icons.Rounded.Refresh, null)
                    Spacer(Modifier.width(5.dp))
                    Text("تحديث السجل")
                }
                Button(
                    onClick = viewModel::acknowledgeOutcomeReview,
                    enabled = state.outcomeReviewReady && !state.loading && state.busyKey == null,
                ) { Text("راجعت السجل") }
            }
        }
    }
}

internal fun LazyListScope.assetLifecycleItems(
    detail: AssetDetail,
    state: OperationsUiState,
    viewModel: OperationsViewModel,
    onStartMaintenance: () -> Unit,
) {
    val asset = detail.summary
    item {
        LifecycleInfoCard("التعريف والإهلاك", Icons.Rounded.Inventory2) {
            LifecycleValue("الماركة", detail.brand ?: "—")
            LifecycleValue("الرقم التسلسلي", detail.serial ?: "—")
            LifecycleValue("المورّد", detail.supplierName ?: "—")
            LifecycleValue("القيمة التخريدية", assetMoney(detail.salvageValue))
            LifecycleValue("الإهلاك المتراكم", assetMoney(detail.accumulatedDepreciation))
            LifecycleValue("إجمالي الصيانة", assetMoney(detail.maintenanceTotal))
            LifecycleValue("العمر الإنتاجي", "${detail.usefulLifeYears} سنة")
            LifecycleValue("طريقة الإهلاك", detail.depreciationMethod.label)
            if (asset.status in setOf(AssetStatus.Retired, AssetStatus.Disposed)) {
                HorizontalDivider(color = Stroke)
                LifecycleValue("تاريخ الإخراج", detail.disposalDate ?: "—")
                LifecycleValue("السبب", detail.disposalReason ?: "—")
                detail.disposalValue?.let { LifecycleValue("العائد", assetMoney(it)) }
            }
        }
    }
    item {
        AssetDocumentsCard(detail.documents, state, viewModel)
    }
    item {
        AssetLifecycleButtons(detail, state, viewModel, onStartMaintenance)
    }
}

@Composable
private fun AssetLifecycleButtons(
    detail: AssetDetail,
    state: OperationsUiState,
    viewModel: OperationsViewModel,
    onStartMaintenance: () -> Unit,
) {
    val asset = detail.summary
    val enabled = state.selectedAssetFresh && !state.assetMutationLocked
    Card(colors = CardDefaults.cardColors(containerColor = Canvas), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text("إجراءات الأصل", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            if (!state.selectedAssetFresh) {
                Text("حدّث تفاصيل الأصل قبل تنفيذ إجراء.", color = Orange)
            }
            if (OperationsPolicy.canEditAsset(asset, state.capabilities)) {
                OutlinedButton(viewModel::openEditAsset, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = enabled) {
                    Icon(Icons.Rounded.Edit, null)
                    Spacer(Modifier.width(7.dp))
                    Text("تعديل بيانات الأصل")
                }
            }
            if (OperationsPolicy.canHandoverAsset(asset, state.capabilities)) {
                OutlinedButton(viewModel::openAssetHandover, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = enabled) {
                    Icon(Icons.Rounded.AssignmentInd, null)
                    Spacer(Modifier.width(7.dp))
                    Text(if (asset.custodianId == null) "تسليم عهدة" else "نقل العهدة")
                }
                if (asset.custodianId != null) {
                    OutlinedButton(viewModel::openCustodyRelease, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = enabled) {
                        Icon(Icons.Rounded.AssignmentReturn, null)
                        Spacer(Modifier.width(7.dp))
                        Text("استرجاع العهدة إلى الشركة")
                    }
                }
            }
            if (OperationsPolicy.canStartMaintenance(asset, state.capabilities)) {
                OutlinedButton(onStartMaintenance, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = enabled) {
                    Icon(Icons.Rounded.Build, null)
                    Spacer(Modifier.width(7.dp))
                    Text("تسجيل صيانة دون مصروف")
                }
            }
            if (OperationsPolicy.canReturnFromMaintenance(asset, state.capabilities)) {
                Button(viewModel::requestReturnAsset, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = enabled) {
                    Text("إعادة الأصل إلى الخدمة")
                }
            }
            if (OperationsPolicy.canDisposeAsset(asset, state.capabilities)) {
                OutlinedButton(
                    viewModel::openAssetDisposal,
                    Modifier.fillMaxWidth().heightIn(min = 50.dp),
                    enabled = enabled,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.Rounded.DeleteForever, null)
                    Spacer(Modifier.width(7.dp))
                    Text("إخراج أو استبعاد")
                }
            }
        }
    }
}

@Composable
private fun AssetDocumentsCard(
    documents: List<AssetDocument>,
    state: OperationsUiState,
    viewModel: OperationsViewModel,
) {
    var preview by remember { mutableStateOf<AssetDocument?>(null) }
    Card(colors = CardDefaults.cardColors(containerColor = Canvas), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.AttachFile, null, tint = Emerald)
                Spacer(Modifier.width(7.dp))
                Text("المستندات (${documents.size})", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                if (state.capabilities.canManageAssetDocuments) {
                    IconButton(
                        onClick = viewModel::openAssetDocument,
                        enabled = state.selectedAssetFresh && !state.assetMutationLocked,
                    ) { Icon(Icons.Rounded.Add, "إضافة مستند", tint = Emerald) }
                }
            }
            if (documents.isEmpty()) {
                Text("لا توجد مستندات مرفقة", color = MutedInk)
            } else {
                documents.forEachIndexed { index, document ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(document.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(if (document.dataUrl != null) "صورة محفوظة" else "بلا ملف", color = MutedInk)
                        }
                        TextButton(onClick = { preview = document }, enabled = document.dataUrl != null) { Text("معاينة") }
                        if (state.capabilities.canManageAssetDocuments) {
                            IconButton(
                                onClick = { viewModel.requestDeleteAssetDocument(document) },
                                enabled = state.selectedAssetFresh && !state.assetMutationLocked,
                            ) { Icon(Icons.Rounded.DeleteForever, "حذف ${document.title}", tint = MaterialTheme.colorScheme.error) }
                        }
                    }
                    if (index < documents.lastIndex) HorizontalDivider(color = Stroke)
                }
            }
        }
    }
    preview?.let { AssetDocumentPreview(it) { preview = null } }
}

@Composable
private fun AssetDocumentPreview(document: AssetDocument, onDismiss: () -> Unit) {
    val image = remember(document.id, document.dataUrl) {
        runCatching {
            val encoded = requireNotNull(document.dataUrl).substringAfter(",")
            val bytes = Base64.getDecoder().decode(encoded)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Color(0xFF090C11)) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(document.title, Modifier.weight(1f), color = Color.White, style = MaterialTheme.typography.titleLarge)
                    IconButton(onDismiss) { Icon(Icons.Rounded.Close, "إغلاق", tint = Color.White) }
                }
                if (image == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("تعذر عرض صورة المستند", color = Color.White)
                    }
                } else {
                    Image(image, document.title, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                }
            }
        }
    }
}

@Composable
internal fun AssetLifecycleOverlays(state: OperationsUiState, viewModel: OperationsViewModel) {
    val detail = (state.assetDetail as? OperationsDetailState.Content)?.value
    when (state.assetOverlay) {
        AssetOverlay.Create -> AssetEditorDialog(null, state, viewModel)
        AssetOverlay.Edit -> detail?.let { AssetEditorDialog(it, state, viewModel) }
        AssetOverlay.Handover -> detail?.let { AssetHandoverDialog(it, state, viewModel) }
        AssetOverlay.ReleaseCustody -> detail?.let { AssetCustodyReturnDialog(it, viewModel) }
        AssetOverlay.Dispose -> detail?.let { AssetDisposalDialog(it, viewModel) }
        AssetOverlay.AddDocument -> detail?.let { AssetDocumentUploadDialog(it, viewModel) }
        AssetOverlay.PostDepreciation -> AssetDepreciationDialog(viewModel)
        null -> Unit
    }
}

@Composable
private fun AssetEditorDialog(detail: AssetDetail?, state: OperationsUiState, viewModel: OperationsViewModel) {
    val options = (state.assetOptions as? OperationsDetailState.Content)?.value
    val editing = detail != null
    val today = remember { baghdadToday().toString() }
    var name by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.name.orEmpty()) }
    var categoryWire by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.category?.wire ?: AssetCategory.Computers.wire) }
    var brand by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.brand.orEmpty()) }
    var serial by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.serial.orEmpty()) }
    var branchId by rememberSaveable(detail?.summary?.id) {
        mutableStateOf((state.scope.branchId ?: detail?.summary?.branchId ?: options?.branches?.singleOrNull()?.id)?.toString().orEmpty())
    }
    var location by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.location.orEmpty()) }
    var custodianId by rememberSaveable(detail?.summary?.id) { mutableStateOf("") }
    var supplierId by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.supplierId?.toString().orEmpty()) }
    var purchaseDate by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.purchaseDate ?: today) }
    var purchaseValue by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.purchaseValue.orEmpty()) }
    var salvageValue by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.salvageValue ?: "0") }
    var usefulLife by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.usefulLifeYears?.toString() ?: "4") }
    var depreciationWire by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.depreciationMethod?.wire ?: "sl") }
    var condition by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.condition ?: "ممتاز") }
    var warrantyEnd by rememberSaveable(detail?.summary?.id) { mutableStateOf(detail?.summary?.warrantyEnd.orEmpty()) }

    val category = AssetCategory.fromWire(categoryWire)
    val input = AssetUpsertInput(
        id = detail?.summary?.id,
        name = name,
        category = category,
        brand = brand.ifBlank { null },
        serial = serial.ifBlank { null },
        branchId = branchId.toLongOrNull(),
        location = location.ifBlank { null },
        custodianId = custodianId.toLongOrNull(),
        supplierId = supplierId.toLongOrNull(),
        purchaseDate = purchaseDate,
        purchaseValue = purchaseValue,
        salvageValue = salvageValue.ifBlank { "0" },
        usefulLifeYears = usefulLife.toIntOrNull() ?: 0,
        depreciationMethod = DepreciationMethod.fromWire(depreciationWire),
        condition = condition.ifBlank { null },
        warrantyEnd = warrantyEnd.ifBlank { null },
    )
    val validation = OperationsValidation.asset(input, state.scope)
    LifecycleDialog(
        title = if (editing) "تعديل ${detail?.summary?.code}" else "إضافة أصل جديد",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = if (editing) "مراجعة التعديل" else "مراجعة الإنشاء",
        confirmEnabled = options != null && state.assetOptionsFresh && validation == null,
        onConfirm = { if (editing) viewModel.requestUpdateAsset(input) else viewModel.requestCreateAsset(input) },
    ) {
        when (val optionState = state.assetOptions) {
            OperationsDetailState.Loading, OperationsDetailState.None -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            is OperationsDetailState.Error -> {
                Text(optionState.message, color = MaterialTheme.colorScheme.error)
                OutlinedButton(viewModel::retryAssetOptions, Modifier.fillMaxWidth()) { Text("إعادة تحميل الخيارات") }
            }
            is OperationsDetailState.Content -> Unit
        }
        Text("البيانات الأساسية", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        OutlinedTextField(name, { name = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("اسم الأصل *") }, singleLine = true)
        Text("الفئة", style = MaterialTheme.typography.titleMedium)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            AssetCategory.entries.filterNot { it == AssetCategory.Unknown }.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    row.forEach { option ->
                        FilterChip(
                            selected = categoryWire == option.wire,
                            onClick = {
                                categoryWire = option.wire
                                if (!editing) usefulLife = option.defaultLifeYears.toString()
                            },
                            label = { Text(option.label) },
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        OutlinedTextField(brand, { brand = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("الماركة") }, singleLine = true)
        OutlinedTextField(
            serial,
            { serial = it.take(128) },
            Modifier.fillMaxWidth(),
            label = { Text("الرقم التسلسلي") },
            trailingIcon = { NativeScannerAction(NativeScanField.SKU_OR_BARCODE, { serial = it }, enabled = state.busyKey == null) },
            singleLine = true,
        )
        options?.let {
            OptionDropdown("الفرع *", branchId.toLongOrNull(), it.branches, enabled = state.scope.branchId == null) { branchId = it?.toString().orEmpty() }
            OptionDropdown("المورّد", supplierId.toLongOrNull(), it.suppliers, allowNone = true) { supplierId = it?.toString().orEmpty() }
            if (!editing) {
                val employees = it.employees.filter { employee -> branchId.toLongOrNull() == null || employee.branchId == branchId.toLongOrNull() }
                OptionDropdown("العهدة الابتدائية", custodianId.toLongOrNull(), employees, allowNone = true) { custodianId = it?.toString().orEmpty() }
            }
        }
        OutlinedTextField(location, { location = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("الموقع") }, singleLine = true)
        OutlinedTextField(condition, { condition = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("الحالة الفنية") }, singleLine = true)
        Text("الشراء والإهلاك", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        ArabicDatePicker(purchaseDate, { purchaseDate = it }, "تاريخ الشراء *")
        OutlinedTextField(
            purchaseValue,
            { purchaseValue = decimalInput(it) },
            Modifier.fillMaxWidth(),
            label = { Text("قيمة الشراء (د.ع) *") },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
            singleLine = true,
        )
        OutlinedTextField(
            salvageValue,
            { salvageValue = decimalInput(it) },
            Modifier.fillMaxWidth(),
            label = { Text("القيمة التخريدية (د.ع)") },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
            singleLine = true,
        )
        OutlinedTextField(
            usefulLife,
            { usefulLife = it.filter(Char::isDigit).take(3) },
            Modifier.fillMaxWidth(),
            label = { Text("العمر الإنتاجي بالسنوات *") },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DepreciationMethod.entries.forEach { method ->
                FilterChip(
                    selected = depreciationWire == method.wire,
                    onClick = { depreciationWire = method.wire },
                    label = { Text(method.label) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        ArabicDatePicker(warrantyEnd, { warrantyEnd = it }, "نهاية الكفالة")
        LifecycleValue("القسط السنوي التقديري", assetMoney(annualDepreciation(input)))
        validation?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        if (editing) {
            Text(
                "تعديل القيمة أو المورد يعيد قيد الاقتناء ويصحح الإهلاك عبر الخادم. راجع الأرقام قبل المتابعة.",
                color = Orange,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun AssetHandoverDialog(detail: AssetDetail, state: OperationsUiState, viewModel: OperationsViewModel) {
    val options = (state.assetOptions as? OperationsDetailState.Content)?.value
    var employeeId by rememberSaveable(detail.summary.id) { mutableStateOf<Long?>(null) }
    var note by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    val employees = options?.employees.orEmpty().filter { it.id != detail.summary.custodianId }
    LifecycleDialog(
        title = if (detail.summary.custodianId == null) "تسليم عهدة" else "نقل العهدة",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = "مراجعة التسليم",
        confirmEnabled = state.assetOptionsFresh && employeeId != null,
        onConfirm = { employeeId?.let { viewModel.requestAssetHandover(it, note.ifBlank { null }) } },
    ) {
        LifecycleValue("الأصل", "${detail.summary.name} — ${detail.summary.code}")
        LifecycleValue("العهدة الحالية", detail.summary.custodianName ?: "بلا عهدة")
        when (val optionState = state.assetOptions) {
            OperationsDetailState.Loading, OperationsDetailState.None -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            is OperationsDetailState.Error -> {
                Text(optionState.message, color = MaterialTheme.colorScheme.error)
                OutlinedButton(viewModel::retryAssetOptions, Modifier.fillMaxWidth()) { Text("إعادة تحميل الموظفين") }
            }
            is OperationsDetailState.Content -> OptionDropdown("الموظف المستلم *", employeeId, employees) { employeeId = it }
        }
        OutlinedTextField(note, { note = it.take(500) }, Modifier.fillMaxWidth(), label = { Text("ملاحظة التسليم") }, minLines = 2)
    }
}

@Composable
private fun AssetCustodyReturnDialog(detail: AssetDetail, viewModel: OperationsViewModel) {
    LifecycleDialog(
        title = "استرجاع العهدة",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = "مراجعة الاسترجاع",
        confirmEnabled = detail.summary.custodianId != null,
        onConfirm = viewModel::requestCustodyRelease,
    ) {
        LifecycleValue("الأصل", "${detail.summary.name} — ${detail.summary.code}")
        LifecycleValue("الموظف الحالي", detail.summary.custodianName ?: "—")
        Text(
            "سيُغلق سجل العهدة الجاري ويعود الأصل إلى مخزون الشركة بلا موظف مسؤول. لا يتغير ربط جهاز البصمة إن وُجد.",
            color = MutedInk,
        )
    }
}

@Composable
private fun AssetDisposalDialog(detail: AssetDetail, viewModel: OperationsViewModel) {
    var statusWire by rememberSaveable(detail.summary.id) { mutableStateOf(AssetStatus.Retired.wire) }
    var date by rememberSaveable(detail.summary.id) { mutableStateOf(baghdadToday().toString()) }
    var reason by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var value by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var confirmation by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    val status = AssetStatus.fromWire(statusWire)
    val command = AssetDisposalInput(detail.summary.id, status, date, reason.ifBlank { null }, value.ifBlank { null })
    val validation = OperationsValidation.disposal(command)
    LifecycleDialog(
        title = "إخراج أو استبعاد الأصل",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = if (status == AssetStatus.Disposed) "مراجعة الاستبعاد" else "مراجعة الإخراج",
        confirmEnabled = validation == null && confirmation == detail.summary.name,
        onConfirm = { viewModel.requestAssetDisposal(command) },
        destructive = true,
    ) {
        LifecycleValue("الأصل", "${detail.summary.name} — ${detail.summary.code}")
        LifecycleValue("القيمة الدفترية", assetMoney(detail.summary.bookValue))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(AssetStatus.Retired, AssetStatus.Disposed).forEach { option ->
                FilterChip(status == option, { statusWire = option.wire }, label = { Text(option.label) }, modifier = Modifier.weight(1f))
            }
        }
        ArabicDatePicker(date, { date = it }, "التاريخ *")
        if (status == AssetStatus.Disposed) {
            OutlinedTextField(
                value,
                { value = decimalInput(it) },
                Modifier.fillMaxWidth(),
                label = { Text("العائد (د.ع) — صفر إن بلا عائد *") },
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
            )
        }
        OutlinedTextField(reason, { reason = it.take(500) }, Modifier.fillMaxWidth(), label = { Text("السبب") }, minLines = 2)
        Text("اكتب اسم الأصل للتأكيد: ${detail.summary.name}", color = MaterialTheme.colorScheme.error)
        OutlinedTextField(confirmation, { confirmation = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("اسم الأصل للتأكيد") }, singleLine = true)
        validation?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text("هذا إجراء مالي وتشغيلي لا رجعة فيه بعد التأكيد.", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AssetDocumentUploadDialog(detail: AssetDetail, viewModel: OperationsViewModel) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    var title by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var dataUrl by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var sourceLabel by rememberSaveable(detail.summary.id) { mutableStateOf("") }
    var error by rememberSaveable(detail.summary.id) { mutableStateOf<String?>(null) }
    var processing by remember { mutableStateOf(false) }

    fun acceptBytes(bytes: ByteArray, mimeType: String, label: String) {
        runCatching { AssetDocumentEncoding.encode(bytes, mimeType) }
            .onSuccess { encoded -> dataUrl = encoded; sourceLabel = label; error = null }
            .onFailure { error = it.message ?: "تعذر تجهيز الصورة" }
    }

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap: Bitmap? ->
        if (bitmap != null) {
            val output = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, output)
            acceptBytes(output.toByteArray(), "image/jpeg", "صورة ملتقطة بالكاميرا")
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) camera.launch(null) else error = "يلزم إذن الكاميرا لتصوير المستند"
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            processing = true
            coroutineScope.launch {
                val result = runCatching {
                    withContext(Dispatchers.IO) {
                        val rawMime = context.contentResolver.getType(uri)?.lowercase() ?: ""
                        val mime = if (rawMime == "image/jpg") "image/jpeg" else rawMime
                        require(mime in setOf("image/jpeg", "image/png", "image/webp")) { "اختر صورة PNG أو JPG أو WEBP" }
                        val bytes = context.contentResolver.openInputStream(uri)?.use(AssetDocumentEncoding::readLimited)
                            ?: error("تعذر قراءة الصورة")
                        AssetDocumentEncoding.encode(bytes, mime)
                    }
                }
                result.onSuccess { encoded -> dataUrl = encoded; sourceLabel = "صورة مختارة من الجهاز"; error = null }
                    .onFailure { error = it.message ?: "تعذر قراءة الصورة" }
                processing = false
            }
        }
    }
    LifecycleDialog(
        title = "إضافة مستند للأصل",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = "مراجعة الرفع",
        confirmEnabled = title.isNotBlank() && dataUrl.isNotBlank() && !processing,
        onConfirm = { viewModel.requestAddAssetDocument(title, dataUrl) },
    ) {
        LifecycleValue("الأصل", "${detail.summary.name} — ${detail.summary.code}")
        OutlinedTextField(title, { title = it.take(255) }, Modifier.fillMaxWidth(), label = { Text("عنوان المستند *") }, singleLine = true)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        camera.launch(null)
                    } else {
                        permission.launch(Manifest.permission.CAMERA)
                    }
                },
                modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                enabled = !processing,
            ) {
                Icon(Icons.Rounded.CameraAlt, null)
                Spacer(Modifier.width(5.dp))
                Text("الكاميرا")
            }
            OutlinedButton(
                onClick = { picker.launch("image/*") },
                modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                enabled = !processing,
            ) {
                Icon(Icons.Rounded.UploadFile, null)
                Spacer(Modifier.width(5.dp))
                Text("اختيار صورة")
            }
        }
        if (processing) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        sourceLabel.takeIf(String::isNotBlank)?.let { Text(it, color = EmeraldDark, fontWeight = FontWeight.Bold) }
        Text("PNG/JPG/WEBP، وبحجم أقصى 2.5 MB قبل الترميز.", color = MutedInk)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun AssetDepreciationDialog(viewModel: OperationsViewModel) {
    val current = remember { YearMonth.now() }
    var period by rememberSaveable { mutableStateOf(current.toString()) }
    var confirmation by rememberSaveable { mutableStateOf("") }
    val parsed = runCatching { YearMonth.parse(period) }.getOrNull()
    val valid = parsed != null && !parsed.isAfter(current) && confirmation == "ترحيل"
    LifecycleDialog(
        title = "ترحيل الإهلاك الشهري",
        onDismiss = viewModel::closeAssetOverlay,
        confirmLabel = "مراجعة الترحيل",
        confirmEnabled = valid,
        onConfirm = { parsed?.let { viewModel.requestPostDepreciation(it.year, it.monthValue) } },
    ) {
        OutlinedTextField(period, { period = it.take(7) }, Modifier.fillMaxWidth(), label = { Text("الفترة *") }, placeholder = { Text("YYYY-MM") }, singleLine = true)
        Text("الإجراء idempotent: إعادة الفترة نفسها لا تكرر القيد. لا يمكن ترحيل شهر مستقبلي.", color = MutedInk)
        Text("اكتب «ترحيل» للتأكيد", color = Orange, fontWeight = FontWeight.Bold)
        OutlinedTextField(confirmation, { confirmation = it.take(10) }, Modifier.fillMaxWidth(), label = { Text("كلمة التأكيد") }, singleLine = true)
        if (parsed?.isAfter(current) == true) Text("لا يمكن ترحيل شهر مستقبلي", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun LifecycleDialog(
    title: String,
    onDismiss: () -> Unit,
    confirmLabel: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    destructive: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Surface(
            Modifier.fillMaxWidth(.96f).fillMaxHeight(.95f).widthIn(max = 820.dp),
            color = Color.White,
            shape = RoundedCornerShape(30.dp),
        ) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
                Row(
                    Modifier.fillMaxWidth().background(EmeraldDark).padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onDismiss) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "رجوع", tint = Color.White) }
                    Text(
                        title,
                        modifier = Modifier.weight(1f).semantics { heading() },
                        color = Color.White,
                        style = MaterialTheme.typography.titleLarge,
                    )
                    IconButton(onDismiss) { Icon(Icons.Rounded.Close, "إغلاق", tint = Color.White) }
                }
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    content = content,
                )
                HorizontalDivider(color = Stroke)
                Row(
                    Modifier.fillMaxWidth().padding(14.dp),
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    OutlinedButton(onDismiss, Modifier.weight(1f).heightIn(min = 52.dp)) { Text("رجوع") }
                    Button(
                        onClick = onConfirm,
                        enabled = confirmEnabled,
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                        colors = if (destructive) {
                            ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                        } else {
                            ButtonDefaults.buttonColors()
                        },
                    ) { Text(confirmLabel, textAlign = TextAlign.Center) }
                }
            }
        }
    }
}

@Composable
private fun OptionDropdown(
    label: String,
    selectedId: Long?,
    options: List<AssetFormOption>,
    allowNone: Boolean = false,
    enabled: Boolean = true,
    onSelected: (Long?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = options.firstOrNull { it.id == selectedId }
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MutedInk)
        Box(Modifier.fillMaxWidth()) {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                enabled = enabled,
            ) {
                Text(
                    selected?.let { listOfNotNull(it.name, it.subtitle).joinToString(" — ") }
                        ?: if (allowNone) "— بلا اختيار —" else "— اختر —",
                    Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Start,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                if (allowNone) {
                    DropdownMenuItem(text = { Text("— بلا اختيار —") }, onClick = { expanded = false; onSelected(null) })
                }
                options.forEach { option ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(option.name)
                                option.subtitle?.let { Text(it, color = MutedInk, style = MaterialTheme.typography.bodySmall) }
                            }
                        },
                        onClick = { expanded = false; onSelected(option.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LifecycleInfoCard(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Canvas), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(icon, null, tint = Emerald)
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            }
            content()
        }
    }
}

@Composable
private fun LifecycleValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, Modifier.weight(.44f), color = MutedInk, style = MaterialTheme.typography.bodyMedium)
        Text(value, Modifier.weight(.56f), fontWeight = FontWeight.Bold, textAlign = TextAlign.End, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun decimalInput(raw: String): String = buildString {
    var dot = false
    var decimals = 0
    raw.forEach { char ->
        when {
            char.isDigit() && (!dot || decimals < 2) -> {
                append(char)
                if (dot) decimals++
            }
            char == '.' && !dot -> {
                append(char)
                dot = true
            }
        }
    }
}.take(18)

private fun annualDepreciation(input: AssetUpsertInput): String {
    val cost = input.purchaseValue.toBigDecimalOrNull() ?: return "0"
    val salvage = input.salvageValue.toBigDecimalOrNull() ?: BigDecimal.ZERO
    if (cost <= BigDecimal.ZERO || input.usefulLifeYears <= 0) return "0"
    val base = (cost - salvage).coerceAtLeast(BigDecimal.ZERO)
    val annual = when (input.depreciationMethod) {
        DepreciationMethod.StraightLine -> base.divide(input.usefulLifeYears.toBigDecimal(), 2, RoundingMode.HALF_UP)
        DepreciationMethod.DecliningBalance -> cost.multiply(BigDecimal(2)).divide(input.usefulLifeYears.toBigDecimal(), 2, RoundingMode.HALF_UP).min(base)
    }
    return annual.stripTrailingZeros().toPlainString()
}

private fun assetMoney(value: String): String = "${value.toBigDecimalOrNull()?.setScale(0, RoundingMode.HALF_UP)?.toPlainString() ?: value} د.ع"

package online.alarabiya.superapp.feature.hradmin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Badge
import androidx.compose.material.icons.rounded.BusinessCenter
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Payments
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.model.hradmin.ApplicantStage
import online.alarabiya.superapp.model.hradmin.EmploymentStatus
import online.alarabiya.superapp.model.hradmin.HrAdminCapabilities
import online.alarabiya.superapp.model.hradmin.HrAdminSection
import online.alarabiya.superapp.model.hradmin.HrAdminPolicies
import online.alarabiya.superapp.model.hradmin.HrEmployee
import online.alarabiya.superapp.model.hradmin.JobApplicant
import online.alarabiya.superapp.model.hradmin.JobVacancy
import online.alarabiya.superapp.model.hradmin.LeaveRequest
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollRun
import online.alarabiya.superapp.model.hradmin.PayrollRunDetail
import online.alarabiya.superapp.model.hradmin.PayrollStatus

private val HrInk = Color(0xFF362087)
private val HrTeal = Color(0xFF5B36D2)
private val HrMint = Color(0xFFF0ECFF)

@Composable
fun HrAdminRoute(
    viewModel: HrAdminViewModel,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    HrAdminScreen(
        state = viewModel.state,
        capabilities = viewModel.capabilities,
        actions = HrAdminActions(
            section = viewModel::section,
            employeeQuery = viewModel::employeeQuery,
            employeeSearch = viewModel::searchEmployees,
            employeeMore = viewModel::moreEmployees,
            includeInactive = viewModel::includeInactiveEmployees,
            selectEmployee = viewModel::selectEmployee,
            employeeStatus = viewModel::setEmployeeStatus,
            terminateEmployee = viewModel::terminateEmployee,
            payrollPeriod = viewModel::payrollPeriod,
            generatePayroll = viewModel::generatePayroll,
            selectPayroll = viewModel::selectPayroll,
            approvePayroll = viewModel::approvePayroll,
            payPayroll = viewModel::payPayroll,
            cancelPayroll = viewModel::cancelPayroll,
            leaveFilter = viewModel::leaveFilter,
            decideLeave = viewModel::decideLeave,
            applicantFilter = viewModel::applicantFilter,
            applicantStage = viewModel::setApplicantStage,
            vacancyPublished = viewModel::setVacancyPublished,
            clearMessage = viewModel::clearMessage,
        ),
        modifier = modifier,
    )
}

data class HrAdminActions(
    val section: (HrAdminSection) -> Unit,
    val employeeQuery: (String) -> Unit,
    val employeeSearch: () -> Unit,
    val employeeMore: () -> Unit,
    val includeInactive: (Boolean) -> Unit,
    val selectEmployee: (Long?) -> Unit,
    val employeeStatus: (EmploymentStatus) -> Unit,
    val terminateEmployee: (String, String) -> Unit,
    val payrollPeriod: (String) -> Unit,
    val generatePayroll: () -> Unit,
    val selectPayroll: (Long?) -> Unit,
    val approvePayroll: () -> Unit,
    val payPayroll: () -> Unit,
    val cancelPayroll: () -> Unit,
    val leaveFilter: (LeaveStatus?) -> Unit,
    val decideLeave: (LeaveRequest, LeaveStatus) -> Unit,
    val applicantFilter: (ApplicantStage?) -> Unit,
    val applicantStage: (JobApplicant, ApplicantStage) -> Unit,
    val vacancyPublished: (JobVacancy, Boolean) -> Unit,
    val clearMessage: () -> Unit,
)

private data class Confirmation(val title: String, val body: String, val action: () -> Unit)

@Composable
fun HrAdminScreen(
    state: HrAdminUiState,
    capabilities: HrAdminCapabilities,
    actions: HrAdminActions,
    modifier: Modifier = Modifier,
) {
    var confirmation by remember { mutableStateOf<Confirmation?>(null) }
    val sections = buildList {
        if (capabilities.canReadEmployees) add(HrAdminSection.EMPLOYEES)
        if (capabilities.canReadCompanyHr) {
            add(HrAdminSection.PAYROLL)
            add(HrAdminSection.LEAVES)
            add(HrAdminSection.RECRUITMENT)
        }
    }
    Scaffold(modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.surface) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            HrHeader(capabilities)
            if (sections.size > 1) {
                TabRow(selectedTabIndex = sections.indexOf(state.section).coerceAtLeast(0)) {
                    sections.forEach { section ->
                        Tab(
                            selected = state.section == section,
                            onClick = { actions.section(section) },
                            enabled = !state.locked,
                            text = { Text(section.label()) },
                            icon = { Icon(section.icon(), null) },
                        )
                    }
                }
            }
            state.error?.let { Feedback(it, true, actions.clearMessage) }
            state.notice?.let { Feedback(it, false, actions.clearMessage) }
            if (state.busy == HrAdminBusy.INITIAL) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else if (sections.isEmpty()) {
                EmptyState("لا توجد صلاحية موارد بشرية ضمن هذه الجلسة")
            } else {
                when (state.section) {
                    HrAdminSection.EMPLOYEES -> EmployeeWorkspace(state, capabilities, actions)
                    HrAdminSection.PAYROLL -> PayrollWorkspace(state, capabilities, actions) { confirmation = it }
                    HrAdminSection.LEAVES -> LeaveWorkspace(state, capabilities, actions) { confirmation = it }
                    HrAdminSection.RECRUITMENT -> RecruitmentWorkspace(state, capabilities, actions) { confirmation = it }
                }
            }
        }
    }
    confirmation?.let { request ->
        AlertDialog(
            onDismissRequest = { if (!state.locked) confirmation = null },
            title = { Text(request.title, fontWeight = FontWeight.Bold) },
            text = { Text(request.body) },
            confirmButton = {
                Button(onClick = { confirmation = null; request.action() }) { Text("تأكيد") }
            },
            dismissButton = {
                OutlinedButton(onClick = { confirmation = null }) { Text("رجوع") }
            },
        )
    }
}

@Composable
private fun HrHeader(capabilities: HrAdminCapabilities) {
    Box(
        Modifier.fillMaxWidth()
            .background(
                Brush.horizontalGradient(listOf(HrInk, HrTeal)),
                RoundedCornerShape(bottomStart = 44.dp, bottomEnd = 16.dp),
            )
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        Box(
            Modifier.size(116.dp).align(Alignment.TopStart)
                .background(Color.White.copy(alpha = .06f), CircleShape),
        )
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("الموارد البشرية", color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
                Text(
                    if (capabilities.canReadCompanyHr) "إدارة القوى العاملة على مستوى الشركة" else "فريق الفرع والصلاحيات التشغيلية",
                    color = Color.White.copy(alpha = .76f),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Surface(color = Color.White.copy(alpha = .13f), shape = RoundedCornerShape(22.dp, 22.dp, 8.dp, 22.dp)) {
                Icon(Icons.Rounded.Badge, null, tint = Color.White, modifier = Modifier.padding(13.dp).size(28.dp))
            }
        }
    }
}

@Composable
private fun EmployeeWorkspace(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) {
            Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                EmployeeList(state, actions, Modifier.weight(.95f).fillMaxHeight())
                EmployeeDetail(state.selectedEmployee, capabilities, state.locked, actions, Modifier.weight(1.05f).fillMaxHeight())
            }
        } else if (state.selectedEmployee != null) {
            EmployeeDetail(state.selectedEmployee, capabilities, state.locked, actions, Modifier.fillMaxSize(), true)
        } else {
            EmployeeList(state, actions, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun EmployeeList(state: HrAdminUiState, actions: HrAdminActions, modifier: Modifier) {
    HrCard(modifier) {
        SectionTitle("فريق الفرع", "${state.employees.total} موظفاً", Icons.Rounded.Groups)
        OutlinedTextField(
            value = state.employeeQuery,
            onValueChange = actions.employeeQuery,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("اسم، هاتف، رقم وطني أو وظيفة") },
            leadingIcon = { Icon(Icons.Rounded.Search, null) },
            trailingIcon = { IconButton(actions.employeeSearch, enabled = !state.locked) { Icon(Icons.Rounded.Search, "بحث") } },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { actions.employeeSearch() }),
            enabled = !state.locked,
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
        )
        Row(Modifier.fillMaxWidth(), Arrangement.End, Alignment.CenterVertically) {
            Text("إظهار غير النشطين", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.width(8.dp))
            Switch(state.includeInactiveEmployees, actions.includeInactive, enabled = !state.locked)
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.employees.rows, key = { it.id }) { employee ->
                EmployeeRow(employee, state.locked) { actions.selectEmployee(employee.id) }
            }
            if (state.employees.rows.size < state.employees.total) {
                item { OutlinedButton(actions.employeeMore, Modifier.fillMaxWidth(), enabled = !state.locked) { Text("تحميل المزيد") } }
            }
        }
    }
}

@Composable
private fun EmployeeRow(employee: HrEmployee, locked: Boolean, select: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 10.dp, bottomStart = 10.dp, bottomEnd = 24.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(enabled = !locked, role = Role.Button, onClick = select)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).background(HrMint, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Person, null, tint = HrTeal)
        }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(employee.fullName, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(employee.position, employee.department).joinToString(" • ").ifBlank { "بلا مسمى وظيفي" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StatusPill(employee.employmentStatus.label(), employee.employmentStatus == EmploymentStatus.ACTIVE)
    }
}

@Composable
private fun EmployeeDetail(
    employee: HrEmployee?,
    capabilities: HrAdminCapabilities,
    locked: Boolean,
    actions: HrAdminActions,
    modifier: Modifier,
    back: Boolean = false,
) {
    var showTermination by remember(employee?.id) { mutableStateOf(false) }
    var terminationDate by remember(employee?.id) { mutableStateOf("") }
    var terminationReason by remember(employee?.id) { mutableStateOf("") }
    HrCard(modifier) {
        if (employee == null) {
            EmptyState("اختر موظفاً لعرض بطاقته")
            return@HrCard
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (back) IconButton({ actions.selectEmployee(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
            Column(Modifier.weight(1f)) {
                Text(employee.fullName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                Text(listOfNotNull(employee.position, employee.department).joinToString(" • "), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            StatusPill(employee.employmentStatus.label(), employee.employmentStatus == EmploymentStatus.ACTIVE)
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            item { DetailStrip("الفرع", employee.branchName ?: "#${employee.branchId}") }
            item { DetailStrip("التواصل", listOfNotNull(employee.phone, employee.email).joinToString(" • ").ifBlank { "غير مسجل" }) }
            item { DetailStrip("بدء العمل", employee.hireDate ?: "غير مسجل") }
            item { DetailStrip("الحضور", when { employee.attendanceExempt -> "معفى بقرار صريح"; employee.deviceLinked -> "مرتبط بجهاز البصمة"; else -> "غير مرتبط بجهاز البصمة" }) }
            item { DetailStrip("رصيد الإجازات", "سنوية ${employee.annualLeaveBalance} • مرضية ${employee.sickLeaveBalance}") }
            item { DetailStrip("نمط الأجر", if (employee.payType == "hourly") "بالساعة" else "شهري") }
            item { DetailStrip("الراتب والبدلات", "${employee.salary ?: "0"} + ${employee.allowances ?: "0"} د.ع") }
        }
        if (capabilities.canManageEmployees) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { actions.employeeStatus(EmploymentStatus.LEAVE) },
                    modifier = Modifier.weight(1f),
                    enabled = !locked && employee.employmentStatus != EmploymentStatus.LEAVE,
                ) { Text("في إجازة") }
                Button(
                    onClick = { actions.employeeStatus(EmploymentStatus.ACTIVE) },
                    modifier = Modifier.weight(1f),
                    enabled = !locked && employee.employmentStatus != EmploymentStatus.ACTIVE,
                ) { Text("إعادة للنشاط") }
            }
            if (employee.employmentStatus != EmploymentStatus.TERMINATED) {
                OutlinedButton(
                    onClick = { showTermination = true },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !locked && capabilities.canTerminate(employee),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text("إنهاء الخدمة") }
                Text(
                    if (employee.userId == capabilities.currentUserId) {
                        "لا يمكن إنهاء سجلّك الشخصي من جلستك الحالية"
                    } else {
                        "يتطلب تاريخاً وسبباً؛ يعطّل الخادم الحساب المرتبط ويحرّر ربط جهاز البصمة"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    if (showTermination && employee != null) {
        val issue = HrAdminPolicies.terminationIssue(terminationDate, terminationReason)
        AlertDialog(
            onDismissRequest = { if (!locked) showTermination = false },
            title = { Text("إنهاء خدمة ${employee.fullName}", fontWeight = FontWeight.ExtraBold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "إجراء نهائي يعطّل حساب النظام المرتبط ويحرّر ربط جهاز البصمة. يمنع الخادم إنهاء سجلّك الشخصي وآخر مدير نشط.",
                        color = MaterialTheme.colorScheme.error,
                    )
                    OutlinedTextField(
                        value = terminationDate,
                        onValueChange = { terminationDate = it.filter { char -> char.isDigit() || char == '-' }.take(10) },
                        label = { Text("تاريخ إنهاء الخدمة YYYY-MM-DD") },
                        singleLine = true,
                        enabled = !locked,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = terminationReason,
                        onValueChange = { terminationReason = it.take(500) },
                        label = { Text("سبب إنهاء الخدمة") },
                        minLines = 3,
                        enabled = !locked,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if ((terminationDate.isNotBlank() || terminationReason.isNotBlank()) && issue != null) {
                        Text(issue.userMessage, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        showTermination = false
                        actions.terminateEmployee(terminationDate, terminationReason)
                    },
                    enabled = !locked && issue == null,
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("تأكيد إنهاء الخدمة") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showTermination = false }, enabled = !locked) { Text("رجوع") }
            },
        )
    }
}

@Composable
private fun PayrollWorkspace(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions, confirm: (Confirmation) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            PayrollList(state, capabilities.canManageCompanyHr, actions, confirm, Modifier.weight(.8f).fillMaxHeight())
            PayrollDetail(state.payrollDetail, capabilities, state.locked, actions, confirm, Modifier.weight(1.2f).fillMaxHeight())
        } else if (state.payrollDetail != null) {
            PayrollDetail(state.payrollDetail, capabilities, state.locked, actions, confirm, Modifier.fillMaxSize(), true)
        } else PayrollList(state, capabilities.canManageCompanyHr, actions, confirm, Modifier.fillMaxSize())
    }
}

@Composable
private fun PayrollList(state: HrAdminUiState, canManage: Boolean, actions: HrAdminActions, confirm: (Confirmation) -> Unit, modifier: Modifier) {
    HrCard(modifier) {
        SectionTitle("دورات الرواتب", "عرض شركة كامل ومحكوم بدور المدير العام", Icons.Rounded.Payments)
        if (canManage) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = state.payrollPeriod,
                    onValueChange = actions.payrollPeriod,
                    modifier = Modifier.weight(1f),
                    label = { Text("YYYY-MM") },
                    singleLine = true,
                    enabled = !state.locked,
                    shape = RoundedCornerShape(16.dp),
                )
                Button(
                    onClick = { confirm(Confirmation("إنشاء مسيّر الرواتب", "سيحسب الخادم الأجور والحضور والإجازات والسلف للشهر ${state.payrollPeriod}.", actions.generatePayroll)) },
                    enabled = !state.locked && state.payrollPeriod.length == 7,
                ) { Text("إنشاء") }
            }
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(state.payrollRuns, key = { it.id }) { run ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp, 10.dp, 22.dp, 10.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .clickable(enabled = !state.locked, role = Role.Button) { actions.selectPayroll(run.id) }
                        .padding(14.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                        Text(run.period, fontWeight = FontWeight.ExtraBold)
                        StatusPill(run.status.label(), run.status == PayrollStatus.PAID)
                    }
                    Text("${run.employeeCount} موظف • صافي ${run.totalNet} د.ع", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun PayrollDetail(
    detail: PayrollRunDetail?,
    capabilities: HrAdminCapabilities,
    locked: Boolean,
    actions: HrAdminActions,
    confirm: (Confirmation) -> Unit,
    modifier: Modifier,
    back: Boolean = false,
) {
    HrCard(modifier) {
        if (detail == null) { EmptyState("اختر دورة رواتب لعرض تفاصيلها"); return@HrCard }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (back) IconButton({ actions.selectPayroll(null) }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "عودة") }
            Column(Modifier.weight(1f)) {
                Text("مسيّر ${detail.run.period}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                Text("${detail.run.employeeCount} موظف", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            StatusPill(detail.run.status.label(), detail.run.status == PayrollStatus.PAID)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MoneyTile("الإجمالي", detail.run.totalGross, Modifier.weight(1f))
            MoneyTile("الاستقطاع", detail.run.totalDeductions, Modifier.weight(1f))
            MoneyTile("الصافي", detail.run.totalNet, Modifier.weight(1f), true)
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            items(detail.items, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(15.dp)).padding(11.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(item.employeeName, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(item.position, item.department).joinToString(" • "), style = MaterialTheme.typography.bodySmall)
                    }
                    Column(horizontalAlignment = Alignment.End) { Text("${item.net} د.ع", color = HrTeal, fontWeight = FontWeight.Bold); Text("خصم ${item.deductions}", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        if (capabilities.canManageCompanyHr) {
            when (detail.run.status) {
                PayrollStatus.DRAFT -> Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        { confirm(Confirmation("إلغاء المسودة", "سيحذف الخادم المسودة وبنودها إذا لم تُعتمد.", actions.cancelPayroll)) },
                        Modifier.weight(1f), enabled = !locked,
                    ) { Text("إلغاء") }
                    Button(
                        { confirm(Confirmation("اعتماد المسيّر", "سيطبّق الخادم فصل المهام ويتحقق من الإجماليات قبل الاعتماد.", actions.approvePayroll)) },
                        Modifier.weight(1f), enabled = !locked,
                    ) { Text("اعتماد") }
                }
                PayrollStatus.APPROVED -> Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        { confirm(Confirmation("إعادة إلى مسودة", "سيُلغى الاعتماد دون إنشاء قيد دفع.", actions.cancelPayroll)) },
                        Modifier.weight(1f), enabled = !locked,
                    ) { Text("تراجع") }
                    Button(
                        { confirm(Confirmation("صرف الرواتب", "سيُنشئ الخادم إيصالات الخزينة والقيود المالية. لا تغلق التطبيق أثناء الطلب.", actions.payPayroll)) },
                        Modifier.weight(1f), enabled = !locked,
                    ) { Text("صرف") }
                }
                PayrollStatus.PAID -> Text("تم الصرف. أي عكس يتطلب إثبات عودة النقد عبر مسار الخزينة.", color = HrTeal, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun LeaveWorkspace(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions, confirm: (Confirmation) -> Unit) {
    HrCard(Modifier.fillMaxSize().padding(14.dp)) {
        SectionTitle("طلبات الإجازة", "قرار إداري يولّد إشعاراً للموظف", Icons.Rounded.CalendarMonth)
        val counts = state.leaves?.counts
        Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
            MetricTile("معلّق", counts?.pending ?: 0, Modifier.weight(1f))
            MetricTile("معتمد", counts?.approved ?: 0, Modifier.weight(1f))
            MetricTile("أيام الشهر", counts?.monthDays ?: 0, Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            FilterChip(state.leaveFilter == null, { actions.leaveFilter(null) }, label = { Text("الكل") }, enabled = !state.locked)
            LeaveStatus.entries.forEach { status -> FilterChip(state.leaveFilter == status, { actions.leaveFilter(status) }, label = { Text(status.label()) }, enabled = !state.locked) }
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(state.leaves?.rows.orEmpty(), key = { it.id }) { request ->
                LeaveCard(request, capabilities.canManageCompanyHr, state.locked, confirm, actions)
            }
        }
    }
}

@Composable
private fun LeaveCard(request: LeaveRequest, canManage: Boolean, locked: Boolean, confirm: (Confirmation) -> Unit, actions: HrAdminActions) {
    Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(24.dp, 10.dp, 24.dp, 10.dp)).padding(13.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) { Text(request.employeeName, fontWeight = FontWeight.ExtraBold); StatusPill(request.status.label(), request.status == LeaveStatus.APPROVED) }
        Text("${request.leaveType} • ${request.fromDate} — ${request.toDate} • ${request.days} يوم", color = MaterialTheme.colorScheme.onSurfaceVariant)
        request.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        if (canManage && request.status == LeaveStatus.PENDING) {
            Spacer(Modifier.height(7.dp))
            Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    { confirm(Confirmation("رفض الإجازة", "سيُحفظ القرار ويرسل إشعاراً للموظف.") { actions.decideLeave(request, LeaveStatus.REJECTED) }) },
                    Modifier.weight(1f), enabled = !locked,
                ) { Text("رفض") }
                Button(
                    { confirm(Confirmation("اعتماد الإجازة", "سيتحقق الخادم من التداخل والمسيّر المقفل والرصيد قبل التنفيذ.") { actions.decideLeave(request, LeaveStatus.APPROVED) }) },
                    Modifier.weight(1f), enabled = !locked,
                ) { Text("اعتماد") }
            }
        }
    }
}

@Composable
private fun RecruitmentWorkspace(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions, confirm: (Confirmation) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        val wide = maxWidth >= 760.dp
        if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ApplicantsPanel(state, capabilities, actions, confirm, Modifier.weight(1.1f).fillMaxHeight())
            VacanciesPanel(state, capabilities, actions, confirm, Modifier.weight(.9f).fillMaxHeight())
        } else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item { ApplicantsPanel(state, capabilities, actions, confirm, Modifier.fillMaxWidth().height(560.dp)) }
            item { VacanciesPanel(state, capabilities, actions, confirm, Modifier.fillMaxWidth().height(460.dp)) }
        }
    }
}

@Composable
private fun ApplicantsPanel(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions, confirm: (Confirmation) -> Unit, modifier: Modifier) {
    HrCard(modifier) {
        SectionTitle("مسار المرشحين", "${state.applicants.size} سجلاً مطابقاً", Icons.Rounded.BusinessCenter)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            FilterChip(state.applicantFilter == null, { actions.applicantFilter(null) }, label = { Text("الكل") }, enabled = !state.locked)
            ApplicantStage.entries.forEach { stage -> FilterChip(state.applicantFilter == stage, { actions.applicantFilter(stage) }, label = { Text(stage.label()) }, enabled = !state.locked) }
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.applicants, key = { it.id }) { applicant ->
                ApplicantCard(applicant, capabilities.canManageCompanyHr, state.locked, actions, confirm)
            }
        }
    }
}

@Composable
private fun ApplicantCard(applicant: JobApplicant, canManage: Boolean, locked: Boolean, actions: HrAdminActions, confirm: (Confirmation) -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(20.dp, 9.dp, 20.dp, 9.dp)).padding(12.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) { Text(applicant.name, fontWeight = FontWeight.Bold); StatusPill(applicant.stage.label(), applicant.stage == ApplicantStage.ACCEPTED) }
        Text(listOfNotNull(applicant.jobTitle, applicant.appliedDate, "★ ${applicant.rating}").joinToString(" • "), style = MaterialTheme.typography.bodySmall)
        if (canManage) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ApplicantStage.entries.filterNot { it == applicant.stage }.forEach { stage ->
                    FilterChip(
                        selected = false,
                        onClick = { confirm(Confirmation("نقل المرشح", "نقل ${applicant.name} إلى مرحلة ${stage.label()}؟") { actions.applicantStage(applicant, stage) }) },
                        label = { Text(stage.label()) },
                        enabled = !locked,
                    )
                }
            }
        }
    }
}

@Composable
private fun VacanciesPanel(state: HrAdminUiState, capabilities: HrAdminCapabilities, actions: HrAdminActions, confirm: (Confirmation) -> Unit, modifier: Modifier) {
    HrCard(modifier) {
        SectionTitle("الوظائف الشاغرة", "النشر يحدّث معرض التقديم العام", Icons.Rounded.Groups)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.vacancies, key = { it.id }) { vacancy ->
                Row(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(18.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(vacancy.title, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(vacancy.department, vacancy.location, "${vacancy.openings} شاغر").joinToString(" • "), style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(
                        checked = vacancy.isPublished,
                        onCheckedChange = { published ->
                            confirm(Confirmation(if (published) "نشر الوظيفة" else "إخفاء الوظيفة", "سيُحدّث معرض التقديم العام فوراً.") { actions.vacancyPublished(vacancy, published) })
                        },
                        enabled = capabilities.canManageCompanyHr && !state.locked,
                    )
                }
            }
        }
    }
}

@Composable
private fun HrCard(modifier: Modifier, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Card(
        modifier,
        shape = RoundedCornerShape(topStart = 30.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 30.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) { Column(Modifier.fillMaxSize().padding(15.dp), verticalArrangement = Arrangement.spacedBy(11.dp), content = content) }
}

@Composable
private fun SectionTitle(title: String, subtitle: String, icon: ImageVector) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(46.dp).background(HrMint, RoundedCornerShape(18.dp, 18.dp, 7.dp, 18.dp)), contentAlignment = Alignment.Center) { Icon(icon, null, tint = HrTeal) }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) { Text(title, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleMedium); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun DetailStrip(label: String, value: String) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp)).padding(11.dp), Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MoneyTile(label: String, value: String, modifier: Modifier, emphasized: Boolean = false) {
    Column(modifier.background(if (emphasized) HrMint else MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(18.dp, 8.dp, 18.dp, 8.dp)).padding(10.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.ExtraBold, color = if (emphasized) HrTeal else MaterialTheme.colorScheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MetricTile(label: String, value: Int, modifier: Modifier) {
    Column(modifier.background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp)).padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value.toString(), fontWeight = FontWeight.ExtraBold, color = HrTeal)
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun StatusPill(label: String, positive: Boolean) {
    Text(
        label,
        modifier = Modifier.background(if (positive) HrMint else MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 5.dp),
        color = if (positive) HrTeal else MaterialTheme.colorScheme.onSecondaryContainer,
        style = MaterialTheme.typography.bodySmall,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun Feedback(text: String, error: Boolean, close: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp),
        color = if (error) MaterialTheme.colorScheme.errorContainer else HrMint,
        shape = RoundedCornerShape(16.dp, 6.dp, 16.dp, 6.dp),
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Rounded.Close else Icons.Rounded.CheckCircle, null, tint = if (error) MaterialTheme.colorScheme.error else HrTeal)
            Spacer(Modifier.width(8.dp))
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            IconButton(close) { Icon(Icons.Rounded.Close, "إغلاق") }
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Rounded.Badge, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline)
            Spacer(Modifier.height(8.dp))
            Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun HrAdminSection.label() = when (this) {
    HrAdminSection.EMPLOYEES -> "الموظفون"
    HrAdminSection.PAYROLL -> "الرواتب"
    HrAdminSection.LEAVES -> "الإجازات"
    HrAdminSection.RECRUITMENT -> "التوظيف"
}

private fun HrAdminSection.icon(): ImageVector = when (this) {
    HrAdminSection.EMPLOYEES -> Icons.Rounded.Groups
    HrAdminSection.PAYROLL -> Icons.Rounded.Payments
    HrAdminSection.LEAVES -> Icons.Rounded.CalendarMonth
    HrAdminSection.RECRUITMENT -> Icons.Rounded.BusinessCenter
}

private fun EmploymentStatus.label() = when (this) {
    EmploymentStatus.ACTIVE -> "نشط"
    EmploymentStatus.LEAVE -> "في إجازة"
    EmploymentStatus.TERMINATED -> "منتهية خدمته"
}

private fun PayrollStatus.label() = when (this) {
    PayrollStatus.DRAFT -> "مسودة"
    PayrollStatus.APPROVED -> "معتمد"
    PayrollStatus.PAID -> "مدفوع"
}

private fun LeaveStatus.label() = when (this) {
    LeaveStatus.PENDING -> "معلّق"
    LeaveStatus.APPROVED -> "معتمد"
    LeaveStatus.REJECTED -> "مرفوض"
}

private fun ApplicantStage.label() = when (this) {
    ApplicantStage.NEW -> "جديد"
    ApplicantStage.REVIEW -> "مراجعة"
    ApplicantStage.INTERVIEW -> "مقابلة"
    ApplicantStage.ACCEPTED -> "مقبول"
    ApplicantStage.REJECTED -> "مرفوض"
    ApplicantStage.ARCHIVED -> "مؤرشف"
}

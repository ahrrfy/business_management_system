package online.alarabiya.superapp.feature.crm

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import online.alarabiya.superapp.ui.ArabicDatePicker
import online.alarabiya.superapp.model.crm.BranchOption
import online.alarabiya.superapp.model.crm.CampaignDraft
import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CampaignSummary
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CrmDashboard

@Composable
internal fun CampaignsWorkspace(state: CrmUiState, capabilities: CrmCapabilities, actions: CrmActions) {
    if (!state.campaignsLoaded) {
        CrmRetryGate(
            title = if (state.campaignCreateOutcomeUnknown || state.campaignMutationOutcomeUnknown) {
                "بيانات الحملات تحتاج تحديثاً"
            } else {
                "الحملات غير متاحة"
            },
            retryEnabled = !state.initializing && state.busyKey == null,
            onRetry = actions.refresh,
        )
        return
    }
    if (state.campaignEditor != null) {
        CampaignEditorPane(state.campaignEditor, state.branches, capabilities, !state.canCreateCampaign, actions)
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        state.dashboard?.let { dashboard -> item { CampaignDashboardCards(dashboard) } }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("الحملات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("دورة اعتماد وتشغيل مرتبطة بصلاحية الحساب", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (capabilities.campaigns.canWrite) {
                    IconButton(onClick = actions.beginCreateCampaign, enabled = state.canCreateCampaign) {
                        Icon(Icons.Rounded.Add, contentDescription = "حملة جديدة")
                    }
                }
            }
        }
        if (state.campaigns.isEmpty()) item { EmptyCrmState("لا توجد حملات متاحة") }
        items(state.campaigns, key = { it.id }) { campaign ->
            CampaignCard(
                campaign = campaign,
                canWrite = capabilities.campaigns.canWrite,
                enabled = state.canMutateCampaign,
                onTransition = { actions.transitionCampaign(campaign, it) },
            )
        }
    }
}

@Composable
private fun CampaignDashboardCards(dashboard: CrmDashboard) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth >= 700.dp) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CampaignMetric("الحملات", "${dashboard.campaignsActive}/${dashboard.campaignsTotal}", Modifier.weight(1f))
                CampaignMetric("برامج الكوبون", "${dashboard.programsActive}/${dashboard.programsTotal}", Modifier.weight(1f))
                CampaignMetric("الاستخدامات", dashboard.redemptionsTotal.toString(), Modifier.weight(1f))
                CampaignMetric("قيمة الخصم", dashboard.redemptionDiscount, Modifier.weight(1f))
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CampaignMetric("الحملات", "${dashboard.campaignsActive}/${dashboard.campaignsTotal}", Modifier.weight(1f))
                    CampaignMetric("برامج الكوبون", "${dashboard.programsActive}/${dashboard.programsTotal}", Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CampaignMetric("الاستخدامات", dashboard.redemptionsTotal.toString(), Modifier.weight(1f))
                    CampaignMetric("قيمة الخصم", dashboard.redemptionDiscount, Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CampaignMetric(label: String, value: String, modifier: Modifier = Modifier) {
    androidx.compose.material3.Card(modifier = modifier) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun CampaignCard(
    campaign: CampaignSummary,
    canWrite: Boolean,
    enabled: Boolean,
    onTransition: (CampaignStatus) -> Unit,
) {
    CrmCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(campaign.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            CrmStatus(campaign.status.label)
        }
        campaign.objective?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(
            listOfNotNull(campaign.startsOn, campaign.endsOn).joinToString(" — ").ifBlank { "بلا مدة محددة" },
            style = MaterialTheme.typography.bodySmall,
        )
        if (canWrite && campaign.allowedTransitions().isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(campaign.allowedTransitions(), key = { it.name }) { status ->
                    Button(onClick = { onTransition(status) }, enabled = enabled) { Text(status.label) }
                }
            }
        }
    }
}

@Composable
private fun CampaignEditorPane(
    draft: CampaignDraft,
    branches: List<BranchOption>,
    capabilities: CrmCapabilities,
    busy: Boolean,
    actions: CrmActions,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = actions.closeCampaignEditor, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "إغلاق")
                }
                Text("حملة جديدة", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Box(Modifier.padding(24.dp))
            }
        }
        item {
            CrmCard {
                CampaignField(draft.name, { actions.updateCampaignDraft(draft.copy(name = it)) }, "اسم الحملة *")
                CampaignField(
                    draft.objective,
                    { actions.updateCampaignDraft(draft.copy(objective = it)) },
                    "الهدف",
                    singleLine = false,
                )
                if (capabilities.branchId != null) {
                    Text("الفرع", style = MaterialTheme.typography.labelLarge)
                    Text(branches.firstOrNull { it.id == capabilities.branchId }?.name ?: "فرع الحساب")
                } else if (branches.isNotEmpty()) {
                    Text("الفرع", style = MaterialTheme.typography.labelLarge)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (capabilities.allBranches) {
                            item {
                                FilterChip(
                                    selected = draft.branchId == null,
                                    onClick = { actions.updateCampaignDraft(draft.copy(branchId = null)) },
                                    label = { Text("كل الفروع") },
                                )
                            }
                        }
                        items(branches, key = { it.id }) { branch ->
                            FilterChip(
                                selected = draft.branchId == branch.id,
                                onClick = { actions.updateCampaignDraft(draft.copy(branchId = branch.id)) },
                                label = { Text(branch.name) },
                            )
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ArabicDatePicker(
                        draft.startsOn,
                        { actions.updateCampaignDraft(draft.copy(startsOn = it)) },
                        "البداية",
                        modifier = Modifier.weight(1f),
                    )
                    ArabicDatePicker(
                        draft.endsOn,
                        { actions.updateCampaignDraft(draft.copy(endsOn = it)) },
                        "النهاية",
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        item {
            Button(
                onClick = actions.saveCampaign,
                enabled = !busy && draft.name.trim().length >= 2,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("إنشاء الحملة") }
        }
    }
}

@Composable
private fun CampaignField(value: String, onChange: (String) -> Unit, label: String, singleLine: Boolean = true) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
    )
}

internal val CampaignStatus.label: String
    get() = when (this) {
        CampaignStatus.DRAFT -> "مسودة"
        CampaignStatus.REVIEW -> "مراجعة"
        CampaignStatus.APPROVED -> "معتمدة"
        CampaignStatus.SCHEDULED -> "مجدولة"
        CampaignStatus.ACTIVE -> "نشطة"
        CampaignStatus.PAUSED -> "متوقفة"
        CampaignStatus.ENDED -> "منتهية"
    }

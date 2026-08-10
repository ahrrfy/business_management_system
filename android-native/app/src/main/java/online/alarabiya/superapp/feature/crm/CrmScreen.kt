package online.alarabiya.superapp.feature.crm

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CrmSection
import online.alarabiya.superapp.model.crm.WhatsappIntentSanitizer

@Composable
fun CrmRoute(
    viewModel: CrmViewModel,
    capabilities: CrmCapabilities,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(viewModel) { viewModel.initialize() }
    CrmScreen(
        state = viewModel.state,
        capabilities = capabilities,
        actions = CrmActions(
            selectSection = viewModel::selectSection,
            refresh = viewModel::initialize,
            setCustomerQuery = viewModel::setCustomerQuery,
            searchCustomers = viewModel::searchCustomers,
            loadMoreCustomers = viewModel::loadMoreCustomers,
            toggleInactiveCustomers = viewModel::toggleInactiveCustomers,
            selectCustomer = viewModel::selectCustomer,
            closeCustomerDetail = viewModel::closeCustomerDetail,
            beginCreateCustomer = viewModel::beginCreateCustomer,
            beginEditCustomer = viewModel::beginEditCustomer,
            updateCustomerDraft = viewModel::updateCustomerDraft,
            closeCustomerEditor = viewModel::closeCustomerEditor,
            saveCustomer = viewModel::saveCustomer,
            setCustomerActive = viewModel::setCustomerActive,
            refreshDueFollowUps = viewModel::refreshDueFollowUps,
            loadMoreDueFollowUps = viewModel::loadMoreDueFollowUps,
            openFollowUpCustomer = viewModel::openFollowUpCustomer,
            resolveDueFollowUp = viewModel::resolveDueFollowUp,
            refreshCustomerOperations = viewModel::refreshCustomerOperations,
            toggleResolvedFollowUps = viewModel::toggleResolvedFollowUps,
            loadMoreCustomerFollowUps = viewModel::loadMoreCustomerFollowUps,
            beginCreateFollowUp = viewModel::beginCreateFollowUp,
            beginEditFollowUp = viewModel::beginEditFollowUp,
            updateFollowUpDraft = viewModel::updateFollowUpDraft,
            closeFollowUpEditor = viewModel::closeFollowUpEditor,
            saveFollowUp = viewModel::saveFollowUp,
            setFollowUpResolved = viewModel::setFollowUpResolved,
            requestDeleteFollowUp = viewModel::requestDeleteFollowUp,
            confirmDeleteFollowUp = viewModel::confirmDeleteFollowUp,
            beginCreateContractPrice = viewModel::beginCreateContractPrice,
            loadMoreContractPrices = viewModel::loadMoreContractPrices,
            beginEditContractPrice = viewModel::beginEditContractPrice,
            updateContractPriceDraft = viewModel::updateContractPriceDraft,
            setContractCatalogQuery = viewModel::setContractCatalogQuery,
            searchContractCatalog = viewModel::searchContractCatalog,
            selectContractCatalogOption = viewModel::selectContractCatalogOption,
            closeContractPriceEditor = viewModel::closeContractPriceEditor,
            saveContractPrice = viewModel::saveContractPrice,
            setContractPriceActive = viewModel::setContractPriceActive,
            requestDeleteContractPrice = viewModel::requestDeleteContractPrice,
            confirmDeleteContractPrice = viewModel::confirmDeleteContractPrice,
            setQuotationQuery = viewModel::setQuotationQuery,
            setQuotationFilter = viewModel::setQuotationFilter,
            searchQuotations = viewModel::searchQuotations,
            loadMoreQuotations = viewModel::loadMoreQuotations,
            selectQuotation = viewModel::selectQuotation,
            closeQuotationDetail = viewModel::closeQuotationDetail,
            beginCreateQuotation = viewModel::beginCreateQuotation,
            beginEditQuotation = viewModel::beginEditQuotation,
            updateQuotationDraft = viewModel::updateQuotationDraft,
            closeQuotationEditor = viewModel::closeQuotationEditor,
            setCatalogQuery = viewModel::setCatalogQuery,
            searchCatalog = viewModel::searchCatalog,
            addCatalogOption = viewModel::addCatalogOption,
            updateQuotationLine = viewModel::updateQuotationLine,
            removeQuotationLine = viewModel::removeQuotationLine,
            saveQuotation = viewModel::saveQuotation,
            setQuotationStatus = viewModel::setQuotationStatus,
            beginCreateCampaign = viewModel::beginCreateCampaign,
            updateCampaignDraft = viewModel::updateCampaignDraft,
            closeCampaignEditor = viewModel::closeCampaignEditor,
            saveCampaign = viewModel::saveCampaign,
            transitionCampaign = viewModel::transitionCampaign,
        ),
        modifier = modifier,
    )
}

@Composable
fun CrmScreen(
    state: CrmUiState,
    capabilities: CrmCapabilities,
    actions: CrmActions,
    modifier: Modifier = Modifier,
) {
    val sections = capabilities.visibleSections
    val selectedIndex = sections.indexOf(state.section).coerceAtLeast(0)
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        Surface(
            color = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
            shape = RoundedCornerShape(bottomStart = 44.dp, bottomEnd = 18.dp),
            shadowElevation = 5.dp,
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 22.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("العلاقات والمبيعات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("العملاء • المتابعات • عروض الأسعار • الحملات", color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .72f))
                }
                IconButton(
                    onClick = actions.refresh,
                    enabled = !state.initializing && state.busyKey == null,
                    modifier = Modifier.clip(RoundedCornerShape(topStart = 18.dp, bottomEnd = 18.dp, topEnd = 11.dp, bottomStart = 11.dp))
                        .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = .14f)),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "تحديث")
                }
            }
        }
        if (sections.isNotEmpty()) {
            ScrollableTabRow(
                selectedTabIndex = selectedIndex,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)
                    .clip(RoundedCornerShape(28.dp)),
                edgePadding = 4.dp,
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                indicator = {},
                divider = {},
            ) {
                sections.forEach { section ->
                    Tab(
                        selected = state.section == section,
                        onClick = { actions.selectSection(section) },
                        modifier = Modifier.padding(4.dp).clip(RoundedCornerShape(22.dp))
                            .background(if (state.section == section) Color.White else Color.Transparent),
                        icon = { Icon(section.icon, contentDescription = null) },
                        text = { Text(section.label) },
                    )
                }
            }
        }
        state.message?.let { InlineCrmMessage(it, error = false) }
        state.error?.let { InlineCrmMessage(it, error = true) }
        when {
            sections.isEmpty() -> EmptyCrmState("لا توجد صلاحية لوحدات العملاء أو المبيعات أو الحملات")
            state.initializing && state.customerPage.rows.isEmpty() && state.quotationPage.rows.isEmpty() && state.campaigns.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
            else -> when (state.section) {
                CrmSection.Customers -> CustomersWorkspace(state, capabilities, actions)
                CrmSection.FollowUps -> FollowUpsWorkspace(state, capabilities, actions)
                CrmSection.Quotations -> QuotationsWorkspace(state, capabilities, actions)
                CrmSection.Campaigns -> CampaignsWorkspace(state, capabilities, actions)
            }
        }
    }
}

data class CrmActions(
    val selectSection: (CrmSection) -> Unit,
    val refresh: () -> Unit,
    val setCustomerQuery: (String) -> Unit,
    val searchCustomers: () -> Unit,
    val loadMoreCustomers: () -> Unit,
    val toggleInactiveCustomers: () -> Unit,
    val selectCustomer: (Long) -> Unit,
    val closeCustomerDetail: () -> Unit,
    val beginCreateCustomer: () -> Unit,
    val beginEditCustomer: () -> Unit,
    val updateCustomerDraft: (online.alarabiya.superapp.model.crm.CustomerDraft) -> Unit,
    val closeCustomerEditor: () -> Unit,
    val saveCustomer: () -> Unit,
    val setCustomerActive: (Boolean) -> Unit,
    val refreshDueFollowUps: () -> Unit,
    val loadMoreDueFollowUps: () -> Unit,
    val openFollowUpCustomer: (Long) -> Unit,
    val resolveDueFollowUp: (online.alarabiya.superapp.model.crm.CustomerFollowUp) -> Unit,
    val refreshCustomerOperations: () -> Unit,
    val toggleResolvedFollowUps: () -> Unit,
    val loadMoreCustomerFollowUps: () -> Unit,
    val beginCreateFollowUp: () -> Unit,
    val beginEditFollowUp: (online.alarabiya.superapp.model.crm.CustomerFollowUp) -> Unit,
    val updateFollowUpDraft: (online.alarabiya.superapp.model.crm.CustomerFollowUpDraft) -> Unit,
    val closeFollowUpEditor: () -> Unit,
    val saveFollowUp: () -> Unit,
    val setFollowUpResolved: (online.alarabiya.superapp.model.crm.CustomerFollowUp, Boolean) -> Unit,
    val requestDeleteFollowUp: (Long?) -> Unit,
    val confirmDeleteFollowUp: () -> Unit,
    val beginCreateContractPrice: () -> Unit,
    val loadMoreContractPrices: () -> Unit,
    val beginEditContractPrice: (online.alarabiya.superapp.model.crm.CustomerContractPrice) -> Unit,
    val updateContractPriceDraft: (online.alarabiya.superapp.model.crm.CustomerContractPriceDraft) -> Unit,
    val setContractCatalogQuery: (String) -> Unit,
    val searchContractCatalog: () -> Unit,
    val selectContractCatalogOption: (online.alarabiya.superapp.model.crm.CatalogOption) -> Unit,
    val closeContractPriceEditor: () -> Unit,
    val saveContractPrice: () -> Unit,
    val setContractPriceActive: (online.alarabiya.superapp.model.crm.CustomerContractPrice, Boolean) -> Unit,
    val requestDeleteContractPrice: (Long?) -> Unit,
    val confirmDeleteContractPrice: () -> Unit,
    val setQuotationQuery: (String) -> Unit,
    val setQuotationFilter: (online.alarabiya.superapp.model.crm.QuotationStatus?) -> Unit,
    val searchQuotations: () -> Unit,
    val loadMoreQuotations: () -> Unit,
    val selectQuotation: (Long) -> Unit,
    val closeQuotationDetail: () -> Unit,
    val beginCreateQuotation: () -> Unit,
    val beginEditQuotation: () -> Unit,
    val updateQuotationDraft: (online.alarabiya.superapp.model.crm.QuotationDraft) -> Unit,
    val closeQuotationEditor: () -> Unit,
    val setCatalogQuery: (String) -> Unit,
    val searchCatalog: () -> Unit,
    val addCatalogOption: (online.alarabiya.superapp.model.crm.CatalogOption) -> Unit,
    val updateQuotationLine: (Int, online.alarabiya.superapp.model.crm.QuotationLineDraft) -> Unit,
    val removeQuotationLine: (Int) -> Unit,
    val saveQuotation: () -> Unit,
    val setQuotationStatus: (online.alarabiya.superapp.model.crm.QuotationStatus) -> Unit,
    val beginCreateCampaign: () -> Unit,
    val updateCampaignDraft: (online.alarabiya.superapp.model.crm.CampaignDraft) -> Unit,
    val closeCampaignEditor: () -> Unit,
    val saveCampaign: () -> Unit,
    val transitionCampaign: (online.alarabiya.superapp.model.crm.CampaignSummary, online.alarabiya.superapp.model.crm.CampaignStatus) -> Unit,
)

@Composable
internal fun CrmCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 18.dp, bottomEnd = 28.dp, bottomStart = 18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(9.dp), content = content)
    }
}

@Composable
internal fun CrmStatus(text: String, color: Color = MaterialTheme.colorScheme.primary) {
    Text(
        text,
        modifier = Modifier.background(color.copy(alpha = .11f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 5.dp),
        color = color,
        style = MaterialTheme.typography.labelMedium,
    )
}

@Composable
internal fun EmptyCrmState(text: String) {
    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun CrmRetryGate(
    title: String,
    retryEnabled: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Button(
            onClick = onRetry,
            enabled = retryEnabled,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        ) { Text("إعادة المحاولة") }
    }
}

@Composable
private fun InlineCrmMessage(text: String, error: Boolean) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().background(
            if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
        ).padding(horizontal = 18.dp, vertical = 10.dp),
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

internal fun launchExternalWhatsApp(context: Context, rawPhone: String?, message: String) {
    val target = WhatsappIntentSanitizer.buildTarget(rawPhone, message)
    if (target == null) {
        Toast.makeText(context, "لا يوجد رقم واتساب صالح", Toast.LENGTH_SHORT).show()
        return
    }
    val packages = listOf("com.whatsapp", "com.whatsapp.w4b")
    for (packageName in packages) {
        val intent = Intent(Intent.ACTION_VIEW, target.uri.toUri()).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            setPackage(packageName)
        }
        try {
            context.startActivity(intent)
            return
        } catch (_: ActivityNotFoundException) {
            // Try the other official WhatsApp package; never fall back to an embedded browser.
        }
    }
    Toast.makeText(context, "واتساب غير مثبت على الجهاز", Toast.LENGTH_SHORT).show()
}

private val CrmSection.label: String
    get() = when (this) {
        CrmSection.Customers -> "العملاء"
        CrmSection.FollowUps -> "المتابعات"
        CrmSection.Quotations -> "عروض الأسعار"
        CrmSection.Campaigns -> "الحملات"
    }

private val CrmSection.icon: ImageVector
    get() = when (this) {
        CrmSection.Customers -> Icons.Rounded.Groups
        CrmSection.FollowUps -> Icons.Rounded.Schedule
        CrmSection.Quotations -> Icons.AutoMirrored.Rounded.Assignment
        CrmSection.Campaigns -> Icons.Rounded.Campaign
    }

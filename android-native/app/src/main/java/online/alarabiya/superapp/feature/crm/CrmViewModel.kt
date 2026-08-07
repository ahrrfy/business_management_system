package online.alarabiya.superapp.feature.crm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import online.alarabiya.superapp.data.CrmDataSource
import online.alarabiya.superapp.model.crm.BranchOption
import online.alarabiya.superapp.model.crm.CampaignDraft
import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CampaignSummary
import online.alarabiya.superapp.model.crm.CatalogOption
import online.alarabiya.superapp.model.crm.CrmCapabilities
import online.alarabiya.superapp.model.crm.CrmDashboard
import online.alarabiya.superapp.model.crm.CrmSection
import online.alarabiya.superapp.model.crm.CrmValidation
import online.alarabiya.superapp.model.crm.CustomerDetail
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerPage
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.model.crm.QuotationDetail
import online.alarabiya.superapp.model.crm.QuotationDraft
import online.alarabiya.superapp.model.crm.QuotationLineDraft
import online.alarabiya.superapp.model.crm.QuotationPage
import online.alarabiya.superapp.model.crm.QuotationStatus

data class CustomerEditor(val customerId: Long?, val draft: CustomerDraft)
data class QuotationEditor(val quotationId: Long?, val draft: QuotationDraft)
private data class InitialResults(
    val customers: Result<CustomerPage>?,
    val quotations: Result<QuotationPage>?,
    val campaigns: Result<Pair<List<CampaignSummary>, CrmDashboard>>?,
    val branches: Result<List<BranchOption>>?,
)

data class CrmUiState(
    val section: CrmSection = CrmSection.Customers,
    val initializing: Boolean = false,
    val busyKey: String? = null,
    val error: String? = null,
    val message: String? = null,
    val customerQuery: String = "",
    val includeInactiveCustomers: Boolean = false,
    val customerPage: CustomerPage = CustomerPage(emptyList(), 0),
    val selectedCustomer: CustomerDetail? = null,
    val customerEditor: CustomerEditor? = null,
    val quotationQuery: String = "",
    val quotationStatus: QuotationStatus? = null,
    val quotationPage: QuotationPage = QuotationPage(emptyList(), false, null),
    val selectedQuotation: QuotationDetail? = null,
    val quotationEditor: QuotationEditor? = null,
    val catalogQuery: String = "",
    val catalogResults: List<CatalogOption> = emptyList(),
    val branches: List<BranchOption> = emptyList(),
    val dashboard: CrmDashboard? = null,
    val campaigns: List<CampaignSummary> = emptyList(),
    val campaignEditor: CampaignDraft? = null,
)

class CrmViewModel(
    private val source: CrmDataSource,
    private val capabilities: CrmCapabilities,
) : ViewModel() {
    var state by mutableStateOf(
        CrmUiState(section = capabilities.visibleSections.firstOrNull() ?: CrmSection.Customers),
    )
        private set

    fun initialize() {
        if (state.initializing || state.busyKey != null) return
        state = state.copy(initializing = true, error = null, message = null)
        viewModelScope.launch {
            val results = coroutineScope {
                val customers = async {
                    if (capabilities.customers.canRead) runCatching { source.searchCustomers("", false) } else null
                }
                val quotations = async {
                    if (capabilities.sales.canRead) runCatching { source.quotations("") } else null
                }
                val campaigns = async {
                    if (capabilities.campaigns.canRead) runCatching { source.campaigns() to source.dashboard() } else null
                }
                val branches = async {
                    if (capabilities.sales.canWrite || capabilities.campaigns.canWrite) runCatching { source.branches() } else null
                }
                InitialResults(customers.await(), quotations.await(), campaigns.await(), branches.await())
            }
            val customerResult = results.customers
            val quotationResult = results.quotations
            val campaignResult = results.campaigns
            val branchResult = results.branches
            val firstError = listOf(customerResult, quotationResult, campaignResult, branchResult)
                .firstNotNullOfOrNull { it?.exceptionOrNull() }
            state = state.copy(
                initializing = false,
                customerPage = customerResult?.getOrNull() ?: state.customerPage,
                quotationPage = quotationResult?.getOrNull() ?: state.quotationPage,
                campaigns = campaignResult?.getOrNull()?.first ?: state.campaigns,
                dashboard = campaignResult?.getOrNull()?.second ?: state.dashboard,
                branches = branchResult?.getOrNull() ?: state.branches,
                error = firstError?.let(::userMessage),
            )
        }
    }

    fun selectSection(section: CrmSection) {
        if (section !in capabilities.visibleSections) return
        state = state.copy(section = section, error = null, message = null)
    }

    fun setCustomerQuery(value: String) {
        state = state.copy(customerQuery = value.take(200))
    }

    fun toggleInactiveCustomers() {
        state = state.copy(includeInactiveCustomers = !state.includeInactiveCustomers)
        searchCustomers()
    }

    fun searchCustomers() = launch("customers:search") {
        require(capabilities.customers.canRead) { "لا توجد صلاحية لقراءة العملاء" }
        val page = source.searchCustomers(state.customerQuery, state.includeInactiveCustomers)
        state = state.copy(customerPage = page, selectedCustomer = null)
    }

    fun loadMoreCustomers() {
        if (state.customerPage.rows.size >= state.customerPage.total) return
        launch("customers:more") {
            val next = source.searchCustomers(
                state.customerQuery,
                state.includeInactiveCustomers,
                offset = state.customerPage.rows.size,
            )
            state = state.copy(customerPage = next.copy(rows = state.customerPage.rows + next.rows))
        }
    }

    fun selectCustomer(id: Long) = launch("customer:$id") {
        require(capabilities.customers.canRead) { "لا توجد صلاحية لقراءة العملاء" }
        state = state.copy(selectedCustomer = source.customer(id), customerEditor = null)
    }

    fun closeCustomerDetail() {
        state = state.copy(selectedCustomer = null, error = null)
    }

    fun beginCreateCustomer() {
        if (!capabilities.customers.canWrite) return
        state = state.copy(
            customerEditor = CustomerEditor(null, CustomerDraft(clientRequestId = UUID.randomUUID().toString())),
            selectedCustomer = null,
            error = null,
        )
    }

    fun beginEditCustomer() {
        if (!capabilities.customers.canWrite) return
        val detail = state.selectedCustomer ?: return
        state = state.copy(customerEditor = CustomerEditor(detail.id, CustomerDraft.from(detail)), error = null)
    }

    fun updateCustomerDraft(draft: CustomerDraft) {
        state.customerEditor?.let { state = state.copy(customerEditor = it.copy(draft = draft), error = null) }
    }

    fun closeCustomerEditor() {
        state = state.copy(customerEditor = null, error = null)
    }

    fun saveCustomer() {
        if (!capabilities.customers.canWrite) return setError("تعديل العملاء يتطلب صلاحية كاملة")
        val editor = state.customerEditor ?: return
        CrmValidation.customer(editor.draft)?.let { return setError(it) }
        launch("customer:save", if (editor.customerId == null) "تم إنشاء العميل" else "تم تحديث العميل") {
            val id = editor.customerId ?: source.createCustomer(editor.draft)
            if (editor.customerId != null) source.updateCustomer(id, editor.draft)
            val page = source.searchCustomers(state.customerQuery, state.includeInactiveCustomers)
            state = state.copy(customerPage = page, selectedCustomer = source.customer(id), customerEditor = null)
        }
    }

    fun setCustomerActive(active: Boolean) {
        val customer = state.selectedCustomer ?: return
        if (!capabilities.customers.canWrite) return
        launch("customer:active", if (active) "تم تفعيل العميل" else "تم تعطيل العميل") {
            source.setCustomerActive(customer.id, active)
            state = state.copy(
                selectedCustomer = source.customer(customer.id),
                customerPage = source.searchCustomers(state.customerQuery, state.includeInactiveCustomers),
            )
        }
    }

    fun setQuotationQuery(value: String) {
        state = state.copy(quotationQuery = value.take(200))
    }

    fun setQuotationFilter(status: QuotationStatus?) {
        state = state.copy(quotationStatus = status)
        searchQuotations()
    }

    fun searchQuotations() = launch("quotations:search") {
        require(capabilities.sales.canRead) { "لا توجد صلاحية لقراءة عروض الأسعار" }
        state = state.copy(
            quotationPage = source.quotations(state.quotationQuery, state.quotationStatus),
            selectedQuotation = null,
        )
    }

    fun loadMoreQuotations() {
        val cursor = state.quotationPage.nextCursor ?: return
        launch("quotations:more") {
            val next = source.quotations(state.quotationQuery, state.quotationStatus, cursor)
            state = state.copy(
                quotationPage = next.copy(rows = state.quotationPage.rows + next.rows),
            )
        }
    }

    fun selectQuotation(id: Long) = launch("quotation:$id") {
        require(capabilities.sales.canRead) { "لا توجد صلاحية لقراءة عروض الأسعار" }
        state = state.copy(selectedQuotation = source.quotation(id), quotationEditor = null)
    }

    fun closeQuotationDetail() {
        state = state.copy(selectedQuotation = null, error = null)
    }

    fun beginCreateQuotation() {
        if (!capabilities.sales.canWrite) return
        val branchId = capabilities.branchId ?: state.branches.singleOrNull()?.id
        state = state.copy(
            quotationEditor = QuotationEditor(
                null,
                QuotationDraft(branchId = branchId, clientRequestId = UUID.randomUUID().toString()),
            ),
            selectedQuotation = null,
            catalogResults = emptyList(),
            catalogQuery = "",
            error = null,
        )
    }

    fun beginEditQuotation() {
        if (!capabilities.sales.canWrite) return
        val detail = state.selectedQuotation?.takeIf(QuotationDetail::canEdit) ?: return
        state = state.copy(
            quotationEditor = QuotationEditor(detail.id, QuotationDraft.from(detail)),
            catalogResults = emptyList(),
            catalogQuery = "",
            error = null,
        )
    }

    fun updateQuotationDraft(draft: QuotationDraft) {
        state.quotationEditor?.let { state = state.copy(quotationEditor = it.copy(draft = draft), error = null) }
    }

    fun closeQuotationEditor() {
        state = state.copy(quotationEditor = null, catalogResults = emptyList(), error = null)
    }

    fun setCatalogQuery(value: String) {
        state = state.copy(catalogQuery = value.take(120))
    }

    fun searchCatalog() {
        if (!capabilities.products.canRead) return setError("لا توجد صلاحية لقراءة كتالوج الأصناف")
        val draft = state.quotationEditor?.draft ?: return
        val branchId = draft.branchId ?: return setError("اختر الفرع قبل البحث عن الأصناف")
        launch("catalog:search") {
            state = state.copy(
                catalogResults = source.catalog(branchId, draft.priceTier, state.catalogQuery, draft.customerId),
            )
        }
    }

    fun addCatalogOption(option: CatalogOption) {
        val editor = state.quotationEditor ?: return
        if (editor.draft.lines.any { it.productUnitId == option.productUnitId }) return
        val line = QuotationLineDraft(
            variantId = option.variantId,
            productUnitId = option.productUnitId,
            label = option.label,
            unitPriceOverride = option.effectivePrice.orEmpty(),
        )
        state = state.copy(quotationEditor = editor.copy(draft = editor.draft.copy(lines = editor.draft.lines + line)))
    }

    fun updateQuotationLine(index: Int, line: QuotationLineDraft) {
        val editor = state.quotationEditor ?: return
        if (index !in editor.draft.lines.indices) return
        val lines = editor.draft.lines.toMutableList().also { it[index] = line }
        state = state.copy(quotationEditor = editor.copy(draft = editor.draft.copy(lines = lines)))
    }

    fun removeQuotationLine(index: Int) {
        val editor = state.quotationEditor ?: return
        if (index !in editor.draft.lines.indices) return
        state = state.copy(
            quotationEditor = editor.copy(
                draft = editor.draft.copy(lines = editor.draft.lines.filterIndexed { position, _ -> position != index }),
            ),
        )
    }

    fun saveQuotation() {
        if (!capabilities.sales.canWrite) return setError("حفظ عرض السعر يتطلب صلاحية كاملة")
        if (!capabilities.products.canRead) return setError("لا توجد صلاحية لقراءة كتالوج الأصناف")
        val editor = state.quotationEditor ?: return
        CrmValidation.quotation(editor.draft)?.let { return setError(it) }
        launch("quotation:save", if (editor.quotationId == null) "تم إنشاء عرض السعر" else "تم تحديث عرض السعر") {
            val id = editor.quotationId ?: source.createQuotation(editor.draft)
            if (editor.quotationId != null) source.updateQuotation(id, editor.draft)
            state = state.copy(
                quotationPage = source.quotations(state.quotationQuery, state.quotationStatus),
                selectedQuotation = source.quotation(id),
                quotationEditor = null,
                catalogResults = emptyList(),
            )
        }
    }

    fun setQuotationStatus(status: QuotationStatus) {
        val quotation = state.selectedQuotation ?: return
        if (!capabilities.sales.canWrite) return
        launch("quotation:status", "تم تحديث حالة عرض السعر") {
            source.setQuotationStatus(quotation.id, status)
            state = state.copy(
                selectedQuotation = source.quotation(quotation.id),
                quotationPage = source.quotations(state.quotationQuery, state.quotationStatus),
            )
        }
    }

    fun beginCreateCampaign() {
        if (!capabilities.campaigns.canWrite) return
        state = state.copy(campaignEditor = CampaignDraft(branchId = capabilities.branchId), error = null)
    }

    fun updateCampaignDraft(draft: CampaignDraft) {
        if (state.campaignEditor != null) state = state.copy(campaignEditor = draft, error = null)
    }

    fun closeCampaignEditor() {
        state = state.copy(campaignEditor = null, error = null)
    }

    fun saveCampaign() {
        if (!capabilities.campaigns.canWrite) return setError("إنشاء الحملات يتطلب صلاحية كاملة")
        val draft = state.campaignEditor ?: return
        CrmValidation.campaign(draft)?.let { return setError(it) }
        launch("campaign:save", "تم إنشاء الحملة") {
            source.createCampaign(draft)
            val campaigns = source.campaigns()
            val dashboard = source.dashboard()
            state = state.copy(campaignEditor = null, campaigns = campaigns, dashboard = dashboard)
        }
    }

    fun transitionCampaign(campaign: CampaignSummary, status: CampaignStatus) {
        if (!capabilities.campaigns.canWrite || status !in campaign.allowedTransitions()) return
        launch("campaign:${campaign.id}", "تم تحديث حالة الحملة") {
            source.transitionCampaign(campaign.id, status)
            state = state.copy(campaigns = source.campaigns(), dashboard = source.dashboard())
        }
    }

    private fun launch(key: String, successMessage: String? = null, operation: suspend () -> Unit) {
        if (state.busyKey != null) return
        state = state.copy(busyKey = key, error = null, message = null)
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess { state = state.copy(busyKey = null, message = successMessage) }
                .onFailure { state = state.copy(busyKey = null, error = userMessage(it)) }
        }
    }

    private fun setError(message: String) {
        state = state.copy(error = message, message = null)
    }

    private fun userMessage(error: Throwable): String =
        error.message?.takeIf(String::isNotBlank) ?: "تعذر إكمال العملية"
}

class CrmViewModelFactory(
    private val source: CrmDataSource,
    private val capabilities: CrmCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CrmViewModel(source, capabilities) as T
}

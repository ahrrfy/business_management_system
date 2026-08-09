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
import online.alarabiya.superapp.model.crm.CustomerContractPrice
import online.alarabiya.superapp.model.crm.CustomerContractPriceDraft
import online.alarabiya.superapp.model.crm.CustomerContractPricePage
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUp
import online.alarabiya.superapp.model.crm.CustomerFollowUpDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUpPage
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
    val dueFollowUps: Result<CustomerFollowUpPage>?,
    val quotations: Result<QuotationPage>?,
    val campaigns: Result<Pair<List<CampaignSummary>, CrmDashboard>>?,
    val branches: Result<List<BranchOption>>?,
)

private data class DueSnapshot(
    val rows: List<CustomerFollowUp>,
    val total: Int,
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
    val customersLoaded: Boolean = false,
    val selectedCustomerFresh: Boolean = false,
    val pendingCustomerRefreshId: Long? = null,
    val customerOperations: CustomerOperationsState = CustomerOperationsState(),
    val quotationQuery: String = "",
    val quotationStatus: QuotationStatus? = null,
    val quotationPage: QuotationPage = QuotationPage(emptyList(), false, null),
    val selectedQuotation: QuotationDetail? = null,
    val quotationEditor: QuotationEditor? = null,
    val quotationsLoaded: Boolean = false,
    val selectedQuotationFresh: Boolean = false,
    val pendingQuotationRefreshId: Long? = null,
    val catalogQuery: String = "",
    val catalogResults: List<CatalogOption> = emptyList(),
    val branches: List<BranchOption> = emptyList(),
    val dashboard: CrmDashboard? = null,
    val campaigns: List<CampaignSummary> = emptyList(),
    val campaignsLoaded: Boolean = false,
    val campaignCreateOutcomeUnknown: Boolean = false,
    val campaignMutationOutcomeUnknown: Boolean = false,
    val lastCreatedCampaignId: Long? = null,
    val pendingCampaignRefreshId: Long? = null,
    val campaignEditor: CampaignDraft? = null,
) {
    val canCreateCustomer: Boolean
        get() = customersLoaded && customerEditor == null && busyKey == null

    val canMutateSelectedCustomer: Boolean
        get() = customersLoaded && selectedCustomerFresh && selectedCustomer != null && busyKey == null

    val canMutateCustomerFollowUps: Boolean
        get() = canMutateSelectedCustomer && customerOperations.canMutateFollowUps

    val canMutateCustomerContracts: Boolean
        get() = canMutateSelectedCustomer && customerOperations.canMutateContracts

    val canCreateQuotation: Boolean
        get() = quotationsLoaded && quotationEditor == null && busyKey == null

    val canMutateSelectedQuotation: Boolean
        get() = quotationsLoaded && selectedQuotationFresh && selectedQuotation != null && busyKey == null

    val canCreateCampaign: Boolean
        get() = campaignsLoaded && !campaignCreateOutcomeUnknown && !campaignMutationOutcomeUnknown && busyKey == null

    val canMutateCampaign: Boolean
        get() = campaignsLoaded && !campaignCreateOutcomeUnknown && !campaignMutationOutcomeUnknown && busyKey == null
}

internal fun CrmUiState.customerSaveCommitted(id: Long): CrmUiState = copy(
    customerEditor = null,
    customersLoaded = false,
    selectedCustomerFresh = false,
    pendingCustomerRefreshId = id,
    message = "تم حفظ العميل",
    error = null,
)

internal fun CrmUiState.customerCreateRetryable(errorMessage: String): CrmUiState = copy(
    busyKey = null,
    error = errorMessage,
    message = null,
)

internal fun CrmUiState.customerMutationUncertain(id: Long): CrmUiState = copy(
    busyKey = null,
    customerEditor = null,
    customersLoaded = false,
    selectedCustomerFresh = false,
    pendingCustomerRefreshId = id,
    error = "تعذر التحقق من نتيجة تعديل العميل. حدّث العملاء قبل تنفيذ إجراء آخر.",
    message = null,
)

internal fun CrmUiState.customerActiveCommitted(active: Boolean): CrmUiState {
    val customer = selectedCustomer ?: return this
    return copy(
        selectedCustomer = customer.copy(isActive = active),
        customersLoaded = false,
        selectedCustomerFresh = false,
        pendingCustomerRefreshId = customer.id,
        message = if (active) "تم تفعيل العميل" else "تم تعطيل العميل",
        error = null,
    )
}

internal fun CrmUiState.customersRefreshed(
    page: CustomerPage,
    detail: CustomerDetail? = null,
): CrmUiState = copy(
    customerPage = page,
    selectedCustomer = detail,
    customersLoaded = true,
    selectedCustomerFresh = detail != null,
    pendingCustomerRefreshId = null,
    error = null,
)

internal fun CrmUiState.quotationSaveCommitted(id: Long): CrmUiState = copy(
    quotationEditor = null,
    catalogResults = emptyList(),
    quotationsLoaded = false,
    selectedQuotationFresh = false,
    pendingQuotationRefreshId = id,
    message = "تم حفظ عرض السعر",
    error = null,
)

internal fun CrmUiState.quotationCreateRetryable(errorMessage: String): CrmUiState = copy(
    busyKey = null,
    error = errorMessage,
    message = null,
)

internal fun CrmUiState.quotationMutationUncertain(id: Long): CrmUiState = copy(
    busyKey = null,
    quotationEditor = null,
    catalogResults = emptyList(),
    quotationsLoaded = false,
    selectedQuotationFresh = false,
    pendingQuotationRefreshId = id,
    error = "تعذر التحقق من نتيجة تعديل عرض السعر. حدّث العروض قبل تنفيذ إجراء آخر.",
    message = null,
)

internal fun CrmUiState.quotationStatusCommitted(status: QuotationStatus): CrmUiState {
    val quotation = selectedQuotation ?: return this
    return copy(
        selectedQuotation = quotation.copy(status = status),
        quotationsLoaded = false,
        selectedQuotationFresh = false,
        pendingQuotationRefreshId = quotation.id,
        message = "تم تحديث حالة عرض السعر",
        error = null,
    )
}

internal fun CrmUiState.quotationsRefreshed(
    page: QuotationPage,
    detail: QuotationDetail? = null,
): CrmUiState = copy(
    quotationPage = page,
    selectedQuotation = detail,
    quotationsLoaded = true,
    selectedQuotationFresh = detail != null,
    pendingQuotationRefreshId = null,
    error = null,
)

internal fun CrmUiState.campaignCreateCommitted(id: Long): CrmUiState = copy(
    campaignEditor = null,
    campaignsLoaded = false,
    campaignCreateOutcomeUnknown = false,
    campaignMutationOutcomeUnknown = false,
    lastCreatedCampaignId = id,
    message = "تم إنشاء الحملة",
    error = null,
)

internal fun CrmUiState.campaignCreateUncertain(): CrmUiState = copy(
    busyKey = null,
    campaignEditor = null,
    campaignsLoaded = false,
    campaignCreateOutcomeUnknown = true,
    campaignMutationOutcomeUnknown = false,
    error = "تعذر التحقق من نتيجة إنشاء الحملة. حدّث الحملات قبل إنشاء حملة أخرى.",
    message = null,
)

internal fun CrmUiState.campaignsRefreshed(
    rows: List<CampaignSummary>,
    freshDashboard: CrmDashboard,
): CrmUiState = copy(
    campaigns = rows,
    dashboard = freshDashboard,
    campaignsLoaded = true,
    campaignCreateOutcomeUnknown = false,
    campaignMutationOutcomeUnknown = false,
    lastCreatedCampaignId = null,
    pendingCampaignRefreshId = null,
    error = null,
)

internal fun CrmUiState.campaignTransitionCommitted(id: Long, status: CampaignStatus): CrmUiState = copy(
    campaigns = campaigns.map { campaign -> if (campaign.id == id) campaign.copy(status = status) else campaign },
    campaignsLoaded = false,
    campaignMutationOutcomeUnknown = false,
    pendingCampaignRefreshId = id,
    message = "تم تحديث حالة الحملة",
    error = null,
)

internal fun CrmUiState.campaignTransitionUncertain(id: Long): CrmUiState = copy(
    busyKey = null,
    campaignsLoaded = false,
    campaignMutationOutcomeUnknown = true,
    pendingCampaignRefreshId = id,
    error = "تعذر التحقق من نتيجة تحديث الحملة. حدّث الحملات قبل تنفيذ إجراء آخر.",
    message = null,
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
        state = state.copy(
            initializing = true,
            error = null,
            message = null,
            customersLoaded = if (capabilities.customers.canRead) false else state.customersLoaded,
            selectedCustomerFresh = false,
            customerOperations = state.customerOperations.copy(
                dueFresh = if (capabilities.customers.canWrite) false else state.customerOperations.dueFresh,
                notesFresh = false,
                contractsFresh = false,
            ),
            quotationsLoaded = if (capabilities.sales.canRead) false else state.quotationsLoaded,
            selectedQuotationFresh = false,
            campaignsLoaded = if (capabilities.campaigns.canRead) false else state.campaignsLoaded,
        )
        viewModelScope.launch {
            val results = coroutineScope {
                val customers = async {
                    if (capabilities.customers.canRead) runCatching { source.searchCustomers("", false) } else null
                }
                val dueFollowUps = async {
                    if (capabilities.customers.canWrite) runCatching { source.dueCustomerFollowUps() } else null
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
                InitialResults(customers.await(), dueFollowUps.await(), quotations.await(), campaigns.await(), branches.await())
            }
            val customerResult = results.customers
            val dueFollowUpsResult = results.dueFollowUps
            val dueFollowUpsPage = dueFollowUpsResult?.getOrNull()
            val quotationResult = results.quotations
            val campaignResult = results.campaigns
            val branchResult = results.branches
            val firstError = listOf(customerResult, dueFollowUpsResult, quotationResult, campaignResult, branchResult)
                .firstNotNullOfOrNull { it?.exceptionOrNull() }
            val customerWorkspaceReady = capabilities.customers.canRead && customerResult?.isSuccess == true
            val quotationWorkspaceReady = capabilities.sales.canRead &&
                quotationResult?.isSuccess == true &&
                (!capabilities.sales.canWrite || branchResult?.isSuccess == true) &&
                (!capabilities.sales.canWrite || !capabilities.customers.canRead || customerResult?.isSuccess == true)
            val campaignWorkspaceReady = !capabilities.campaigns.canRead || (
                campaignResult?.isSuccess == true &&
                    (!capabilities.campaigns.canWrite || branchResult?.isSuccess == true)
                )
            state = state.copy(
                initializing = false,
                customerPage = customerResult?.getOrNull() ?: state.customerPage,
                selectedCustomer = if (customerWorkspaceReady) null else state.selectedCustomer,
                customersLoaded = customerWorkspaceReady,
                selectedCustomerFresh = false,
                pendingCustomerRefreshId = if (customerWorkspaceReady) null else state.pendingCustomerRefreshId,
                customerOperations = state.customerOperations.copy(
                    dueRows = dueFollowUpsPage?.rows ?: state.customerOperations.dueRows,
                    dueTotal = dueFollowUpsPage?.total ?: state.customerOperations.dueTotal,
                    dueFresh = !capabilities.customers.canWrite || dueFollowUpsResult?.isSuccess == true,
                    notesFresh = false,
                    contractsFresh = false,
                ),
                quotationPage = quotationResult?.getOrNull() ?: state.quotationPage,
                selectedQuotation = if (quotationWorkspaceReady) null else state.selectedQuotation,
                quotationsLoaded = quotationWorkspaceReady,
                selectedQuotationFresh = false,
                pendingQuotationRefreshId = if (quotationWorkspaceReady) null else state.pendingQuotationRefreshId,
                campaigns = campaignResult?.getOrNull()?.first ?: state.campaigns,
                dashboard = campaignResult?.getOrNull()?.second ?: state.dashboard,
                campaignsLoaded = capabilities.campaigns.canRead && campaignWorkspaceReady,
                campaignCreateOutcomeUnknown = if (campaignWorkspaceReady) false else state.campaignCreateOutcomeUnknown,
                campaignMutationOutcomeUnknown = if (campaignWorkspaceReady) false else state.campaignMutationOutcomeUnknown,
                lastCreatedCampaignId = if (campaignWorkspaceReady) null else state.lastCreatedCampaignId,
                pendingCampaignRefreshId = if (campaignWorkspaceReady) null else state.pendingCampaignRefreshId,
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
        if (!state.canCreateCustomer) return
        state = state.copy(includeInactiveCustomers = !state.includeInactiveCustomers)
        searchCustomers()
    }

    fun searchCustomers() {
        if (!state.canCreateCustomer) return
        launch("customers:search") {
            require(capabilities.customers.canRead) { "لا توجد صلاحية لقراءة العملاء" }
            state = state.copy(customersLoaded = false, selectedCustomerFresh = false)
            val page = source.searchCustomers(state.customerQuery, state.includeInactiveCustomers)
            state = state.customersRefreshed(page)
        }
    }

    fun loadMoreCustomers() {
        if (!state.canCreateCustomer) return
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

    fun selectCustomer(id: Long) {
        if (!state.canCreateCustomer) return
        launch("customer:$id") {
            require(capabilities.customers.canRead) { "لا توجد صلاحية لقراءة العملاء" }
            state = state.copy(
                selectedCustomer = null,
                selectedCustomerFresh = false,
                pendingCustomerRefreshId = id,
                customerOperations = state.customerOperations.clearSelectedCustomer(),
            )
            val result = coroutineScope {
                val detail = async { runCatching { source.customer(id) } }
                val notes = async { runCatching { source.customerFollowUps(id, state.customerOperations.includeResolved) } }
                val contracts = async {
                    if (capabilities.customers.canWrite) runCatching { source.contractPrices(id) }
                    else Result.success(CustomerContractPricePage(emptyList(), 0, false, null))
                }
                Triple(detail.await(), notes.await(), contracts.await())
            }
            val detail = result.first.getOrThrow()
            state = state.copy(
                selectedCustomer = detail,
                selectedCustomerFresh = true,
                pendingCustomerRefreshId = null,
                customerEditor = null,
                customerOperations = state.customerOperations.copy(
                    notesPage = result.second.getOrNull() ?: CustomerFollowUpPage(emptyList(), 0),
                    notesFresh = result.second.isSuccess,
                    contracts = result.third.getOrNull()?.rows.orEmpty(),
                    contractTotal = result.third.getOrNull()?.total ?: 0,
                    contractHasMore = result.third.getOrNull()?.hasMore == true,
                    contractNextCursor = result.third.getOrNull()?.nextCursor,
                    contractsFresh = result.third.isSuccess,
                ),
                error = listOf(result.second, result.third).firstNotNullOfOrNull { it.exceptionOrNull() }?.let(::userMessage),
            )
        }
    }

    fun closeCustomerDetail() {
        state = state.copy(
            selectedCustomer = null,
            selectedCustomerFresh = false,
            pendingCustomerRefreshId = null,
            customerOperations = state.customerOperations.clearSelectedCustomer(),
            error = null,
        )
    }

    fun beginCreateCustomer() {
        if (!capabilities.customers.canWrite || !state.canCreateCustomer) return
        state = state.copy(
            customerEditor = CustomerEditor(null, CustomerDraft(clientRequestId = UUID.randomUUID().toString())),
            selectedCustomer = null,
            error = null,
        )
    }

    fun beginEditCustomer() {
        if (!capabilities.customers.canWrite || !state.canMutateSelectedCustomer) return
        val detail = state.selectedCustomer ?: return
        state = state.copy(customerEditor = CustomerEditor(detail.id, CustomerDraft.from(detail)), error = null)
    }

    fun updateCustomerDraft(draft: CustomerDraft) {
        if (!state.customersLoaded || state.busyKey != null) return
        state.customerEditor?.let { state = state.copy(customerEditor = it.copy(draft = draft), error = null) }
    }

    fun closeCustomerEditor() {
        if (state.busyKey != null) return
        state = state.copy(customerEditor = null, error = null)
    }

    fun saveCustomer() {
        if (!capabilities.customers.canWrite) return setError("تعديل العملاء يتطلب صلاحية كاملة")
        if (!state.customersLoaded || state.busyKey != null) return
        val editor = state.customerEditor ?: return
        if (editor.customerId != null &&
            (!state.selectedCustomerFresh || state.selectedCustomer?.id != editor.customerId)
        ) return
        CrmValidation.customer(editor.draft)?.let { return setError(it) }
        state = state.copy(busyKey = "customer:save", error = null, message = null)
        viewModelScope.launch {
            val id = if (editor.customerId == null) {
                runCatching { source.createCustomer(editor.draft) }.getOrElse {
                    // Customer creation is idempotent. Keep the exact request id so Retry is safe.
                    state = state.customerCreateRetryable(userMessage(it))
                    return@launch
                }
            } else {
                runCatching { source.updateCustomer(editor.customerId, editor.draft) }.getOrElse {
                    // Updates have no request id; a transport failure is an unknown outcome.
                    state = state.customerMutationUncertain(editor.customerId)
                    return@launch
                }
                editor.customerId
            }
            state = state.customerSaveCommitted(id)
            runCatching { refreshCustomer(id) }
                .onSuccess { (page, detail) ->
                    state = state.customersRefreshed(page, detail).copy(
                        busyKey = null,
                        message = if (editor.customerId == null) "تم إنشاء العميل" else "تم تحديث العميل",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم حفظ العميل، وتعذر تحديث بياناته. حدّث العملاء قبل تنفيذ إجراء آخر.",
                        message = null,
                    )
                }
        }
    }

    fun setCustomerActive(active: Boolean) {
        val customer = state.selectedCustomer ?: return
        if (!capabilities.customers.canWrite || !state.canMutateSelectedCustomer || customer.isActive == active) return
        state = state.copy(busyKey = "customer:active", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.setCustomerActive(customer.id, active) }.getOrElse {
                state = state.customerMutationUncertain(customer.id)
                return@launch
            }
            state = state.customerActiveCommitted(active)
            runCatching { refreshCustomer(customer.id) }
                .onSuccess { (page, detail) ->
                    state = state.customersRefreshed(page, detail).copy(
                        busyKey = null,
                        message = if (active) "تم تفعيل العميل" else "تم تعطيل العميل",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم تحديث العميل، وتعذر تحديث بياناته. حدّث العملاء قبل تنفيذ إجراء آخر.",
                        message = null,
                    )
                }
        }
    }

    fun refreshDueFollowUps() {
        if (!capabilities.customers.canWrite || state.busyKey != null) return
        launch("followups:due") {
            state = state.copy(customerOperations = state.customerOperations.copy(dueFresh = false))
            val page = source.dueCustomerFollowUps()
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    dueRows = page.rows,
                    dueTotal = page.total,
                    dueFresh = true,
                ),
            )
        }
    }

    fun loadMoreDueFollowUps() {
        val operations = state.customerOperations
        if (!capabilities.customers.canWrite || !operations.dueFresh || state.busyKey != null) return
        if (operations.dueRows.size >= operations.dueTotal) return
        launch("followups:due:more") {
            val next = source.dueCustomerFollowUps(offset = operations.dueRows.size)
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    dueRows = (operations.dueRows + next.rows).distinctBy { it.id },
                    dueTotal = next.total,
                    dueFresh = true,
                ),
            )
        }
    }

    fun openFollowUpCustomer(customerId: Long) {
        if (customerId <= 0 || !state.canCreateCustomer) return
        state = state.copy(section = CrmSection.Customers, error = null, message = null)
        selectCustomer(customerId)
    }

    fun resolveDueFollowUp(row: CustomerFollowUp) {
        if (!capabilities.customers.canWrite || !state.customerOperations.dueFresh || state.busyKey != null) return
        if (state.customerOperations.dueRows.none { it.id == row.id }) return
        state = state.copy(busyKey = "followup:due:resolve", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.resolveCustomerFollowUp(row.id, true) }.getOrElse {
                state = state.copy(
                    busyKey = null,
                    customerOperations = state.customerOperations.copy(dueFresh = false),
                    error = "تعذر التحقق من نتيجة إنجاز المتابعة. حدّث القائمة قبل تنفيذ إجراء آخر.",
                )
                return@launch
            }
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    dueRows = state.customerOperations.dueRows.filterNot { it.id == row.id },
                    dueTotal = (state.customerOperations.dueTotal - 1).coerceAtLeast(0),
                    dueFresh = false,
                    notesPage = if (state.selectedCustomer?.id == row.customerId) {
                        state.customerOperations.notesPage.copy(
                            rows = state.customerOperations.notesPage.rows
                                .map { if (it.id == row.id) it.copy(isResolved = true) else it }
                                .filterNot { !state.customerOperations.includeResolved && it.id == row.id },
                            total = if (!state.customerOperations.includeResolved) {
                                (state.customerOperations.notesPage.total - 1).coerceAtLeast(0)
                            } else state.customerOperations.notesPage.total,
                        )
                    } else state.customerOperations.notesPage,
                    notesFresh = if (state.selectedCustomer?.id == row.customerId) false else state.customerOperations.notesFresh,
                ),
                message = "تم إنجاز المتابعة",
            )
            runCatching { source.dueCustomerFollowUps() }
                .onSuccess { page ->
                    state = state.copy(
                        busyKey = null,
                        customerOperations = state.customerOperations.copy(
                            dueRows = page.rows,
                            dueTotal = page.total,
                            dueFresh = true,
                        ),
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم إنجاز المتابعة، وتعذر تحديث القائمة. حدّثها قبل تنفيذ إجراء آخر.",
                    )
                }
        }
    }

    fun refreshCustomerOperations() {
        val customerId = state.selectedCustomer?.id ?: return
        if (!capabilities.customers.canRead || state.busyKey != null) return
        state = state.copy(busyKey = "customer:operations", error = null, message = null)
        viewModelScope.launch {
            val results = loadCustomerOperations(customerId)
            val notes = results.first
            val contracts = results.second
            val due = results.third
            val contractPage = contracts.getOrNull()
            val duePage = due.getOrNull()
            state = state.copy(
                busyKey = null,
                customerOperations = state.customerOperations.copy(
                    notesPage = notes.getOrNull() ?: state.customerOperations.notesPage,
                    notesFresh = notes.isSuccess,
                    contracts = contractPage?.rows ?: state.customerOperations.contracts,
                    contractTotal = contractPage?.total ?: state.customerOperations.contractTotal,
                    contractHasMore = contractPage?.hasMore ?: state.customerOperations.contractHasMore,
                    contractNextCursor = if (contracts.isSuccess) contractPage?.nextCursor else state.customerOperations.contractNextCursor,
                    contractsFresh = contracts.isSuccess,
                    dueRows = duePage?.rows ?: state.customerOperations.dueRows,
                    dueTotal = duePage?.total ?: state.customerOperations.dueTotal,
                    dueFresh = due.isSuccess,
                ),
                error = notes.exceptionOrNull()?.let(::userMessage)
                    ?: contracts.exceptionOrNull()?.let(::userMessage)
                    ?: due.exceptionOrNull()?.let(::userMessage),
            )
        }
    }

    fun toggleResolvedFollowUps() {
        val customer = state.selectedCustomer ?: return
        if (state.busyKey != null) return
        val includeResolved = !state.customerOperations.includeResolved
        state = state.copy(
            busyKey = "followups:filter",
            error = null,
            customerOperations = state.customerOperations.copy(includeResolved = includeResolved, notesFresh = false),
        )
        viewModelScope.launch {
            runCatching { source.customerFollowUps(customer.id, includeResolved) }
                .onSuccess { page ->
                    state = state.copy(
                        busyKey = null,
                        customerOperations = state.customerOperations.copy(notesPage = page, notesFresh = true),
                    )
                }
                .onFailure {
                    state = state.copy(busyKey = null, error = userMessage(it))
                }
        }
    }

    fun loadMoreCustomerFollowUps() {
        val customer = state.selectedCustomer ?: return
        val operations = state.customerOperations
        if (!operations.notesFresh || state.busyKey != null || operations.notesPage.rows.size >= operations.notesPage.total) return
        launch("followups:more") {
            val next = source.customerFollowUps(
                customer.id,
                operations.includeResolved,
                offset = operations.notesPage.rows.size,
            )
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    notesPage = next.copy(rows = operations.notesPage.rows + next.rows),
                    notesFresh = true,
                ),
            )
        }
    }

    fun beginCreateFollowUp() {
        if (!capabilities.customers.canWrite || !state.canMutateCustomerFollowUps) return
        if (capabilities.branchId == null) return setError("اختر فرع الجلسة قبل إنشاء متابعة")
        state = state.copy(
            customerOperations = state.customerOperations.copy(followUpEditor = CustomerFollowUpDraft()),
            error = null,
        )
    }

    fun beginEditFollowUp(row: CustomerFollowUp) {
        if (!capabilities.customers.canWrite || !state.canMutateCustomerFollowUps) return
        if (row.customerId != state.selectedCustomer?.id) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(
                followUpEditor = CustomerFollowUpDraft(row.id, row.note, row.followUpDate.orEmpty()),
            ),
            error = null,
        )
    }

    fun updateFollowUpDraft(draft: CustomerFollowUpDraft) {
        if (state.busyKey != null || state.customerOperations.followUpEditor == null) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(followUpEditor = draft),
            error = null,
        )
    }

    fun closeFollowUpEditor() {
        if (state.busyKey != null) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(followUpEditor = null),
            error = null,
        )
    }

    fun saveFollowUp() {
        val customer = state.selectedCustomer ?: return
        val editor = state.customerOperations.followUpEditor ?: return
        val previous = editor.noteId?.let { noteId ->
            state.customerOperations.notesPage.rows.firstOrNull { it.id == noteId }
        }
        if (!capabilities.customers.canWrite || !state.canMutateCustomerFollowUps) return
        CrmValidation.followUp(editor)?.let { return setError(it) }
        val creationBranchId = if (editor.noteId == null) {
            capabilities.branchId ?: return setError("اختر فرع الجلسة قبل إنشاء متابعة")
        } else null
        state = state.copy(busyKey = "followup:save", error = null, message = null)
        viewModelScope.launch {
            val noteId = if (editor.noteId == null) {
                runCatching { source.createCustomerFollowUp(customer.id, requireNotNull(creationBranchId), editor) }.getOrElse {
                    customerOperationsOutcomeUnknown("تعذر التحقق من نتيجة إنشاء المتابعة. حدّث سجل المتابعات قبل تنفيذ إجراء آخر.")
                    return@launch
                }
            } else {
                runCatching { source.updateCustomerFollowUp(editor) }.getOrElse {
                    customerOperationsOutcomeUnknown("تعذر التحقق من نتيجة تعديل المتابعة. حدّث سجل المتابعات قبل تنفيذ إجراء آخر.")
                    return@launch
                }
                editor.noteId
            }
            val committed = if (editor.noteId == null) {
                CustomerFollowUp(
                    id = noteId,
                    customerId = customer.id,
                    customerName = customer.name,
                    customerPhone = customer.whatsapp ?: customer.phone,
                    note = editor.note.trim(),
                    followUpDate = editor.followUpDate.ifBlank { null },
                    isResolved = false,
                    createdByName = null,
                    branchId = creationBranchId,
                    createdAt = null,
                )
            } else {
                state.customerOperations.notesPage.rows.firstOrNull { it.id == noteId }
                    ?.copy(note = editor.note.trim(), followUpDate = editor.followUpDate.ifBlank { null })
                    ?: return@launch customerOperationsOutcomeUnknown("تم حفظ المتابعة، ويلزم تحديث سجل المتابعات.")
            }
            val currentRows = state.customerOperations.notesPage.rows
            val merged = if (editor.noteId == null) listOf(committed) + currentRows else currentRows.map {
                if (it.id == committed.id) committed else it
            }
            val due = mergeDueFollowUp(
                rows = state.customerOperations.dueRows,
                total = state.customerOperations.dueTotal,
                committed = committed,
                previous = previous,
            )
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    notesPage = CustomerFollowUpPage(merged, if (editor.noteId == null) state.customerOperations.notesPage.total + 1 else state.customerOperations.notesPage.total),
                    notesFresh = false,
                    dueRows = due.rows,
                    dueTotal = due.total,
                    dueFresh = false,
                    followUpEditor = null,
                ),
                message = if (editor.noteId == null) "تم إنشاء المتابعة" else "تم تحديث المتابعة",
            )
            refreshCustomerOperationsAfterCommit(customer.id)
        }
    }

    fun setFollowUpResolved(row: CustomerFollowUp, resolved: Boolean) {
        if (!capabilities.customers.canWrite || !state.canMutateCustomerFollowUps || row.isResolved == resolved) return
        if (row.customerId != state.selectedCustomer?.id) return
        state = state.copy(busyKey = "followup:resolve", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.resolveCustomerFollowUp(row.id, resolved) }.getOrElse {
                customerOperationsOutcomeUnknown("تعذر التحقق من نتيجة تحديث المتابعة. حدّث سجل المتابعات قبل تنفيذ إجراء آخر.")
                return@launch
            }
            val committed = row.copy(isResolved = resolved)
            val due = mergeDueFollowUp(
                rows = state.customerOperations.dueRows,
                total = state.customerOperations.dueTotal,
                committed = committed,
                previous = row,
            )
            val committedRows = state.customerOperations.notesPage.rows
                .map { if (it.id == row.id) committed else it }
                .filterNot { resolved && !state.customerOperations.includeResolved && it.id == row.id }
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    notesPage = state.customerOperations.notesPage.copy(
                        rows = committedRows,
                        total = if (resolved && !state.customerOperations.includeResolved) {
                            (state.customerOperations.notesPage.total - 1).coerceAtLeast(0)
                        } else state.customerOperations.notesPage.total,
                    ),
                    notesFresh = false,
                    dueRows = due.rows,
                    dueTotal = due.total,
                    dueFresh = false,
                ),
                message = if (resolved) "تم إنجاز المتابعة" else "أُعيد فتح المتابعة",
            )
            refreshCustomerOperationsAfterCommit(row.customerId)
        }
    }

    fun requestDeleteFollowUp(noteId: Long?) {
        if (!state.canMutateCustomerFollowUps) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(pendingDeleteFollowUpId = noteId),
        )
    }

    fun confirmDeleteFollowUp() {
        val customerId = state.selectedCustomer?.id ?: return
        val noteId = state.customerOperations.pendingDeleteFollowUpId ?: return
        if (!capabilities.customers.canWrite || !state.canMutateCustomerFollowUps) return
        val deleted = state.customerOperations.notesPage.rows.firstOrNull { it.id == noteId }
        state = state.copy(busyKey = "followup:delete", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.deleteCustomerFollowUp(noteId) }.getOrElse {
                customerOperationsOutcomeUnknown("تعذر التحقق من نتيجة حذف المتابعة. حدّث سجل المتابعات قبل تنفيذ إجراء آخر.")
                return@launch
            }
            val due = removeDueFollowUp(
                rows = state.customerOperations.dueRows,
                total = state.customerOperations.dueTotal,
                removed = deleted,
            )
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    notesPage = state.customerOperations.notesPage.copy(
                        rows = state.customerOperations.notesPage.rows.filterNot { it.id == noteId },
                        total = (state.customerOperations.notesPage.total - 1).coerceAtLeast(0),
                    ),
                    notesFresh = false,
                    dueRows = due.rows,
                    dueTotal = due.total,
                    dueFresh = false,
                    pendingDeleteFollowUpId = null,
                ),
                message = "تم حذف المتابعة",
            )
            refreshCustomerOperationsAfterCommit(customerId)
        }
    }

    fun beginCreateContractPrice() {
        if (!capabilities.customers.canWrite || !capabilities.products.canRead || !state.canMutateCustomerContracts) return
        if (capabilities.branchId == null) return setError("اختر فرع الجلسة قبل إضافة سعر تعاقدي")
        state = state.copy(
            customerOperations = state.customerOperations.copy(
                contractEditor = CustomerContractPriceDraft(),
                contractCatalogQuery = "",
                contractCatalogResults = emptyList(),
            ),
            error = null,
        )
    }

    fun loadMoreContractPrices() {
        val customer = state.selectedCustomer ?: return
        val operations = state.customerOperations
        if (!capabilities.customers.canWrite || !operations.contractsFresh || state.busyKey != null) return
        if (!operations.contractHasMore) return
        val cursor = operations.contractNextCursor
            ?: return setError("تعذر تحديد الصفحة التالية للأسعار التعاقدية. حدّث الأسعار ثم أعد المحاولة.")
        launch("contracts:more") {
            val next = source.contractPrices(customer.id, cursor)
            if (state.selectedCustomer?.id != customer.id) return@launch
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    contracts = (operations.contracts + next.rows).distinctBy { it.id },
                    contractTotal = next.total,
                    contractHasMore = next.hasMore,
                    contractNextCursor = next.nextCursor,
                    contractsFresh = true,
                ),
            )
        }
    }

    fun beginEditContractPrice(row: CustomerContractPrice) {
        if (!capabilities.customers.canWrite || !state.canMutateCustomerContracts) return
        if (row.customerId != state.selectedCustomer?.id) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(
                contractEditor = CustomerContractPriceDraft(
                    priceId = row.id,
                    productUnitId = row.productUnitId,
                    productLabel = row.productLabel,
                    price = row.price,
                    note = row.note.orEmpty(),
                ),
                contractCatalogQuery = "",
                contractCatalogResults = emptyList(),
            ),
            error = null,
        )
    }

    fun updateContractPriceDraft(draft: CustomerContractPriceDraft) {
        if (state.busyKey != null || state.customerOperations.contractEditor == null) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(contractEditor = draft),
            error = null,
        )
    }

    fun setContractCatalogQuery(value: String) {
        if (state.busyKey != null || state.customerOperations.contractEditor == null) return
        state = state.copy(customerOperations = state.customerOperations.copy(contractCatalogQuery = value.take(120)))
    }

    fun searchContractCatalog() {
        val customer = state.selectedCustomer ?: return
        val branchId = capabilities.branchId ?: return setError("اختر فرع الجلسة قبل البحث عن الأصناف")
        if (!capabilities.products.canRead || state.customerOperations.contractEditor == null) return
        launch("contract:catalog") {
            val rows = source.catalog(
                branchId,
                customer.priceTier,
                state.customerOperations.contractCatalogQuery,
                customer.id,
            )
            state = state.copy(customerOperations = state.customerOperations.copy(contractCatalogResults = rows))
        }
    }

    fun selectContractCatalogOption(option: CatalogOption) {
        val editor = state.customerOperations.contractEditor ?: return
        if (state.busyKey != null || editor.priceId != null) return
        val existing = state.customerOperations.contracts.firstOrNull { it.productUnitId == option.productUnitId }
        state = state.copy(
            customerOperations = state.customerOperations.copy(
                contractEditor = existing?.let {
                    CustomerContractPriceDraft(
                        priceId = it.id,
                        productUnitId = it.productUnitId,
                        productLabel = it.productLabel,
                        price = it.price,
                        note = it.note.orEmpty(),
                    )
                } ?: editor.copy(
                    productUnitId = option.productUnitId,
                    productLabel = option.label,
                    price = "",
                ),
                contractCatalogResults = emptyList(),
            ),
        )
    }

    fun closeContractPriceEditor() {
        if (state.busyKey != null) return
        state = state.copy(
            customerOperations = state.customerOperations.copy(
                contractEditor = null,
                contractCatalogResults = emptyList(),
            ),
            error = null,
        )
    }

    fun saveContractPrice() {
        val customer = state.selectedCustomer ?: return
        val editor = state.customerOperations.contractEditor ?: return
        if (!capabilities.customers.canWrite || !state.canMutateCustomerContracts) return
        CrmValidation.contractPrice(editor)?.let { return setError(it) }
        state = state.copy(busyKey = "contract:save", error = null, message = null)
        viewModelScope.launch {
            val mutation = runCatching { source.upsertContractPrice(customer.id, editor) }.getOrElse {
                contractOutcomeUnknown("تعذر التحقق من نتيجة حفظ السعر التعاقدي. حدّث الأسعار قبل تنفيذ إجراء آخر.")
                return@launch
            }
            val id = mutation.id
            val existing = state.customerOperations.contracts.firstOrNull { it.id == id || it.productUnitId == editor.productUnitId }
            val committed = existing?.copy(price = editor.price.trim(), note = editor.note.trim().ifBlank { null }, isActive = true)
                ?: CustomerContractPrice(
                    id = id,
                    customerId = customer.id,
                    productUnitId = requireNotNull(editor.productUnitId),
                    price = editor.price.trim(),
                    isActive = true,
                    note = editor.note.trim().ifBlank { null },
                    updatedAt = null,
                    productId = 0,
                    productName = editor.productLabel,
                    variantName = null,
                    color = null,
                    size = null,
                    sku = "",
                    unitName = "",
                )
            val nextTotal = if (mutation.updated) {
                state.customerOperations.contractTotal
            } else {
                state.customerOperations.contractTotal + 1
            }
            val nextRows = (listOf(committed) + state.customerOperations.contracts.filterNot {
                it.id == id || it.productUnitId == editor.productUnitId
            }).take(100)
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    contracts = nextRows,
                    contractTotal = nextTotal,
                    contractHasMore = nextRows.size < nextTotal,
                    contractNextCursor = null,
                    contractsFresh = false,
                    contractEditor = null,
                    contractCatalogResults = emptyList(),
                ),
                message = "تم حفظ السعر التعاقدي",
            )
            refreshContractsAfterCommit(customer.id)
        }
    }

    fun setContractPriceActive(row: CustomerContractPrice, active: Boolean) {
        if (!capabilities.customers.canWrite || !state.canMutateCustomerContracts || row.isActive == active) return
        state = state.copy(busyKey = "contract:active", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.setContractPriceActive(row.id, active) }.getOrElse {
                contractOutcomeUnknown("تعذر التحقق من نتيجة تحديث السعر التعاقدي. حدّث الأسعار قبل تنفيذ إجراء آخر.")
                return@launch
            }
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    contracts = state.customerOperations.contracts.map { if (it.id == row.id) it.copy(isActive = active) else it },
                    contractsFresh = false,
                ),
                message = if (active) "تم تفعيل السعر التعاقدي" else "تم تعطيل السعر التعاقدي",
            )
            refreshContractsAfterCommit(row.customerId)
        }
    }

    fun requestDeleteContractPrice(priceId: Long?) {
        if (!state.canMutateCustomerContracts) return
        state = state.copy(customerOperations = state.customerOperations.copy(pendingDeleteContractId = priceId))
    }

    fun confirmDeleteContractPrice() {
        val customerId = state.selectedCustomer?.id ?: return
        val priceId = state.customerOperations.pendingDeleteContractId ?: return
        if (!capabilities.customers.canWrite || !state.canMutateCustomerContracts) return
        state = state.copy(busyKey = "contract:delete", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.deleteContractPrice(priceId) }.getOrElse {
                contractOutcomeUnknown("تعذر التحقق من نتيجة حذف السعر التعاقدي. حدّث الأسعار قبل تنفيذ إجراء آخر.")
                return@launch
            }
            state = state.copy(
                customerOperations = state.customerOperations.copy(
                    contracts = state.customerOperations.contracts.filterNot { it.id == priceId },
                    contractTotal = (state.customerOperations.contractTotal - 1).coerceAtLeast(0),
                    contractHasMore = state.customerOperations.contracts.size - 1 <
                        (state.customerOperations.contractTotal - 1).coerceAtLeast(0),
                    contractNextCursor = null,
                    contractsFresh = false,
                    pendingDeleteContractId = null,
                ),
                message = "تم حذف السعر التعاقدي",
            )
            refreshContractsAfterCommit(customerId)
        }
    }

    fun setQuotationQuery(value: String) {
        state = state.copy(quotationQuery = value.take(200))
    }

    fun setQuotationFilter(status: QuotationStatus?) {
        if (!state.canCreateQuotation) return
        state = state.copy(quotationStatus = status)
        searchQuotations()
    }

    fun searchQuotations() {
        if (!state.canCreateQuotation) return
        launch("quotations:search") {
            require(capabilities.sales.canRead) { "لا توجد صلاحية لقراءة عروض الأسعار" }
            state = state.copy(quotationsLoaded = false, selectedQuotationFresh = false)
            state = state.quotationsRefreshed(source.quotations(state.quotationQuery, state.quotationStatus))
        }
    }

    fun loadMoreQuotations() {
        if (!state.canCreateQuotation) return
        val cursor = state.quotationPage.nextCursor ?: return
        launch("quotations:more") {
            val next = source.quotations(state.quotationQuery, state.quotationStatus, cursor)
            state = state.copy(
                quotationPage = next.copy(rows = state.quotationPage.rows + next.rows),
            )
        }
    }

    fun selectQuotation(id: Long) {
        if (!state.canCreateQuotation) return
        launch("quotation:$id") {
            require(capabilities.sales.canRead) { "لا توجد صلاحية لقراءة عروض الأسعار" }
            state = state.copy(selectedQuotation = null, selectedQuotationFresh = false, pendingQuotationRefreshId = id)
            state = state.copy(
                selectedQuotation = source.quotation(id),
                selectedQuotationFresh = true,
                pendingQuotationRefreshId = null,
                quotationEditor = null,
            )
        }
    }

    fun closeQuotationDetail() {
        state = state.copy(selectedQuotation = null, selectedQuotationFresh = false, pendingQuotationRefreshId = null, error = null)
    }

    fun beginCreateQuotation() {
        if (!capabilities.sales.canWrite || !state.canCreateQuotation) return
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
        if (!capabilities.sales.canWrite || !state.canMutateSelectedQuotation) return
        val detail = state.selectedQuotation?.takeIf(QuotationDetail::canEdit) ?: return
        state = state.copy(
            quotationEditor = QuotationEditor(detail.id, QuotationDraft.from(detail)),
            catalogResults = emptyList(),
            catalogQuery = "",
            error = null,
        )
    }

    fun updateQuotationDraft(draft: QuotationDraft) {
        if (!state.quotationsLoaded || state.busyKey != null) return
        state.quotationEditor?.let { state = state.copy(quotationEditor = it.copy(draft = draft), error = null) }
    }

    fun closeQuotationEditor() {
        if (state.busyKey != null) return
        state = state.copy(quotationEditor = null, catalogResults = emptyList(), error = null)
    }

    fun setCatalogQuery(value: String) {
        if (!state.quotationsLoaded || state.busyKey != null) return
        state = state.copy(catalogQuery = value.take(120))
    }

    fun searchCatalog() {
        if (!capabilities.products.canRead) return setError("لا توجد صلاحية لقراءة كتالوج الأصناف")
        if (!state.quotationsLoaded) return
        val draft = state.quotationEditor?.draft ?: return
        val branchId = draft.branchId ?: return setError("اختر الفرع قبل البحث عن الأصناف")
        launch("catalog:search") {
            state = state.copy(
                catalogResults = source.catalog(branchId, draft.priceTier, state.catalogQuery, draft.customerId),
            )
        }
    }

    fun addCatalogOption(option: CatalogOption) {
        if (!state.quotationsLoaded || state.busyKey != null) return
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
        if (!state.quotationsLoaded || state.busyKey != null) return
        val editor = state.quotationEditor ?: return
        if (index !in editor.draft.lines.indices) return
        val lines = editor.draft.lines.toMutableList().also { it[index] = line }
        state = state.copy(quotationEditor = editor.copy(draft = editor.draft.copy(lines = lines)))
    }

    fun removeQuotationLine(index: Int) {
        if (!state.quotationsLoaded || state.busyKey != null) return
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
        if (!state.quotationsLoaded || state.busyKey != null) return
        val editor = state.quotationEditor ?: return
        if (editor.quotationId != null &&
            (!state.selectedQuotationFresh || state.selectedQuotation?.id != editor.quotationId)
        ) return
        CrmValidation.quotation(editor.draft)?.let { return setError(it) }
        state = state.copy(busyKey = "quotation:save", error = null, message = null)
        viewModelScope.launch {
            val id = if (editor.quotationId == null) {
                runCatching { source.createQuotation(editor.draft) }.getOrElse {
                    // Quotation creation is idempotent. Keep the exact request id for a safe Retry.
                    state = state.quotationCreateRetryable(userMessage(it))
                    return@launch
                }
            } else {
                runCatching { source.updateQuotation(editor.quotationId, editor.draft) }.getOrElse {
                    state = state.quotationMutationUncertain(editor.quotationId)
                    return@launch
                }
                editor.quotationId
            }
            state = state.quotationSaveCommitted(id)
            runCatching { refreshQuotation(id) }
                .onSuccess { (page, detail) ->
                    state = state.quotationsRefreshed(page, detail).copy(
                        busyKey = null,
                        message = if (editor.quotationId == null) "تم إنشاء عرض السعر" else "تم تحديث عرض السعر",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم حفظ عرض السعر، وتعذر تحديث بياناته. حدّث العروض قبل تنفيذ إجراء آخر.",
                        message = null,
                    )
                }
        }
    }

    fun setQuotationStatus(status: QuotationStatus) {
        val quotation = state.selectedQuotation ?: return
        if (!capabilities.sales.canWrite ||
            !state.canMutateSelectedQuotation ||
            status !in quotation.status.allowedMutationTransitions()
        ) return
        state = state.copy(busyKey = "quotation:status", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.setQuotationStatus(quotation.id, status) }.getOrElse {
                state = state.quotationMutationUncertain(quotation.id)
                return@launch
            }
            state = state.quotationStatusCommitted(status)
            runCatching { refreshQuotation(quotation.id) }
                .onSuccess { (page, detail) ->
                    state = state.quotationsRefreshed(page, detail).copy(
                        busyKey = null,
                        message = "تم تحديث حالة عرض السعر",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم تحديث حالة عرض السعر، وتعذر تحديث بياناته. حدّث العروض قبل تنفيذ إجراء آخر.",
                        message = null,
                    )
                }
        }
    }

    fun beginCreateCampaign() {
        if (!capabilities.campaigns.canWrite || !state.canCreateCampaign) return
        state = state.copy(campaignEditor = CampaignDraft(branchId = capabilities.branchId), error = null)
    }

    fun updateCampaignDraft(draft: CampaignDraft) {
        if (!state.campaignsLoaded || state.busyKey != null) return
        if (state.campaignEditor != null) state = state.copy(campaignEditor = draft, error = null)
    }

    fun closeCampaignEditor() {
        if (state.busyKey != null) return
        state = state.copy(campaignEditor = null, error = null)
    }

    fun saveCampaign() {
        if (!capabilities.campaigns.canWrite) return setError("إنشاء الحملات يتطلب صلاحية كاملة")
        if (!state.canCreateCampaign) return
        val draft = state.campaignEditor ?: return
        CrmValidation.campaign(draft)?.let { return setError(it) }
        state = state.copy(busyKey = "campaign:save", error = null, message = null)
        viewModelScope.launch {
            val id = runCatching { source.createCampaign(draft) }.getOrElse {
                // This endpoint has no clientRequestId. A transport error may mean the campaign was
                // created, so the editor is closed and creation stays locked until a fresh list.
                state = state.campaignCreateUncertain()
                return@launch
            }
            state = state.campaignCreateCommitted(id)
            runCatching { source.campaigns() to source.dashboard() }
                .onSuccess { (campaigns, dashboard) ->
                    state = state.campaignsRefreshed(campaigns, dashboard).copy(
                        busyKey = null,
                        message = "تم إنشاء الحملة",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم إنشاء الحملة، وتعذر تحديث لوحة الحملات. حدّث البيانات قبل إنشاء حملة أخرى.",
                        message = null,
                    )
                }
        }
    }

    fun transitionCampaign(campaign: CampaignSummary, status: CampaignStatus) {
        val current = state.campaigns.firstOrNull { it.id == campaign.id } ?: return
        if (!capabilities.campaigns.canWrite || !state.canMutateCampaign || status !in current.allowedTransitions()) return
        state = state.copy(busyKey = "campaign:${current.id}", error = null, message = null)
        viewModelScope.launch {
            runCatching { source.transitionCampaign(current.id, status) }.getOrElse {
                state = state.campaignTransitionUncertain(current.id)
                return@launch
            }
            state = state.campaignTransitionCommitted(current.id, status)
            runCatching { source.campaigns() to source.dashboard() }
                .onSuccess { (campaigns, dashboard) ->
                    state = state.campaignsRefreshed(campaigns, dashboard).copy(
                        busyKey = null,
                        message = "تم تحديث حالة الحملة",
                    )
                }
                .onFailure {
                    state = state.copy(
                        busyKey = null,
                        error = "تم تحديث حالة الحملة، وتعذر تحديث لوحة الحملات. حدّث الحملات قبل تنفيذ إجراء آخر.",
                        message = null,
                    )
                }
        }
    }

    private suspend fun loadCustomerOperations(
        customerId: Long,
    ): Triple<Result<CustomerFollowUpPage>, Result<CustomerContractPricePage>, Result<CustomerFollowUpPage>> = coroutineScope {
        val notes = async {
            runCatching { source.customerFollowUps(customerId, state.customerOperations.includeResolved) }
        }
        val contracts = async {
            if (capabilities.customers.canWrite) runCatching { source.contractPrices(customerId) }
            else Result.success(CustomerContractPricePage(emptyList(), 0, false, null))
        }
        val due = async {
            if (capabilities.customers.canWrite) runCatching { source.dueCustomerFollowUps() }
            else Result.success(CustomerFollowUpPage(emptyList(), 0))
        }
        Triple(notes.await(), contracts.await(), due.await())
    }

    private suspend fun refreshCustomerOperationsAfterCommit(customerId: Long) {
        val results = loadCustomerOperations(customerId)
        if (state.selectedCustomer?.id != customerId) {
            state = state.copy(busyKey = null)
            return
        }
        val contractPage = results.second.getOrNull()
        val duePage = results.third.getOrNull()
        state = state.copy(
            busyKey = null,
            customerOperations = state.customerOperations.copy(
                notesPage = results.first.getOrNull() ?: state.customerOperations.notesPage,
                notesFresh = results.first.isSuccess,
                contracts = contractPage?.rows ?: state.customerOperations.contracts,
                contractTotal = contractPage?.total ?: state.customerOperations.contractTotal,
                contractHasMore = contractPage?.hasMore ?: state.customerOperations.contractHasMore,
                contractNextCursor = if (results.second.isSuccess) contractPage?.nextCursor else state.customerOperations.contractNextCursor,
                contractsFresh = results.second.isSuccess,
                dueRows = duePage?.rows ?: state.customerOperations.dueRows,
                dueTotal = duePage?.total ?: state.customerOperations.dueTotal,
                dueFresh = results.third.isSuccess,
            ),
            error = results.first.exceptionOrNull()?.let(::userMessage)
                ?: results.second.exceptionOrNull()?.let(::userMessage)
                ?: results.third.exceptionOrNull()?.let(::userMessage),
        )
    }

    private suspend fun refreshContractsAfterCommit(customerId: Long) {
        val result = runCatching { source.contractPrices(customerId) }
        if (state.selectedCustomer?.id != customerId) {
            state = state.copy(busyKey = null)
            return
        }
        state = state.copy(
            busyKey = null,
            customerOperations = state.customerOperations.copy(
                contracts = result.getOrNull()?.rows ?: state.customerOperations.contracts,
                contractTotal = result.getOrNull()?.total ?: state.customerOperations.contractTotal,
                contractHasMore = result.getOrNull()?.hasMore ?: state.customerOperations.contractHasMore,
                contractNextCursor = if (result.isSuccess) result.getOrNull()?.nextCursor else state.customerOperations.contractNextCursor,
                contractsFresh = result.isSuccess,
            ),
            error = result.exceptionOrNull()?.let {
                "تم تنفيذ الإجراء، وتعذر تحديث الأسعار التعاقدية. حدّث الأسعار قبل تنفيذ إجراء آخر."
            },
        )
    }

    private fun customerOperationsOutcomeUnknown(message: String) {
        state = state.copy(
            busyKey = null,
            customerOperations = state.customerOperations.copy(
                notesFresh = false,
                dueFresh = false,
                followUpEditor = null,
                pendingDeleteFollowUpId = null,
            ),
            error = message,
            message = null,
        )
    }

    private fun contractOutcomeUnknown(message: String) {
        state = state.copy(
            busyKey = null,
            customerOperations = state.customerOperations.copy(
                contractsFresh = false,
                contractEditor = null,
                contractCatalogResults = emptyList(),
                pendingDeleteContractId = null,
            ),
            error = message,
            message = null,
        )
    }

    private fun mergeDueFollowUp(
        rows: List<CustomerFollowUp>,
        total: Int,
        committed: CustomerFollowUp,
        previous: CustomerFollowUp?,
    ): DueSnapshot {
        val without = rows.filterNot { it.id == committed.id }
        val wasDue = previous?.let(::isDueFollowUp) == true
        val isDue = isDueFollowUp(committed)
        val nextTotal = when {
            !wasDue && isDue -> total + 1
            wasDue && !isDue -> (total - 1).coerceAtLeast(0)
            else -> total
        }
        val nextRows = if (isDue) {
            (without + committed)
                .sortedWith(compareBy<CustomerFollowUp> { it.followUpDate }.thenBy { it.id })
                .take(100)
        } else {
            without
        }
        return DueSnapshot(nextRows, nextTotal)
    }

    private fun removeDueFollowUp(
        rows: List<CustomerFollowUp>,
        total: Int,
        removed: CustomerFollowUp?,
    ): DueSnapshot = DueSnapshot(
        rows = rows.filterNot { it.id == removed?.id },
        total = if (removed?.let(::isDueFollowUp) == true) (total - 1).coerceAtLeast(0) else total,
    )

    private fun isDueFollowUp(row: CustomerFollowUp): Boolean {
        if (row.isResolved) return false
        val today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Baghdad")).toString()
        return row.followUpDate?.let { it <= today } == true
    }

    private suspend fun refreshCustomer(id: Long): Pair<CustomerPage, CustomerDetail> = coroutineScope {
        val page = async { source.searchCustomers(state.customerQuery, state.includeInactiveCustomers) }
        val detail = async { source.customer(id) }
        page.await() to detail.await()
    }

    private suspend fun refreshQuotation(id: Long): Pair<QuotationPage, QuotationDetail> = coroutineScope {
        val page = async { source.quotations(state.quotationQuery, state.quotationStatus) }
        val detail = async { source.quotation(id) }
        page.await() to detail.await()
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

private fun QuotationStatus.allowedMutationTransitions(): List<QuotationStatus> = when (this) {
    QuotationStatus.DRAFT -> listOf(
        QuotationStatus.SENT,
        QuotationStatus.ACCEPTED,
        QuotationStatus.REJECTED,
        QuotationStatus.EXPIRED,
    )
    QuotationStatus.SENT -> listOf(QuotationStatus.ACCEPTED, QuotationStatus.REJECTED, QuotationStatus.EXPIRED)
    QuotationStatus.ACCEPTED -> listOf(QuotationStatus.REJECTED, QuotationStatus.EXPIRED)
    QuotationStatus.REJECTED,
    QuotationStatus.CONVERTED,
    QuotationStatus.EXPIRED -> emptyList()
}

class CrmViewModelFactory(
    private val source: CrmDataSource,
    private val capabilities: CrmCapabilities,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CrmViewModel(source, capabilities) as T
}

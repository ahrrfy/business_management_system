package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.crm.BranchOption
import online.alarabiya.superapp.model.crm.CampaignDraft
import online.alarabiya.superapp.model.crm.CampaignStatus
import online.alarabiya.superapp.model.crm.CampaignSummary
import online.alarabiya.superapp.model.crm.CatalogOption
import online.alarabiya.superapp.model.crm.CrmDashboard
import online.alarabiya.superapp.model.crm.CrmMappers
import online.alarabiya.superapp.model.crm.CrmValidation
import online.alarabiya.superapp.model.crm.CustomerDetail
import online.alarabiya.superapp.model.crm.CustomerDraft
import online.alarabiya.superapp.model.crm.CustomerPage
import online.alarabiya.superapp.model.crm.PriceTier
import online.alarabiya.superapp.model.crm.QuotationDetail
import online.alarabiya.superapp.model.crm.QuotationDraft
import online.alarabiya.superapp.model.crm.QuotationPage
import online.alarabiya.superapp.model.crm.QuotationStatus
import org.json.JSONArray
import org.json.JSONObject

interface CrmDataSource {
    suspend fun searchCustomers(query: String, includeInactive: Boolean = false, offset: Int = 0): CustomerPage
    suspend fun customer(customerId: Long): CustomerDetail
    suspend fun createCustomer(draft: CustomerDraft): Long
    suspend fun updateCustomer(customerId: Long, draft: CustomerDraft)
    suspend fun setCustomerActive(customerId: Long, active: Boolean)
    suspend fun quotations(query: String, status: QuotationStatus? = null, cursor: Long? = null): QuotationPage
    suspend fun quotation(quotationId: Long): QuotationDetail
    suspend fun catalog(branchId: Long, tier: PriceTier, query: String, customerId: Long?): List<CatalogOption>
    suspend fun branches(): List<BranchOption>
    suspend fun createQuotation(draft: QuotationDraft): Long
    suspend fun updateQuotation(quotationId: Long, draft: QuotationDraft)
    suspend fun setQuotationStatus(quotationId: Long, status: QuotationStatus)
    suspend fun dashboard(): CrmDashboard
    suspend fun campaigns(): List<CampaignSummary>
    suspend fun createCampaign(draft: CampaignDraft): Long
    suspend fun transitionCampaign(id: Long, status: CampaignStatus)
}

class CrmRepository(private val api: TrpcClient) : CrmDataSource {
    override suspend fun searchCustomers(query: String, includeInactive: Boolean, offset: Int): CustomerPage {
        val input = JSONObject()
            .put("includeInactive", includeInactive)
            .put("limit", 100)
            .put("offset", offset.coerceAtLeast(0))
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        return CrmMappers.customerPage(api.query("customers.search", input))
    }

    override suspend fun customer(customerId: Long): CustomerDetail {
        require(customerId > 0) { "معرّف العميل غير صالح" }
        return CrmMappers.customerDetail(
            api.query("customers.get", JSONObject().put("customerId", customerId)),
        )
    }

    override suspend fun createCustomer(draft: CustomerDraft): Long {
        CrmValidation.customer(draft)?.let { throw IllegalArgumentException(it) }
        val requestId = draft.clientRequestId.trim()
        require(requestId.length in 8..64) { "مفتاح طلب إنشاء العميل غير صالح" }
        val result = api.mutate(
            "customers.create",
            customerInput(draft).put("clientRequestId", requestId),
        )
        return result.optLong("customerId", result.optLong("id")).also {
            require(it > 0) { "لم يُرجع الخادم معرّف العميل" }
        }
    }

    override suspend fun updateCustomer(customerId: Long, draft: CustomerDraft) {
        require(customerId > 0) { "معرّف العميل غير صالح" }
        CrmValidation.customer(draft)?.let { throw IllegalArgumentException(it) }
        api.mutate("customers.update", customerInput(draft).put("customerId", customerId))
    }

    override suspend fun setCustomerActive(customerId: Long, active: Boolean) {
        require(customerId > 0) { "معرّف العميل غير صالح" }
        api.mutate(
            if (active) "customers.activate" else "customers.deactivate",
            JSONObject().put("customerId", customerId),
        )
    }

    override suspend fun quotations(query: String, status: QuotationStatus?, cursor: Long?): QuotationPage {
        val input = JSONObject().put("limit", 60)
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        status?.let { input.put("status", it.name) }
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        return CrmMappers.quotationPage(api.query("quotations.list", input))
    }

    override suspend fun quotation(quotationId: Long): QuotationDetail {
        require(quotationId > 0) { "معرّف عرض السعر غير صالح" }
        return CrmMappers.quotationDetail(
            api.query("quotations.get", JSONObject().put("quotationId", quotationId)),
        )
    }

    override suspend fun catalog(
        branchId: Long,
        tier: PriceTier,
        query: String,
        customerId: Long?,
    ): List<CatalogOption> {
        require(branchId > 0) { "اختر الفرع قبل البحث عن الأصناف" }
        val input = JSONObject()
            .put("branchId", branchId)
            .put("tier", tier.name)
            .put("query", query.trim().take(120))
            .put("limit", 40)
            .put("customerId", customerId ?: JSONObject.NULL)
        return CrmMappers.catalogOptions(api.queryArray("catalog.posList", input))
    }

    override suspend fun branches(): List<BranchOption> = CrmMappers.branches(api.queryArray("branches.list"))

    override suspend fun createQuotation(draft: QuotationDraft): Long {
        CrmValidation.quotation(draft)?.let { throw IllegalArgumentException(it) }
        val requestId = draft.clientRequestId.trim()
        require(requestId.isNotEmpty() && requestId.length <= 80) { "مفتاح طلب عرض السعر غير صالح" }
        val result = api.mutate(
            "quotations.create",
            quotationInput(draft).put("clientRequestId", requestId),
        )
        return result.optLong("quotationId").also { require(it > 0) { "لم يُرجع الخادم معرّف عرض السعر" } }
    }

    override suspend fun updateQuotation(quotationId: Long, draft: QuotationDraft) {
        require(quotationId > 0) { "معرّف عرض السعر غير صالح" }
        CrmValidation.quotation(draft)?.let { throw IllegalArgumentException(it) }
        api.mutate("quotations.update", quotationInput(draft, includeBranch = false).put("quotationId", quotationId))
    }

    override suspend fun setQuotationStatus(quotationId: Long, status: QuotationStatus) {
        require(status != QuotationStatus.CONVERTED) { "تحويل العرض إلى فاتورة عملية مستقلة" }
        api.mutate(
            "quotations.setStatus",
            JSONObject().put("quotationId", quotationId).put("status", status.name),
        )
    }

    override suspend fun dashboard(): CrmDashboard = CrmMappers.dashboard(api.query("crm.dashboard"))

    override suspend fun campaigns(): List<CampaignSummary> = CrmMappers.campaigns(api.queryArray("crm.campaigns.list"))

    override suspend fun createCampaign(draft: CampaignDraft): Long {
        CrmValidation.campaign(draft)?.let { throw IllegalArgumentException(it) }
        val input = JSONObject()
            .put("name", draft.name.trim())
            .putNullable("objective", draft.objective)
            .put("branchId", draft.branchId ?: JSONObject.NULL)
            .putNullable("startsOn", draft.startsOn)
            .putNullable("endsOn", draft.endsOn)
        val result = api.mutate("crm.campaigns.create", input)
        return result.optLong("campaignId").also { require(it > 0) { "لم يُرجع الخادم معرّف الحملة" } }
    }

    override suspend fun transitionCampaign(id: Long, status: CampaignStatus) {
        require(id > 0) { "معرّف الحملة غير صالح" }
        api.mutate("crm.campaigns.transition", JSONObject().put("id", id).put("status", status.name))
    }

    private fun customerInput(draft: CustomerDraft): JSONObject = JSONObject()
        .put("name", draft.name.trim())
        .putNullable("phone", draft.phone)
        .putNullable("whatsapp", draft.whatsapp)
        .putNullable("address", draft.address)
        .putNullable("city", draft.city)
        .putNullable("district", draft.district)
        .put("customerType", draft.customerType.wire)
        .put("defaultPriceTier", draft.priceTier.name)
        .putNullable("notes", draft.notes)

    private fun quotationInput(draft: QuotationDraft, includeBranch: Boolean = true): JSONObject {
        val input = JSONObject()
            .put("customerId", draft.customerId ?: JSONObject.NULL)
            .put("priceTier", draft.priceTier.name)
            .putNullable("validUntil", draft.validUntil)
            .putNullable("invoiceDiscount", draft.invoiceDiscount)
            .putNullable("taxRatePercent", draft.taxRatePercent)
            .putNullable("notes", draft.notes)
            .put("lines", JSONArray().apply {
                draft.lines.forEach { line ->
                    put(
                        JSONObject()
                            .put("variantId", line.variantId)
                            .put("productUnitId", line.productUnitId)
                            .put("quantity", line.quantity.trim())
                            .putNullable("unitPriceOverride", line.unitPriceOverride)
                            .putNullable("discountPercent", line.discountPercent)
                            .putNullable("discountAmount", line.discountAmount),
                    )
                }
            })
        if (includeBranch) input.put("branchId", requireNotNull(draft.branchId))
        return input
    }
}

private fun JSONObject.putNullable(key: String, value: String): JSONObject =
    put(key, value.trim().takeIf(String::isNotEmpty) ?: JSONObject.NULL)

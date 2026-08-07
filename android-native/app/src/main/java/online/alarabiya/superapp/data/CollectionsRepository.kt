package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.collections.CancelCreditDecisionCommand
import online.alarabiya.superapp.model.collections.CollectionsCapabilities
import online.alarabiya.superapp.model.collections.CollectionsValidation
import online.alarabiya.superapp.model.collections.CreditDecision
import online.alarabiya.superapp.model.collections.CreditDecisionPage
import online.alarabiya.superapp.model.collections.CreditDecisionStatus
import org.json.JSONArray
import org.json.JSONObject

interface CollectionsDataSource {
    suspend fun creditDecisions(
        status: CreditDecisionStatus,
        customerId: Long? = null,
        offset: Int = 0,
        limit: Int = 50,
    ): CreditDecisionPage

    suspend fun cancelCreditDecision(command: CancelCreditDecisionCommand): Long
}

class CollectionsRepository(
    private val api: TrpcClient,
    private val capabilities: CollectionsCapabilities,
) : CollectionsDataSource {
    override suspend fun creditDecisions(
        status: CreditDecisionStatus,
        customerId: Long?,
        offset: Int,
        limit: Int,
    ): CreditDecisionPage {
        requireRead()
        require(customerId == null || customerId > 0) { "معرّف العميل غير صالح" }
        val safeOffset = offset.coerceAtLeast(0)
        val safeLimit = limit.coerceIn(1, 200)
        val input = JSONObject()
            .put("status", status.name)
            .put("limit", safeLimit)
            .put("offset", safeOffset)
        customerId?.let { input.put("customerId", it) }
        val response = api.query("creditApproval.list", input)
        return CreditDecisionPage(
            rows = response.optJSONArray("rows").objects().mapNotNull { it.toCreditDecisionOrNull(status) },
            total = response.optInt("total"),
            offset = safeOffset,
            limit = safeLimit,
        )
    }

    override suspend fun cancelCreditDecision(command: CancelCreditDecisionCommand): Long {
        require(capabilities.canCancelActiveDecision) { "إلغاء قرار الائتمان محصور بالمدير" }
        CollectionsValidation.cancel(command)?.let { throw IllegalArgumentException(it) }
        val response = api.mutate(
            "creditApproval.cancel",
            JSONObject().put("id", command.decisionId).put("reason", command.reason.trim()),
        )
        return response.optLong("id").takeIf { it > 0 } ?: error("لم يُرجع الخادم معرّف القرار الملغى")
    }

    private fun requireRead() {
        require(capabilities.canReadCreditDecisions) { "سجل قرارات الائتمان محصور بمدير النظام أو مدير الشركة" }
    }
}

internal fun JSONObject.toCreditDecisionOrNull(status: CreditDecisionStatus): CreditDecision? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    val customerId = optLong("customerId").takeIf { it > 0 } ?: return null
    return CreditDecision(
        id = id,
        customerId = customerId,
        customerName = optString("customerName", "—"),
        customerPhone = nullableText("customerPhone"),
        maxAmount = money("maxAmount"),
        approvedBy = nullableLong("approvedBy"),
        approvedByName = nullableText("approvedByName"),
        approvedAt = nullableText("approvedAt"),
        expiresAt = nullableText("expiresAt"),
        consumedAt = nullableText("consumedAt"),
        consumedByInvoiceId = nullableLong("consumedByInvoiceId"),
        notes = nullableText("notes"),
        status = status,
    )
}

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    val source = this@objects ?: return@buildList
    for (index in 0 until source.length()) source.optJSONObject(index)?.let(::add)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONObject.money(key: String): String = nullableText(key) ?: "0"

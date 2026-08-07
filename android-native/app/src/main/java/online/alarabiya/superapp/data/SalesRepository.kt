package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.sales.CatalogSaleItem
import online.alarabiya.superapp.model.sales.PaymentMethod
import online.alarabiya.superapp.model.sales.PriceTier
import online.alarabiya.superapp.model.sales.RetailShift
import online.alarabiya.superapp.model.sales.ReturnCreation
import online.alarabiya.superapp.model.sales.ReturnSubmission
import online.alarabiya.superapp.model.sales.ReturnableInvoice
import online.alarabiya.superapp.model.sales.SaleCreation
import online.alarabiya.superapp.model.sales.SaleDetail
import online.alarabiya.superapp.model.sales.SaleSubmission
import online.alarabiya.superapp.model.sales.SalesCustomer
import online.alarabiya.superapp.model.sales.SalesMappers
import online.alarabiya.superapp.model.sales.SalesPage
import online.alarabiya.superapp.model.sales.SalesValidation
import org.json.JSONArray
import org.json.JSONObject

interface SalesDataSource {
    suspend fun catalog(branchId: Long, tier: PriceTier, query: String, customerId: Long?): List<CatalogSaleItem>
    suspend fun customers(query: String): List<SalesCustomer>
    suspend fun openRetailShifts(branchId: Long): List<RetailShift>
    suspend fun createSale(submission: SaleSubmission): SaleCreation
    suspend fun sales(branchId: Long?, query: String, cursor: Long? = null): SalesPage
    suspend fun sale(invoiceId: Long): SaleDetail
    suspend fun returnableInvoice(invoiceId: Long): ReturnableInvoice
    suspend fun createReturn(submission: ReturnSubmission, invoice: ReturnableInvoice): ReturnCreation
}

class SalesRepository(private val api: TrpcClient) : SalesDataSource {
    override suspend fun catalog(
        branchId: Long,
        tier: PriceTier,
        query: String,
        customerId: Long?,
    ): List<CatalogSaleItem> {
        require(branchId > 0) { "لا يوجد فرع صالح للبحث" }
        val input = JSONObject()
            .put("branchId", branchId)
            .put("tier", tier.name)
            .put("query", query.trim().take(120))
            .put("limit", 80)
        customerId?.let { input.put("customerId", it) }
        return SalesMappers.catalog(api.queryArray("catalog.posList", input))
    }

    override suspend fun customers(query: String): List<SalesCustomer> {
        val input = JSONObject()
            .put("q", query.trim().take(120))
            .put("includeInactive", false)
            .put("limit", 50)
            .put("offset", 0)
        return SalesMappers.customers(api.query("customers.search", input))
    }

    override suspend fun openRetailShifts(branchId: Long): List<RetailShift> {
        require(branchId > 0) { "لا يوجد فرع صالح للوردية" }
        val input = JSONObject()
            .put("branchId", branchId)
            .put("status", "OPEN")
            .put("shiftType", "RETAIL")
            .put("limit", 100)
            .put("offset", 0)
        return SalesMappers.shifts(api.query("shifts.list", input))
    }

    override suspend fun createSale(submission: SaleSubmission): SaleCreation {
        SalesValidation.sale(submission)?.let { throw IllegalArgumentException(it) }
        return SalesMappers.creation(api.mutate("sales.create", SalesWire.saleInput(submission)))
    }

    override suspend fun sales(branchId: Long?, query: String, cursor: Long?): SalesPage {
        val input = JSONObject()
            .put("limit", 60)
            .put("sourceType", "POS")
        branchId?.takeIf { it > 0 }?.let { input.put("branchId", it) }
        query.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it.take(200)) }
        cursor?.takeIf { it > 0 }?.let { input.put("cursor", it) }
        return SalesMappers.page(api.query("sales.listPage", input))
    }

    override suspend fun sale(invoiceId: Long): SaleDetail {
        require(invoiceId > 0) { "معرّف الفاتورة غير صالح" }
        return SalesMappers.detail(api.query("sales.get", JSONObject().put("invoiceId", invoiceId)))
    }

    override suspend fun returnableInvoice(invoiceId: Long): ReturnableInvoice {
        require(invoiceId > 0) { "معرّف الفاتورة غير صالح" }
        return SalesMappers.returnableInvoice(
            api.query("returns.getInvoice", JSONObject().put("invoiceId", invoiceId)),
        )
    }

    override suspend fun createReturn(
        submission: ReturnSubmission,
        invoice: ReturnableInvoice,
    ): ReturnCreation {
        SalesValidation.salesReturn(submission, invoice)?.let { throw IllegalArgumentException(it) }
        return SalesMappers.returnCreation(api.mutate("returns.create", SalesWire.returnInput(submission)))
    }
}

/** Wire payloads stay isolated and testable: authority fields are intentionally never accepted from UI state. */
internal object SalesWire {
    fun saleInput(submission: SaleSubmission): JSONObject {
        val payment = JSONObject()
            .put("amount", submission.collectedAmount.trim())
            .put("method", submission.paymentMethod.name)
        submission.paymentReference.trim().takeIf(String::isNotEmpty)?.let {
            payment.put("reference", it.take(100))
        }
        val input = JSONObject()
            .put("branchId", submission.branchId)
            .put("priceTier", submission.priceTier.name)
            .put("sourceType", "POS")
            .put("lines", JSONArray().apply {
                submission.lines.forEach { line ->
                    put(
                        JSONObject()
                            .put("variantId", line.item.variantId)
                            .put("productUnitId", line.item.productUnitId)
                            .put("quantity", line.quantity.trim()),
                    )
                }
            })
            .put("payment", payment)
            .put("cashRoundIQD", submission.paymentMethod == PaymentMethod.CASH)
            .put("clientRequestId", submission.clientRequestId)
        submission.shiftId?.let { input.put("shiftId", it) }
        submission.customerId?.let { input.put("customerId", it) }
        submission.notes.trim().takeIf(String::isNotEmpty)?.let { input.put("notes", it.take(1_000)) }
        return input
    }

    fun returnInput(submission: ReturnSubmission): JSONObject {
        val input = JSONObject()
            .put("invoiceId", submission.invoiceId)
            .put("lines", JSONArray().apply {
                submission.quantities.filterValues { it > 0 }.forEach { (itemId, quantity) ->
                    put(JSONObject().put("invoiceItemId", itemId).put("baseQuantity", quantity))
                }
            })
            .put("restock", submission.restock)
            .put("clientRequestId", submission.clientRequestId)
        val amount = submission.refundAmount.trim()
        if (amount.isNotEmpty() && amount.toDoubleOrNull()?.let { it > 0 } == true) {
            val refund = JSONObject().put("amount", amount).put("method", submission.refundMethod.name)
            submission.refundShiftId?.let { refund.put("shiftId", it) }
            input.put("refund", refund)
        }
        return input
    }
}

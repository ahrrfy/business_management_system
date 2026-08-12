package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.insights.CashOrphanCategory
import online.alarabiya.superapp.model.insights.CashOrphanRowInsight
import online.alarabiya.superapp.model.insights.CashOrphansReportInsight
import online.alarabiya.superapp.model.insights.DayCloseDiscountInsight
import online.alarabiya.superapp.model.insights.DayCloseReportInsight
import online.alarabiya.superapp.model.insights.DayCloseShiftInsight
import online.alarabiya.superapp.model.insights.DayCloseTotalsInsight
import online.alarabiya.superapp.model.insights.InsightMoney
import online.alarabiya.superapp.model.insights.InventoryValuationReportInsight
import online.alarabiya.superapp.model.insights.InventoryValuationRowInsight
import online.alarabiya.superapp.model.insights.InventoryValuationTotalsInsight
import online.alarabiya.superapp.model.insights.ItemLedgerReportInsight
import online.alarabiya.superapp.model.insights.ItemLedgerRowInsight
import online.alarabiya.superapp.model.insights.ItemLedgerVariantInsight
import online.alarabiya.superapp.model.insights.PercentText
import online.alarabiya.superapp.model.insights.ProductionReportInsight
import online.alarabiya.superapp.model.insights.ProductionRowInsight
import online.alarabiya.superapp.model.insights.PurchaseRegisterReportInsight
import online.alarabiya.superapp.model.insights.PurchaseRegisterRowInsight
import online.alarabiya.superapp.model.insights.ReportCatalogKind
import online.alarabiya.superapp.model.insights.ReportCatalogQuery
import online.alarabiya.superapp.model.insights.ReportCatalogResult
import online.alarabiya.superapp.model.insights.ReportPageInfo
import online.alarabiya.superapp.model.insights.SalesRegisterReportInsight
import online.alarabiya.superapp.model.insights.SalesRegisterRowInsight
import online.alarabiya.superapp.model.insights.WorkOrderCountInsight
import online.alarabiya.superapp.model.insights.WorkOrdersReportInsight
import org.json.JSONArray
import org.json.JSONObject

/** Calls only reportViewerProcedure-backed endpoints; branch isolation is enforced again by the server. */
class NativeReportCatalogRepository(private val api: TrpcClient) {
    suspend fun load(query: ReportCatalogQuery): ReportCatalogResult {
        require(query.validationError() == null) { query.validationError().orEmpty() }
        return when (query.kind) {
            ReportCatalogKind.DAY_CLOSE -> api.query(
                "reports.dayCloseReconciliation",
                query.branchInput().put("date", query.range.to),
            ).let { ReportCatalogMapper.dayClose(it) }

            ReportCatalogKind.CASH_ORPHANS -> api.query(
                "reports.cashOrphans",
                query.datedInput()
                    .put("limit", query.pageSize)
                    .also { input -> query.orphanCategory.wireValue?.let { input.put("category", it) } },
            ).let { ReportCatalogMapper.cashOrphans(it, query) }

            ReportCatalogKind.SALES_REGISTER -> api.query(
                "reports.salesRegister",
                query.datedInput().put("limit", query.pageSize).put("offset", query.offset)
                    .also { input -> query.search.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it) } },
            ).let { ReportCatalogMapper.salesRegister(it, query) }

            ReportCatalogKind.INVENTORY_VALUATION -> api.query(
                "reports.inventoryValuation",
                query.branchInput(),
            ).let(ReportCatalogMapper::inventoryValuation)

            ReportCatalogKind.ITEM_LEDGER -> api.query(
                "reports.itemLedger",
                query.datedInput()
                    .put("variantId", requireNotNull(query.variantId))
                    .put("limit", query.pageSize)
                    .put("offset", query.offset),
            ).let { ReportCatalogMapper.itemLedger(it, query) }

            ReportCatalogKind.PURCHASE_REGISTER -> api.query(
                "reports.purchaseRegister",
                query.datedInput().put("limit", query.pageSize).put("offset", query.offset)
                    .also { input -> query.search.trim().takeIf(String::isNotEmpty)?.let { input.put("q", it) } },
            ).let { ReportCatalogMapper.purchaseRegister(it, query) }

            ReportCatalogKind.PRODUCTION -> api.query(
                "reports.productionReportPage",
                query.datedInput().put("limit", query.pageSize).put("offset", query.offset),
            ).let { ReportCatalogMapper.production(it, query) }

            ReportCatalogKind.WORK_ORDERS -> api.query(
                "reports.workOrdersReport",
                query.datedInput(),
            ).let(ReportCatalogMapper::workOrders)
        }
    }
}

object ReportCatalogMapper {
    fun dayClose(json: JSONObject): DayCloseReportInsight {
        val totals = json.optJSONObject("totals") ?: JSONObject()
        val extras = json.optJSONObject("receptionExtras") ?: JSONObject()
        val funded = extras.optJSONObject("fundedDrafts") ?: JSONObject()
        return DayCloseReportInsight(
            date = json.optString("date"),
            totals = DayCloseTotalsInsight(
                shiftCount = totals.safeCount("shiftCount"),
                openCount = totals.safeCount("openCount"),
                closedCount = totals.safeCount("closedCount"),
                expected = totals.money("expected"),
                counted = totals.money("counted"),
                drift = totals.money("drift"),
                cashIn = totals.money("cashIn"),
                operatingOut = totals.money("operatingOut"),
                handovers = totals.money("handoversCash"),
            ),
            balancedCount = json.safeCount("balancedCount"),
            overCount = json.safeCount("overCount"),
            shortCount = json.safeCount("shortCount"),
            fundedDraftCount = funded.safeCount("count"),
            fundedDraftAmount = funded.money("heldNet"),
            discounts = extras.optJSONArray("discountByUser").objects().map {
                DayCloseDiscountInsight(
                    userName = it.optString("userName", "غير معروف"),
                    invoiceCount = it.safeCount("invoiceCount"),
                    manualDiscount = it.money("manualDiscount"),
                    averageRate = PercentText.fromPercent(it.nullableText("avgRatePct")),
                )
            },
            shifts = json.optJSONArray("shifts").objects().mapNotNull { shift ->
                val id = shift.optLong("shiftId").takeIf { it > 0L } ?: return@mapNotNull null
                DayCloseShiftInsight(
                    shiftId = id,
                    branchName = shift.nullableText("branchName"),
                    userName = shift.nullableText("userName"),
                    shiftType = shift.optString("shiftType"),
                    status = shift.optString("status"),
                    openedAt = shift.optValueText("openedAt"),
                    closedAt = shift.nullableText("closedAt"),
                    expected = shift.money("expected"),
                    counted = shift.nullableMoney("counted"),
                    drift = shift.nullableMoney("drift"),
                    cashIn = shift.money("cashIn"),
                    operatingOut = shift.money("operatingOut"),
                    handovers = shift.money("handoversCash"),
                )
            },
        )
    }

    fun cashOrphans(json: JSONObject, query: ReportCatalogQuery): CashOrphansReportInsight {
        val rows = json.optJSONArray("rows").objects().mapNotNull { row ->
            val id = row.optLong("receiptId").takeIf { it > 0L } ?: return@mapNotNull null
            CashOrphanRowInsight(
                receiptId = id,
                branchName = row.nullableText("branchName"),
                direction = row.optString("direction"),
                amount = row.money("amount"),
                category = if (row.optString("category") == "TREASURY") {
                    CashOrphanCategory.TREASURY
                } else {
                    CashOrphanCategory.TRUE_ORPHAN
                },
                source = row.optString("source"),
                reference = row.nullableText("voucherNumber") ?: row.nullableText("referenceNumber"),
                description = row.nullableText("description"),
                createdAt = row.optValueText("createdAt"),
                createdBy = row.nullableText("createdByName"),
            )
        }
        val count = json.safeCount("count")
        return CashOrphansReportInsight(
            count = count,
            totalIn = json.money("totalIn"),
            totalOut = json.money("totalOut"),
            net = json.money("net"),
            treasuryCount = json.safeCount("countTreasury"),
            trueOrphanCount = json.safeCount("countTrueOrphan"),
            trueOrphanNet = json.money("netTrueOrphan"),
            rows = rows,
            pageInfo = ReportPageInfo(
                page = 0,
                pageSize = query.pageSize,
                total = count,
                hasPrevious = false,
                hasNext = false,
                serverWindowLimited = rows.size >= query.pageSize,
            ),
        )
    }

    fun salesRegister(json: JSONObject, query: ReportCatalogQuery): SalesRegisterReportInsight {
        val rows = json.optJSONArray("rows").objects().mapNotNull { row ->
            val id = row.optLong("id").takeIf { it > 0L } ?: return@mapNotNull null
            val invoiceId = row.optLong("invoiceId").takeIf { it > 0L } ?: return@mapNotNull null
            SalesRegisterRowInsight(
                id = id,
                invoiceId = invoiceId,
                invoiceNumber = row.optString("invoiceNumber"),
                date = row.optString("invoiceDate"),
                customerName = row.nullableText("customerName"),
                productName = row.optString("productName"),
                quantity = row.optString("quantity", "0"),
                unitPrice = row.money("unitPrice"),
                total = row.money("total"),
                profit = row.money("profit"),
            )
        }
        val totals = json.optJSONObject("totals") ?: JSONObject()
        val total = json.safeCount("total")
        return SalesRegisterReportInsight(
            revenue = totals.money("revenue"),
            cost = totals.money("cost"),
            profit = totals.money("profit"),
            quantity = totals.optString("qty", "0"),
            rows = rows,
            pageInfo = query.pageInfo(total, rows.size),
        )
    }

    fun inventoryValuation(json: JSONObject): InventoryValuationReportInsight {
        val totals = json.optJSONObject("totals") ?: JSONObject()
        val consignment = json.optJSONObject("consignment") ?: JSONObject()
        return InventoryValuationReportInsight(
            totals = totals.toValuationTotals(),
            consignment = consignment.toValuationTotals(),
            rows = json.optJSONArray("rows").objects().map {
                InventoryValuationRowInsight(
                    categoryId = it.nullableLong("categoryId"),
                    categoryName = it.optString("categoryName", "بلا فئة"),
                    items = it.safeCount("items"),
                    quantity = it.safeCount("totalQty"),
                    value = it.money("totalValue"),
                )
            },
        )
    }

    fun itemLedger(json: JSONObject, query: ReportCatalogQuery): ItemLedgerReportInsight {
        val variantJson = json.optJSONObject("variant")
        val variantId = variantJson?.optLong("variantId")?.takeIf { it > 0L }
        val rows = json.optJSONArray("rows").objects().mapNotNull { row ->
            val id = row.optLong("id").takeIf { it > 0L } ?: return@mapNotNull null
            ItemLedgerRowInsight(
                id = id,
                date = row.optString("date"),
                type = row.optString("type"),
                signedQuantity = row.optInt("signedQty"),
                balance = row.optInt("balance"),
                reference = row.nullableText("reference"),
            )
        }
        val total = json.safeCount("total")
        return ItemLedgerReportInsight(
            variant = if (variantId == null || variantJson == null) null else ItemLedgerVariantInsight(
                id = variantId,
                productName = variantJson.optString("productName"),
                label = variantJson.optString("label"),
                sku = variantJson.optString("sku"),
            ),
            openingBalance = json.optInt("openingBalance"),
            closingBalance = json.optInt("closingBalance"),
            rows = rows,
            pageInfo = query.pageInfo(total, rows.size),
        )
    }

    fun purchaseRegister(json: JSONObject, query: ReportCatalogQuery): PurchaseRegisterReportInsight {
        val rows = json.optJSONArray("rows").objects().mapNotNull { row ->
            val id = row.optLong("id").takeIf { it > 0L } ?: return@mapNotNull null
            val poId = row.optLong("poId").takeIf { it > 0L } ?: return@mapNotNull null
            PurchaseRegisterRowInsight(
                id = id,
                purchaseOrderId = poId,
                purchaseOrderNumber = row.nullableText("poNumber"),
                date = row.optString("orderDate"),
                supplierName = row.nullableText("supplierName"),
                productName = row.nullableText("productName"),
                quantity = row.optString("quantity", "0"),
                unitPrice = row.money("unitPrice"),
                total = row.money("total"),
            )
        }
        val total = json.safeCount("total")
        return PurchaseRegisterReportInsight(
            amount = (json.optJSONObject("totals") ?: JSONObject()).money("amount"),
            rows = rows,
            pageInfo = query.pageInfo(total, rows.size),
        )
    }

    fun production(json: JSONObject, query: ReportCatalogQuery): ProductionReportInsight {
        val rows = json.optJSONArray("rows").objects().mapNotNull { row ->
            val id = row.optLong("id").takeIf { it > 0L } ?: return@mapNotNull null
            ProductionRowInsight(
                id = id,
                documentNumber = row.nullableText("docNumber"),
                date = row.optString("date"),
                branchName = row.nullableText("branchName"),
                inputsCost = row.money("inputsCost"),
                laborCost = row.money("laborCost"),
                wasteCost = row.money("wasteCost"),
                totalCost = row.money("totalCost"),
            )
        }
        val totals = json.optJSONObject("totals") ?: JSONObject()
        val total = json.safeCount("total").coerceAtLeast(rows.size)
        return ProductionReportInsight(
            count = total,
            inputsCost = totals.money("inputsCost"),
            laborCost = totals.money("laborCost"),
            wasteCost = totals.money("wasteCost"),
            totalCost = totals.money("totalCost"),
            rows = rows,
            pageInfo = query.pageInfo(total, rows.size),
        )
    }

    fun workOrders(json: JSONObject): WorkOrdersReportInsight {
        val delivered = json.optJSONObject("delivered") ?: JSONObject()
        return WorkOrdersReportInsight(
            deliveredCount = delivered.safeCount("count"),
            revenue = delivered.money("totalRevenue"),
            materials = delivered.money("totalMaterials"),
            labor = delivered.money("totalLabor"),
            grossProfit = delivered.money("grossProfit"),
            statusDistribution = json.optJSONArray("statusDistribution").objects().map {
                WorkOrderCountInsight(it.optString("status"), it.optString("label"), it.safeCount("count"))
            },
            channelDistribution = json.optJSONArray("byChannel").objects().map {
                WorkOrderCountInsight(it.optString("channel"), it.optString("label"), it.safeCount("count"))
            },
        )
    }
}

private fun ReportCatalogQuery.branchInput(): JSONObject = JSONObject().also { input ->
    branchId?.let { input.put("branchId", it) }
}

private fun ReportCatalogQuery.datedInput(): JSONObject = branchInput()
    .put("from", range.from)
    .put("to", range.to)

private fun ReportCatalogQuery.pageInfo(total: Int, returned: Int) = ReportPageInfo(
    page = page,
    pageSize = pageSize,
    total = total.coerceAtLeast(0),
    hasPrevious = page > 0,
    hasNext = offset + returned < total,
)

private fun JSONObject.toValuationTotals() = InventoryValuationTotalsInsight(
    items = safeCount("items"),
    quantity = safeCount("totalQty"),
    value = money("totalValue"),
)

private fun JSONObject.money(key: String): InsightMoney = InsightMoney.fromServer(nullableText(key))

private fun JSONObject.nullableMoney(key: String): InsightMoney? = nullableText(key)?.let(InsightMoney::fromServer)

private fun JSONObject.safeCount(key: String): Int = optInt(key).coerceAtLeast(0)

private fun JSONObject.optValueText(key: String): String =
    if (!has(key) || isNull(key)) "" else opt(key)?.toString().orEmpty()

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0L }

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}

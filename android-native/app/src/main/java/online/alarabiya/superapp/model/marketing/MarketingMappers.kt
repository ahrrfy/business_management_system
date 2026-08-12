package online.alarabiya.superapp.model.marketing

import org.json.JSONArray
import org.json.JSONObject

object MarketingMappers {
    fun promotions(root: JSONArray): List<PromotionSummary> = buildList {
        for (index in 0 until root.length()) promotion(root.optJSONObject(index))?.let(::add)
    }

    fun promotionDetail(root: JSONObject): PromotionDetail {
        val value = promotion(root.optJSONObject("promotion"))
            ?: throw IllegalArgumentException("Invalid promotion payload")
        val targets = root.optJSONArray("targets") ?: JSONArray()
        return PromotionDetail(
            promotion = value,
            targets = buildList {
                for (index in 0 until targets.length()) {
                    val row = targets.optJSONObject(index) ?: continue
                    add(
                        PromotionTarget(
                            categoryId = row.nullableLong("categoryId"),
                            productId = row.nullableLong("productId"),
                            variantId = row.nullableLong("variantId"),
                        ),
                    )
                }
            },
        )
    }

    fun couponPrograms(root: JSONArray): List<CouponProgram> = buildList {
        for (index in 0 until root.length()) {
            val row = root.optJSONObject(index) ?: continue
            val id = row.optLong("id")
            val promotionId = row.optLong("promotionId")
            val name = row.optString("name")
            if (id <= 0 || promotionId <= 0 || name.isBlank()) continue
            val design = row.optJSONObject("designJson")
            add(
                CouponProgram(
                    id = id,
                    campaignId = row.nullableLong("campaignId"),
                    promotionId = promotionId,
                    name = name,
                    status = CouponProgramStatus.fromWire(row.nullableString("status")),
                    branchId = row.nullableLong("branchId"),
                    validFrom = row.ymd("validFrom"),
                    validTo = row.nullableString("validTo")?.take(10),
                    perCouponLimit = row.optInt("perCouponLimit", 1),
                    perCustomerLimit = row.optInt("perCustomerLimit", 1),
                    codePrefix = row.optString("codePrefix", "CRM"),
                    designTitle = design?.nullableString("title"),
                    designSubtitle = design?.nullableString("subtitle"),
                    designTerms = design?.nullableString("terms"),
                    designColor = design?.nullableString("color"),
                    issued = row.optInt("issued").coerceAtLeast(0),
                    redeemed = row.optInt("redeemed").coerceAtLeast(0),
                    createdAt = row.nullableString("createdAt"),
                ),
            )
        }
    }

    fun issuedCoupons(root: JSONObject, offset: Int, limit: Int): IssuedCouponPage {
        val rows = root.optJSONArray("rows") ?: JSONArray()
        return IssuedCouponPage(
            rows = buildList {
                for (index in 0 until rows.length()) {
                    val row = rows.optJSONObject(index) ?: continue
                    val id = row.optLong("id")
                    val programId = row.optLong("programId")
                    val code = row.optString("code")
                    if (id <= 0 || programId <= 0 || code.isBlank()) continue
                    add(
                        IssuedCoupon(
                            id = id,
                            programId = programId,
                            code = code,
                            customerId = row.nullableLong("customerId"),
                            status = CouponStatus.fromWire(row.nullableString("status")),
                            redemptionCount = row.optInt("redemptionCount").coerceAtLeast(0),
                            issuedAt = row.nullableString("issuedAt"),
                        ),
                    )
                }
            },
            total = root.optInt("total").coerceAtLeast(0),
            activeCount = root.optInt("activeCount").coerceAtLeast(0),
            offset = offset.coerceAtLeast(0),
            limit = limit.coerceIn(1, 500),
        )
    }

    fun couponPreview(root: JSONObject): CouponPreview {
        val rows = root.optJSONArray("lines") ?: JSONArray()
        return CouponPreview(
            code = root.optString("code"),
            programName = root.optString("programName"),
            lines = buildList {
                for (index in 0 until rows.length()) {
                    val row = rows.optJSONObject(index) ?: continue
                    val unitId = row.optLong("productUnitId")
                    val promotionId = row.optLong("promotionId")
                    if (unitId <= 0 || promotionId <= 0) continue
                    add(
                        CouponPriceEffect(
                            productUnitId = unitId,
                            promotionId = promotionId,
                            promotionName = row.optString("promotionName"),
                            discountPerUnit = row.optString("promotionDiscountForUnit", "0"),
                            effectivePrice = row.optString("promotionEffectivePrice", "0"),
                        ),
                    )
                }
            },
        )
    }

    fun anomalyPage(root: JSONObject, offset: Int, limit: Int): CatalogAnomalyPage {
        val findings = root.optJSONArray("findings") ?: JSONArray()
        val counts = root.optJSONObject("counts") ?: JSONObject()
        val truncated = root.optJSONArray("truncatedLenses") ?: JSONArray()
        return CatalogAnomalyPage(
            findings = buildList {
                for (index in 0 until findings.length()) anomaly(findings.optJSONObject(index))?.let(::add)
            },
            blockerCount = counts.optInt("blocker").coerceAtLeast(0),
            warningCount = counts.optInt("warning").coerceAtLeast(0),
            infoCount = counts.optInt("info").coerceAtLeast(0),
            overriddenCount = root.optInt("overriddenCount").coerceAtLeast(0),
            total = root.optInt("total").coerceAtLeast(0),
            hasMore = root.optBoolean("hasMore"),
            truncatedLenses = buildList {
                for (index in 0 until truncated.length()) truncated.optString(index).takeIf(String::isNotBlank)?.let(::add)
            },
            offset = offset.coerceAtLeast(0),
            limit = limit.coerceIn(1, 500),
        )
    }

    private fun promotion(row: JSONObject?): PromotionSummary? {
        row ?: return null
        val id = row.optLong("id")
        val name = row.optString("name")
        if (id <= 0 || name.isBlank()) return null
        return PromotionSummary(
            id = id,
            campaignId = row.nullableLong("campaignId"),
            name = name,
            description = row.nullableString("description"),
            type = PromotionType.fromWire(row.nullableString("type")),
            discountPercent = row.optString("discountPercent", "0"),
            discountAmount = row.optString("discountAmount", "0"),
            scope = PromotionScope.fromWire(row.nullableString("scope")),
            effectiveFrom = row.ymd("effectiveFrom"),
            effectiveTo = row.nullableString("effectiveTo")?.take(10),
            customerTier = CustomerTier.fromWire(row.nullableString("customerTier")),
            branchId = row.nullableLong("branchId"),
            minLineAmount = row.optString("minLineAmount", "0"),
            priority = row.optInt("priority"),
            isActive = row.optBoolean("isActive"),
            mode = PromotionMode.fromWire(row.nullableString("applicationMode")),
            channel = if (row.optBoolean("isStoreManaged")) PromotionChannel.Store else PromotionChannel.Pos,
        )
    }

    private fun anomaly(row: JSONObject?): CatalogAnomaly? {
        row ?: return null
        val variantId = row.optLong("variantId")
        val productId = row.optLong("productId")
        val productName = row.optString("productName")
        if (variantId <= 0 || productId <= 0 || productName.isBlank()) return null
        val metricsJson = row.optJSONObject("metrics") ?: JSONObject()
        val override = row.optJSONObject("override")
        return CatalogAnomaly(
            variantId = variantId,
            productId = productId,
            sku = row.optString("sku"),
            productName = productName,
            code = AnomalyCode.fromWire(row.nullableString("code")),
            severity = AnomalySeverity.fromWire(row.nullableString("severity")),
            metrics = buildMap {
                val keys = metricsJson.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (!metricsJson.isNull(key)) metricsJson.opt(key)?.toString()?.let { put(key, it) }
                }
            },
            note = row.optString("note"),
            overrideKind = override?.nullableString("kind"),
            overrideUntil = override?.nullableString("excludeUntil")?.take(10),
        )
    }
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONObject.ymd(key: String): String = nullableString(key)?.take(10).orEmpty()

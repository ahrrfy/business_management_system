import { sql, type SQL } from "drizzle-orm";

/** Item quantities remain whole units. Only reviewed, still-unabsorbed component credits reduce line value. */
export function componentRightsNetRevenueSql(input: {
  itemId: SQL;
  baseQuantity: SQL;
  returnedQuantity: SQL;
  invoiceSubtotal: SQL;
  invoiceDiscount: SQL;
  invoiceTax: SQL;
  ordinary: SQL;
}): SQL {
  const remainingCredit = sql`COALESCE((SELECT SUM(cra.commercialAmount - ROUND(cra.commercialAmount * LEAST(GREATEST(${input.returnedQuantity} - cra.normalReturnedBaseQuantity, 0), ${input.baseQuantity} - cra.normalReturnedBaseQuantity) / NULLIF(${input.baseQuantity} - cra.normalReturnedBaseQuantity, 0), 2)) FROM componentRightsAdjustments cra WHERE cra.invoiceItemId = ${input.itemId} AND cra.originalBundleComponentId IS NOT NULL), 0)`;
  // Existing item reports use pre-header-discount line totals. Reverse exactly that same basis.
  const multiplier = sql`CASE WHEN ${input.invoiceSubtotal} > 0 THEN ((${input.invoiceSubtotal} - ${input.invoiceDiscount} + ${input.invoiceTax}) / ${input.invoiceSubtotal}) ELSE 1 END`;
  return sql`GREATEST(0, ${input.ordinary} - COALESCE(${remainingCredit} / NULLIF(${multiplier}, 0), 0))`;
}

/** Actual source-linked restorations, including subsequent ordinary returns, have one projection owner per item. */
export function componentRightsNetCostSql(input: {
  itemId: SQL;
  originalCost: SQL;
  ordinary: SQL;
}): SQL {
  return sql`CASE WHEN EXISTS(SELECT 1 FROM componentRightsAdjustments crc WHERE crc.invoiceItemId = ${input.itemId}) THEN GREATEST(0, ${input.originalCost} - COALESCE((SELECT SUM(crc.restoredValue + crc.priorRestoredValue + crc.subsequentRestoredValue) FROM componentRightsAdjustments crc WHERE crc.invoiceItemId = ${input.itemId}), 0)) ELSE ${input.ordinary} END`;
}

export const componentRightsRawRevenueSql = (ordinary: SQL) =>
  componentRightsNetRevenueSql({
    itemId: sql`ii.id`,
    baseQuantity: sql`ii.baseQuantity`,
    returnedQuantity: sql`COALESCE(ii.returnedBaseQuantity, 0)`,
    invoiceSubtotal: sql`i.subtotal`,
    invoiceDiscount: sql`i.discountAmount`,
    invoiceTax: sql`i.taxAmount`,
    ordinary,
  });
export const componentRightsRawCostSql = (ordinary: SQL) =>
  componentRightsNetCostSql({
    itemId: sql`ii.id`,
    originalCost: sql`ii.lineCost`,
    ordinary,
  });

/** Reporting only: delivery remains an invoice-level revenue, never a product margin. */
export function reportInvoiceDeliveryRevenueSql(): SQL {
  return sql`CASE WHEN i.invoiceStatus = 'RETURNED' OR (COALESCE(i.returnedTotal, 0) > 0 AND i.total <= i.returnedTotal) THEN 0
    ELSE LEAST(GREATEST(COALESCE(i.total, 0) - COALESCE(i.cashRoundingAdjustment, 0) - COALESCE(i.returnedTotal, 0), 0), COALESCE(i.deliveryFee, 0)) END`;
}

/** Signed return tax is authoritative when present; old imported invoices use the same tax ratio. */
export function reportInvoiceOriginalGoodsRevenueSql(): SQL {
  return sql`GREATEST(i.total - COALESCE(i.cashRoundingAdjustment, 0) - COALESCE(i.taxAmount, 0) - COALESCE(i.deliveryFee, 0), 0)`;
}

export function reportInvoiceGoodsRevenueSql(): SQL {
  // Cash rounding is posted separately; it is neither a goods discount nor delivery revenue.
  const remainingGross = sql`CASE WHEN i.invoiceStatus = 'RETURNED' OR (COALESCE(i.returnedTotal, 0) > 0 AND i.total <= i.returnedTotal) THEN 0
    ELSE GREATEST(i.total - COALESCE(i.cashRoundingAdjustment, 0) - COALESCE(i.returnedTotal, 0) - (${reportInvoiceDeliveryRevenueSql()}), 0) END`;
  const remainingTax = sql`CASE WHEN COALESCE(i.taxAmount, 0) = 0 OR ${remainingGross} = 0 THEN 0 ELSE GREATEST(0, COALESCE(
    i.taxAmount + (SELECT SUM(rt.taxAmount) FROM accountingEntries rt WHERE rt.invoiceId = i.id AND rt.entryType = 'RETURN' AND rt.supplierId IS NULL),
    ROUND(${remainingGross} * i.taxAmount / NULLIF(i.total - COALESCE(i.cashRoundingAdjustment, 0) - COALESCE(i.deliveryFee, 0), 0), 2)
  )) END`;
  return sql`GREATEST(${remainingGross} - (${remainingTax}), 0)`;
}

/**
 * Allocate the retained, pre-tax goods value using the remaining commercial rights as weights.
 * Rounded cumulative differences conserve every cent across each invoice, including head discounts,
 * partial returns and component credits. Never filter a product/search inside this projection:
 * doing so would redistribute a whole invoice's value to only the matched products.
 */
export function invoiceLineReportProjectionSql(invoiceScope: SQL): SQL {
  const weight = componentRightsRawRevenueSql(sql`CASE WHEN ii.baseQuantity > 0
    THEN ii.total * GREATEST(ii.baseQuantity - COALESCE(ii.returnedBaseQuantity, 0), 0) / ii.baseQuantity
    ELSE ii.total END`);
  return sql`SELECT allocated.id, allocated.invoiceId,
    CASE WHEN allocated.weightTotal > 0 THEN
      ROUND(allocated.goodsValue * allocated.weightCumulative / allocated.weightTotal, 2)
      - ROUND(allocated.goodsValue * (allocated.weightCumulative - allocated.weight) / allocated.weightTotal, 2)
      ELSE 0 END AS revenue,
    CASE WHEN allocated.originalTotal > 0 THEN
      ROUND(allocated.originalGoodsValue * allocated.originalCumulative / allocated.originalTotal, 2)
      - ROUND(allocated.originalGoodsValue * (allocated.originalCumulative - allocated.originalWeight) / allocated.originalTotal, 2)
      ELSE 0 END AS originalRevenue
    FROM (
      SELECT weighted.*,
        SUM(weighted.weight) OVER (PARTITION BY weighted.invoiceId) AS weightTotal,
        SUM(weighted.weight) OVER (PARTITION BY weighted.invoiceId ORDER BY weighted.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS weightCumulative,
        SUM(weighted.originalWeight) OVER (PARTITION BY weighted.invoiceId) AS originalTotal,
        SUM(weighted.originalWeight) OVER (PARTITION BY weighted.invoiceId ORDER BY weighted.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS originalCumulative
      FROM (
        SELECT ii.id, ii.invoiceId, ${weight} AS weight, GREATEST(ii.total, 0) AS originalWeight,
          ${reportInvoiceGoodsRevenueSql()} AS goodsValue,
          ${reportInvoiceOriginalGoodsRevenueSql()} AS originalGoodsValue
        FROM invoiceItems ii JOIN invoices i ON i.id = ii.invoiceId
        WHERE ${invoiceScope}
      ) weighted
    ) allocated`;
}

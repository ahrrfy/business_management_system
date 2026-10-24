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

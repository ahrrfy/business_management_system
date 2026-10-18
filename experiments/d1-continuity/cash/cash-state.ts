import { baghdadToday } from '../../../server/services/businessDay';
import { tables, quote } from './schema';

export function cashReadBoundary(now = new Date()) {
  return { utcDay: now.toISOString().slice(0, 10), baghdadDay: baghdadToday(now) };
}
export function assertCashReadBoundary(boundary: any, now = new Date()) {
  const current = cashReadBoundary(now);
  if (!boundary || boundary.utcDay !== current.utcDay || boundary.baghdadDay !== current.baghdadDay)
    throw Object.assign(new Error('STALE_SNAPSHOT_RETRY_SAME_REQUEST'), {code:'STALE_SNAPSHOT_RETRY_SAME_REQUEST',status:409});
}

// Keep each SQLite JSON function within D1's32-argument limit.
export function rowJsonSql(names: string[]) {
  let sql = 'json_object(' + names.slice(0,15).flatMap(n=>["'"+n+"'",quote(n)]).join(',') + ')';
  for(let i=15;i<names.length;i+=15)
    sql='json_set('+sql+','+names.slice(i,i+15).flatMap(n=>["'$.'||'"+n+"'",quote(n)]).join(',')+')';
  return sql;
}

// The one bound envelope contains only admitted IDs/tier and captured dates.
// Every subquery and sequence value shares the cashEpoch SQL snapshot.
const ctes = `WITH cashScope AS (
 SELECT json_extract(j,'$.input.branchId') branchId,json_extract(j,'$.input.shiftId') shiftId,
 json_extract(j,'$.actor.userId') userId,json_extract(j,'$.input.clientRequestId') requestId,
 COALESCE(json_extract(j,'$.input.priceTier'),'RETAIL') tier,
 json_extract(j,'$.utcDay') utcDay,json_extract(j,'$.baghdadDay') baghdadDay,j
 FROM (SELECT json(?) j)
), cashLines AS (SELECT json_extract(value,'$.variantId') variantId,json_extract(value,'$.productUnitId') unitId FROM cashScope,json_each(j,'$.input.lines')),
 cashReplay AS (SELECT id FROM invoices WHERE sourceId=(SELECT requestId FROM cashScope)),
 cashHeld AS (
 SELECT i.* FROM onlineOrderItems i JOIN onlineOrders o ON o.id=i.onlineOrderId
 WHERE o.branchId=(SELECT branchId FROM cashScope)
 AND (o.orderStatus IN ('CONFIRMED','PROCESSING') OR (o.orderStatus='PENDING' AND COALESCE(o.reservationExpiresAt,datetime(o.orderDate,'+24 hours'))>CURRENT_TIMESTAMP))
 AND (i.variantId IN(SELECT variantId FROM cashLines) OR i.variantId IN(SELECT bundleVariantId FROM bundleComponents WHERE componentVariantId IN(SELECT variantId FROM cashLines)))
), cashUnits AS (
 SELECT unitId id FROM cashLines UNION SELECT productUnitId FROM cashHeld
 UNION SELECT productUnitId FROM invoiceItems WHERE invoiceId IN(SELECT id FROM cashReplay)
), cashVariants AS (
 SELECT variantId id FROM cashLines UNION SELECT variantId FROM productUnits WHERE id IN(SELECT id FROM cashUnits)
 UNION SELECT variantId FROM cashHeld UNION SELECT variantId FROM invoiceItems WHERE invoiceId IN(SELECT id FROM cashReplay)
), cashBounce AS (
 SELECT c.id FROM couponPrograms c JOIN promotions p ON c.promotionId=p.id
 WHERE c.couponProgramStatus='ACTIVE' AND(c.branchId IS NULL OR c.branchId=(SELECT branchId FROM cashScope))
 AND c.validFrom<=(SELECT baghdadDay FROM cashScope) AND(c.validTo IS NULL OR c.validTo>=(SELECT baghdadDay FROM cashScope))
 AND p.isActive=1 AND p.promotionApplicationMode='COUPON' AND(p.branchId IS NULL OR p.branchId=(SELECT branchId FROM cashScope))
 AND(p.promotionCustomerTier IS NULL OR p.promotionCustomerTier=(SELECT tier FROM cashScope))
 AND p.effectiveFrom<=(SELECT baghdadDay FROM cashScope) AND(p.effectiveTo IS NULL OR p.effectiveTo>=(SELECT baghdadDay FROM cashScope))
 ORDER BY c.branchId DESC,c.id DESC LIMIT 10
), cashCoupons AS (SELECT couponId id FROM couponRedemptions WHERE invoiceId IN(SELECT id FROM cashReplay)),
 cashPrograms AS (SELECT id FROM cashBounce UNION SELECT programId FROM coupons WHERE id IN(SELECT id FROM cashCoupons))`;

const selectors: Record<string,string> = {
 branches:'id IN(SELECT branchId FROM cashScope UNION SELECT branchId FROM shifts WHERE id=(SELECT shiftId FROM cashScope) UNION SELECT branchId FROM users WHERE id=(SELECT userId FROM cashScope))',
 users:'id IN(SELECT userId FROM cashScope UNION SELECT userId FROM shifts WHERE id=(SELECT shiftId FROM cashScope))',
 customers:'id IN(SELECT customerId FROM onlineOrders WHERE id IN(SELECT onlineOrderId FROM cashHeld) UNION SELECT customerId FROM invoices WHERE id IN(SELECT id FROM cashReplay) UNION SELECT customerId FROM coupons WHERE id IN(SELECT id FROM cashCoupons))',
 monthCloseSequence:'id=1',
 shifts:'id=(SELECT shiftId FROM cashScope)',
 products:'id IN(SELECT productId FROM productVariants WHERE id IN(SELECT id FROM cashVariants))',
 productVariants:'id IN(SELECT id FROM cashVariants)',
 productUnits:'id IN(SELECT id FROM cashUnits)',
 productPrices:'productUnitId IN(SELECT unitId FROM cashLines) AND priceTier=(SELECT tier FROM cashScope)',
 branchStock:'branchId=(SELECT branchId FROM cashScope) AND variantId IN(SELECT variantId FROM cashLines)',
 reservationStock:'branchId=(SELECT branchId FROM cashScope) AND variantId IN(SELECT variantId FROM cashLines)',
 invoices:'id IN(SELECT id FROM cashReplay)',
 invoiceItems:'invoiceId IN(SELECT id FROM cashReplay)',
 inventoryMovements:'0',receipts:'0',accountingEntries:'0',invoiceAttributions:'0',
 idempotencyKeys:"operation='sale.create' AND clientRequestId=(SELECT requestId FROM cashScope)",
 documentCounters:"counterKey='invoice'",
 financialPeriods:"id IN(SELECT id FROM financialPeriods WHERE periodStatus='LOCKED' ORDER BY cutoffDate DESC,id DESC LIMIT 1)",
 doubleEntrySettings:'id=1',openingModeSettings:'id=1',
 onlineOrders:'id IN(SELECT onlineOrderId FROM cashHeld)',
 onlineOrderItems:'id IN(SELECT id FROM cashHeld)',
 bundleComponents:'componentVariantId IN(SELECT variantId FROM cashLines) AND bundleVariantId IN(SELECT variantId FROM cashHeld)',
 promotions:'id IN(SELECT promotionId FROM couponPrograms WHERE id IN(SELECT id FROM cashPrograms))',
 promotionTargets:'0',couponPrograms:'id IN(SELECT id FROM cashPrograms)',
 cashDailyReconciliations:'branchId=(SELECT branchId FROM cashScope) AND businessDate=(SELECT utcDay FROM cashScope)',
 couponRedemptions:'invoiceId IN(SELECT id FROM cashReplay)',coupons:'id IN(SELECT id FROM cashCoupons)',deliveryConsignments:'0',
};
export const cashProjectionSql = (() => {
  const pieces=tables.map(t=>{
    const where=selectors[t.name];if(where===undefined)throw Error('MISSING_CASH_SCOPE_POLICY:'+t.name);
    return '(SELECT json_group_array(json(rowJson)) FROM (SELECT '+rowJsonSql(t.columns.map(c=>c.name))+' AS rowJson FROM '+quote(t.name)+' WHERE '+where+' ORDER BY '+t.primary.map(quote).join(',')+')) AS '+quote(t.name);
  });
  return ctes+' SELECT epoch,(SELECT json_group_object(name,seq) FROM sqlite_sequence WHERE name IN('+tables.filter(t=>t.columns.some(c=>c.auto)).map(t=>"'"+t.name+"'").join(',')+')) AS sequences,'+pieces.join(',')+' FROM cashEpoch WHERE id=1';
})();

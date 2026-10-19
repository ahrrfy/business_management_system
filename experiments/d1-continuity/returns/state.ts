import { scopeCtes, cashSelectors, projectionSql } from "../cash/cash-state";
import { tables } from "./schema";
const ctes =
  scopeCtes(
    "COALESCE(json_extract(j,'$.input.priceTier'),(SELECT defaultPriceTier FROM customers WHERE id=COALESCE(json_extract(j,'$.input.customerId'),(SELECT customerId FROM invoices WHERE id=json_extract(j,'$.input.invoiceId')))),'RETAIL')",
  ).replace(
    "FROM cashScope,json_each(j,'$.input.lines'))",
    "FROM cashScope,json_each(j,'$.input.lines') WHERE json_extract(j,'$.input.commandType')!='RETURN' UNION SELECT variantId,productUnitId FROM invoiceItems WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) AND (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN')",
  ) +
  `,creditCustomer AS(SELECT COALESCE(json_extract(j,'$.input.customerId'),(SELECT customerId FROM invoices WHERE id=json_extract(j,'$.input.invoiceId'))) id FROM cashScope),creditInvoiceSet AS(SELECT id FROM invoices WHERE customerId=(SELECT id FROM creditCustomer) AND invoiceStatus IN('PENDING','PARTIALLY_PAID') UNION SELECT id FROM cashReplay UNION SELECT json_extract(j,'$.input.invoiceId') FROM cashScope),creditReceiptReplay AS(SELECT refId id FROM idempotencyKeys WHERE operation='sale.pay' AND clientRequestId=(SELECT requestId FROM cashScope))`;
const selectors = {
  ...cashSelectors,
  branchStock:
    "(" +
    cashSelectors.branchStock +
    ") OR ((SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN' AND variantId IN(SELECT variantId FROM cashLines))",
  customers: "id=(SELECT id FROM creditCustomer) OR " + cashSelectors.customers,
  invoices: "id IN(SELECT id FROM creditInvoiceSet)",
  branches:
    cashSelectors.branches +
    " OR id IN(SELECT branchId FROM invoices WHERE id IN(SELECT id FROM creditInvoiceSet))",
  users:
    cashSelectors.users +
    " OR id IN(SELECT createdBy FROM invoices WHERE id IN(SELECT id FROM creditInvoiceSet))",
  receipts:
    "id IN(SELECT id FROM creditReceiptReplay UNION SELECT id FROM receipts WHERE (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN' AND invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) UNION SELECT id FROM receipts WHERE (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN' AND branchId=(SELECT branchId FROM cashScope) AND shiftId=(SELECT shiftId FROM cashScope) AND cashBucket='DRAWER')",
  idempotencyKeys:
    "operation IN('sale.create','sale.pay','sale.return','sale.return.amount') AND clientRequestId=(SELECT requestId FROM cashScope)",
  customerContractPrices:
    "customerId=(SELECT id FROM creditCustomer) AND productUnitId IN(SELECT unitId FROM cashLines) AND isActive=1",
  auditLogs: "0",
  invoiceItems:
    "invoiceId IN(SELECT id FROM cashReplay UNION SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  accountingEntries:
    "id IN(SELECT id FROM accountingEntries WHERE (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN' AND invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) UNION SELECT accountingEntries.id FROM receipts JOIN accountingEntries ON accountingEntries.receiptId=receipts.id WHERE (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='RETURN' AND receipts.invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))",
  documentCounters: "counterKey IN('invoice','voucher')",
  roles:
    "id IN(SELECT customRoleId FROM users WHERE id=(SELECT userId FROM cashScope))",
  returnRequests:
    "invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  salesControlRequests:
    "invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  installmentPlans:
    "invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  workOrders: "0",
  orderPayments: "0",
  deliveryLedgerEntries: "0",
  deliveryRemittances: "0",
  digitalSaleDetails:
    "invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  invoiceItemBundleComponents:
    "invoiceItemId IN(SELECT id FROM invoiceItems WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))",
  invoiceItemServiceMaterials:
    "invoiceItemId IN(SELECT id FROM invoiceItems WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))",
  documentEffects:
    "documentType='INVOICE' AND documentId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)",
  deliveryParties: "0",
};
export const creditProjectionSql = projectionSql(tables, selectors, ctes, [
  `json_object('unsupportedReturn',EXISTS(SELECT 1 FROM workOrders WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)) OR EXISTS(SELECT 1 FROM orderPayments WHERE orderPayKind='APPLICATION' AND orderPayAppliedKind='INVOICE' AND appliedId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)) OR EXISTS(SELECT 1 FROM couponRedemptions WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)) OR EXISTS(SELECT 1 FROM invoiceItemBundleComponents WHERE invoiceItemId IN(SELECT id FROM invoiceItems WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))) OR EXISTS(SELECT 1 FROM invoiceItemServiceMaterials WHERE invoiceItemId IN(SELECT id FROM invoiceItems WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))), 'deliveryHistory',EXISTS(SELECT 1 FROM deliveryConsignments d JOIN invoices i ON i.id=d.invoiceId WHERE i.customerId=(SELECT id FROM creditCustomer) OR d.invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)),
 'unsupportedCollection',EXISTS(SELECT 1 FROM invoices i WHERE i.id=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) AND (SELECT json_extract(j,'$.input.commandType') FROM cashScope)='COLLECT' AND(i.sourceType!='POS' OR i.customerId IS NULL OR i.paymentMode!='CREDIT' OR NOT EXISTS(SELECT 1 FROM invoiceItems x WHERE x.invoiceId=i.id) OR EXISTS(SELECT 1 FROM invoiceItems x LEFT JOIN productVariants v ON v.id=x.variantId LEFT JOIN products p ON p.id=v.productId WHERE x.invoiceId=i.id AND(p.id IS NULL OR p.isService=1 OR p.isBundle=1 OR p.isConsignment=1 OR p.productType='DIGITAL_CARD'))))) AS scopeFlags`,
]);

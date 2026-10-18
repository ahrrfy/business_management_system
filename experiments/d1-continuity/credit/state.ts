import { scopeCtes, cashSelectors, projectionSql } from "../cash/cash-state";
import { tables } from "./schema";
const ctes =
  scopeCtes(
    "COALESCE(json_extract(j,'$.input.priceTier'),(SELECT defaultPriceTier FROM customers WHERE id=COALESCE(json_extract(j,'$.input.customerId'),(SELECT customerId FROM invoices WHERE id=json_extract(j,'$.input.invoiceId')))),'RETAIL')",
  ) +
  `,creditCustomer AS(SELECT COALESCE(json_extract(j,'$.input.customerId'),(SELECT customerId FROM invoices WHERE id=json_extract(j,'$.input.invoiceId'))) id FROM cashScope),creditInvoiceSet AS(SELECT id FROM invoices WHERE customerId=(SELECT id FROM creditCustomer) AND invoiceStatus IN('PENDING','PARTIALLY_PAID') UNION SELECT id FROM cashReplay UNION SELECT json_extract(j,'$.input.invoiceId') FROM cashScope),creditReceiptReplay AS(SELECT refId id FROM idempotencyKeys WHERE operation='sale.pay' AND clientRequestId=(SELECT requestId FROM cashScope))`;
const selectors = {
  ...cashSelectors,
  customers: "id=(SELECT id FROM creditCustomer) OR " + cashSelectors.customers,
  invoices: "id IN(SELECT id FROM creditInvoiceSet)",
  branches:
    cashSelectors.branches +
    " OR id IN(SELECT branchId FROM invoices WHERE id IN(SELECT id FROM creditInvoiceSet))",
  users:
    cashSelectors.users +
    " OR id IN(SELECT createdBy FROM invoices WHERE id IN(SELECT id FROM creditInvoiceSet))",
  receipts: "id IN(SELECT id FROM creditReceiptReplay)",
  idempotencyKeys:
    "operation IN('sale.create','sale.pay') AND clientRequestId=(SELECT requestId FROM cashScope)",
  customerContractPrices:
    "customerId=(SELECT id FROM creditCustomer) AND productUnitId IN(SELECT unitId FROM cashLines) AND isActive=1",
  auditLogs: "0",
  deliveryParties: "0",
};
export const creditProjectionSql = projectionSql(tables, selectors, ctes, [
  `json_object('deliveryHistory',EXISTS(SELECT 1 FROM deliveryConsignments d JOIN invoices i ON i.id=d.invoiceId WHERE i.customerId=(SELECT id FROM creditCustomer) OR d.invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope)),
 'unsupportedCollection',EXISTS(SELECT 1 FROM invoices i WHERE i.id=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) AND(i.sourceType!='POS' OR i.customerId IS NULL OR i.paymentMode!='CREDIT' OR NOT EXISTS(SELECT 1 FROM invoiceItems x WHERE x.invoiceId=i.id) OR EXISTS(SELECT 1 FROM invoiceItems x LEFT JOIN productVariants v ON v.id=x.variantId LEFT JOIN products p ON p.id=v.productId WHERE x.invoiceId=i.id AND(p.id IS NULL OR p.isService=1 OR p.isBundle=1 OR p.isConsignment=1 OR p.productType='DIGITAL_CARD'))))) AS scopeFlags`,
]);

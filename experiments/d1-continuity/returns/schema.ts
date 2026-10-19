import {
  tableNames as cashNames,
  createProjectionTables,
  projectionInitializationSql,
} from "../cash/schema";
import { cashReadIndexes } from "../cash/cash-indexes";
export { quote } from "../cash/schema";
export const tableNames = [
  ...cashNames,
  "customerContractPrices",
  "auditLogs",
  "deliveryParties",
  "roles",
  "returnRequests",
  "salesControlRequests",
  "installmentPlans",
  "workOrders",
  "orderPayments",
  "deliveryLedgerEntries",
  "deliveryRemittances",
  "digitalSaleDetails",
  "invoiceItemBundleComponents",
  "invoiceItemServiceMaterials",
  "documentEffects",
];
// These two control tables are read-only. Hydrate their generated uniqueness
// columns from source data; no mutation of either table is admitted.
const originalNames = [
  ...cashNames,
  "customerContractPrices",
  "auditLogs",
  "deliveryParties",
];
const originalTables = createProjectionTables(originalNames, true);
export const tables = createProjectionTables(tableNames, true, [
  "salesControlRequests.activeInvoiceId",
  "returnRequests.activeInvoiceId",
]).map((t) => originalTables.find((old) => old.name === t.name) ?? t);
export const initializationSql = projectionInitializationSql(tables, [
  ...cashReadIndexes,
  "CREATE INDEX IF NOT EXISTS credit_scope_open ON invoices(customerId,invoiceStatus,invoiceDate,id);",
  "CREATE INDEX IF NOT EXISTS credit_scope_delivery ON deliveryConsignments(invoiceId);",
  "CREATE INDEX IF NOT EXISTS returns_invoice_receipts ON receipts(invoiceId);",
  "CREATE INDEX IF NOT EXISTS returns_drawer_receipts ON receipts(branchId,shiftId,cashBucket);",
  "CREATE INDEX IF NOT EXISTS returns_invoice_ledger ON accountingEntries(invoiceId);",
  "CREATE INDEX IF NOT EXISTS returns_receipt_ledger ON accountingEntries(receiptId);",
  "CREATE INDEX IF NOT EXISTS returns_document_effects ON documentEffects(documentType,documentId);",
]);

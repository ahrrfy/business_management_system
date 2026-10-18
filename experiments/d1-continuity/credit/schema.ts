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
];
export const tables = createProjectionTables(tableNames, true);
export const creditIndexes = [
  ...cashReadIndexes,
  "CREATE INDEX IF NOT EXISTS credit_scope_open ON invoices(customerId,invoiceStatus,invoiceDate,id);",
  "CREATE INDEX IF NOT EXISTS credit_scope_delivery ON deliveryConsignments(invoiceId);",
];
export const initializationSql = projectionInitializationSql(
  tables,
  creditIndexes,
);

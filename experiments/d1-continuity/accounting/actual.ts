import { createReturnsPort } from "../returns/actual";
import { tables } from "./schema";
import { allowedQueries } from "./queries";
import { accountingProjectionSql } from "./state";
import { LAB_ID } from "./identity";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "../cash/plan-runtime";
export const CASH_SCHEMA_VERSION = "actual-accounting-q1-native-v1";
export const accountingPortOptions = {
  tables,
  allowedQueries,
  projectionSql: accountingProjectionSql,
  labId: LAB_ID,
  schemaVersion: CASH_SCHEMA_VERSION,
  planOptions: { groupInserts: true },
  allowedModes: new Set(["OFF", "SHADOW", "ACTIVE"]),
  mutableTables: new Set([
    "customers",
    "branchStock",
    "invoices",
    "invoiceItems",
    "inventoryMovements",
    "receipts",
    "accountingEntries",
    "idempotencyKeys",
    "documentCounters",
    "invoiceAttributions",
    "auditLogs",
    "documentEffects",
    "productVariants",
    "journalEntries",
    "journalLines",
  ]),
};
export const { prepareCashSale, applyCashPlan, creditRecoveryStrategy } =
  createReturnsPort(accountingPortOptions);

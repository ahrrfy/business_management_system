import { createReturnsPort } from "../returns/actual";
import { accountingPortOptions } from "./actual";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "../cash/plan-runtime";
export const CASH_SCHEMA_VERSION =
  "actual-accounting-q1-namespace-candidate64-v1";
export const { prepareCashSale, applyCashPlan, creditRecoveryStrategy } =
  createReturnsPort({
    ...accountingPortOptions,
    schemaVersion: CASH_SCHEMA_VERSION,
    planOptions: { groupInserts: true, maxChanges: 64 },
  });

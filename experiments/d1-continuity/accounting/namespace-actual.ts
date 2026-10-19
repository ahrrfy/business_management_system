import { createReturnsPort } from "../returns/actual";
import { accountingPortOptions } from "./actual";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "../cash/plan-runtime";
export const CASH_SCHEMA_VERSION = "actual-accounting-q1-namespace-v1";
export const { prepareCashSale, applyCashPlan, creditRecoveryStrategy } =
  createReturnsPort({
    ...accountingPortOptions,
    schemaVersion: CASH_SCHEMA_VERSION,
  });

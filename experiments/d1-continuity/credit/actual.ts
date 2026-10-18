import { createConfirmedPosSaleInTx } from "../../../server/services/posExternalPayment";
import { processPayment } from "../../../server/services/sale/payment";
import { lockFinancialPostingGate } from "../../../server/services/reports/monthCloseGate";
import { idempotencyHash } from "../../../server/services/idempotency";
import { snapshotDatabase } from "../cash/snapshot";
import { applyPlan } from "../cash/plan-runtime";
import { tables } from "./schema";
import { creditProjectionSql } from "./state";
import { allowedQueries } from "./queries";
import { inStaging } from "./transaction";
import { readOpeningWindowState } from "../../../server/services/openingModeService";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "../cash/plan-runtime";
export const CASH_SCHEMA_VERSION = "actual-credit-v1";
const mutableTables = new Set([
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
]);
export async function prepareCashSale(binding: any, input: any, actor: any) {
  if (input.branchId !== actor.branchId) throw Error("INVALID_ACTOR");
  const snap = await snapshotDatabase(binding, input, actor, {
    tables,
    allowedQueries,
    projectionSql: creditProjectionSql,
    mode: "CREDIT_SCOPED",
    exactCustomerBalance: true,
    rejectDeliveryHistory: true,
  });
  try {
    for (const line of input.lines ?? []) {
      const v = snap.before.productVariants.find(
          (v) => v.id === line.variantId,
        ),
        p = snap.before.products.find((p) => p.id === v?.productId);
      if (
        !p ||
        p.isService ||
        p.isBundle ||
        p.isConsignment ||
        p.allowBackorder ||
        p.productType === "DIGITAL_CARD"
      )
        throw Error("UNSUPPORTED_PRODUCT");
    }
    await lockFinancialPostingGate(snap.tx as any);
    if (snap.before.doubleEntrySettings.some((s) => s.mode !== "OFF"))
      throw Error("UNSUPPORTED_DOUBLE_ENTRY_MODE");
    if ((await readOpeningWindowState(snap.tx as any)).active)
      throw Error("UNSUPPORTED_OPENING_WINDOW");
    const staged = await inStaging(snap.tx, async () => {
      const { commandType, branchId, ...original } = input;
      return commandType === "SALE"
        ? createConfirmedPosSaleInTx(
            snap.tx as any,
            { ...original, branchId, paymentMode: "CREDIT" },
            actor,
          )
        : processPayment(
            { ...original, enforceBranchId: actor.branchId },
            actor,
          );
    });
    const result = staged.value,
      changes = snap.changes();
    if (
      changes.some(
        (c) =>
          !mutableTables.has(c.table) ||
          (c.table === "branchStock" && c.after.quantity < 0),
      )
    )
      throw Error("UNSUPPORTED_TABLE_WRITE");
    // Successful recovery protocol costs12 statements outside the primary batch;
    // epoch/assert/command/outbox/cleanup cost5, plus one insert or two update statements.
    // Leave two queries of headroom within the Free invocation limit of50.
    const invocationSql =
      17 + changes.reduce((n, c) => n + (c.before ? 2 : 1), 0);
    if (changes.length > 30 || invocationSql > 48)
      throw Object.assign(Error("CREDIT_INVOCATION_BUDGET_EXCEEDED"), {
        code: "CREDIT_INVOCATION_BUDGET_EXCEEDED",
        status: 422,
      });
    const plan = {
      version: 1,
      schemaVersion: CASH_SCHEMA_VERSION,
      expectedEpoch: snap.expectedEpoch,
      readBoundary: snap.boundary,
      requestId: input.clientRequestId,
      requestHash: idempotencyHash({ input, actor }),
      request: { input, actor },
      result,
      changes,
      outbox: {
        eventId: "CREDIT:" + input.clientRequestId,
        payload: {
          type: "FINANCIAL_DATA_CHANGED",
          branchIds: [input.branchId],
          invoiceId: result.invoiceId,
          deferredHooks: staged.deferredHooks,
        },
      },
    };
    return {
      result,
      plan,
      trace: snap.trace,
      snapshot: { epoch: snap.expectedEpoch, ...snap.metrics },
    };
  } catch (error: any) {
    error.cashTrace = snap.trace;
    throw error;
  } finally {
    snap.close();
  }
}
export function applyCashPlan(binding: any, plan: any, options: any = {}) {
  return applyPlan(
    binding,
    plan,
    { tables, mutableTables, schemaVersion: CASH_SCHEMA_VERSION },
    options,
  );
}

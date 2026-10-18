import { createConfirmedPosSaleInTx } from "../../../server/services/posExternalPayment";
import { lockFinancialPostingGate } from "../../../server/services/reports/monthCloseGate";
import { idempotencyHash } from "../../../server/services/idempotency";
import { snapshotDatabase } from "./snapshot";
import { tables, initializationSql } from "./schema";
export { initializationSql } from "./schema";
export { fixtureSql, fixtureActor, fixtureInput } from "./fixture";
export const CASH_SCHEMA_VERSION = "actual-cash-v1";
import { canonicalCashJson, applyPlan } from "./plan-runtime";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "./plan-runtime";
const mutableTables = new Set([
  "branchStock",
  "invoices",
  "invoiceItems",
  "inventoryMovements",
  "receipts",
  "accountingEntries",
  "idempotencyKeys",
  "documentCounters",
  "invoiceAttributions",
]);
const allowed = new Set([
  "branchId",
  "shiftId",
  "sourceType",
  "clientRequestId",
  "lines",
  "payment",
  "cashRoundIQD",
  "invoiceDiscount",
  "taxRatePercent",
  "priceTier",
  "notes",
  "contactName",
  "contactPhone",
  "deviceId",
]);
function admit(input: any, actor: any) {
  if (
    !input ||
    Object.keys(input).some((k) => !allowed.has(k)) ||
    input.sourceType !== "POS" ||
    input.payment?.method !== "CASH" ||
    typeof input.clientRequestId !== "string" ||
    !input.clientRequestId ||
    input.clientRequestId.length > 100 ||
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > 4
  )
    throw Error("UNSUPPORTED_CASH_COMMAND");
  if (input.branchId !== actor.branchId || !Number.isSafeInteger(actor.userId))
    throw Error("INVALID_ACTOR");
  if (Object.keys(input.payment).some((k) => !["method", "amount"].includes(k)))
    throw Error("UNSUPPORTED_PAYMENT_OPTION");
  if (
    typeof input.payment.amount !== "string" ||
    !/^\d{1,13}(\.\d{1,2})?$/.test(input.payment.amount)
  )
    throw Error("INVALID_MONEY_INPUT");
  for (const line of input.lines) {
    if (
      Object.keys(line).some(
        (k) =>
          ![
            "variantId",
            "productUnitId",
            "quantity",
            "discountPercent",
            "discountAmount",
          ].includes(k),
      )
    )
      throw Error("UNSUPPORTED_LINE_OPTION");
    if (
      !Number.isSafeInteger(line.variantId) ||
      !Number.isSafeInteger(line.productUnitId) ||
      typeof line.quantity !== "string" ||
      !/^\d{1,7}(\.\d{1,3})?$/.test(line.quantity)
    )
      throw Error("INVALID_LINE_INPUT");
  }
}
export async function prepareCashSale(binding: any, input: any, actor: any) {
  admit(input, actor);
  const snap = await snapshotDatabase(binding, input, actor);
  try {
    for (const line of input.lines) {
      const v = snap.before.productVariants.find(
        (v: any) => v.id === line.variantId,
      );
      const p = snap.before.products.find((p: any) => p.id === v?.productId);
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
    const result = await createConfirmedPosSaleInTx(
      snap.tx as any,
      input,
      actor,
    );
    if (result.status !== "PAID") throw Error("FULL_CASH_REQUIRED");
    const changes = snap.changes();
    if (changes.some((c) => c.table === "branchStock" && c.after.quantity < 0))
      throw Error("UNSUPPORTED_NEGATIVE_STOCK");
    if (changes.some((c) => !mutableTables.has(c.table)))
      throw Error("UNSUPPORTED_TABLE_WRITE");
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
        eventId: "CASH:" + input.clientRequestId,
        payload: {
          type: "FINANCIAL_DATA_CHANGED",
          branchIds: [input.branchId],
          invoiceId: result.invoiceId,
        },
      },
    };
    return {
      result,
      plan,
      trace: snap.trace,
      snapshot: {
        epoch: snap.expectedEpoch,
        tables: tables.map((t) => t.name),
        ...snap.metrics,
      },
    };
  } catch (error: any) {
    error.cashTrace = snap.trace;
    throw error;
  } finally {
    snap.close();
  }
}
export function applyCashPlan(
  binding: any,
  plan: any,
  options: {
    fault?: boolean;
    knownAbsent?: boolean;
    historicalRestore?: boolean;
  } = {},
) {
  return applyPlan(
    binding,
    plan,
    { tables, mutableTables, schemaVersion: CASH_SCHEMA_VERSION },
    options,
  );
}

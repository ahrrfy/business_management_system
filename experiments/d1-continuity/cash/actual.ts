import { createConfirmedPosSaleInTx } from "../../../server/services/posExternalPayment";
import { lockFinancialPostingGate } from "../../../server/services/reports/monthCloseGate";
import { idempotencyHash } from "../../../server/services/idempotency";
import { snapshotDatabase } from "./snapshot";
import { tables, quote, initializationSql } from "./schema";
import { assertCashReadBoundary } from './cash-state';
export { initializationSql } from "./schema";
export { fixtureSql, fixtureActor, fixtureInput } from "./fixture";
export const CASH_SCHEMA_VERSION = "actual-cash-v1";
export function canonicalCashJson(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalCashJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalCashJson(value[key]))
      .join(",") +
    "}"
  );
}
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
  const snap = await snapshotDatabase(binding,input,actor);
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
export function cashCommandFromRow(row: any) {
  return row
    ? {
        requestId: row.requestId,
        requestHash: row.requestHash,
        result: JSON.parse(row.resultJson),
        request: JSON.parse(row.requestJson),
        plan: JSON.parse(row.planJson),
        planHash: row.planHash,
      }
    : null;
}
export async function readCashCommand(binding: any, requestId: string) {
  return cashCommandFromRow(await binding
    .prepare("SELECT * FROM cashCommands WHERE requestId=?")
    .bind(requestId)
    .first());
}
export async function applyCashPlan(
  binding: any,
  plan: any,
  options: { fault?: boolean; knownAbsent?: boolean; historicalRestore?: boolean } = {},
) {
  if (
    plan.version !== 1 ||
    plan.schemaVersion !== CASH_SCHEMA_VERSION ||
    !Number.isSafeInteger(plan.expectedEpoch) ||
    plan.requestId !== plan.request?.input?.clientRequestId ||
    plan.requestHash !== idempotencyHash(plan.request) ||
    !Array.isArray(plan.changes) ||
    plan.changes.length > 30
  )
    throw Error("INVALID_PLAN_VERSION");
  // The original epoch CAS and unique command key still arbitrate a race after
  // the caller's authoritative preflight. Restore/default callers re-read.
  const existing = options.knownAbsent ? null : await readCashCommand(binding, plan.requestId);
  if (existing) {
    if (existing.requestHash !== plan.requestHash)
      throw Error("REQUEST_CONFLICT");
    return { ...existing.result, idempotentReplay: true };
  }
  if(plan.readBoundary&&!options.historicalRestore)assertCashReadBoundary(plan.readBoundary);
  const statements = [
    binding
      .prepare("UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1 AND epoch=?")
      .bind(plan.expectedEpoch),
    binding.prepare("INSERT INTO cashAssert(ok) VALUES(changes())"),
  ];
  for (const change of plan.changes) {
    const table = tables.find((t) => t.name === change.table);
    if (!table || !mutableTables.has(change.table))
      throw Error("INVALID_PLAN_TABLE");
    const keys = table.primary;
    const row = change.after;
    const names = Object.keys(row);
    if (
      names.length !== table.columns.length ||
      names.some((k) => !table.columns.some((c) => c.name === k)) ||
      keys.some((k) => row[k] !== change.key[k])
    )
      throw Error("INVALID_PLAN_COLUMN");
    if (change.before) {
      const columns = Object.keys(change.before);
      if (
        columns.length !== table.columns.length ||
        columns.some((k) => !table.columns.some((c) => c.name === k)) ||
        keys.some((k) => change.before[k] !== change.key[k])
      )
        throw Error("INVALID_PLAN_PREIMAGE");
      statements.push(
        binding
          .prepare(
            "INSERT INTO cashAssert(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM " +
              quote(table.name) +
              " WHERE " +
              columns.map((k) => quote(k) + " IS ?").join(" AND ") +
              ") THEN 1 ELSE 0 END",
          )
          .bind(...columns.map((k) => change.before[k])),
      );
      statements.push(
        binding
          .prepare(
            "UPDATE " +
              quote(table.name) +
              " SET " +
              names.map((k) => quote(k) + "=?").join(",") +
              " WHERE " +
              keys.map((k) => quote(k) + "=?").join(" AND "),
          )
          .bind(...names.map((k) => row[k]), ...keys.map((k) => change.key[k])),
      );
    } else
      statements.push(
        binding
          .prepare(
            "INSERT INTO " +
              quote(table.name) +
              " (" +
              names.map(quote).join(",") +
              ") VALUES (" +
              names.map(() => "?").join(",") +
              ")",
          )
          .bind(...names.map((k) => row[k])),
      );
  }
  const planJson = canonicalCashJson(plan),
    planHash = idempotencyHash(plan);
  statements.push(
    binding
      .prepare("INSERT INTO cashCommands VALUES(?,?,?,?,?,?)")
      .bind(
        plan.requestId,
        plan.requestHash,
        canonicalCashJson(plan.request),
        canonicalCashJson(plan.result),
        planJson,
        planHash,
      ),
    binding
      .prepare("INSERT INTO cashOutbox VALUES(?,?,?,?)")
      .bind(plan.outbox.eventId, plan.requestId, planJson, planHash),
  );
  statements.push(binding.prepare("DELETE FROM cashAssert"));
  if (options.fault)
    statements.push(binding.prepare("INSERT INTO cashAssert(ok) VALUES(0)"));
  await binding.batch(statements);
  return plan.result;
}

import { returnSaleDirect } from "../../../server/services/returnService";
import { logAuditTx } from "../../../server/services/auditService";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../../../server/services/returns/auditActions";
import { exactReturnQuery } from "./numeric";
import Decimal from "decimal.js";
import { createConfirmedPosSaleInTx } from "../../../server/services/posExternalPayment";
import { processPayment } from "../../../server/services/sale/payment";
import { lockFinancialPostingGate } from "../../../server/services/reports/monthCloseGate";
import { idempotencyHash } from "../../../server/services/idempotency";
import { snapshotDatabase } from "../cash/snapshot";
import { applyPlan, planMutationStatements } from "../cash/plan-runtime";
import { tables } from "./schema";
import { creditProjectionSql } from "./state";
import { allowedQueries } from "./queries";
import { inStaging } from "../credit/transaction";
import { readOpeningWindowState } from "../../../server/services/openingModeService";
import { cashReadBoundary } from "../cash/cash-state";
import { LAB_ID } from "../credit/identity";
export {
  canonicalCashJson,
  cashCommandFromRow,
  readCashCommand,
} from "../cash/plan-runtime";
export const CASH_SCHEMA_VERSION = "actual-credit-v1";
const defaultMutableTables = new Set([
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
]);
// Immutable per-port configuration; never mutate a process-wide request setting.
export function createReturnsPort(
  config: {
    tables?: typeof tables;
    allowedQueries?: ReadonlySet<string>;
    projectionSql?: string;
    mutableTables?: Set<string>;
    allowedModes?: ReadonlySet<string>;
    schemaVersion?: string;
    labId?: string;
    planOptions?: { groupInserts?: boolean; maxChanges?: number };
  } = {},
) {
  const projectedTables = config.tables ?? tables;
  const queries = new Set(config.allowedQueries ?? allowedQueries);
  const projection = config.projectionSql ?? creditProjectionSql;
  const mutableTables = new Set(config.mutableTables ?? defaultMutableTables);
  const allowedModes = new Set(config.allowedModes ?? ["OFF"]);
  const planOptions = Object.freeze({ ...config.planOptions });
  const schemaVersion = config.schemaVersion ?? CASH_SCHEMA_VERSION;
  const creditRecoveryStrategy = {
    confirmedReplayRead: true,
    eagerPrepare: "RETURN",
    async primaryPreflight(db: any, input: any, actor: any) {
      const boundary = cashReadBoundary(),
        envelope = JSON.stringify({ input, actor, ...boundary });
      const state = await db.batch([
        db
          .prepare("SELECT role FROM cashSandboxIdentity WHERE id=?")
          .bind(config.labId ?? LAB_ID),
        db
          .prepare("SELECT * FROM cashCommands WHERE requestId=?")
          .bind(input.clientRequestId),
        db.prepare("SELECT epoch FROM cashEpoch WHERE id=1"),
        db
          .prepare(
            projection +
              " AND NOT EXISTS(SELECT 1 FROM cashCommands WHERE requestId=(SELECT requestId FROM cashScope))",
          )
          .bind(envelope),
      ]);
      const row = state[3].results[0];
      if (row && row.epoch !== state[2].results[0]?.epoch)
        throw Error("CREDIT_PREFLIGHT_EPOCH_MISMATCH");
      return { state, snapshot: { row, envelope, boundary } };
    },
    prepare: prepareCashSale,
  };
  async function prepareCashSale(
    binding: any,
    input: any,
    actor: any,
    preloaded?: any,
  ) {
    if (input.branchId !== actor.branchId) throw Error("INVALID_ACTOR");
    if (input.commandType === "RETURN") {
      if (
        new Set(input.lines.map((l: any) => l.invoiceItemId)).size !==
        input.lines.length
      )
        throw Object.assign(Error("DUPLICATE_RETURN_LINE"), { status: 400 });
      const refund = input.resolution ?? input.refund;
      if (refund && new Decimal(refund.amount).gt(0) && refund.shiftId == null)
        throw Object.assign(Error("EXPLICIT_RETURN_DRAWER_REQUIRED"), {
          status: 400,
        });
      if (refund?.shiftId != null && refund.shiftId !== input.shiftId)
        throw Object.assign(Error("RETURN_DRAWER_SCOPE_MISMATCH"), {
          status: 400,
        });
      if (input.resolution && input.refund)
        throw Object.assign(Error("AMBIGUOUS_REFUND"), { status: 400 });
      if (
        input.resolution &&
        input.restock !== (input.resolution.disposition === "RESTOCK")
      )
        throw Object.assign(Error("RETURN_DISPOSITION_MISMATCH"), {
          status: 400,
        });
    }
    const snap = await snapshotDatabase(binding, input, actor, {
      tables: projectedTables,
      allowedQueries: queries,
      projectionSql: projection,
      mode: "CREDIT_SCOPED",
      exactCustomerBalance: true,
      rejectDeliveryHistory: true,
      rejectUnsupportedReturnHistory: true,
      schemaTemplate: true,
      exactSelect: exactReturnQuery,
      ...(preloaded ? { preloaded } : {}),
    });
    try {
      for (const line of input.commandType === "RETURN"
        ? snap.before.invoiceItems
        : (input.lines ?? [])) {
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
      if (
        snap.before.doubleEntrySettings.some((s) => !allowedModes.has(s.mode))
      )
        throw Error("UNSUPPORTED_DOUBLE_ENTRY_MODE");
      if ((await readOpeningWindowState(snap.tx as any)).active)
        throw Error("UNSUPPORTED_OPENING_WINDOW");
      if (input.commandType === "RETURN") {
        const inv = snap.before.invoices.find((i) => i.id === input.invoiceId);
        if (!inv || inv.sourceType !== "POS" || inv.branchId !== actor.branchId)
          throw Object.assign(Error("UNSUPPORTED_RETURN_INVOICE"), {
            status: 422,
          });
      }
      const staged = await inStaging(snap.tx, async () => {
        const { commandType, branchId, shiftId, ...original } = input;
        if (commandType === "RETURN") {
          const result = await returnSaleDirect(original, actor);
          await logAuditTx(snap.tx as any, actor, {
            branchId,
            action: RETURN_EXECUTED_AUDIT_ACTION,
            entityType: "invoice",
            entityId: String(input.invoiceId),
            newValue: { ...original, result },
          });
          return result;
        }
        return commandType === "SALE" || commandType === "CASH_SALE"
          ? createConfirmedPosSaleInTx(
              snap.tx as any,
              {
                ...original,
                branchId,
                shiftId,
                paymentMode: commandType === "CASH_SALE" ? "PREPAID" : "CREDIT",
              },
              actor,
            )
          : processPayment(
              { ...original, shiftId, enforceBranchId: actor.branchId },
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
      // The non-lookahead recovery protocol costs13 statements outside the primary batch;
      // epoch/assert/command/outbox/cleanup cost5, plus one insert or two update statements.
      // Leave two queries of headroom within the Free invocation limit of50.
      const invocationSql =
        18 + planMutationStatements(changes, planOptions.groupInserts);
      if (changes.length > (planOptions.maxChanges ?? 30) || invocationSql > 48)
        throw Object.assign(Error("CREDIT_INVOCATION_BUDGET_EXCEEDED"), {
          code: "CREDIT_INVOCATION_BUDGET_EXCEEDED",
          status: 422,
        });
      const plan = {
        version: 1,
        schemaVersion,
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
        preparationValidUntil: (() => {
          const expiry = snap.before.users.find(
            (u) => u.id === actor.userId,
          )?.accessExpiresAt;
          if (expiry == null) return null;
          const text = String(expiry);
          return Date.parse(
            text.includes("T") ? text : text.replace(" ", "T") + "Z",
          );
        })(),
      };
    } catch (error: any) {
      if (error.name === "OperationalApprovalRequiredError") {
        error.status = 412;
        error.code = "OPERATIONAL_APPROVAL_REQUIRED";
      } else if (error.message?.startsWith("UNSUPPORTED_")) error.status = 422;
      error.cashTrace = snap.trace;
      throw error;
    } finally {
      snap.close();
    }
  }
  function applyCashPlan(binding: any, plan: any, options: any = {}) {
    return applyPlan(
      binding,
      plan,
      {
        tables: projectedTables,
        mutableTables,
        schemaVersion,
        ...planOptions,
      },
      options,
    );
  }

  return { prepareCashSale, applyCashPlan, creditRecoveryStrategy };
}
export const { prepareCashSale, applyCashPlan, creditRecoveryStrategy } =
  createReturnsPort();

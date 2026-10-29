import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { isDeadInvoice } from "@shared/predicates";
import { and, asc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accountingEntries,
  idempotencyKeys,
  installmentLines,
  installmentPlans,
  installmentReceiptAllocations as history,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx, DB } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { idempotencyHash, recordIdempotencyKey } from "../idempotency";

/** Durable identity of the principal, not another balance or a guessed historical payment. */
export function installmentScopeHash(invoice: typeof invoices.$inferSelect) {
  return idempotencyHash({
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    branchId: invoice.branchId,
    total: toDbMoney(invoice.total),
    returnedTotal: toDbMoney(invoice.returnedTotal),
  });
}
export async function installmentScopeMatches(
  db: DB | Tx,
  planId: number,
  invoice: typeof invoices.$inferSelect,
) {
  const [scope] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "installment.scope"),
        eq(idempotencyKeys.clientRequestId, String(planId)),
      ),
    );
  return (
    scope?.refId === invoice.id &&
    scope.payloadHash === installmentScopeHash(invoice)
  );
}

export function installmentConflict(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر مطابقة تحصيل الأقساط",
      why,
      doThis:
        "حدّث الخطة وراجع سند التحصيل الأصلي؛ لا تعاود القبض قبل تسوية الاختلاف",
    }),
  });
}

export type AllocationRow = typeof history.$inferSelect;
export type LockedLine = typeof installmentLines.$inferSelect & {
  allocations: AllocationRow[];
  paid: Decimal;
  remaining: Decimal;
};
export type LockedPlan = {
  plan: typeof installmentPlans.$inferSelect;
  lines: LockedLine[];
};

export async function assertInstallmentScopeTx(
  tx: Tx,
  state: LockedPlan,
  invoice: typeof invoices.$inferSelect,
) {
  if (
    isDeadInvoice(invoice) ||
    !(await installmentScopeMatches(tx, state.plan.id, invoice)) ||
    !money(invoice.total)
      .minus(invoice.returnedTotal)
      .minus(invoice.paidAmount)
      .eq(state.lines.reduce((sum, line) => sum.plus(line.remaining), money(0)))
  )
    installmentConflict(
      "رصيد الفاتورة الحي لا يطابق أقساط الخطة المتبقية؛ يلزم مطابقة السندات",
    );
}

/** Batch observational scope checks, including refunds with no proven original receipt identity. */
export async function installmentPlanViews(
  db: DB | Tx,
  plans: (typeof installmentPlans.$inferSelect)[],
  lines: (typeof installmentLines.$inferSelect)[],
  views: Awaited<ReturnType<typeof installmentLineViews>>,
) {
  const invoiceIds = plans.flatMap((plan) =>
    plan.invoiceId == null ? [] : [plan.invoiceId],
  );
  const actualInvoices = invoiceIds.length
    ? await db.select().from(invoices).where(inArray(invoices.id, invoiceIds))
    : [];
  const scopes = plans.length
    ? await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "installment.scope"),
            inArray(
              idempotencyKeys.clientRequestId,
              plans.map((plan) => String(plan.id)),
            ),
          ),
        )
    : [];
  return new Map(
    plans.map((plan) => {
      const invoice = actualInvoices.find((row) => row.id === plan.invoiceId);
      const scope = scopes.find(
        (row) => row.clientRequestId === String(plan.id),
      );
      const planLines = lines.filter((line) => line.planId === plan.id);
      const remaining = planLines.reduce(
        (sum, line) => sum.plus(views.get(line.id)!.remainingAmount),
        money(0),
      );
      const reconciliationRequired =
        !invoice ||
        isDeadInvoice(invoice) ||
        !scope ||
        scope.refId !== invoice.id ||
        scope.payloadHash !== installmentScopeHash(invoice) ||
        planLines.some((line) => views.get(line.id)!.reconciliationRequired) ||
        !money(invoice.total)
          .minus(invoice.returnedTotal)
          .minus(invoice.paidAmount)
          .eq(remaining);
      return [
        plan.id,
        {
          reconciliationRequired,
          invoiceNetPaidAmount: invoice?.paidAmount ?? null,
          invoiceRemainingAmount: invoice
            ? toDbMoney(
                money(invoice.total)
                  .minus(invoice.returnedTotal)
                  .minus(invoice.paidAmount),
              )
            : null,
        },
      ] as const;
    }),
  );
}

/** Only existing immutable PRIMARY KEY reads after the current line lock. No range/SUM locking. */
export async function readInstallmentChainTx(
  tx: Tx,
  line: typeof installmentLines.$inferSelect,
  invoiceId: number,
) {
  if (!line.allocationHistoryReady)
    installmentConflict("السجل التاريخي يحتاج مطابقة موثقة قبل التحصيل");
  const rows: AllocationRow[] = [];
  let id = line.allocationHeadId;
  const seen = new Set<number>();
  while (id != null) {
    if (seen.has(id)) installmentConflict("دورة في سلسلة تخصيص القسط");
    seen.add(id);
    const [row] = await tx
      .select()
      .from(history)
      .where(eq(history.id, id))
      .for("share");
    if (
      !row ||
      row.lineId !== line.id ||
      row.invoiceId !== invoiceId ||
      (row.previousAllocationId != null && row.previousAllocationId >= row.id)
    )
      installmentConflict("سلسلة تخصيص القسط مفقودة أو مختلفة المصدر");
    rows.push(row);
    id = row.previousAllocationId;
  }
  const paid = rows.reduce((sum, row) => sum.plus(row.amount), money(0));
  if (paid.lt(0) || paid.gt(line.amount))
    installmentConflict("مجموع تخصيص القسط خارج قيمة الجدولة");
  return {
    ...line,
    allocations: rows,
    paid,
    remaining: money(line.amount).minus(paid),
  };
}

/** Caller owns invoice PK X first. Discovery uses the unique active guard, never an invoice table scan lock. */
export async function lockInstallmentPlanTx(
  tx: Tx,
  planId: number,
  allowUnready = false,
): Promise<LockedPlan | null> {
  const [plan] = await tx
    .select()
    .from(installmentPlans)
    .where(eq(installmentPlans.id, planId))
    .for("update");
  if (!plan || plan.invoiceId == null) return null;
  const ids = await tx
    .select({ id: installmentLines.id })
    .from(installmentLines)
    .where(eq(installmentLines.planId, plan.id))
    .orderBy(asc(installmentLines.id));
  const lines: LockedLine[] = [];
  for (const { id } of ids) {
    const [line] = await tx
      .select()
      .from(installmentLines)
      .where(eq(installmentLines.id, id))
      .for("update");
    if (!line || line.planId !== plan.id)
      installmentConflict("تغيّرت هوية سطر القسط");
    if (!line.allocationHistoryReady && allowUnready) return null;
    lines.push(await readInstallmentChainTx(tx, line, plan.invoiceId));
  }
  if (!lines.length) installmentConflict("الخطة بلا أسطر موثقة");
  return { plan, lines };
}

export interface InstallmentReceiptEffect {
  sourceReceiptId: number;
  effectReceiptId: number;
  effectKey: string;
  selectedLineId?: number;
  /** Full inverse of existing effects of this actual receipt; never a fresh FIFO. */
  reverseEffectReceiptId?: number;
  reverseSourceReceiptId?: number;
}

/** A proven consumed source cannot spend a later receipt's invoice balance. Caller owns invoice X. */
export async function assertInstallmentReceiptNotReversedTx(tx: Tx, invoiceId: number, receiptId: number, replayingCancellationReceiptId?: number) {
  const plans = await tx.select({ id: installmentPlans.id }).from(installmentPlans)
    .where(eq(installmentPlans.invoiceId, invoiceId)).orderBy(asc(installmentPlans.id));
  for (const plan of plans) {
    const state = await lockInstallmentPlanTx(tx, plan.id, true);
    if (!state) continue;
    for (const line of state.lines) {
      for (const original of line.allocations.filter(row => row.effectReceiptId === receiptId)) {
        const inverse = line.allocations.find(row => row.reversesAllocationId === original.id);
        if (inverse && !(replayingCancellationReceiptId != null
          && inverse.effectReceiptId === replayingCancellationReceiptId
          && inverse.effectKey === `REVERSE:${replayingCancellationReceiptId}:${original.id}`))
          installmentConflict("سند التحصيل معكوس بالفعل؛ لا يمكن عكسه مرة ثانية");
      }
    }
  }
}

/** Adopt direct proven legacy line receipts only; never infer historical FIFO. */
export async function adoptProvenLegacyPlanTx(
  tx: Tx,
  invoice: typeof invoices.$inferSelect,
  planId: number,
) {
  const [plan] = await tx
    .select()
    .from(installmentPlans)
    .where(eq(installmentPlans.id, planId))
    .for("update");
  if (
    !plan || isDeadInvoice(invoice) || plan.status === "CANCELLED" ||
    plan.invoiceId !== invoice.id ||
    plan.customerId !== invoice.customerId ||
    plan.branchId !== invoice.branchId
  )
    return;
  const ids = await tx
    .select({ id: installmentLines.id })
    .from(installmentLines)
    .where(eq(installmentLines.planId, planId))
    .orderBy(asc(installmentLines.id));
  const prepared: {
    line: typeof installmentLines.$inferSelect;
    receipt: typeof receipts.$inferSelect | null;
    paid: Decimal;
  }[] = [];
  for (const { id } of ids) {
    const [line] = await tx
      .select()
      .from(installmentLines)
      .where(eq(installmentLines.id, id))
      .for("update");
    if (line.allocationHistoryReady) {
      prepared.push({
        line,
        receipt: null,
        paid: (await readInstallmentChainTx(tx, line, invoice.id)).paid,
      });
      continue;
    }
    if (line.allocationHeadId != null || line.pendingAllocationClaimId != null)
      return;
    if (line.receiptId == null && line.status === "PENDING") {
      prepared.push({ line, receipt: null, paid: money(0) });
      continue;
    }
    if (!["PAID", "PENDING"].includes(line.status) || line.receiptId == null) return;
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, line.receiptId)).for("share");
    const entries = await tx
      .select()
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.receiptId, line.receiptId),
          eq(accountingEntries.entryType, "PAYMENT_IN"),
        ),
      ).for("share");
    if (
      !receipt ||
      receipt.invoiceId !== invoice.id ||
      receipt.partyType !== "CUSTOMER" ||
      receipt.partyId !== plan.customerId ||
      receipt.branchId !== plan.branchId ||
      receipt.direction !== "IN" ||
      receipt.status !== "COMPLETED" ||
      receipt.approvalStatus !== "APPROVED" ||
      !money(receipt.amount).gt(0) || money(receipt.amount).gt(line.amount) ||
      (line.status === "PAID" && !money(receipt.amount).eq(line.amount)) ||
      entries.length !== 1 ||
      entries[0].customerId !== plan.customerId ||
      entries[0].branchId !== plan.branchId ||
      !money(entries[0].amount).eq(receipt.amount)
    )
      return;
    if (prepared.some((row) => row.receipt?.id === receipt.id)) return;
    prepared.push({ line, receipt, paid: money(receipt.amount) });
  }
  if (
    !prepared.length ||
    !money(invoice.total)
      .minus(invoice.returnedTotal)
      .minus(invoice.paidAmount)
      .eq(
        prepared.reduce(
          (sum, row) => sum.plus(money(row.line.amount).minus(row.paid)),
          money(0),
        ),
      )
  )
    return;
  const [scope] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "installment.scope"),
        eq(idempotencyKeys.clientRequestId, String(planId)),
      ),
    );
  if (scope && (scope.refId !== invoice.id || scope.payloadHash !== installmentScopeHash(invoice))) return;
  if (!scope)
    await recordIdempotencyKey(
      tx,
      "installment.scope",
      String(planId),
      invoice.id,
      installmentScopeHash(invoice),
    );
  for (const row of prepared) {
    if (row.line.allocationHistoryReady) continue;
    await tx
      .update(installmentLines)
      .set({ allocationHistoryReady: true })
      .where(eq(installmentLines.id, row.line.id));
    if (row.receipt) {
      const line: LockedLine = {
        ...row.line,
        allocationHistoryReady: true,
        allocations: [],
        paid: money(0),
        remaining: money(row.line.amount),
      };
      await append(
        tx,
        { plan, lines: [line] },
        line,
        {
          sourceReceiptId: row.receipt.id,
          effectReceiptId: row.receipt.id,
          effectKey: `LEGACY:${row.receipt.id}`,
        },
        row.paid,
      );
    }
  }
}

async function append(
  tx: Tx,
  state: LockedPlan,
  line: LockedLine,
  input: InstallmentReceiptEffect,
  amount: Decimal,
  inverse?: AllocationRow,
) {
  const effectKey = inverse
    ? `${input.effectKey}:${inverse.id}`
    : input.effectKey;
  const existing = line.allocations.find((row) => row.effectKey === effectKey);
  if (existing) {
    if (
      !money(existing.amount).eq(amount) ||
      existing.effectReceiptId !== input.effectReceiptId ||
      existing.sourceReceiptId !== input.sourceReceiptId
    )
      installmentConflict("تغيّرت هوية تخصيص محفوظ");
    return;
  }
  const values = {
    invoiceId: state.plan.invoiceId!,
    lineId: line.id,
    sourceReceiptId: inverse?.sourceReceiptId ?? input.sourceReceiptId,
    effectReceiptId: input.effectReceiptId,
    effectKey,
    amount: toDbMoney(amount),
    reversesAllocationId: inverse?.id ?? null,
    previousAllocationId: line.allocationHeadId,
  };
  const id = extractInsertId(await tx.insert(history).values(values));
  line.allocations.unshift({ ...values, id, createdAt: new Date() });
  line.allocationHeadId = id;
  line.paid = line.paid.plus(amount);
  line.remaining = money(line.amount).minus(line.paid);
  if (line.remaining.lt(0) || line.paid.lt(0))
    installmentConflict("تخصيص القسط يتجاوز قيمته");
  const status = line.remaining.eq(0)
    ? "PAID"
    : line.status === "BOUNCED"
      ? "BOUNCED"
      : "PENDING";
  await tx
    .update(installmentLines)
    .set({
      allocationHeadId: id,
      status,
      ...(amount.gt(0)
        ? {
            receiptId: input.effectReceiptId,
            paidAt: line.remaining.eq(0) ? new Date() : null,
          }
        : { paidAt: null }),
    })
    .where(eq(installmentLines.id, line.id));
}

/** Evidence/status ONLY. The caller already owns the actual invoice/cash/AR/GL effects. */
export async function applyInstallmentReceiptEffectTx(
  tx: Tx,
  invoiceBefore: typeof invoices.$inferSelect,
  amount: Decimal,
  input: InstallmentReceiptEffect,
) {
  const [active] = await tx
    .select({ id: installmentPlans.id })
    .from(installmentPlans)
    .where(eq(installmentPlans.activeInvoiceGuard, invoiceBefore.id))
    .for("share");
  const candidateIds = new Set<number>(active ? [active.id] : []);
  if (
    input.reverseEffectReceiptId != null ||
    input.reverseSourceReceiptId != null
  ) {
    // Discovery is observational; every candidate and its chain are revalidated by existing PK locks.
    const candidates = await tx
      .select({ id: installmentPlans.id })
      .from(installmentPlans)
      .where(eq(installmentPlans.invoiceId, invoiceBefore.id));
    candidates.forEach((row) => candidateIds.add(row.id));
  }
  for (const planId of Array.from(candidateIds).sort((a, b) => a - b)) {
    const [preview] = await tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, planId))
      .for("update");
    if (
      !preview ||
      preview.invoiceId !== invoiceBefore.id ||
      preview.status === "CANCELLED"
    )
      continue;
    // Unproven legacy history remains explicit reconciliation, never guessed allocation.
    const state = await lockInstallmentPlanTx(tx, planId, true);
    if (!state) continue;
    if (
      state.plan.customerId !== invoiceBefore.customerId ||
      state.plan.branchId !== invoiceBefore.branchId
    )
      installmentConflict("الخطة تختلف عن فرع أو عميل الفاتورة");
    const beforeRemaining = state.lines.reduce(
      (sum, line) => sum.plus(line.remaining),
      money(0),
    );
    const invoiceRemaining = money(invoiceBefore.total)
      .minus(invoiceBefore.returnedTotal)
      .minus(invoiceBefore.paidAmount);
    const matchesScope =
      beforeRemaining.eq(invoiceRemaining) &&
      !isDeadInvoice(invoiceBefore) &&
      (await installmentScopeMatches(tx, planId, invoiceBefore));
    if (
      input.reverseEffectReceiptId != null ||
      input.reverseSourceReceiptId != null
    ) {
      for (const line of state.lines) {
        const reversed = new Set(
          line.allocations
            .map((row) => row.reversesAllocationId)
            .filter((id) => id != null),
        );
        const sources = line.allocations.filter(
          (row) =>
            (input.reverseEffectReceiptId != null
              ? row.effectReceiptId === input.reverseEffectReceiptId
              : row.sourceReceiptId === input.reverseSourceReceiptId && money(row.amount).gt(0)),
        );
        for (const source of sources) {
          if (!reversed.has(source.id)) continue;
          const inverse = line.allocations.find(row => row.reversesAllocationId === source.id)!;
          if (inverse.effectReceiptId !== input.effectReceiptId || inverse.effectKey !== `${input.effectKey}:${source.id}`)
            installmentConflict("سند التحصيل معكوس بالفعل؛ لا يمكن عكسه مرة ثانية");
        }
        const originals = sources.filter(row => !reversed.has(row.id));
        for (const original of originals)
          await append(
            tx,
            state,
            line,
            input,
            money(original.amount).neg(),
            original,
          );
      }
    } else {
      if (!matchesScope)
        installmentConflict("رصيد الفاتورة الحي لا يطابق أقساط الخطة المتبقية");
      if (
        state.lines.some((line) =>
          line.allocations.some((row) => row.effectKey === input.effectKey),
        )
      )
        continue;
      let left = amount;
      const ordered = [...state.lines]
        .sort((a, b) => a.seq - b.seq || a.id - b.id)
        .filter(
          (line) =>
            input.selectedLineId == null || line.id === input.selectedLineId,
        );
      for (const line of ordered) {
        const part = Decimal.min(left, line.remaining);
        if (part.lte(0)) continue;
        await append(tx, state, line, input, part);
        left = left.minus(part);
      }
      if (!left.eq(0))
        installmentConflict("الدفعة تتجاوز المتبقي على القسط المحدد");
    }
    // Never revive terminal invoices or a plan whose original funding scope changed.
    if (matchesScope && (active == null || active.id === planId)) {
      const complete = state.lines.every((line) => line.remaining.eq(0));
      await tx
        .update(installmentPlans)
        .set({ status: complete ? "COMPLETED" : "ACTIVE" })
        .where(eq(installmentPlans.id, planId));
    }
  }
}

/** Safe, page-bounded observational projection. Never used to authorize monetary mutations. */
export async function installmentLineViews(
  db: DB | Tx,
  lines: (typeof installmentLines.$inferSelect)[],
) {
  if (!lines.length) return new Map<number, ReturnType<typeof view>>();
  const rows = await db
    .select({
      allocation: history,
      receiptId: receipts.id,
      voucherNumber: receipts.voucherNumber,
      paymentMethod: receipts.paymentMethod,
      receiptAmount: receipts.amount,
      receiptDate: receipts.createdAt,
    })
    .from(history)
    .innerJoin(receipts, eq(receipts.id, history.effectReceiptId))
    .where(
      inArray(
        history.lineId,
        lines.map((line) => line.id),
      ),
    );
  function view(line: typeof installmentLines.$inferSelect) {
    const actual = rows.filter((row) => row.allocation.lineId === line.id);
    const paid = actual.reduce(
      (sum, row) => sum.plus(row.allocation.amount),
      money(0),
    );
    const reversed = new Set(
      actual.map((row) => row.allocation.reversesAllocationId),
    );
    return {
      paidAmount: toDbMoney(paid),
      remainingAmount: toDbMoney(money(line.amount).minus(paid)),
      reconciliationRequired:
        !line.allocationHistoryReady || paid.lt(0) || paid.gt(line.amount),
      pendingApproval: line.pendingAllocationClaimId != null,
      paymentHistory: actual.map((row) => ({
        id: row.allocation.id,
        receiptId: row.receiptId,
        voucherNumber: row.voucherNumber,
        paymentMethod: row.paymentMethod,
        amount: row.receiptAmount,
        effectAmount: row.allocation.amount,
        createdAt: row.receiptDate,
        reversed: reversed.has(row.allocation.id),
      })),
    };
  }
  return new Map(lines.map((line) => [line.id, view(line)]));
}

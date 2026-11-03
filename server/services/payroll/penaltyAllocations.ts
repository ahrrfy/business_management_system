import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import {
  auditLogs,
  employeePenalties,
  payrollItems,
  payrollAccountingEvents,
  payrollObligations,
  payrollPenaltyAllocations,
  payrollRuns,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { logAuditTx } from "../auditService";
import { capPenaltyDeduction } from "./helpers";

export type PenaltySource = {
  id: number;
  employeeId: number;
  decisionNumber: string;
  decisionDate: string;
  original: Decimal;
  remaining: Decimal;
  /** Amount reserved in later periods, still due when the earlier period was captured. */
  futureReserved: Decimal;
  capturedRunIds: number[];
};

/** Current, individually linked reservations, never inferred from legacy APPLIED rows. */
export async function readPenaltySourcesTx(
  tx: Tx,
  employeeIds: number[],
  period: string,
  lock = true,
  existingRunId?: number,
): Promise<PenaltySource[]> {
  if (!employeeIds.length) return [];
  const query = tx.select({
    id: employeePenalties.id,
    employeeId: employeePenalties.employeeId,
    decisionNumber: employeePenalties.decisionNumber,
    decisionDate: employeePenalties.decisionDate,
    amount: employeePenalties.deductionAmount,
    status: employeePenalties.status,
    payrollRunId: employeePenalties.payrollRunId,
  }).from(employeePenalties).where(and(
    inArray(employeePenalties.employeeId, employeeIds),
    inArray(employeePenalties.status, ["APPROVED", "APPLIED"]),
    sql`${employeePenalties.deductionAmount} > 0`,
    sql`DATE_FORMAT(${employeePenalties.decisionDate}, '%Y-%m') <= ${period}`,
  )).orderBy(asc(employeePenalties.decisionDate), asc(employeePenalties.id));
  let sources;
  try {
    sources = lock ? await query.for("update", { noWait: true }) : await query;
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
      const value = cause as { code?: unknown; errno?: unknown; cause?: unknown };
      if (value.code === "ER_LOCK_NOWAIT" || Number(value.errno) === 3572) {
        throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر تثبيت العقوبات للرواتب", why: "تتغيّر إحدى العقوبات حالياً", doThis: "أعد المحاولة بعد اكتمال التعديل" }) });
      }
      cause = value.cause;
    }
    throw error;
  }
  if (!sources.length) return [];
  const allocationsQuery = tx.select({
    penaltyId: payrollPenaltyAllocations.penaltyId,
    runId: payrollPenaltyAllocations.runId,
    amount: payrollPenaltyAllocations.amount,
    period: payrollRuns.period,
    itemRunId: payrollItems.runId,
    itemEmployeeId: payrollItems.employeeId,
    itemSnapshotComplete: payrollItems.penaltySnapshotComplete,
  }).from(payrollPenaltyAllocations)
    .innerJoin(payrollRuns, eq(payrollPenaltyAllocations.runId, payrollRuns.id))
    .innerJoin(payrollItems, eq(payrollPenaltyAllocations.itemId, payrollItems.id)).where(inArray(
    payrollPenaltyAllocations.penaltyId, sources.map((source) => Number(source.id)),
  )).orderBy(payrollPenaltyAllocations.id);
  const allocations = lock ? await allocationsQuery.for("share") : await allocationsQuery;
  return sources.flatMap((source) => {
    const rows = allocations.filter((allocation) => Number(allocation.penaltyId) === Number(source.id));
    if (rows.some((row) => !row.itemSnapshotComplete || Number(row.itemRunId) !== Number(row.runId) || Number(row.itemEmployeeId) !== Number(source.employeeId))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حساب متبقي العقوبة", why: `تخصيص القرار #${source.id} لا يستند إلى لقطة الموظف والمسيّر`, doThis: "راجع تخصيصات القرار قبل متابعة الرواتب" }) });
    }
    const hasFuture = rows.some((allocation) => allocation.period > period);
    const hasCurrent = existingRunId != null && rows.some((allocation) => Number(allocation.runId) === existingRunId);
    if (hasFuture && !hasCurrent) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذّر ترتيب استقطاع العقوبة", why: `العقوبة #${source.id} محجوزة مسبقاً في مسيّر شهر لاحق`, doThis: "راجع المسيّر اللاحق وصحّح تسلسل الأشهر قبل التوليد" }) });
    }
    if (!(source.status === "APPROVED" && source.payrollRunId == null) &&
        !(source.status === "APPLIED" && hasCurrent && hasFuture)) return [];
    const allocated = round2(rows.reduce((sum, row) => sum.plus(money(row.amount)), new Decimal(0)));
    const original = money(source.amount);
    if (allocated.gt(original)) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّرت متابعة استقطاعات الرواتب", why: `تخصيصات العقوبة #${source.id} تتجاوز أصل القرار`, doThis: "راجع سجل القرار والتخصيصات قبل إعادة المحاولة" }) });
    }
    return [{
      id: Number(source.id), employeeId: Number(source.employeeId),
      decisionNumber: source.decisionNumber, decisionDate: String(source.decisionDate),
      original, remaining: round2(original.minus(allocated)),
      futureReserved: round2(rows.filter((row) => row.period > period)
        .reduce((sum, row) => sum.plus(money(row.amount)), new Decimal(0))),
      capturedRunIds: rows.map((row) => Number(row.runId)),
    }];
  });
}

export function allocatePenaltyCap(sources: PenaltySource[], cap: Decimal) {
  let left = round2(cap);
  return sources.filter((source) => source.remaining.gt(0)).map((source) => {
    const amount = round2(Decimal.min(source.remaining, Decimal.max(0, left)));
    left = round2(left.minus(amount));
    return { source, amount };
  });
}

export async function savePenaltyAllocationsTx(
  tx: Tx, runId: number, itemId: number,
  allocationPlan: ReturnType<typeof allocatePenaltyCap>,
): Promise<void> {
  if (!allocationPlan.length) return;
  const [item] = await tx.select({ runId: payrollItems.runId, employeeId: payrollItems.employeeId, snapshotComplete: payrollItems.penaltySnapshotComplete })
    .from(payrollItems).where(eq(payrollItems.id, itemId)).for("update").limit(1);
  if (!item || !item.snapshotComplete || Number(item.runId) !== runId || allocationPlan.some(({ source }) => source.employeeId !== Number(item.employeeId))) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر ربط العقوبات ببند الراتب", why: "الموظف أو المسيّر لا يطابق مصدر القرار", doThis: "راجع القرار وبند الراتب ثم أعد التوليد" }) });
  }
  await tx.insert(payrollPenaltyAllocations).values(allocationPlan.map(({ source, amount }) => ({
    penaltyId: source.id, runId, itemId, amount: toDbMoney(amount),
    decisionNumberSnapshot: source.decisionNumber,
    decisionDateSnapshot: source.decisionDate,
  })));
}

export type PenaltyBreakdown = {
  penaltyDeduction: string | null;
  penaltyLines: Array<{ penaltyId: number; decisionNumber: string; decisionDate: string; amount: string }>;
};

export async function readPenaltySnapshotsTx(tx: Tx, itemIds: number[]) {
  const snapshots = new Map<number, Array<{ allocationId: number; penaltyId: number; runId: number; itemId: number; amount: string; decisionNumber: string; decisionDate: string }>>();
  if (!itemIds.length) return snapshots;
  const rows = await tx.select().from(payrollPenaltyAllocations)
    .where(inArray(payrollPenaltyAllocations.itemId, itemIds))
    .orderBy(asc(payrollPenaltyAllocations.itemId), asc(payrollPenaltyAllocations.penaltyId), asc(payrollPenaltyAllocations.id)).for("share");
  for (const row of rows) {
    const key = Number(row.itemId);
    const list = snapshots.get(key) ?? [];
    list.push({ allocationId: Number(row.id), penaltyId: Number(row.penaltyId), runId: Number(row.runId), itemId: key,
      amount: toDbMoney(row.amount), decisionNumber: row.decisionNumberSnapshot, decisionDate: String(row.decisionDateSnapshot) });
    snapshots.set(key, list);
  }
  return snapshots;
}

/** A missing allocation history is unknown, not proof that a legacy deduction was zero. */
export async function readPenaltyBreakdownsTx(tx: Tx, itemIds: number[]): Promise<Map<number, PenaltyBreakdown>> {
  const result = new Map<number, PenaltyBreakdown>();
  if (!itemIds.length) return result;
  const rows = await tx.select({ allocation: payrollPenaltyAllocations, itemEmployeeId: payrollItems.employeeId, itemRunId: payrollItems.runId, itemSnapshotComplete: payrollItems.penaltySnapshotComplete, wageReduction: payrollItems.wageReduction, penaltyEmployeeId: employeePenalties.employeeId }).from(payrollPenaltyAllocations)
    .innerJoin(payrollItems, eq(payrollPenaltyAllocations.itemId, payrollItems.id))
    .innerJoin(employeePenalties, eq(payrollPenaltyAllocations.penaltyId, employeePenalties.id))
    .where(inArray(payrollPenaltyAllocations.itemId, itemIds))
    .orderBy(payrollPenaltyAllocations.id).for("share");
  for (const joined of rows) {
    const row = joined.allocation;
    if (!joined.itemSnapshotComplete || Number(joined.itemRunId) !== Number(row.runId) || Number(joined.itemEmployeeId) !== Number(joined.penaltyEmployeeId)) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر عرض تفاصيل العقوبة", why: "لا يطابق التخصيص الموظف أو مسيّر الراتب", doThis: "راجع سجل التخصيص قبل متابعة العرض" }) });
    }
    const id = Number(row.itemId);
    const current = result.get(id) ?? { penaltyDeduction: "0.00", penaltyLines: [] };
    current.penaltyDeduction = toDbMoney(money(current.penaltyDeduction ?? 0).plus(money(row.amount)));
    if (money(current.penaltyDeduction).gt(money(joined.wageReduction))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر عرض تفاصيل العقوبة", why: "يتجاوز مجموع تخصيصات العقوبة خفض الأجر المحفوظ", doThis: "راجع بند الراتب وتخصيصاته قبل متابعة العرض" }) });
    }
    current.penaltyLines.push({ penaltyId: Number(row.penaltyId), decisionNumber: row.decisionNumberSnapshot, decisionDate: String(row.decisionDateSnapshot), amount: toDbMoney(row.amount) });
    result.set(id, current);
  }
  return result;
}

/** Validate item/source ownership and that the frozen payroll still contains each allocation. */
export async function assertRunPenaltyAllocationsTx(tx: Tx, runId: number): Promise<void> {
  const rows = await tx.select({
    allocation: payrollPenaltyAllocations,
    itemEmployeeId: payrollItems.employeeId,
    itemRunId: payrollItems.runId,
    wageReduction: payrollItems.wageReduction,
    sourceEmployeeId: employeePenalties.employeeId,
    itemSnapshotComplete: payrollItems.penaltySnapshotComplete,
    sourceAmount: employeePenalties.deductionAmount,
    sourceStatus: employeePenalties.status,
    sourceDecisionNumber: employeePenalties.decisionNumber,
    sourceDecisionDate: employeePenalties.decisionDate,
  }).from(payrollPenaltyAllocations)
    .innerJoin(payrollItems, eq(payrollPenaltyAllocations.itemId, payrollItems.id))
    .innerJoin(employeePenalties, eq(payrollPenaltyAllocations.penaltyId, employeePenalties.id))
    .where(or(eq(payrollPenaltyAllocations.runId, runId), eq(payrollItems.runId, runId)))
    .orderBy(payrollPenaltyAllocations.id).for("share");
  const totals = new Map<number, Decimal>();
  for (const row of rows) {
    const a = row.allocation;
    if (!row.itemSnapshotComplete || Number(row.itemRunId) !== runId || Number(a.runId) !== runId || Number(row.itemEmployeeId) !== Number(row.sourceEmployeeId) || !["APPROVED", "APPLIED"].includes(row.sourceStatus) || money(a.amount).gt(money(row.sourceAmount)) || a.decisionNumberSnapshot !== row.sourceDecisionNumber || String(a.decisionDateSnapshot) !== String(row.sourceDecisionDate)) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّرت مطابقة العقوبات مع مسيّر الرواتب", why: `تخصيص العقوبة #${a.penaltyId} لا يطابق الموظف أو القرار`, doThis: "راجع تخصيصات القرار قبل اعتماد المسيّر" }) });
    }
    const id = Number(a.itemId);
    const total = round2((totals.get(id) ?? new Decimal(0)).plus(money(a.amount)));
    if (total.gt(money(row.wageReduction))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر اعتماد استقطاع العقوبة", why: `خفض أجر البند #${id} أقل من العقوبات المثبتة له`, doThis: "أعد توليد المسودة أو صحّح إجمالي الاستقطاعات" }) });
    }
    totals.set(id, total);
  }
  const penaltyIds = Array.from(new Set(rows.map((row) => Number(row.allocation.penaltyId))));
  if (penaltyIds.length) {
    const all = await tx.select({ penaltyId: payrollPenaltyAllocations.penaltyId, amount: payrollPenaltyAllocations.amount })
      .from(payrollPenaltyAllocations).where(inArray(payrollPenaltyAllocations.penaltyId, penaltyIds)).for("share");
    for (const row of rows) {
      const total = all.filter((a) => Number(a.penaltyId) === Number(row.allocation.penaltyId))
        .reduce((sum, a) => sum.plus(money(a.amount)), new Decimal(0));
      if (total.gt(money(row.sourceAmount))) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّرت مطابقة استقطاع العقوبة", why: `تجاوزت تخصيصات القرار #${row.allocation.penaltyId} أصل المبلغ`,
        doThis: "راجع تخصيصات القرار قبل متابعة الرواتب",
      }) });
    }
  }
}

/** A changed wage may require a different reservation; force explicit regeneration. */
export async function assertPenaltyCapAtApprovalTx(tx: Tx, runId: number, period: string): Promise<void> {
  const items = await tx.select().from(payrollItems)
    .where(eq(payrollItems.runId, runId)).orderBy(payrollItems.id).for("share");
  const sources = await readPenaltySourcesTx(tx, items.map((item) => Number(item.employeeId)), period, true, runId);
  const allocations = items.length ? await tx.select().from(payrollPenaltyAllocations)
    .where(eq(payrollPenaltyAllocations.runId, runId)).orderBy(payrollPenaltyAllocations.id).for("share") : [];
  for (const item of items) {
    if (!item.penaltySnapshotComplete) continue;
    const current = round2(allocations.filter((a) => Number(a.itemId) === Number(item.id))
      .reduce((sum, a) => sum.plus(money(a.amount)), new Decimal(0)));
    const remaining = round2(sources.filter((source) => source.employeeId === Number(item.employeeId))
      .reduce((sum, source) => sum.plus(source.remaining).plus(source.futureReserved), new Decimal(0)));
    const nonPenalty = round2(money(item.wageReduction).minus(current));
    const base = money(item.gross).plus(money(item.overtime)).plus(money(item.commission))
      .minus(money(item.socialSecurityEmployee)).minus(money(item.incomeTax)).minus(nonPenalty);
    if (nonPenalty.isNegative() || !capPenaltyDeduction(base, round2(current.plus(remaining))).eq(current)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذّر اعتماد استقطاع العقوبة", why: `تغيّر الأجر أو الرصيد الواجب التقاطه للموظف #${item.employeeId}`,
        doThis: "احذف المسودة وأعد توليدها بعد مراجعة الأجر والقرارات",
      }) });
    }
  }
}

const ZERO_NET_ACTION = "payroll.penalty.zero_net_settled";
type ZeroNetIdentity = { runId: number; itemId: number; revisionNo: number; itemSnapshotHash: string | null; approvalSnapshotHash: string | null };

function parseZeroNetEvidence(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
}

function zeroNetEvidenceMatches(value: unknown, identity: ZeroNetIdentity): boolean {
  const row = parseZeroNetEvidence(value);
  if (!row) return false;
  return Number(row.runId) === identity.runId && Number(row.itemId) === identity.itemId &&
    Number(row.revisionNo) === identity.revisionNo && row.itemSnapshotHash === identity.itemSnapshotHash &&
    row.approvalSnapshotHash === identity.approvalSnapshotHash && row.version === 1;
}

async function zeroNetEvidenceTx(tx: Tx, identities: ZeroNetIdentity[]): Promise<Set<number>> {
  const result = new Set<number>();
  if (!identities.length) return result;
  const rows = await tx.select({ entityId: auditLogs.entityId, value: auditLogs.newValue }).from(auditLogs)
    .where(and(eq(auditLogs.action, ZERO_NET_ACTION), eq(auditLogs.entityType, "payrollItem"),
      inArray(auditLogs.entityId, identities.map((item) => String(item.itemId)))))
    .orderBy(auditLogs.id).for("share");
  for (const identity of identities) {
    if (!identity.itemSnapshotHash || !identity.approvalSnapshotHash) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر إثبات تسوية الراتب الصفري", why: "لقطة اعتماد البند أو المسيّر ناقصة", doThis: "راجع اعتماد البند قبل المتابعة" }) });
    }
    const sameRevision = rows.filter((row) => {
      const value = parseZeroNetEvidence(row.value);
      return row.entityId === String(identity.itemId) && value &&
        Number(value.runId) === identity.runId && Number(value.revisionNo) === identity.revisionNo;
    });
    if (sameRevision.length > 1 || (sameRevision.length === 1 && !zeroNetEvidenceMatches(sameRevision[0].value, identity))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر التحقق من الراتب الصفري", why: "دليل إقفال البند مكرر أو غير مطابق للّقطة", doThis: "راجع سجل الإقفال قبل المتابعة" }) });
    }
    if (sameRevision.length) result.add(identity.itemId);
  }
  return result;
}

async function zeroNetItemsTx(tx: Tx, run: typeof payrollRuns.$inferSelect) {
  const rows = await tx.select({ item: payrollItems }).from(payrollPenaltyAllocations)
    .innerJoin(payrollItems, eq(payrollPenaltyAllocations.itemId, payrollItems.id))
    .where(and(eq(payrollPenaltyAllocations.runId, Number(run.id)), eq(payrollItems.net, "0.00"), sql`${payrollPenaltyAllocations.amount} > 0`))
    .orderBy(payrollItems.id).for("share");
  const unique = new Map(rows.map(({ item }) => [Number(item.id), item]));
  const identities = Array.from(unique.values()).map((item) => ({
    runId: Number(run.id), itemId: Number(item.id), revisionNo: Number(item.revisionNo),
    itemSnapshotHash: item.snapshotHash, approvalSnapshotHash: run.approvalSnapshotHash,
  }));
  return { unique, identities };
}

/** A zero-net employee has no cash payment event; record an auditable closure, never a fake receipt. */
export async function recordZeroNetPenaltySettlementTx(tx: Tx, run: typeof payrollRuns.$inferSelect, actorUserId: number): Promise<void> {
  const { unique, identities } = await zeroNetItemsTx(tx, run);
  const existing = await zeroNetEvidenceTx(tx, identities);
  for (const identity of identities) {
    if (existing.has(identity.itemId)) continue;
    const item = unique.get(identity.itemId)!;
    await logAuditTx(tx, { userId: actorUserId, branchId: item.branchIdSnapshot }, {
      action: ZERO_NET_ACTION, entityType: "payrollItem", entityId: identity.itemId,
      newValue: { version: 1, ...identity },
    });
  }
}

export async function assertZeroNetPenaltySettlementTx(tx: Tx, run: typeof payrollRuns.$inferSelect): Promise<void> {
  const { identities } = await zeroNetItemsTx(tx, run);
  const existing = await zeroNetEvidenceTx(tx, identities);
  if (identities.some((identity) => !existing.has(identity.itemId))) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر التحقق من إقفال الراتب الصفري", why: "دليل إقفال أحد البنود الصفرية غير موجود", doThis: "راجع سجل الإقفال قبل متابعة الرواتب" }) });
  }
}

export async function assertZeroNetEvidenceIfPaymentExistsTx(tx: Tx, run: typeof payrollRuns.$inferSelect): Promise<void> {
  const [payment] = await tx.select({ id: payrollAccountingEvents.id }).from(payrollAccountingEvents)
    .where(and(eq(payrollAccountingEvents.runId, Number(run.id)), eq(payrollAccountingEvents.revisionNo, Number(run.revisionNo)),
      eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"))).for("share").limit(1);
  if (run.status === "paid" || payment) await assertZeroNetPenaltySettlementTx(tx, run);
}

/** Update source state only from settled employee obligations, never from a draft reservation. */
export async function refreshPenaltyStatesTx(tx: Tx, penaltyIds: number[]): Promise<void> {
  if (!penaltyIds.length) return;
  const ids = Array.from(new Set(penaltyIds)).sort((a, b) => a - b);
  const sources = await tx.select().from(employeePenalties)
    .where(inArray(employeePenalties.id, ids)).orderBy(employeePenalties.id).for("update");
  const rows = await tx.select({
    penaltyId: payrollPenaltyAllocations.penaltyId,
    runId: payrollPenaltyAllocations.runId,
    itemId: payrollPenaltyAllocations.itemId,
    itemRunId: payrollItems.runId,
    itemEmployeeId: payrollItems.employeeId,
    itemSnapshotComplete: payrollItems.penaltySnapshotComplete,
    amount: payrollPenaltyAllocations.amount,
    runStatus: payrollRuns.status,
    runRevisionNo: payrollRuns.revisionNo,
    revisionNo: payrollItems.revisionNo,
    net: payrollItems.net,
    itemSnapshotHash: payrollItems.snapshotHash,
    approvalSnapshotHash: payrollRuns.approvalSnapshotHash,
    obligationStatus: payrollObligations.status,
  }).from(payrollPenaltyAllocations)
    .innerJoin(payrollRuns, eq(payrollPenaltyAllocations.runId, payrollRuns.id))
    .innerJoin(payrollItems, eq(payrollPenaltyAllocations.itemId, payrollItems.id))
    .leftJoin(payrollObligations, and(
      eq(payrollObligations.itemId, payrollItems.id),
      eq(payrollObligations.runId, payrollRuns.id),
      eq(payrollObligations.revisionNo, payrollItems.revisionNo),
      eq(payrollObligations.kind, "SALARY_NET"),
    ))
    .where(inArray(payrollPenaltyAllocations.penaltyId, ids))
    .orderBy(payrollPenaltyAllocations.id).for("share");
  const zeroIdentities = rows.filter((row) => money(row.net).isZero() && money(row.amount).gt(0)).map((row) => ({
    runId: Number(row.runId), itemId: Number(row.itemId), revisionNo: Number(row.revisionNo),
    itemSnapshotHash: row.itemSnapshotHash, approvalSnapshotHash: row.approvalSnapshotHash,
  }));
  const zeroEvidence = await zeroNetEvidenceTx(tx, zeroIdentities.filter((identity) => identity.itemSnapshotHash && identity.approvalSnapshotHash));
  // A missing closure proof for an already-paid zero-net item is corruption,
  // not evidence that its penalty became payable again in another period.
  const zeroRows = rows.filter((row) => money(row.net).isZero() && money(row.amount).gt(0));
  const zeroRunIds = Array.from(new Set(zeroRows.map((row) => Number(row.runId))));
  const payments = zeroRunIds.length ? await tx.select({ runId: payrollAccountingEvents.runId, revisionNo: payrollAccountingEvents.revisionNo })
    .from(payrollAccountingEvents).where(and(inArray(payrollAccountingEvents.runId, zeroRunIds),
      eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"))).for("share") : [];
  for (const row of zeroRows) {
    const paymentRecorded = payments.some((payment) => Number(payment.runId) === Number(row.runId) && Number(payment.revisionNo) === Number(row.runRevisionNo));
    if (Number(row.revisionNo) !== Number(row.runRevisionNo) ||
        (row.runStatus !== "draft" && (row.runStatus === "paid" || paymentRecorded) && !zeroEvidence.has(Number(row.itemId)))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر التحقق من تسوية العقوبة", why: "دليل إقفال راتب صفري سابق مفقود أو لا يطابق مراجعته",
        doThis: "راجع سجل إقفال الرواتب قبل متابعة العملية",
      }) });
    }
  }
  for (const source of sources) {
    if (source.status !== "APPROVED" && source.status !== "APPLIED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّرت تسوية العقوبة", why: `تغيّرت حالة العقوبة #${source.id} أثناء معالجة الرواتب`, doThis: "حدّث السجل وراجع القرار قبل إعادة المحاولة" }) });
    }
    const allocations = rows.filter((row) => Number(row.penaltyId) === Number(source.id));
    if (allocations.some((row) => !row.itemSnapshotComplete || Number(row.itemRunId) !== Number(row.runId) || Number(row.itemEmployeeId) !== Number(source.employeeId))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّرت تسوية العقوبة", why: "لا يطابق التخصيص موظف القرار أو مسيّره", doThis: "راجع تفاصيل التخصيص قبل إعادة المحاولة" }) });
    }
    const settled = allocations.filter((row) => row.obligationStatus === "SETTLED" || (money(row.net).isZero() && zeroEvidence.has(Number(row.itemId))));
    const paid = round2(settled.reduce((sum, row) => sum.plus(money(row.amount)), new Decimal(0)));
    if (paid.gt(money(source.deductionAmount))) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّرت تسوية العقوبة", why: `تسوية العقوبة #${source.id} تتجاوز أصلها`, doThis: "راجع التخصيصات قبل إعادة المحاولة" }) });
    const complete = paid.eq(money(source.deductionAmount)) && paid.gt(0);
    await tx.update(employeePenalties).set({
      status: complete ? "APPLIED" : "APPROVED",
      payrollRunId: complete ? Number(settled[settled.length - 1].runId) : null,
    }).where(eq(employeePenalties.id, Number(source.id)));
  }
}

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, or, sql } from "drizzle-orm";
import {
  accountingEntries, auditLogs, employeePenalties, employees, payrollAccountingEvents,
  payrollItems, payrollObligationAllocations, payrollObligations, payrollRuns, receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { resolveApprovalActor } from "../approval/ownerGate";
import { logAuditTx } from "../auditService";
import { money } from "../money";
import { type Actor, withTx } from "../tx";
import { payrollHash } from "./helpers";
import { verifyApprovalSnapshotTx } from "./obligations";
import { assertSalaryReceiptEvidence, readSalarySettlementEvidence } from "./settlementEvidence";

/** This is evidence of an external statement, not a payroll or cash correction. */
export const HISTORICAL_PENALTY_ATTESTATION = "payroll.historicalPenalty.attest";
const ENTITY = "payrollHistoricalPenalty";
const VERSION = "payroll-historical-penalty-attestation.v1";
const RECORDER = "External owner confirmation recorded by operator";

function fail(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}
function validId(id: number): boolean { return Number.isSafeInteger(id) && id > 0; }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Verify the stored external statement before presenting it as evidence. */
export function historicalPenaltyAttestationMatches(
  value: unknown,
  penalty: typeof employeePenalties.$inferSelect,
): boolean {
  const record = object(value);
  if (!record) return false;
  const {
    sourceHash, requestKey, evidenceKind, evidenceStatement, evidenceReference,
    evidenceHash, reportedActualPayout, reportedCashSource, status, ...snapshot
  } = record;
  try {
    return typeof sourceHash === "string" && /^[0-9a-f]{64}$/.test(sourceHash) &&
      payrollHash(snapshot) === sourceHash &&
      typeof requestKey === "string" && /^[A-Za-z0-9._:-]{8,100}$/.test(requestKey) &&
      evidenceKind === "EXTERNAL_OWNER_CONFIRMATION" &&
      typeof evidenceStatement === "string" && evidenceStatement.length >= 10 && evidenceStatement.length <= 500 &&
      typeof evidenceReference === "string" && evidenceReference.length >= 5 && evidenceReference.length <= 300 &&
      evidenceHash === sha256(evidenceStatement) && reportedCashSource === "TREASURY" &&
      status === "NEEDS_RECONCILIATION" && snapshot.version === VERSION &&
      Number(snapshot.penaltyId) === Number(penalty.id) &&
      Number(snapshot.employeeId) === Number(penalty.employeeId) &&
      Number(snapshot.branchId) === Number(penalty.branchId) &&
      snapshot.decisionNumber === penalty.decisionNumber &&
      snapshot.decisionDate === String(penalty.decisionDate) &&
      snapshot.period === String(penalty.decisionDate).slice(0, 7) &&
      snapshot.penaltyReasonHash === sha256(penalty.reason) &&
      money(snapshot.penaltyAmount as string).eq(money(penalty.deductionAmount)) &&
      typeof reportedActualPayout === "string" && /^\d+(\.\d{1,2})?$/.test(reportedActualPayout) &&
      money(snapshot.recordedPayout as string).minus(money(reportedActualPayout)).eq(money(penalty.deductionAmount));
  } catch {
    return false;
  }
}

export interface HistoricalPenaltySourceInput {
  penaltyId: number;
  itemId: number;
}
export interface HistoricalPenaltyAttestationInput extends HistoricalPenaltySourceInput {
  sourceHash: string;
  requestKey: string;
  reportedActualPayout: string;
  reportedCashSource: "TREASURY";
  /** The owner's actual external statement; it is not an in-app signature. */
  evidenceStatement: string;
  evidenceReference: string;
}

async function assertOwner(tx: Tx, actor: Actor) {
  const owner = await resolveApprovalActor(tx, actor, { current: true });
  if (!owner.isOwner) throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
    what: "تعذّر تسجيل الإقرار التاريخي", why: "الحساب الحالي ليس حساب مالك نشطاً",
    doThis: "اطلب من مالك النظام مراجعة القرار وتسجيل الإقرار",
  }) });
}

/** Current locking reads; the governance gate serializes writers on apply. */
async function readSource(tx: Tx, input: HistoricalPenaltySourceInput) {
  if (!validId(input.penaltyId) || !validId(input.itemId)) fail("معرّف القرار أو بند الراتب غير صالح.");
  const [penalty] = await tx.select().from(employeePenalties)
    .where(eq(employeePenalties.id, input.penaltyId)).for("share");
  if (!penalty || penalty.status !== "DRAFT" || penalty.payrollRunId != null ||
      penalty.penaltyType !== "SALARY_DEDUCTION" || !money(penalty.deductionAmount).gt(0))
    fail("قرار العقوبة ليس مسودة مالية مستقلة صالحة للمراجعة التاريخية.");
  const [employee] = await tx.select().from(employees)
    .where(eq(employees.id, Number(penalty.employeeId))).for("share");
  const [item] = await tx.select().from(payrollItems)
    .where(eq(payrollItems.id, input.itemId)).for("share");
  if (!employee || !item || Number(item.employeeId) !== Number(penalty.employeeId))
    fail("لا يطابق بند الراتب موظف القرار.");
  const [run] = await tx.select().from(payrollRuns)
    .where(eq(payrollRuns.id, Number(item.runId))).for("share");
  if (!run || !["approved", "paid"].includes(run.status) ||
      run.period !== String(penalty.decisionDate).slice(0, 7) ||
      Number(item.revisionNo) !== Number(run.revisionNo) || !run.approvalSnapshotHash || !item.snapshotHash)
    fail("لا تطابق لقطة المسيّر المعتمدة شهر القرار أو مراجعة البند.");
  // Reproduce the original approval proof, including every item in the run.
  const approvedItems = await verifyApprovalSnapshotTx(tx, run);
  if (!approvedItems.some((approved) => Number(approved.row.id) === Number(item.id)))
    fail("لم يُعثر على بند الموظف في لقطة اعتماد المسيّر.");
  if (penalty.branchId == null || item.branchIdSnapshot == null ||
      Number(penalty.branchId) !== Number(item.branchIdSnapshot))
    fail("فرع القرار لا يطابق لقطة بند الراتب.");
  const fixedDeductions = money(item.advanceDeduction).plus(money(item.incomeTax)).plus(money(item.socialSecurityEmployee));
  if (!money(item.wageReduction).isZero() || !money(item.deductions).eq(fixedDeductions) ||
      !money(item.gross).plus(money(item.overtime)).plus(money(item.commission)).minus(money(item.deductions)).eq(money(item.net)) ||
      money(penalty.deductionAmount).gt(money(item.net)))
    fail("لا يمكن إثبات أن هذا الجزاء خارج استقطاعات لقطة الراتب؛ راجع المستندات يدوياً.");
  const obligations = await tx.select().from(payrollObligations).where(and(
    eq(payrollObligations.runId, Number(run.id)), eq(payrollObligations.itemId, Number(item.id)),
    eq(payrollObligations.revisionNo, Number(run.revisionNo)), eq(payrollObligations.kind, "SALARY_NET"),
  )).for("share");
  if (obligations.length !== 1) fail("التزام راتب الموظف غير فريد أو مفقود.");
  const obligation = obligations[0];
  if (Number(obligation.employeeId) !== Number(employee.id) || Number(obligation.branchIdSnapshot) !== Number(item.branchIdSnapshot) ||
      obligation.status !== "SETTLED" || !money(obligation.remainingAmount).isZero() || !money(obligation.originalAmount).eq(money(item.net)))
    fail("التزام الراتب لا يطابق البند المسوّى.");
  const payments = await tx.select().from(payrollAccountingEvents).where(and(
    eq(payrollAccountingEvents.obligationId, Number(obligation.id)),
    eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
  )).for("share");
  const active = [] as typeof payments;
  for (const event of payments) {
    const reversals = await tx.select({ id: payrollAccountingEvents.id }).from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.reversalOfId, Number(event.id))).for("share");
    if (!reversals.length) active.push(event);
  }
  if (active.length !== 1) fail("دفع الراتب الفعّال غير فريد أو مفقود.");
  const event = active[0];
  if (Number(event.runId) !== Number(run.id) || Number(event.revisionNo) !== Number(run.revisionNo) || event.receiptId == null)
    fail("حدث دفع الراتب لا يطابق المسير المعتمد.");
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, Number(event.receiptId))).for("share");
  const [entry] = await tx.select().from(accountingEntries).where(eq(accountingEntries.id, Number(event.accountingEntryId))).for("share");
  if (!receipt || !entry || entry.entryType !== "PAYMENT_OUT" || Number(entry.receiptId) !== Number(receipt.id) ||
      Number(entry.branchId) !== Number(item.branchIdSnapshot) ||
      (entry.postingProfile != null && entry.postingProfile !== "PAYMENT_OUT_PAYROLL_NET"))
    fail("سند وقيد دفع الراتب لا يطابقان المصدر.");
  const evidence = readSalarySettlementEvidence(event.settlementEvidence, event.sourceHash);
  if (!evidence || evidence.kind !== "SALARY_PAYMENT" || evidence.method !== "CASH" ||
      evidence.approvalSnapshotHash !== run.approvalSnapshotHash ||
      !money(evidence.entitlementSettled).eq(money(item.net)))
    fail("دليل دفع الراتب غير مكتمل أو لا يطابق لقطة الاعتماد.");
  assertSalaryReceiptEvidence(evidence, { event, receipt, obligation, entryAmount: entry.amount, reversed: false });
  const allocations = await tx.select().from(payrollObligationAllocations).where(and(
    eq(payrollObligationAllocations.accountingEventId, Number(event.id)),
    eq(payrollObligationAllocations.direction, "APPLY"),
  )).for("share");
  if (allocations.length !== 1 || Number(allocations[0].obligationId) !== Number(obligation.id) ||
      !money(allocations[0].amount).eq(money(evidence.entitlementSettled)))
    fail("تخصيص دفع الراتب غير فريد أو غير مطابق.");
  const reversedAllocations = await tx.select({ id: payrollObligationAllocations.id }).from(payrollObligationAllocations)
    .where(eq(payrollObligationAllocations.reversalOfId, Number(allocations[0].id))).for("share");
  if (reversedAllocations.length) fail("تخصيص الراتب معكوس ولا يقبل هذا الإقرار.");

  const snapshot = {
    version: VERSION, penaltyId: Number(penalty.id), employeeId: Number(employee.id),
    employeeName: [employee.firstName, employee.fatherName, employee.grandfatherName, employee.lastName].filter(Boolean).join(" "),
    branchId: Number(item.branchIdSnapshot), decisionNumber: penalty.decisionNumber,
    decisionDate: String(penalty.decisionDate), penaltyReasonHash: sha256(penalty.reason),
    penaltyCreatedBy: Number(penalty.createdById), penaltyCreatedAt: penalty.createdAt.toISOString(),
    penaltyAmount: money(penalty.deductionAmount).toFixed(2),
    runId: Number(run.id), period: run.period, revisionNo: Number(run.revisionNo), itemId: Number(item.id),
    itemSnapshotHash: item.snapshotHash, approvalSnapshotHash: run.approvalSnapshotHash,
    recordedNet: money(item.net).toFixed(2), recordedDeductions: money(item.deductions).toFixed(2),
    recordedAdvanceDeduction: money(item.advanceDeduction).toFixed(2), recordedWageReduction: money(item.wageReduction).toFixed(2),
    obligationId: Number(obligation.id), allocationId: Number(allocations[0].id),
    paymentEventId: Number(event.id), paymentSourceHash: event.sourceHash,
    receiptId: Number(receipt.id), accountingEntryId: Number(entry.id),
    recordedEntitlement: evidence.entitlementSettled, recordedPayout: evidence.actualPayout,
    signedRoundingDifference: evidence.signedDifference, paymentMethod: evidence.method,
    cashBucket: evidence.cashBucket, shiftId: evidence.shiftId, paymentYmd: evidence.paymentYmd,
  } as const;
  if (![snapshot.penaltyId, snapshot.employeeId, snapshot.branchId, snapshot.runId, snapshot.itemId,
    snapshot.obligationId, snapshot.allocationId, snapshot.paymentEventId, snapshot.receiptId,
    snapshot.accountingEntryId, snapshot.penaltyCreatedBy].every(validId))
    fail("هوية أحد مستندات المصدر غير صالحة.");
  return { snapshot, sourceHash: payrollHash(snapshot) };
}

async function existingForEmployee(tx: Tx, employeeId: number) {
  return tx.select().from(auditLogs).where(and(
    eq(auditLogs.action, HISTORICAL_PENALTY_ATTESTATION), eq(auditLogs.entityType, ENTITY),
    eq(auditLogs.entityId, String(employeeId)),
  )).for("share");
}

async function existingForKey(tx: Tx, penaltyId: number, requestKey: string) {
  return tx.select().from(auditLogs).where(and(
    eq(auditLogs.action, HISTORICAL_PENALTY_ATTESTATION), eq(auditLogs.entityType, ENTITY),
    or(sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.penaltyId')) = ${String(penaltyId)}`,
      sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.requestKey')) = ${requestKey}`),
  )).for("share");
}

export async function previewHistoricalPenaltyAttestation(input: HistoricalPenaltySourceInput, actor: Actor) {
  return withTx(async (tx) => {
    await assertOwner(tx, actor);
    const source = await readSource(tx, input);
    const matches = (await existingForEmployee(tx, source.snapshot.employeeId))
      .filter((row) => object(row.newValue)?.penaltyId === input.penaltyId);
    if (matches.length > 1) fail("توجد إقرارات تاريخية مكررة للقرار؛ راجع سجل التدقيق.");
    return { ...source, existingAuditId: matches.length ? Number(matches[0].id) : null,
      status: "NEEDS_RECONCILIATION" as const };
  }, { gate: "GOVERNANCE", bootstrapMissingGate: false });
}

export async function attestHistoricalPenalty(input: HistoricalPenaltyAttestationInput, actor: Actor) {
  if (!/^[0-9a-f]{64}$/.test(input.sourceHash) || !/^[A-Za-z0-9._:-]{8,100}$/.test(input.requestKey) ||
      typeof input.reportedActualPayout !== "string" || !/^\d+(\.\d{1,2})?$/.test(input.reportedActualPayout) ||
      input.reportedCashSource !== "TREASURY" ||
      typeof input.evidenceStatement !== "string" || input.evidenceStatement.trim().length < 10 || input.evidenceStatement.length > 500 ||
      typeof input.evidenceReference !== "string" || input.evidenceReference.trim().length < 5 || input.evidenceReference.length > 300)
    fail("بيانات إقرار الخصم التاريخي غير صالحة.");
  return withTx(async (tx) => {
    await assertOwner(tx, actor);
    const source = await readSource(tx, input);
    if (source.sourceHash !== input.sourceHash) fail("تغيّر مصدر الراتب أو القرار منذ المعاينة؛ أعد المراجعة.");
    const reportedPayout = money(input.reportedActualPayout);
    if (source.snapshot.cashBucket !== "TREASURY" || reportedPayout.isNegative() ||
        !money(source.snapshot.recordedPayout).minus(reportedPayout).eq(money(source.snapshot.penaltyAmount)))
      fail("المبلغ المصرّح أو مصدر النقد لا يطابق فرق القرار والسند المسجل؛ راجع الواقعة يدوياً.");
    const statement = input.evidenceStatement.trim();
    const payload = {
      ...source.snapshot, sourceHash: source.sourceHash, requestKey: input.requestKey,
      evidenceKind: "EXTERNAL_OWNER_CONFIRMATION", evidenceStatement: statement,
      evidenceReference: input.evidenceReference.trim(), evidenceHash: sha256(statement),
      reportedActualPayout: reportedPayout.toFixed(2), reportedCashSource: input.reportedCashSource,
      status: "NEEDS_RECONCILIATION",
    };
    const matches = await existingForKey(tx, input.penaltyId, input.requestKey);
    if (matches.length) {
      const prior = matches[0];
      const operation = object(prior.operation);
      const recorder = object(operation?.actor);
      if (matches.length !== 1 || !validId(Number(prior.userId)) || operation?.version !== "operation.v2" ||
          operation.outcome !== "SUCCESS" || recorder?.source !== "system" || recorder.label !== RECORDER ||
          payrollHash(prior.newValue) !== payrollHash(payload))
        fail("يوجد إقرار مختلف أو متعارض للقرار؛ راجع سجل التدقيق.");
      return { mode: "REPLAY_VERIFIED" as const, auditId: Number(prior.id), status: "NEEDS_RECONCILIATION" as const };
    }
    await logAuditTx(tx, { userId: actor.userId, branchId: source.snapshot.branchId }, {
      action: HISTORICAL_PENALTY_ATTESTATION, entityType: ENTITY, entityId: source.snapshot.employeeId,
      actor: { source: "system", label: RECORDER }, newValue: payload,
    });
    const saved = await existingForKey(tx, input.penaltyId, input.requestKey);
    if (saved.length !== 1 || Number(saved[0].userId) !== actor.userId || payrollHash(saved[0].newValue) !== payrollHash(payload))
      fail("تعذّر التحقق من حفظ الإقرار كاملاً في سجل التدقيق.");
    return { mode: "RECORDED" as const, auditId: Number(saved[0].id), status: "NEEDS_RECONCILIATION" as const };
  }, { gate: "GOVERNANCE", bootstrapMissingGate: false });
}

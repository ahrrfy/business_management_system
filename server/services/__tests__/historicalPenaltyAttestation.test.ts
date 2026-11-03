import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { PAYROLL_LEGAL_DEFAULTS } from "../payrollLegalService";
import { buildPayrollLegalPolicyEvidence } from "../payroll/legalSnapshot";
import { approveRun, payRun, returnSalaryPayment } from "../payrollService";
import { cancelEmployeePenalty, listEmployeePenalties } from "../employeePenaltyService";
import {
  attestHistoricalPenalty, HISTORICAL_PENALTY_ATTESTATION, previewHistoricalPenaltyAttestation,
} from "../payroll/historicalPenaltyAttestation";

const owner = { userId: 1, branchId: 1, role: "admin" };
const otherOwner = { userId: 2, branchId: 1, role: "admin" };
const nonOwner = { userId: 3, branchId: 1, role: "manager" };
const db = () => { const d = getDb(); if (!d) throw new Error("test database unavailable"); return d; };
let itemId: number;
let runId: number;

beforeEach(async () => {
  const d = db();
  await d.insert(s.branches).values({ id: 1, code: "HIST", name: "فرع الاختبار", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "historic-penalty-owner", role: "admin", branchId: 1, isOwner: true },
    { id: 2, openId: "historic-penalty-checker", role: "admin", branchId: 1, isOwner: true },
    { id: 3, openId: "historic-penalty-manager", role: "manager", branchId: 1, isOwner: false },
  ]);
  await d.insert(s.employees).values({ id: 10, branchId: 1, firstName: "موظف", lastName: "اختبار", payType: "monthly", salary: "1000000.00" });
  await d.insert(s.employeePenalties).values({
    id: 20, employeeId: 10, branchId: 1, penaltyType: "SALARY_DEDUCTION", decisionNumber: "TEST-20",
    decisionDate: "2026-10-31", reason: "قرار قديم للاختبار", deductionAmount: "5000.00", status: "DRAFT", createdById: 1,
  });
  await d.insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "2000000.00", paymentMethod: "CASH",
    cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 });
  await d.insert(s.monthCloseSequence).values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  const policy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
  runId = extractInsertId(await d.insert(s.payrollRuns).values({
    period: "2026-10", branchId: 1, status: "draft", employeeCount: 1, createdBy: 1,
    totalGross: "1000000.00", totalOvertime: "0.00", totalCommission: "0.00", totalDeductions: "0.00", totalNet: "1000000.00",
    legalPolicySnapshot: policy.snapshot, legalPolicyHash: policy.hash,
  }));
  itemId = extractInsertId(await d.insert(s.payrollItems).values({
    runId, employeeId: 10, branchIdSnapshot: 1, payType: "monthly", gross: "1000000.00", net: "1000000.00",
    deductions: "0.00", wageReduction: "0.00", advanceDeduction: "0.00",
  }));
  await approveRun(runId, otherOwner);
  await payRun(runId, otherOwner, { paymentMethod: "CASH", cashBucket: "TREASURY", paymentDate: "2026-11-01" });
});

async function financialSnapshot() {
  const d = db();
  return {
    penalties: await d.select().from(s.employeePenalties),
    runs: await d.select().from(s.payrollRuns),
    items: await d.select().from(s.payrollItems),
    obligations: await d.select().from(s.payrollObligations),
    payrollEvents: await d.select().from(s.payrollAccountingEvents),
    allocations: await d.select().from(s.payrollObligationAllocations),
    receipts: await d.select().from(s.receipts),
    entries: await d.select().from(s.accountingEntries),
    journals: await d.select().from(s.journalEntries),
    journalLines: await d.select().from(s.journalLines),
    advances: await d.select().from(s.employeeAdvances),
    advanceSettlements: await d.select().from(s.advanceSettlements),
  };
}

async function input() {
  const preview = await previewHistoricalPenaltyAttestation({ penaltyId: 20, itemId }, owner);
  return {
    penaltyId: 20, itemId, sourceHash: preview.sourceHash, requestKey: "historic-penalty-test-20",
    reportedActualPayout: "995000.00", reportedCashSource: "TREASURY" as const,
    evidenceStatement: "تم خصم خمسة آلاف يدوياً من الراتب فعلياً", evidenceReference: "إقرار المالك في المحادثة",
  };
}

describe("historical manual penalty attestation", () => {
  it("records one pending external attestation and replays without financial changes", async () => {
    const before = await financialSnapshot();
    const request = await input();
    const first = await attestHistoricalPenalty(request, owner);
    expect(first).toMatchObject({ mode: "RECORDED", status: "NEEDS_RECONCILIATION" });
    const second = await attestHistoricalPenalty(request, owner);
    expect(second).toMatchObject({ mode: "REPLAY_VERIFIED", auditId: first.auditId });
    expect(await financialSnapshot()).toEqual(before);
    const records = await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.action, HISTORICAL_PENALTY_ATTESTATION), eq(s.auditLogs.entityId, "10"),
    ));
    expect(records).toHaveLength(1);
    expect(records[0].newValue).toMatchObject({ status: "NEEDS_RECONCILIATION", penaltyId: 20, itemId,
      recordedPayout: "1000000.00", reportedActualPayout: "995000.00", reportedCashSource: "TREASURY",
      evidenceKind: "EXTERNAL_OWNER_CONFIRMATION" });
    expect(records[0].operation).toMatchObject({ actor: { source: "system" } });
  });

  it("serializes concurrent retries into one event", async () => {
    const before = await financialSnapshot();
    const request = await input();
    const results = await Promise.all([attestHistoricalPenalty(request, owner), attestHistoricalPenalty(request, owner)]);
    expect(results.map((row) => row.mode).sort()).toEqual(["RECORDED", "REPLAY_VERIFIED"]);
    expect(results[0].auditId).toBe(results[1].auditId);
    expect(await financialSnapshot()).toEqual(before);
  });

  it.each(["period", "sourceHash"] as const)("does not display a tampered historical %s as evidence", async (field) => {
    const recorded = await attestHistoricalPenalty(await input(), owner);
    const [entry] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, recorded.auditId));
    const value = entry.newValue as Record<string, unknown>;
    await db().update(s.auditLogs).set({ newValue: {
      ...value, [field]: field === "period" ? "2026-09" : "0".repeat(64),
    } }).where(eq(s.auditLogs.id, recorded.auditId));
    await expect(listEmployeePenalties(10, 1)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("detects a tampered penalty identity before filtering an employee's attestations", async () => {
    const recorded = await attestHistoricalPenalty(await input(), owner);
    await db().insert(s.employeePenalties).values({
      id: 21, employeeId: 10, branchId: 1, penaltyType: "SALARY_DEDUCTION", decisionNumber: "TEST-21",
      decisionDate: "2026-10-31", reason: "قرار آخر للاختبار", deductionAmount: "5000.00", status: "DRAFT", createdById: 1,
    });
    const rows = await listEmployeePenalties(10, 1);
    expect(rows.find((row) => Number(row.id) === 20)?.historicalAttestation?.status).toBe("NEEDS_RECONCILIATION");
    expect(rows.find((row) => Number(row.id) === 21)?.historicalAttestation).toBeNull();

    const [entry] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, recorded.auditId));
    await db().update(s.auditLogs).set({ newValue: { ...(entry.newValue as Record<string, unknown>), penaltyId: 21 } })
      .where(eq(s.auditLogs.id, recorded.auditId));
    await expect(listEmployeePenalties(10, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelEmployeePenalty(owner, 20, "إلغاء تجريبي")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [unchanged] = await db().select().from(s.employeePenalties).where(eq(s.employeePenalties.id, 20));
    expect(unchanged.status).toBe("DRAFT");
  });

  it("rejects a changed statement or payout instead of replacing evidence", async () => {
    const request = await input();
    await attestHistoricalPenalty(request, owner);
    const before = await financialSnapshot();
    await expect(attestHistoricalPenalty({ ...request, evidenceStatement: "إقرار آخر لا يطابق الإقرار الأصلي" }, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(attestHistoricalPenalty({ ...request, reportedActualPayout: "994000" }, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await financialSnapshot()).toEqual(before);
  });

  it("rejects reuse of a request key for a different penalty", async () => {
    const request = await input();
    await attestHistoricalPenalty(request, owner);
    await db().insert(s.employeePenalties).values({
      id: 21, employeeId: 10, branchId: 1, penaltyType: "SALARY_DEDUCTION", decisionNumber: "TEST-21",
      decisionDate: "2026-10-31", reason: "قرار آخر للاختبار", deductionAmount: "5000.00", status: "DRAFT", createdById: 1,
    });
    const next = await previewHistoricalPenaltyAttestation({ penaltyId: 21, itemId }, owner);
    await expect(attestHistoricalPenalty({ ...request, penaltyId: 21, sourceHash: next.sourceHash }, owner))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects stale source evidence and non-owner actors", async () => {
    const request = await input();
    await expect(previewHistoricalPenaltyAttestation({ penaltyId: 20, itemId }, nonOwner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attestHistoricalPenalty(request, nonOwner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.employeePenalties).set({ reason: "سبب تغيّر بعد المعاينة" }).where(eq(s.employeePenalties.id, 20));
    await expect(attestHistoricalPenalty(request, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, HISTORICAL_PENALTY_ATTESTATION))).toHaveLength(0);
  });

  it("rejects a paid-item change that breaks the original approval snapshot", async () => {
    const request = await input();
    await db().update(s.payrollItems).set({ gross: "1000001.00", net: "1000001.00" }).where(eq(s.payrollItems.id, itemId));
    await expect(attestHistoricalPenalty(request, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, HISTORICAL_PENALTY_ATTESTATION))).toHaveLength(0);
  });

  it("refuses an actual salary return rather than treating it as a valid payout", async () => {
    const request = await input();
    const [event] = await db().select().from(s.payrollAccountingEvents).where(and(
      eq(s.payrollAccountingEvents.runId, runId), eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
    ));
    await returnSalaryPayment({ accountingEventId: Number(event.id), returnedAt: "2026-11-01", reason: "إعادة فعلية للاختبار" }, owner);
    const before = await financialSnapshot();
    await expect(attestHistoricalPenalty(request, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await financialSnapshot()).toEqual(before);
  });
});

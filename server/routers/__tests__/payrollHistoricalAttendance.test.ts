import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { payrollRouter } from "../payrollRouter";
import { wageProfileOf } from "../../services/hr/wageProfile";
import { attendanceCorrectionSourceHash } from "../../services/hr/payrollHistoricalAttendanceCorrection";
import { projectPayrollWageBasisTx } from "../../services/hr/payrollWageBasis";

function db() {
  const connection = getDb();
  if (!connection) throw new Error("test DB required");
  return connection;
}
function caller(id = 10, owner = true, hr = "FULL") {
  return payrollRouter.createCaller({
    req: { headers: {} }, res: {}, sessionId: null, platformAdmin: null,
    user: { id, role: "manager", branchId: 1, isOwner: owner,
      permissionsOverride: { hr }, totpEnabledAt: new Date() },
  } as never);
}
let sourceId: number;
let sourceHash: string;
let originalBefore: unknown;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T09:30:00Z"));
  await db().insert(s.branches).values({ id: 1, name: "Main", code: "M" });
  await db().insert(s.users).values([
    { id: 10, openId: "attest-owner", role: "manager", branchId: 1, name: "Owner", isOwner: true, isActive: true },
    { id: 11, openId: "attest-manager", role: "manager", branchId: 1, name: "Manager", isOwner: false, isActive: true },
  ]);
  await db().insert(s.employees).values({ id: 101, branchId: 1, firstName: "ادم", fatherName: "مهدي", lastName: "القيسي",
    salary: "500000.00", hireDate: "2026-09-12", employmentStatus: "active", isActive: true });
  await db().insert(s.monthCloseSequence).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
  const [employee] = await db().select().from(s.employees).where(eq(s.employees.id, 101));
  const before = wageProfileOf(employee);
  const after = wageProfileOf({ ...before, attendanceExempt: true });
  const [inserted] = await db().insert(s.auditLogs).values({
    action: "employee.update", entityType: "employee", entityId: "101", userId: 10, branchId: 1,
    oldValue: before, newValue: { wageFields: ["attendanceExempt"], wage: after },
    createdAt: new Date("2026-11-01T09:00:00Z"),
  });
  await db().update(s.employees).set({ attendanceExempt: true }).where(eq(s.employees.id, 101));
  const [source] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, inserted.insertId));
  sourceId = Number(source.id);
  sourceHash = attendanceCorrectionSourceHash(source);
  originalBefore = source.oldValue;
});
afterEach(() => vi.useRealTimers());

const input = () => ({ period: "2026-10", employeeId: 101, sourceAuditId: sourceId, sourceHash,
  expectedEmployeeName: "ادم مهدي القيسي", evidenceText: "تأكيد المالك بناءً على ملف الموظف", confirmFixedExemption: true as const });

describe("historical attendance exemption API", () => {
  it("shows only an owner a read-only, month-bound and source-bound candidate", async () => {
    await expect(caller(11, false).historicalAttendanceCandidates({ period: "2026-10" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const candidates = await caller(10, true, "READ").historicalAttendanceCandidates({ period: "2026-10" });
    expect(candidates).toEqual([{ kind: "attestable", employeeId: 101, employeeName: "ادم مهدي القيسي", period: "2026-10",
      sourceAuditId: sourceId, sourceHash, sourceChangedAt: "2026-11-01T09:00:00.000Z",
      beforeExempt: false, afterExempt: true }]);
    expect(await caller().historicalAttendanceCandidates({ period: "2026-11" })).toEqual([]);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });

  it("requires a currently active owner and an explicit, well-supported confirmation", async () => {
    await expect(caller(11, false).attestHistoricalAttendanceExemption(input()))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().attestHistoricalAttendanceExemption({ ...input(), confirmFixedExemption: false } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().attestHistoricalAttendanceExemption({ ...input(), evidenceText: "قصير" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().attestHistoricalAttendanceExemption({ ...input(), sourceHash: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 10));
    await expect(caller().historicalAttendanceCandidates({ period: "2026-10" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().attestHistoricalAttendanceExemption(input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });

  it("records and replays an in-app owner attestation without changing the source or creating payroll", async () => {
    const first = await caller().attestHistoricalAttendanceExemption(input());
    expect(first.mode).toBe("APPLIED");
    expect(await caller().attestHistoricalAttendanceExemption(input()))
      .toMatchObject({ mode: "REPLAY_VERIFIED", auditId: first.auditId });
    expect(await caller().historicalAttendanceCandidates({ period: "2026-10" })).toEqual([]);
    const [attestation] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, first.auditId));
    expect(attestation.userId).toBe(10);
    expect(attestation.operation).toMatchObject({ actor: { source: "user" } });
    expect(attestation.newValue).toMatchObject({ evidenceKind: "IN_APP_OWNER_CONFIRMATION",
      evidenceReference: input().evidenceText, confirmedEmployeeName: input().expectedEmployeeName,
      employeeId: 101, period: "2026-10", attendanceExempt: true });
    await expect(caller().attestHistoricalAttendanceExemption({ ...input(), expectedEmployeeName: "اسم آخر" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [source] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, sourceId));
    expect(source.oldValue).toEqual(originalBefore);
    const [employee] = await db().select().from(s.employees).where(eq(s.employees.id, 101));
    expect(employee.attendanceExempt).toBe(true);
    const projected = await db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-10-31"));
    expect(projected[0].attendanceExempt).toBe(true);
    expect(projected[0].payrollAttendanceCorrection?.auditId).toBe(first.auditId);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
  });

  it("does not offer unproven or already closed situations", async () => {
    await db().insert(s.employeeContracts).values({ employeeId: 101, branchId: 1, startDate: "2026-01-01",
      contractType: "FIXED_TERM", createdById: 10 });
    expect(await caller().historicalAttendanceCandidates({ period: "2026-10" })).toEqual([
      { kind: "manual_review", employeeId: 101, employeeName: "ادم مهدي القيسي", period: "2026-10",
        reason: "توجد عقود أو ترقيات مرتبطة بالموظف؛ راجع سريانها لهذا الشهر." },
    ]);
    await expect(caller().attestHistoricalAttendanceExemption(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
    await db().delete(s.employeeContracts);
    await db().insert(s.payrollRuns).values({ period: "2026-10", status: "draft" });
    expect(await caller().historicalAttendanceCandidates({ period: "2026-10" })).toEqual([]);
    await expect(caller().attestHistoricalAttendanceExemption(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });

  it("exposes ambiguous leave and incomplete snapshots for review only", async () => {
    await db().update(s.employees).set({ employmentStatus: "leave" }).where(eq(s.employees.id, 101));
    const leave = await caller().historicalAttendanceCandidates({ period: "2026-10" });
    expect(leave).toMatchObject([{ kind: "manual_review", employeeId: 101 }]);
    expect(leave[0]).not.toHaveProperty("sourceHash");
    await expect(caller().attestHistoricalAttendanceExemption(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await db().update(s.employees).set({ employmentStatus: "active" }).where(eq(s.employees.id, 101));
    await db().update(s.auditLogs).set({ oldValue: { attendanceExempt: false } }).where(eq(s.auditLogs.id, sourceId));
    expect(await caller().historicalAttendanceCandidates({ period: "2026-10" }))
      .toMatchObject([{ kind: "manual_review", employeeId: 101 }]);
  });

  it("rejects a changed employee name under the recording lock", async () => {
    await db().update(s.employees).set({ lastName: "تعديل" }).where(eq(s.employees.id, 101));
    await expect(caller().attestHistoricalAttendanceExemption(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { hrEnterpriseRouter } from "../../routers/hrEnterpriseRouter";
import type { TrpcContext } from "../../context";
import { accrueMonthlyLeave } from "../hr/leaveAccrual";
import { baghdadToday } from "../businessDay";
import {
  renewEmployeeContract,
  approveEmployeeContract,
  terminateEmployeeContract,
  listEmployeeContracts,
} from "../employeeContractService";
import { employeeRouter } from "../../routers/employeeRouter";
import { generatePayroll } from "../payrollService";
import { WEEK_DAYS } from "@shared/hr";
import { wageProfileOf } from "../hr/wageProfile";
import { projectPayrollWageBasisTx } from "../hr/payrollWageBasis";
import { attendanceCorrectionSourceHash, recordHistoricalAttendanceCorrection, recordHistoricalAttendanceCorrectionTx } from "../hr/payrollHistoricalAttendanceCorrection";
import { withTx } from "../tx";
import { healAndRefoldMonthAttendance } from "../attendanceService";
import * as attendanceService from "../attendanceService";
import {
  balances,
  calculateLeaveEncashment,
  cancelLeave,
  createLeave,
  decideLeave,
} from "../leaveService";

const maker = { userId: 11, role: "manager", branchId: 1 };
const checker = { userId: 12, role: "manager", branchId: 1 };
const admin = { userId: 10, role: "admin", branchId: 1 };
function payrollEmployee(
  payroll: Awaited<ReturnType<typeof generatePayroll>>,
  employeeId = 101,
) {
  const item = payroll.items?.find((row) => row.employeeId === employeeId);
  if (!item) throw new Error(`Missing payroll item for employee ${employeeId}`);
  return item;
}
function db() {
  const database = getDb();
  if (!database) throw new Error("test DB required");
  return database;
}
function caller(actor = maker) {
  return hrEnterpriseRouter.createCaller({
    user: {
      id: actor.userId,
      role: actor.role,
      branchId: actor.branchId,
      permissionsOverride: { hr: "FULL" },
    },
    req: { headers: {} },
    res: {},
  } as unknown as TrpcContext);
}
async function contract(employeeId = 101) {
  const [result] = await db()
    .insert(s.employeeContracts)
    .values({
      employeeId,
      branchId: employeeId === 101 ? 1 : 2,
      contractType: "FIXED_TERM",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      status: "ACTIVE",
      basicSalary: "500000.00",
      createdById: 10,
      approvedById: 10,
    });
  return result.insertId;
}
async function snapshot(employeeId = 101) {
  return (
    await db().select().from(s.employees).where(eq(s.employees.id, employeeId))
  )[0];
}
async function historicalAttendanceFixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
  const before = wageProfileOf(await snapshot());
  const after = wageProfileOf({ ...before, attendanceExempt: true });
  const [inserted] = await db().insert(s.auditLogs).values({
    action: "employee.update", entityType: "employee", entityId: "101", userId: 10, branchId: 1,
    oldValue: before, newValue: { wageFields: ["attendanceExempt"], wage: after },
    createdAt: new Date("2026-11-01T09:00:00Z"),
  });
  await db().update(s.employees).set({ attendanceExempt: true }).where(eq(s.employees.id, 101));
  await db().insert(s.monthCloseSequence).values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  const [source] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, inserted.insertId));
  return { employeeId: 101, period: "2026-10", sourceAuditId: Number(source.id),
    sourceHash: attendanceCorrectionSourceHash(source),
    evidenceStatement: "نعم، كان معفى وراتبه ثابت", evidenceReference: "owner-confirmation:test:101:2026-10" };
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "A", code: "A" },
      { id: 2, name: "B", code: "B" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 10,
        openId: "hr-admin",
        role: "admin",
        branchId: 1,
        name: "Admin",
        isActive: true,
        isOwner: true,
      },
      {
        id: 11,
        openId: "hr-maker",
        role: "manager",
        branchId: 1,
        name: "Maker",
        isActive: true,
        permissionsOverride: { hr: "FULL" },
      },
      {
        id: 12,
        openId: "hr-checker",
        role: "manager",
        branchId: 1,
        name: "Checker",
        isActive: true,
        permissionsOverride: { hr: "FULL" },
      },
      {
        id: 13,
        openId: "hr-other",
        role: "manager",
        branchId: 2,
        name: "Other",
        isActive: true,
        permissionsOverride: { hr: "FULL" },
      },
    ]);
  await db()
    .insert(s.employees)
    .values([
      {
        id: 101,
        firstName: "Local",
        lastName: "Employee",
        branchId: 1,
        salary: "500000.00",
        hireDate: "2025-01-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: "0.00",
      },
      {
        id: 102,
        firstName: "Foreign",
        lastName: "Employee",
        branchId: 2,
        salary: "500000.00",
        hireDate: "2025-01-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: "0.00",
      },
    ]);
});
afterEach(() => vi.useRealTimers());

describe("audit26 HR resource authority", () => {
  it("rejects a foreign employee transfer without writing a decision", async () => {
    await expect(
      caller().transfers.request({
        employeeId: 102,
        decisionNumber: "foreign",
        transferDate: baghdadToday(),
        effectiveDate: baghdadToday(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeTransfers)).toHaveLength(0);
    expect((await snapshot(102)).branchId).toBe(2);
  });
  it("rejects a local manager moving an employee into another branch", async () => {
    await expect(
      caller().transfers.request({
        employeeId: 101,
        toBranchId: 2,
        decisionNumber: "outgoing",
        transferDate: baghdadToday(),
        effectiveDate: baghdadToday(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeTransfers)).toHaveLength(0);
  });
  it("allows an independently approved same-branch transfer", async () => {
    const result = await caller().transfers.request({
      employeeId: 101,
      toDepartment: "Accounts",
      decisionNumber: "valid",
      transferDate: baghdadToday(),
      effectiveDate: baghdadToday(),
    });
    await expect(
      caller(checker).transfers.approve({ id: result.id }),
    ).resolves.toMatchObject({ status: "EFFECTIVE" });
    expect((await snapshot()).department).toBe("Accounts");
  });
  it("limits a due-transfer sweep to resources the acting branch controls", async () => {
    await db().insert(s.employeeTransfers).values({
      employeeId: 102,
      fromBranchId: 2,
      toBranchId: 2,
      decisionNumber: "foreign-due",
      transferDate: "2026-01-01",
      effectiveDate: "2026-01-01",
      status: "APPROVED",
      createdById: 13,
      approvedById: 10,
      toPosition: "Foreign changed",
    });
    await expect(caller().transfers.executePending()).resolves.toMatchObject({
      executedCount: 0,
    });
    expect((await snapshot(102)).position).not.toBe("Foreign changed");
  });
  it("rejects create-contract against a foreign employee", async () => {
    await expect(
      caller().contracts.create({
        employeeId: 102,
        contractType: "FIXED_TERM",
        startDate: baghdadToday(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeContracts)).toHaveLength(0);
  });
  it("rechecks current account authority before a write", async () => {
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 11));
    await expect(
      caller().transfers.request({
        employeeId: 101,
        decisionNumber: "revoked",
        transferDate: baghdadToday(),
        effectiveDate: baghdadToday(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeTransfers)).toHaveLength(0);
  });
  it("rejects a foreign transfer approval and keeps its pending state", async () => {
    const [transfer] = await db().insert(s.employeeTransfers).values({
      employeeId: 102,
      fromBranchId: 2,
      toBranchId: 2,
      decisionNumber: "foreign-approve",
      transferDate: "2026-01-01",
      effectiveDate: "2026-01-01",
      createdById: 13,
    });
    await expect(
      caller(checker).transfers.approve({ id: transfer.insertId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeeTransfers))[0].status).toBe(
      "PENDING",
    );
  });
  it("guards document creation and identifier-based changes with the actual employee", async () => {
    await expect(
      caller().documents.add({
        employeeId: 102,
        documentType: "OTHER",
        title: "Foreign",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [doc] = await db().insert(s.employeeDocuments).values({
      employeeId: 102,
      documentType: "OTHER",
      title: "Original",
      createdById: 13,
    });
    await expect(
      caller().documents.update({ id: doc.insertId, title: "Changed" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().documents.delete({ id: doc.insertId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeeDocuments))[0].title).toBe(
      "Original",
    );
  });
  it("guards penalty creation, approval and cancellation with the actual employee", async () => {
    await expect(
      caller().penalties.create({
        employeeId: 102,
        penaltyType: "WARNING",
        decisionNumber: "foreign",
        decisionDate: baghdadToday(),
        reason: "test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [penalty] = await db().insert(s.employeePenalties).values({
      employeeId: 102,
      branchId: 2,
      penaltyType: "WARNING",
      decisionNumber: "foreign-existing",
      decisionDate: baghdadToday(),
      reason: "test",
      createdById: 13,
    });
    await expect(
      caller().penalties.approve({ id: penalty.insertId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().penalties.cancel({ id: penalty.insertId, reason: "test" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeePenalties))[0].status).toBe(
      "DRAFT",
    );
  });
  it("guards custody creation and return without making a foreign financial entry", async () => {
    await expect(
      caller().custody.assign({
        employeeId: 102,
        itemType: "DEVICE",
        itemName: "Foreign",
        handoverDate: baghdadToday(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [custody] = await db().insert(s.employeeCustody).values({
      employeeId: 102,
      branchId: 2,
      itemType: "DEVICE",
      itemName: "Foreign",
      handoverDate: baghdadToday(),
      createdById: 13,
    });
    await expect(
      caller().custody.return({
        id: custody.insertId,
        actualReturnDate: baghdadToday(),
        status: "LOST",
        damageAmount: "1000",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeeCustody))[0].status).toBe(
      "HELD",
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });
});

describe("audit26 contract renewal approval and effectivity", () => {
  it("uses the September wage basis after the October contract has already activated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    await db().update(s.employees).set({ attendanceExempt: true });
    const old = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2026-01-01",
      endDate: "2026-09-30",
      basicSalary: "500000",
      allowances: "50000",
    });
    await approveEmployeeContract(checker, old.id);
    const next = await renewEmployeeContract(maker, {
      id: old.id,
      startDate: "2026-10-01",
      endDate: "2027-09-30",
      basicSalary: "900000",
      allowances: "90000",
    });
    await approveEmployeeContract(checker, next.newContractId);
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    await listEmployeeContracts(101, 1);
    expect((await snapshot()).salary).toBe("900000.00");
    const payroll = await generatePayroll("2026-09", checker);
    const item = payrollEmployee(payroll);
    expect(item.gross).toBe("550000.00");
    expect(item.allowances).toBe("50000.00");
    expect((await snapshot()).salary).toBe("900000.00");
    expect((await snapshot()).allowances).toBe("90000.00");
  });
  it("excludes a never-applied September renewal cancelled by its parent's termination audit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
    await db().update(s.employees).set({ attendanceExempt: true });
    const old = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2026-01-01",
      basicSalary: "500000",
    });
    await approveEmployeeContract(checker, old.id);
    const september = await renewEmployeeContract(maker, {
      id: old.id,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, september.newContractId);
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, checker.userId));
    vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
    await terminateEmployeeContract(
      admin,
      old.id,
      "Cancel parent and unactivated renewals",
    );
    expect((await snapshot()).salary).toBe("500000.00");
    vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
    const november = await caller(admin).contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2026-11-01",
      basicSalary: "1200000",
    });
    await approveEmployeeContract(admin, november.id);
    const payroll = await generatePayroll("2026-09", maker);
    expect(payrollEmployee(payroll).gross).toBe(
      "500000.00",
    );
    expect((await snapshot()).salary).toBe("1200000.00");
    const [cancelled] = await db()
      .select()
      .from(s.employeeContracts)
      .where(eq(s.employeeContracts.id, september.newContractId));
    expect(cancelled.status).toBe("TERMINATED");
  });
  it("recognizes a reviewed September agreement through its historical end date without applying it to today's employee", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
    await db().update(s.employees).set({ attendanceExempt: true });
    const pending = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, pending.id);
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    const payroll = await generatePayroll("2026-09", checker);
    expect(payrollEmployee(payroll).gross).toBe(
      "900000.00",
    );
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("fails closed when an already-applied later agreement has no provable earlier wage basis", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    await db().update(s.employees).set({ attendanceExempt: true });
    const next = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2026-10-01",
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, next.id);
    await db().insert(s.attendance).values({
      employeeId: 101,
      branchId: 1,
      attendanceDate: "2026-09-14",
      hours: "2.00",
      hourlyRate: "1000.00",
      amount: "2000.00",
      status: "PRESENT",
      source: "manual",
    });
    await expect(generatePayroll("2026-09", checker)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await snapshot()).salary).toBe("900000.00");
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    const [attendance] = await db().select().from(s.attendance);
    expect(attendance.hourlyRate).toBe("1000.00");
    expect(attendance.amount).toBe("2000.00");
  });
  it("does not infer an earlier exemption from a later administrative change alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const before = wageProfileOf(await snapshot());
    const after = wageProfileOf({ ...before, attendanceExempt: true });
    await db().insert(s.auditLogs).values({
      action: "employee.update",
      entityType: "employee",
      entityId: "101",
      userId: admin.userId,
      branchId: 1,
      oldValue: before,
      newValue: {
        wageFields: ["attendanceExempt"],
        wage: after,
      },
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await db()
      .update(s.employees)
      .set({ attendanceExempt: true })
      .where(eq(s.employees.id, 101));
    const employee = await snapshot();
    await expect(db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-10-31")))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await snapshot()).attendanceExempt).toBe(true);
  });
  it("fails closed when the first later admin before-snapshot is incomplete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const after = wageProfileOf({
      ...(await snapshot()),
      attendanceExempt: true,
    });
    await db().insert(s.auditLogs).values({
      action: "employee.update",
      entityType: "employee",
      entityId: "101",
      userId: admin.userId,
      branchId: 1,
      oldValue: { attendanceExempt: false },
      newValue: {
        wageFields: ["attendanceExempt"],
        wage: after,
      },
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await db()
      .update(s.employees)
      .set({ attendanceExempt: true })
      .where(eq(s.employees.id, 101));

    await expect(generatePayroll("2026-10", checker)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
  });
  it("applies a separately attested historical exemption only to the specified month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const before = wageProfileOf(await snapshot());
    const after = wageProfileOf({ ...before, attendanceExempt: true });
    const [inserted] = await db().insert(s.auditLogs).values({
      action: "employee.update", entityType: "employee", entityId: "101",
      userId: admin.userId, branchId: 1, oldValue: before,
      newValue: { wageFields: ["attendanceExempt"], wage: after },
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await db().update(s.employees).set({ attendanceExempt: true });
    await db().insert(s.hrAttendanceSettings).values({
      id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-08-01",
    });
    await db().insert(s.monthCloseSequence).values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    const [source] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, inserted.insertId));
    const input = { employeeId: 101, period: "2026-10", sourceAuditId: Number(source.id),
      sourceHash: attendanceCorrectionSourceHash(source),
      evidenceStatement: "نعم، كان معفى وراتبه ثابت", evidenceReference: "owner-confirmation:test:101:2026-10" };
    const first = await recordHistoricalAttendanceCorrection(input, admin);
    const replay = await recordHistoricalAttendanceCorrection(input, admin);
    expect(first.mode).toBe("APPLIED");
    expect(replay).toMatchObject({ mode: "REPLAY_VERIFIED", auditId: first.auditId });
    const employee = await snapshot();
    const october = await db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-10-31"));
    expect(october[0].attendanceExempt).toBe(true);
    expect(october[0].payrollAttendanceCorrection?.auditId).toBe(first.auditId);
    await expect(db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-09-30")))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const payroll = await generatePayroll("2026-10", checker);
    expect(payrollEmployee(payroll).gross).toBe("500000.00");
    expect(payrollEmployee(payroll).hours).toBeNull();
    expect(payrollEmployee(payroll).note).toContain("إعفاء حضور تاريخي موثق");
    expect((await snapshot()).attendanceExempt).toBe(true);
    const links = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.applied"));
    expect(links).toHaveLength(1);
    expect(links[0].entityId).toBe(String(payrollEmployee(payroll).id));
    expect(links[0].newValue).toMatchObject({ attestationAuditId: first.auditId, employeeId: 101, period: "2026-10" });
    await expect(recordHistoricalAttendanceCorrection(input, admin)).resolves.toMatchObject({ mode: "REPLAY_VERIFIED", auditId: first.auditId });
  });
  it("rejects unauthorized, changed and rolled-back historical attestations", async () => {
    const input = await historicalAttendanceFixture();
    await expect(recordHistoricalAttendanceCorrection(input, checker)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(recordHistoricalAttendanceCorrection({ ...input, sourceHash: "0".repeat(64) }, admin))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(withTx((tx) => recordHistoricalAttendanceCorrectionTx(tx, input, admin)))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(withTx(async (tx) => {
      await recordHistoricalAttendanceCorrectionTx(tx, input, admin);
      throw new Error("force rollback");
    }, { gate: "GOVERNANCE" })).rejects.toThrow("force rollback");
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
    await recordHistoricalAttendanceCorrection(input, admin);
    await expect(recordHistoricalAttendanceCorrection({ ...input, evidenceReference: "different-confirmation" }, admin))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(1);
  });
  it("serializes concurrent conflicting attestations at the exclusive gate", async () => {
    const input = await historicalAttendanceFixture();
    let releaseFirst!: () => void;
    let firstInserted!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstReady = new Promise<void>((resolve) => { firstInserted = resolve; });
    const first = withTx(async (tx) => {
      const result = await recordHistoricalAttendanceCorrectionTx(tx, input, admin);
      firstInserted();
      await holdFirst;
      return result;
    }, { gate: "GOVERNANCE" });
    await firstReady;
    let secondEntered = false;
    const second = withTx(async (tx) => {
      secondEntered = true;
      return recordHistoricalAttendanceCorrectionTx(tx, { ...input, evidenceReference: "conflicting-confirmation" }, admin);
    }, { gate: "GOVERNANCE" }).then((result) => ({ result }), (error: unknown) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondEntered).toBe(false);
    releaseFirst();
    expect((await first).mode).toBe("APPLIED");
    expect(await second).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(1);
  });
  it("keeps payroll and a concurrent attestation consistent after a retry", async () => {
    const input = await historicalAttendanceFixture();
    await db().update(s.employees).set({ attendanceExempt: true }).where(eq(s.employees.id, 102));
    await db().insert(s.hrAttendanceSettings).values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-08-01" });
    let release!: () => void;
    let ready!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const inserted = new Promise<void>((resolve) => { ready = resolve; });
    const writer = withTx(async (tx) => {
      const result = await recordHistoricalAttendanceCorrectionTx(tx, input, admin);
      ready();
      await hold;
      return result;
    }, { gate: "GOVERNANCE" });
    await inserted;
    const concurrent = generatePayroll("2026-10", checker)
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const recorded = await writer;
    const outcome = await concurrent;
    if ("error" in outcome) {
      const error = outcome.error as { code?: string; cause?: { code?: string } };
      expect(["CONFLICT", "PRECONDITION_FAILED", "ER_LOCK_DEADLOCK"]).toContain(error.code ?? error.cause?.code);
      expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    }
    const payroll = "result" in outcome ? outcome.result : await generatePayroll("2026-10", checker);
    expect(payrollEmployee(payroll).gross).toBe("500000.00");
    expect(await db().select().from(s.payrollRuns)).toHaveLength(1);
    const links = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.applied"));
    expect(links).toHaveLength(1);
    expect(links[0].newValue).toMatchObject({ attestationAuditId: recorded.auditId, period: "2026-10" });
  }, 20000);
  it("does not wait on a locked future promotion while generating payroll", async () => {
    const input = await historicalAttendanceFixture();
    await recordHistoricalAttendanceCorrection(input, admin);
    await db().update(s.employees).set({ attendanceExempt: true }).where(eq(s.employees.id, 102));
    await db().insert(s.hrAttendanceSettings).values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-08-01" });
    const [promotion] = await db().insert(s.employeePromotions).values({ employeeId: 101, toTitle: "Future",
      effectiveDate: "2026-12-01", status: "approved", approvedBy: admin.userId });
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    let holder: Promise<void> | undefined;
    const spy = vi.spyOn(attendanceService, "healAndRefoldMonthAttendance").mockImplementationOnce(async () => {
      holder = withTx(async (tx) => {
        await tx.select().from(s.employeePromotions).where(eq(s.employeePromotions.id, promotion.insertId)).for("update");
        locked();
        await hold;
      });
      await ready;
      return { period: "2026-10", refoldedDays: 0, cleanedGhostDays: 0, updatedRates: 0, healedSchedules: 0 };
    });
    const generation = generatePayroll("2026-10", checker)
      .then((payroll) => ({ payroll }), (error: unknown) => ({ error }));
    try {
      const outcome = await Promise.race([generation, new Promise<{ timeout: true }>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), 8000))]);
      release();
      await holder;
      expect(outcome).toHaveProperty("payroll");
      if ("payroll" in outcome) expect(payrollEmployee(outcome.payroll).gross).toBe("500000.00");
      await generation;
    } finally {
      release();
      if (holder) await holder;
      spy.mockRestore();
    }
  }, 20000);
  it("does not block unrelated employee audit writes while reading the wage basis", async () => {
    const input = await historicalAttendanceFixture();
    await recordHistoricalAttendanceCorrection(input, admin);
    const employee = await snapshot();
    let release!: () => void;
    let ready!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const reader = db().transaction(async (tx) => {
      await projectPayrollWageBasisTx(tx, [employee], "2026-10-31");
      ready();
      await hold;
    });
    await started;
    const insertion = db().insert(s.auditLogs).values({ action: "employee.update", entityType: "employee",
      entityId: "102", userId: admin.userId, branchId: 2, newValue: { name: "Unrelated" } })
      .then(() => "inserted" as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([insertion, new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 8000);
      })]);
      release();
      await reader;
      await insertion;
      expect(result).toBe("inserted");
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await reader;
    }
  }, 20000);
  it("does not add an attestation to a closed financial period", async () => {
    const input = await historicalAttendanceFixture();
    await db().insert(s.financialPeriods).values({ cutoffDate: "2026-10-31", status: "LOCKED", lockedBy: admin.userId });
    await expect(recordHistoricalAttendanceCorrection(input, admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });
  it("does not add an attestation after a payroll exists", async () => {
    const input = await historicalAttendanceFixture();
    await db().insert(s.payrollRuns).values({ period: "2026-10", status: "draft" });
    await expect(recordHistoricalAttendanceCorrection(input, admin)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "payroll.attendanceExemption.attest"))).toHaveLength(0);
  });
  it("rejects a changed attestation or original source before using it", async () => {
    const input = await historicalAttendanceFixture();
    const saved = await recordHistoricalAttendanceCorrection(input, admin);
    const [attestation] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, saved.auditId));
    const original = attestation.newValue as Record<string, unknown>;
    await db().update(s.auditLogs).set({ newValue: { ...original, evidenceStatement: "changed" } })
      .where(eq(s.auditLogs.id, saved.auditId));
    const employee = await snapshot();
    await expect(db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-10-31")))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await db().update(s.auditLogs).set({ newValue: original }).where(eq(s.auditLogs.id, saved.auditId));
    await db().update(s.auditLogs).set({ oldValue: { attendanceExempt: false } }).where(eq(s.auditLogs.id, input.sourceAuditId));
    await expect(db().transaction((tx) => projectPayrollWageBasisTx(tx, [employee], "2026-10-31")))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("rejects changed attestation evidence between preflight and payroll generation", async () => {
    const input = await historicalAttendanceFixture();
    const saved = await recordHistoricalAttendanceCorrection(input, admin);
    const [attestation] = await db().select().from(s.auditLogs).where(eq(s.auditLogs.id, saved.auditId));
    const spy = vi.spyOn(attendanceService, "healAndRefoldMonthAttendance").mockImplementationOnce(async () => {
      await db().update(s.auditLogs).set({ newValue: { ...(attestation.newValue as Record<string, unknown>), evidenceReference: "changed-reference" } })
        .where(eq(s.auditLogs.id, saved.auditId));
      return { period: "2026-10", refoldedDays: 0, cleanedGhostDays: 0, updatedRates: 0, healedSchedules: 0 };
    });
    try {
      await expect(generatePayroll("2026-10", checker)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("applies an approved due promotion without blocking an attested exemption", async () => {
    const input = await historicalAttendanceFixture();
    await recordHistoricalAttendanceCorrection(input, admin);
    await db().update(s.employees).set({ attendanceExempt: true }).where(eq(s.employees.id, 102));
    await db().insert(s.hrAttendanceSettings).values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-08-01" });
    const [promotion] = await db().insert(s.employeePromotions).values({
      employeeId: 101, toTitle: "Promoted", toSalary: "600000.00", effectiveDate: "2026-10-01",
      status: "approved", createdBy: maker.userId, approvedBy: checker.userId,
    });
    const payroll = await generatePayroll("2026-10", checker);
    expect(payrollEmployee(payroll).gross).toBe("600000.00");
    const [applied] = await db().select().from(s.employeePromotions).where(eq(s.employeePromotions.id, promotion.insertId));
    expect(applied.appliedAt).not.toBeNull();
  });
  it("finishes historical healing preflight with the supplied wage map", async () => {
    const rates = (amount: number) =>
      Object.fromEntries(WEEK_DAYS.map((day) => [day, amount]));
    await db()
      .update(s.employees)
      .set({ payType: "hourly", salary: "0.00", dayRates: rates(2000) })
      .where(eq(s.employees.id, 101));
    const current = await snapshot();
    const projectedWages = new Map([
      [101, { ...current, dayRates: rates(1000) }],
    ]);
    await db().insert(s.attendance).values({
      employeeId: 101,
      branchId: 1,
      attendanceDate: "2026-09-14",
      hours: "2.00",
      hourlyRate: "2000.00",
      amount: "4000.00",
      status: "PRESENT",
      source: "manual",
    });
    await healAndRefoldMonthAttendance("2026-09", {
      projectedWages,
    } as Parameters<typeof healAndRefoldMonthAttendance>[1]);
    const [attendance] = await db().select().from(s.attendance);
    expect(attendance.hourlyRate).toBe("1000.00");
    expect(attendance.amount).toBe("2000.00");
    expect((await snapshot()).dayRates).toEqual(rates(2000));
  });
  it("preserves a legitimate current admin wage change instead of restoring an older contract", async () => {
    const period = baghdadToday().slice(0, 7);
    await db().update(s.employees).set({ attendanceExempt: true });
    const old = await caller().contracts.create({
      employeeId: 101,
      contractType: "INDEFINITE",
      startDate: "2025-01-01",
      basicSalary: "500000",
    });
    await approveEmployeeContract(checker, old.id);
    const employeeCaller = employeeRouter.createCaller({
      user: { id: 10, role: "admin", branchId: 1, isOwner: true },
      req: { headers: {} },
      res: {},
    } as unknown as TrpcContext);
    await employeeCaller.update({
      id: 101,
      firstName: "Local",
      lastName: "Employee",
      branchId: 1,
      payType: "monthly",
      salary: "700000",
      attendanceExempt: true,
    });
    const payroll = await generatePayroll(period, checker);
    expect(payrollEmployee(payroll).gross).toBe(
      "700000.00",
    );
    expect((await snapshot()).salary).toBe("700000.00");
  });
  it("uses the same historical promotion wage map for hourly attendance and payroll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    const rates = (amount: number) =>
      Object.fromEntries(WEEK_DAYS.map((day) => [day, amount]));
    await db()
      .update(s.employees)
      .set({
        payType: "hourly",
        salary: "0.00",
        allowances: "0.00",
        dayRates: rates(2000),
      })
      .where(eq(s.employees.id, 101));
    const current = await snapshot();
    const before = wageProfileOf({ ...current, dayRates: rates(500) });
    const september = wageProfileOf({ ...current, dayRates: rates(1000) });
    const october = wageProfileOf(current);
    await db()
      .insert(s.employeePromotions)
      .values([
        {
          employeeId: 101,
          toTitle: "Hourly",
          effectiveDate: "2026-09-01",
          status: "approved",
          approvedBy: checker.userId,
          approvedAt: new Date("2026-09-01T09:00:00Z"),
          appliedAt: new Date("2026-09-01T09:00:00Z"),
          fromWage: before,
          toWage: september,
          createdBy: maker.userId,
        },
        {
          employeeId: 101,
          toTitle: "Hourly",
          effectiveDate: "2026-10-01",
          status: "approved",
          approvedBy: checker.userId,
          approvedAt: new Date("2026-10-01T09:00:00Z"),
          appliedAt: new Date("2026-10-01T09:00:00Z"),
          fromWage: september,
          toWage: october,
          createdBy: maker.userId,
        },
      ]);
    await db().insert(s.attendance).values({
      employeeId: 101,
      branchId: 1,
      attendanceDate: "2026-09-14",
      hours: "2.00",
      hourlyRate: "2000.00",
      amount: "4000.00",
      status: "PRESENT",
      source: "manual",
    });
    const payroll = await generatePayroll("2026-09", checker);
    expect(payrollEmployee(payroll).gross).toBe(
      "2000.00",
    );
    expect((await db().select().from(s.attendance))[0].hourlyRate).toBe(
      "1000.00",
    );
    expect((await snapshot()).dayRates).toEqual(rates(2000));
  });
  it("payroll boundary applies a due approved wage and preserves an approved future wage", async () => {
    const period = baghdadToday().slice(0, 7);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${period}-01T09:00:00Z`));
    await db().update(s.employees).set({ attendanceExempt: true });
    const oldId = await contract();
    const renewal = await renewEmployeeContract(maker, {
      id: oldId,
      startDate: `${period}-15`,
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, renewal.newContractId);
    const future = await caller(admin).contracts.create({
      employeeId: 102,
      contractType: "FIXED_TERM",
      startDate: "2099-01-01",
      basicSalary: "950000",
    });
    await approveEmployeeContract(admin, future.id);
    expect((await snapshot()).salary).toBe("500000.00");
    vi.setSystemTime(new Date(`${period}-15T09:00:00Z`));
    const payroll = await generatePayroll(period, checker);
    expect(payrollEmployee(payroll).gross).toBe(
      "900000.00",
    );
    expect(payrollEmployee(payroll, 102).gross).toBe(
      "500000.00",
    );
    expect((await snapshot()).salary).toBe("900000.00");
    expect((await snapshot(102)).salary).toBe("500000.00");
  });
  it("creates an unapproved renewal draft and preserves the current salary and contract", async () => {
    const oldId = await contract();
    const result = await renewEmployeeContract(maker, {
      id: oldId,
      startDate: "2099-01-01",
      basicSalary: "900000",
    });
    expect(result.status).toBe("DRAFT");
    const [renewal] = await db()
      .select()
      .from(s.employeeContracts)
      .where(eq(s.employeeContracts.id, result.newContractId));
    expect(renewal.approvedById).toBeNull();
    expect((await snapshot()).salary).toBe("500000.00");
    expect(
      (
        await db()
          .select()
          .from(s.employeeContracts)
          .where(eq(s.employeeContracts.id, oldId))
      )[0].status,
    ).toBe("ACTIVE");
  });
  it("requires independent approval for renewal drafts", async () => {
    const oldId = await contract();
    const result = await renewEmployeeContract(maker, {
      id: oldId,
      startDate: "2099-01-01",
      basicSalary: "900000",
    });
    await expect(
      approveEmployeeContract(maker, result.newContractId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not apply a future normal contract when independently approved", async () => {
    const oldId = await contract();
    const draft = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2099-01-01",
      basicSalary: "900000",
    });
    await expect(
      approveEmployeeContract(checker, draft.id),
    ).resolves.toMatchObject({ status: "SCHEDULED" });
    expect((await snapshot()).salary).toBe("500000.00");
    expect(
      (
        await db()
          .select()
          .from(s.employeeContracts)
          .where(eq(s.employeeContracts.id, oldId))
      )[0].status,
    ).toBe("ACTIVE");
  });
  it("replays the same renewal without creating a second pending revision", async () => {
    const oldId = await contract();
    const input = { id: oldId, startDate: "2099-01-01", basicSalary: "900000" };
    const first = await renewEmployeeContract(maker, input);
    const replay = await renewEmployeeContract(maker, input);
    expect(replay.newContractId).toBe(first.newContractId);
    expect(await db().select().from(s.employeeContracts)).toHaveLength(2);
  });
  it("terminates linked scheduled renewals with their current contract", async () => {
    const oldId = await contract();
    const renewal = await renewEmployeeContract(maker, {
      id: oldId,
      startDate: "2099-01-01",
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, renewal.newContractId);
    await terminateEmployeeContract(admin, oldId, "End employment agreement");
    const contracts = await listEmployeeContracts(101, null);
    expect(contracts.every((row) => row.status === "TERMINATED")).toBe(true);
    expect(
      contracts.every((row) => row.terms?.includes("End employment agreement")),
    ).toBe(true);
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("does not replace a newer current agreement on the same effective date", async () => {
    const period = baghdadToday().slice(0, 7);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${period}-01T09:00:00Z`));
    const pending = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: `${period}-15`,
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, pending.id);
    await db()
      .insert(s.employeeContracts)
      .values({
        employeeId: 101,
        branchId: 1,
        contractType: "FIXED_TERM",
        startDate: `${period}-15`,
        status: "ACTIVE",
        basicSalary: "500000.00",
        createdById: 10,
        approvedById: 10,
      });
    vi.setSystemTime(new Date(`${period}-16T09:00:00Z`));
    await listEmployeeContracts(101, 1);
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("exposes an approved due agreement without applying a revoked reviewer's authority", async () => {
    const period = baghdadToday().slice(0, 7);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${period}-01T09:00:00Z`));
    const pending = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: `${period}-15`,
      basicSalary: "900000",
    });
    await approveEmployeeContract(checker, pending.id);
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, checker.userId));
    vi.setSystemTime(new Date(`${period}-16T09:00:00Z`));
    const rows = await listEmployeeContracts(101, 1);
    expect(rows[0].displayStatus).toBe("DUE");
    expect((await snapshot()).salary).toBe("500000.00");
    const payroll = await generatePayroll(period, maker);
    expect(payrollEmployee(payroll).gross).toBe(
      "500000.00",
    );
  });
  it("serializes concurrent renewal retries into one draft revision", async () => {
    const oldId = await contract();
    const input = { id: oldId, startDate: "2099-01-01", basicSalary: "900000" };
    const results = await Promise.all([
      renewEmployeeContract(maker, input),
      renewEmployeeContract(maker, input),
    ]);
    expect(results[0].newContractId).toBe(results[1].newContractId);
    expect(await db().select().from(s.employeeContracts)).toHaveLength(2);
  });
});

describe("audit26 contract calendar and interval validation", () => {
  it("rejects an inverse interval on creation before recording a draft", async () => {
    await expect(
      caller().contracts.create({
        employeeId: 101,
        contractType: "FIXED_TERM",
        startDate: "2027-01-01",
        endDate: "2026-12-31",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.employeeContracts)).toHaveLength(0);
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("rejects an inverse renewal interval without retiring the current contract", async () => {
    const oldId = await contract();
    await expect(
      renewEmployeeContract(maker, {
        id: oldId,
        startDate: "2027-01-01",
        endDate: "2026-12-31",
        basicSalary: "900000",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.employeeContracts)).toHaveLength(1);
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("rejects an impossible calendar day with a clear validation error", async () => {
    await expect(
      caller().contracts.create({
        employeeId: 101,
        contractType: "FIXED_TERM",
        startDate: "2099-02-30",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.employeeContracts)).toHaveLength(0);
  });
  it("checks existing draft intervals again at the approval boundary", async () => {
    const [draft] = await db().insert(s.employeeContracts).values({
      employeeId: 101,
      branchId: 1,
      contractType: "FIXED_TERM",
      startDate: "2027-01-01",
      endDate: "2026-12-31",
      basicSalary: "900000",
      createdById: maker.userId,
    });
    await expect(
      approveEmployeeContract(checker, draft.insertId),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await db().select().from(s.employeeContracts))[0].approvedAt,
    ).toBeNull();
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("retains a valid future renewal as a draft without an early salary effect", async () => {
    const oldId = await contract();
    await expect(
      renewEmployeeContract(maker, {
        id: oldId,
        startDate: "2099-01-01",
        endDate: "2099-12-31",
        basicSalary: "900000",
      }),
    ).resolves.toMatchObject({ status: "DRAFT" });
    expect((await snapshot()).salary).toBe("500000.00");
  });
});

describe("audit26 reviewed draft cancellation", () => {
  async function scheduled(employeeId = 101, startDate = "2099-01-01") {
    const draft = await caller(
      employeeId === 101 ? maker : admin,
    ).contracts.create({
      employeeId,
      contractType: "FIXED_TERM",
      startDate,
      basicSalary: "900000",
    });
    await approveEmployeeContract(
      employeeId === 101 ? checker : admin,
      draft.id,
    );
    return draft.id;
  }
  it("rejects an ACTIVE termination cascade over a pending contract from another recorded branch", async () => {
    const currentId = await contract();
    await db().insert(s.employeeContracts).values({
      employeeId: 101,
      branchId: 2,
      contractType: "FIXED_TERM",
      startDate: "2099-01-01",
      createdById: 13,
    });
    await expect(
      caller().contracts.terminate({
        id: currentId,
        reason: "Local termination",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await db().select().from(s.employeeContracts)).map((row) => row.status),
    ).toEqual(["ACTIVE", "DRAFT"]);
  });
  it("cancels only the scheduled agreement without financial mutation or later resurrection", async () => {
    const currentId = await contract();
    const pendingId = await scheduled();
    const otherId = await scheduled(101, "2099-02-01");
    const before = await snapshot();
    await expect(
      caller().contracts.terminate({
        id: pendingId,
        reason: "Withdraw scheduled agreement",
      }),
    ).resolves.toMatchObject({ status: "TERMINATED" });
    const rows = await db().select().from(s.employeeContracts);
    expect(rows.find((row) => row.id === currentId)!.status).toBe("ACTIVE");
    expect(rows.find((row) => row.id === otherId)!.status).toBe("DRAFT");
    expect(rows.find((row) => row.id === pendingId)!.status).toBe("TERMINATED");
    expect(await snapshot()).toEqual(before);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.payrollItems)).toHaveLength(0);
    const [audit] = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "employeeContract.terminate"));
    expect(audit.oldValue).toMatchObject({ status: "DRAFT" });
    expect(audit.newValue).toMatchObject({
      mode: "CANCEL_SCHEDULED",
      reason: "Withdraw scheduled agreement",
      cancelledPendingContractIds: [],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-02T09:00:00Z"));
    await listEmployeeContracts(101, 1);
    expect((await snapshot()).salary).toBe("500000.00");
  });
  it("cancels a standalone due agreement whose reviewer no longer has authority", async () => {
    const period = baghdadToday().slice(0, 7);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${period}-01T09:00:00Z`));
    const pendingId = await scheduled(101, `${period}-15`);
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, checker.userId));
    vi.setSystemTime(new Date(`${period}-16T09:00:00Z`));
    expect((await listEmployeeContracts(101, 1))[0].displayStatus).toBe("DUE");
    await expect(
      caller().contracts.terminate({
        id: pendingId,
        reason: "Withdraw due agreement",
      }),
    ).resolves.toMatchObject({ status: "TERMINATED" });
    expect((await snapshot()).salary).toBe("500000.00");
    expect((await listEmployeeContracts(101, 1))[0].status).toBe("TERMINATED");
  });
  it("rejects cancelling a scheduled agreement outside the actor's current branch", async () => {
    const pendingId = await scheduled(102);
    await expect(
      caller().contracts.terminate({
        id: pendingId,
        reason: "Foreign cancellation",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeeContracts))[0].status).toBe(
      "DRAFT",
    );
    expect((await snapshot(102)).salary).toBe("500000.00");
  });
  it("requires a reason for cancelling a reviewed draft", async () => {
    const pendingId = await scheduled();
    await expect(
      caller().contracts.terminate({ id: pendingId, reason: "   " }),
    ).rejects.toThrow(/سبب/);
    expect((await db().select().from(s.employeeContracts))[0].status).toBe(
      "DRAFT",
    );
  });
  it("rejects cancellation using a revoked actor account", async () => {
    const pendingId = await scheduled();
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, maker.userId));
    await expect(
      caller().contracts.terminate({
        id: pendingId,
        reason: "Revoked cancellation",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.employeeContracts))[0].status).toBe(
      "DRAFT",
    );
  });
  it("continues rejecting unreviewed drafts through the termination operation", async () => {
    const draft = await caller().contracts.create({
      employeeId: 101,
      contractType: "FIXED_TERM",
      startDate: "2099-01-01",
    });
    await expect(
      caller().contracts.terminate({ id: draft.id, reason: "Unreviewed" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("does not turn scheduled-only cancellation into ACTIVE termination after a state race", async () => {
    const currentId = await contract();
    await expect(
      caller().contracts.terminate({
        id: currentId,
        reason: "Opened as scheduled",
        cancelScheduledOnly: true,
      } as Parameters<ReturnType<typeof caller>["contracts"]["terminate"]>[0]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(s.employeeContracts))[0].status).toBe(
      "ACTIVE",
    );
  });
});

describe("audit26 fractional leave accrual", () => {
  it("preserves numeric day balances in the published employee and leave APIs", async () => {
    await db()
      .update(s.employees)
      .set({ annualLeaveBalance: "1.67", sickLeaveBalance: "0.50" })
      .where(eq(s.employees.id, 101));
    const employeeCaller = employeeRouter.createCaller({
      user: { id: 10, role: "admin", branchId: 1, isOwner: true },
      req: { headers: {} },
      res: {},
    } as unknown as TrpcContext);
    const employee = await employeeCaller.get({ id: 101 });
    expect(employee.annualLeaveBalance).toBe(1.67);
    expect(employee.sickLeaveBalance).toBe(0.5);
    const list = await employeeCaller.list();
    expect(list.rows.find((row) => row.id === 101)!.annualLeaveBalance).toBe(
      1.67,
    );
    expect((await balances(1))[0].annualLeaveBalance).toBe(1.67);
  });
  it("retains the fractional remainder through leave deduction, cancellation, reports and encashment", async () => {
    await db()
      .update(s.employees)
      .set({ annualLeaveBalance: "1.67", salary: "30000.00" })
      .where(eq(s.employees.id, 101));
    const leave = await createLeave(
      {
        employeeId: 101,
        leaveType: "سنوية",
        fromDate: "2026-10-26",
        toDate: "2026-10-26",
        scopedBranchId: 1,
      },
      maker,
    );
    await decideLeave(leave.id, "approved", {
      userId: checker.userId,
      scopedBranchId: 1,
    });
    expect((await snapshot()).annualLeaveBalance).toBe("0.67");
    expect((await balances(1))[0].annualLeaveBalance).toBe(0.67);
    expect(
      calculateLeaveEncashment(await snapshot()).encashmentAmount.toFixed(2),
    ).toBe("670.00");
    await cancelLeave(leave.id, { userId: checker.userId, scopedBranchId: 1 });
    expect((await snapshot()).annualLeaveBalance).toBe("1.67");
    expect(
      calculateLeaveEncashment(await snapshot()).encashmentAmount.toFixed(2),
    ).toBe("1670.00");
  });
  it("accepts fractional day balances through the actual employee router", async () => {
    const employeeCaller = employeeRouter.createCaller({
      user: { id: 10, role: "admin", branchId: 1, isOwner: true },
      req: { headers: {} },
      res: {},
    } as unknown as TrpcContext);
    const result = await employeeCaller.create({
      firstName: "Fractional",
      lastName: "Days",
      branchId: 1,
      payType: "monthly",
      annualLeaveBalance: 1.67,
      sickLeaveBalance: 0.5,
    });
    expect(
      new Decimal((await snapshot(result!.id)).annualLeaveBalance ?? 0).toFixed(
        2,
      ),
    ).toBe("1.67");
  });
  it("stores the same fractional entitlement reported by a monthly accrual", async () => {
    const result = await accrueMonthlyLeave("2025-01", admin);
    expect(
      new Decimal((await snapshot()).annualLeaveBalance ?? 0).toFixed(2),
    ).toBe(result.daysPerEmployee);
  });
  it("accrues exactly twenty days across twelve monthly events", async () => {
    const monthly: string[] = [];
    for (let month = 1; month <= 12; month++) {
      const result = await accrueMonthlyLeave(
        `2025-${String(month).padStart(2, "0")}`,
        admin,
      );
      monthly.push(result.daysPerEmployee);
    }
    expect(
      monthly.reduce((sum, days) => sum.plus(days), new Decimal(0)).toFixed(2),
    ).toBe("20.00");
    expect(
      new Decimal((await snapshot()).annualLeaveBalance ?? 0).toFixed(2),
    ).toBe("20.00");
    const logs = await db()
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "leave.accrueMonth"),
          eq(s.auditLogs.entityId, "2025-02"),
        ),
      );
    expect(logs[0].newValue).toMatchObject({ daysPerEmployee: "1.66" });
  });
});

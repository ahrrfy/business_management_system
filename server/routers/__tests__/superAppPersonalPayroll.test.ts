import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { base32Decode, base32Encode, hotp } from "../../auth/totp";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";
import {
  getMobileAttendanceHistory,
  getMobilePayslip,
  getMobileToday,
} from "../../services/mobileTodayService";
import { encryptSecret } from "../../services/cryptoService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function caller(
  userId: number,
  nativeClientId: TrpcContext["nativeClientId"] = null,
) {
  const context: TrpcContext = {
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: {
      id: userId,
      role: "cashier",
      branchId: 1,
      name: `user-${userId}`,
      email: `user-${userId}@test.local`,
      isActive: true,
    } as TrpcContext["user"],
    nativeClientId,
  };
  return appRouter.createCaller(context);
}

function mobileToday(userId: number, role = "cashier", isOwner = false) {
  return getMobileToday({
    actor: { userId, role, isOwner, branchId: 1 },
    date: "2026-09-10",
    db: db(),
  });
}

function mobileAttendanceHistory(userId: number) {
  return getMobileAttendanceHistory({
    actor: { userId, role: "cashier", branchId: 1 },
    date: "2026-09-10",
    db: db(),
  });
}

beforeEach(async () => {
  await truncateTables([
    "attendance",
    "appNotificationOutbox",
    "nativePushOutbox",
    "webPushOutbox",
    "appNotifications",
    "leaveRequests",
    "idempotencyKeys",
    "auditLogs",
    "payrollItems",
    "payrollRuns",
    "employees",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 2,
        openId: "employee-a",
        name: "Employee A",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "employee-b",
        name: "Employee B",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db()
    .insert(s.employees)
    .values([
      {
        id: 20,
        userId: 2,
        firstName: "A",
        lastName: "Employee",
        branchId: 1,
        payType: "monthly",
        salary: "1000",
        employmentStatus: "active",
        isActive: true,
      },
      {
        id: 30,
        userId: 3,
        firstName: "B",
        lastName: "Employee",
        branchId: 1,
        payType: "monthly",
        salary: "2000",
        employmentStatus: "active",
        isActive: true,
      },
    ]);
  await db()
    .insert(s.payrollRuns)
    .values([
      { id: 100, period: "2026-06", status: "approved", employeeCount: 2 },
      { id: 101, period: "2026-07", status: "paid", employeeCount: 2 },
      { id: 102, period: "2026-08", status: "draft", employeeCount: 2 },
    ]);
  await db()
    .insert(s.payrollItems)
    .values([
      {
        id: 200,
        runId: 100,
        employeeId: 20,
        payType: "monthly",
        gross: "1000",
        deductions: "100",
        net: "900",
      },
      {
        id: 201,
        runId: 101,
        employeeId: 20,
        payType: "monthly",
        gross: "1100",
        allowances: "50",
        deductions: "100",
        net: "1000",
      },
      {
        id: 202,
        runId: 102,
        employeeId: 20,
        payType: "monthly",
        gross: "1200",
        deductions: "100",
        net: "1100",
      },
      {
        id: 300,
        runId: 101,
        employeeId: 30,
        payType: "monthly",
        gross: "2000",
        deductions: "200",
        net: "1800",
      },
    ]);
});

describe("superApp personal payroll isolation", () => {
  it("advertises the personal workspace only for an account linked to an employee", async () => {
    const linked = await caller(2).superApp.bootstrap();
    const unlinked = await caller(99).superApp.bootstrap();

    expect(linked.capabilities.hasPersonalWorkspace).toBe(true);
    expect(unlinked.capabilities.hasPersonalWorkspace).toBe(false);
  });

  it("derives history from the session employee and hides draft or peer rows", async () => {
    const rows = await caller(2).superApp.payrollHistory({ limit: 36 });

    expect(rows.map((row) => row.itemId)).toEqual([201, 200]);
    expect(rows.every((row) => Number(row.net) <= 1000)).toBe(true);
  });

  it("returns a compact personal mobile home without salary fields or a caller-supplied subject", async () => {
    const today = await mobileToday(2);
    const serialized = JSON.stringify(today);

    expect(today.personal.state).toBe("READY");
    expect(today.navigation).toEqual({ ownerCenter: false, personal: true, work: true });
    expect(today.personal.payroll).toEqual(
      expect.objectContaining({
        period: "2026-07",
        status: "approved",
        action: { destination: "SELF_PAYROLL", requiresStepUp: true },
      }),
    );
    expect(serialized).not.toContain("1000.00");
    expect(serialized).not.toContain('"allowances"');
    expect(serialized).not.toContain('"gross"');
  });

  it("returns an explicit unlinked state instead of another employee's data", async () => {
    const today = await mobileToday(99);

    expect(today.personal).toMatchObject({
      state: "NOT_LINKED",
      employee: null,
      attendance: null,
      focus: null,
      payroll: null,
    });
    expect(today.navigation).toEqual({ ownerCenter: false, personal: false, work: false });
  });

  it("derives mobile navigation from the server role and employee link", async () => {
    await expect(mobileToday(2, "manager")).resolves.toMatchObject({
      navigation: { ownerCenter: true, personal: true, work: true },
    });
    await expect(mobileToday(99, "admin", true)).resolves.toMatchObject({
      navigation: { ownerCenter: true, personal: false, work: false },
    });
  });

  it("returns only the signed-in employee's bounded attendance history", async () => {
    await db().insert(s.attendance).values([
      {
        employeeId: 20,
        attendanceDate: "2026-09-10",
        checkIn: new Date("2026-09-10T06:00:00.000Z"),
        status: "PRESENT",
        hours: "8.00",
        hourlyRate: "10000.00",
        amount: "80000.00",
        notes: "private manager note",
        source: "fingerprint",
      },
      {
        employeeId: 30,
        attendanceDate: "2026-09-10",
        checkIn: new Date("2026-09-10T07:00:00.000Z"),
        status: "LATE",
        hours: "7.00",
      },
      {
        employeeId: 20,
        attendanceDate: "2026-08-10",
        status: "PRESENT",
        hours: "8.00",
      },
    ]);

    const history = await mobileAttendanceHistory(2);
    expect(history.range).toEqual({ from: "2026-08-11", to: "2026-09-10" });
    expect(history.personal.entries).toEqual([
      expect.objectContaining({
        date: "2026-09-10",
        status: "PRESENT",
        hours: "8.00",
        state: "RECORDED",
      }),
    ]);
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain("hourlyRate");
    expect(serialized).not.toContain("80000");
    expect(serialized).not.toContain("private manager note");
  });

  it("returns no payroll figures when a session has no linked employee", async () => {
    const result = await getMobilePayslip({
      actor: { userId: 99, role: "cashier", branchId: 1 },
      db: db(),
    });
    expect(result).toEqual({ personal: { state: "NOT_LINKED", payslip: null } });
  });

  it("returns structured own payslip detail but rejects another employee item", async () => {
    const own = await caller(2).superApp.payslipDetail({ payrollItemId: 201 });

    expect(own.period).toBe("2026-07");
    expect(own.allowances).toBe("50.00");
    expect(own.penaltyDeduction).toBeNull();
    await expect(
      caller(2).superApp.payslipDetail({ payrollItemId: 300 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves unknown historical penalty detail and employee isolation in personal payslips", async () => {
    await expect(caller(2).payroll.myPayslip({ runId: 100 })).resolves.toMatchObject({ item: { penaltyDeduction: null, penaltyLines: [] } });
    await expect(caller(3).payroll.myPayslip({ runId: 100 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reserves historical-penalty evidence preview and attestation to the owner", async () => {
    await expect(caller(2).payroll.historicalPenaltyPreview({ penaltyId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(2).payroll.attestHistoricalPenalty({ penaltyId: 1, itemId: 1,
      sourceHash: "a".repeat(64), requestKey: "audit-test-001", reportedActualPayout: "1.00", reportedCashSource: "TREASURY",
      evidenceStatement: "تصريح تاريخي لغرض الاختبار", evidenceReference: "مرجع اختبار موثق",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects caller-supplied employeeId instead of silently accepting it", async () => {
    await expect(
      (
        caller(2).superApp.payrollHistory as unknown as (
          input: unknown,
        ) => Promise<unknown>
      )({
        limit: 10,
        employeeId: 30,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

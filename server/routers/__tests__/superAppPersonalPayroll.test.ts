import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function caller(userId: number) {
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
  };
  return appRouter.createCaller(context);
}

beforeEach(async () => {
  await truncateTables([
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
  it("derives history from the session employee and hides draft or peer rows", async () => {
    const rows = await caller(2).superApp.payrollHistory({ limit: 36 });

    expect(rows.map((row) => row.itemId)).toEqual([201, 200]);
    expect(rows.every((row) => Number(row.net) <= 1000)).toBe(true);
  });

  it("returns structured own payslip detail but rejects another employee item", async () => {
    const own = await caller(2).superApp.payslipDetail({ payrollItemId: 201 });

    expect(own.period).toBe("2026-07");
    expect(own.allowances).toBe("50.00");
    await expect(
      caller(2).superApp.payslipDetail({ payrollItemId: 300 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

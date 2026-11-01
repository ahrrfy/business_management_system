import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getPayrollSummary } from "../reportsHrService";
import { truncateTables } from "./__testUtils__";

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set");
  return connection;
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems",
    "payrollRuns",
    "employees",
    "branches",
  ]);
  await db().insert(schema.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(schema.employees)
    .values([
      {
        id: 1,
        firstName: "أحمد",
        lastName: "الجبوري",
        payType: "monthly",
        salary: "600.00",
        employmentStatus: "active",
        isActive: true,
        branchId: 1,
        hireDate: "2025-01-01",
      },
      {
        id: 2,
        firstName: "زينب",
        lastName: "الربيعي",
        payType: "monthly",
        salary: "400.00",
        employmentStatus: "active",
        isActive: true,
        branchId: 1,
        hireDate: "2025-01-01",
      },
    ]);
});

describe("ملخص استقطاع السلف في تقرير الرواتب", () => {
  it("يجمع payrollItems مرة لكل مسيّر من مراجعته الحالية دون مضاعفة رأس المسيّر", async () => {
    await db()
      .insert(schema.payrollRuns)
      .values([
        {
          id: 101,
          period: "2026-08",
          branchId: 1,
          status: "approved",
          revisionNo: 3,
          employeeCount: 2,
          totalGross: "1000.00",
          totalDeductions: "300.00",
          totalNet: "700.00",
        },
        {
          id: 102,
          period: "2026-09",
          branchId: 1,
          status: "draft",
          revisionNo: 0,
          employeeCount: 1,
          totalGross: "900.00",
          totalDeductions: "50.00",
          totalNet: "850.00",
        },
      ]);
    await db()
      .insert(schema.payrollItems)
      .values([
        {
          runId: 101,
          employeeId: 1,
          revisionNo: 3,
          payType: "monthly",
          gross: "600.00",
          deductions: "70.00",
          advanceDeduction: "70.00",
          net: "530.00",
        },
        {
          runId: 101,
          employeeId: 2,
          revisionNo: 3,
          payType: "monthly",
          gross: "400.00",
          deductions: "230.00",
          advanceDeduction: "30.00",
          net: "170.00",
        },
        {
          runId: 101,
          employeeId: 1,
          revisionNo: 2,
          payType: "monthly",
          gross: "600.00",
          deductions: "999.00",
          advanceDeduction: "999.00",
          net: "0.00",
        },
        {
          runId: 102,
          employeeId: 1,
          revisionNo: 0,
          payType: "monthly",
          gross: "900.00",
          deductions: "50.00",
          advanceDeduction: "50.00",
          net: "850.00",
        },
      ]);

    const result = await getPayrollSummary();

    expect(
      result.rows.map((row) => [row.id, row.totalAdvanceDeduction]),
    ).toEqual([
      [102, "50.00"],
      [101, "100.00"],
    ]);
    expect(result.totals.totalAdvanceDeduction).toBe("150.00");
    expect(result.totals.gross).toBe("1900.00");

    const august = await getPayrollSummary({ period: "2026-08" });
    expect(august.rows).toHaveLength(1);
    expect(august.rows[0]?.totalAdvanceDeduction).toBe("100.00");
    expect(august.totals.totalAdvanceDeduction).toBe("100.00");
  });
});

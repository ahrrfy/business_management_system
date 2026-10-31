import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import {
  listAdvances,
  suggestDeductionsForPeriod,
} from "../advances";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return previous.toISOString().slice(0, 7);
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "advanceSettlements",
    "employeeLoanRequests",
    "employeeAdvances",
    "employees",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`DELETE FROM \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await d
    .insert(s.users)
    .values({ id: 1, openId: "monthly-projection-test", role: "admin" });
  await d.insert(s.employees).values({
    id: 10,
    branchId: 1,
    firstName: "اختبار",
    lastName: "السلف الشهرية",
    payType: "monthly",
    salary: "1000000.00",
    employmentStatus: "active",
  });
});

describe("سلامة السلف الشهرية", () => {
  it("يحفظ حالات الرفض والإلغاء التاريخية ولا يعرضها كطلبات غير مصنفة قابلة للإلغاء", async () => {
    await db()
      .insert(s.employeeLoanRequests)
      .values(
        (["PENDING", "REJECTED", "CANCELLED"] as const).map((status) => ({
          employeeId: 10,
          branchId: 1,
          amount: "1000.00",
          monthlyDeduction: "1000.00",
          payrollPeriod: null,
          status,
          createdById: 1,
        })),
      );
    const rows = await listAdvances({
      employeeId: 10,
      period: baghdadToday().slice(0, 7),
    });
    expect(rows.map((row) => row.status).sort()).toEqual([
      "CANCELLED",
      "LEGACY_UNCLASSIFIED",
      "REJECTED",
    ]);
    expect(rows.find((row) => row.status === "CANCELLED")?.workflowStatus).toBe(
      "CANCELLED",
    );
    expect(rows.find((row) => row.status === "REJECTED")?.workflowStatus).toBe(
      "REJECTED",
    );
  });

  it("يجمع كل سلف الشهر كاملة ولا يلتقط سلفة راتبية من شهر آخر", async () => {
    const current = baghdadToday().slice(0, 7);
    const previous = previousPeriod(current);
    await db()
      .insert(s.employeeAdvances)
      .values([
        {
          employeeId: 10,
          branchId: 1,
          amount: "50000.00",
          remaining: "50000.00",
          monthlyDeduction: "5000.00",
          sourceType: "SALARY_ADVANCE",
          payrollPeriod: current,
          status: "ACTIVE",
          createdBy: 1,
        },
        {
          employeeId: 10,
          branchId: 1,
          amount: "25000.00",
          remaining: "25000.00",
          monthlyDeduction: "5000.00",
          sourceType: "SALARY_ADVANCE",
          payrollPeriod: current,
          status: "ACTIVE",
          createdBy: 1,
        },
        {
          employeeId: 10,
          branchId: 1,
          amount: "40000.00",
          remaining: "40000.00",
          monthlyDeduction: "5000.00",
          sourceType: "SALARY_ADVANCE",
          payrollPeriod: previous,
          status: "ACTIVE",
          createdBy: 1,
        },
        {
          employeeId: 10,
          branchId: 1,
          amount: "30000.00",
          remaining: "30000.00",
          monthlyDeduction: "10000.00",
          sourceType: "OTHER_DEDUCTION",
          payrollPeriod: null,
          status: "ACTIVE",
          createdBy: 1,
        },
      ]);

    const currentSuggestion = await suggestDeductionsForPeriod([10], current);
    const previousSuggestion = await suggestDeductionsForPeriod([10], previous);

    // الشهر الجاري: 50k + 25k كاملتين، والدين الآخر يحتفظ بقسطه 10k.
    expect(currentSuggestion[10]?.suggested).toBe("85000.00");
    // الشهر السابق لا يلتقط سلف الشهر الجاري: 40k كاملة + 10k دين آخر.
    expect(previousSuggestion[10]?.suggested).toBe("50000.00");

    const currentTable = await listAdvances({
      employeeId: 10,
      period: current,
    });
    const previousTable = await listAdvances({
      employeeId: 10,
      period: previous,
    });
    expect(currentTable.map((row) => row.amount).sort()).toEqual([
      "25000.00",
      "30000.00",
      "50000.00",
    ]);
    expect(previousTable.map((row) => row.amount)).toEqual(["40000.00"]);
  });
});

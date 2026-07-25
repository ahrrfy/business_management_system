import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { grantAdvance } from "../advancesService";
import { createEmployee } from "../employeeService";
import { approveRun, cancelRun, generatePayroll, payRun, updateItem } from "../payrollService";

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 2, branchId: 1, role: "manager" };

const TABLES = [
  "accountingEntries",
  "receipts",
  "shifts",
  "idempotencyKeys",
  "advanceSettlements",
  "employeeAdvances",
  "payrollItems",
  "payrollRuns",
  "attendance",
  "leaveRequests",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "pay-maker", name: "منشئ", role: "admin", branchId: 1 },
    { id: 2, openId: "pay-checker", name: "مدقق", role: "manager", branchId: 1 },
  ]);
});

describe("financial integrity — payroll", () => {
  it("يرفض استقطاعاً يجعل صافي بند الموظف سالباً", async () => {
    await createEmployee({
      firstName: "علي",
      lastName: "حسن",
      payType: "monthly",
      salary: "100000",
      allowances: "0",
      branchId: 1,
    });
    const run = await generatePayroll("2026-06", MAKER);
    await expect(updateItem(run!.items[0].id, { deductions: "100001" }, CHECKER)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("آخر معدّل مالي لا يستطيع اعتماد تعديله بنفسه", async () => {
    await createEmployee({
      firstName: "سارة",
      lastName: "كاظم",
      payType: "monthly",
      salary: "500000",
      allowances: "0",
      branchId: 1,
    });
    const run = await generatePayroll("2026-06", MAKER);
    await updateItem(run!.items[0].id, { overtime: "25000" }, CHECKER);
    await expect(approveRun(run!.id, CHECKER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveRun(run!.id, MAKER)).resolves.toMatchObject({ status: "approved" });
  });

  it("يحتسب الموظف المعين منتصف الشهر عن أيام خدمته فقط", async () => {
    await createEmployee({
      firstName: "نور",
      lastName: "عادل",
      payType: "monthly",
      salary: "300000",
      allowances: "30000",
      hireDate: "2026-06-16",
      branchId: 1,
    });
    const run = await generatePayroll("2026-06", MAKER);
    expect(Number(run!.items[0].gross)).toBe(165000);
    expect(Number(run!.items[0].allowances)).toBe(15000);
  });

  it("الإنتاج يرفض عكس راتب مدفوع بلا دليل تحصيل نقدي", async () => {
    await createEmployee({
      firstName: "زيد",
      lastName: "حيدر",
      payType: "monthly",
      salary: "250000",
      allowances: "0",
      branchId: 1,
    });
    const run = await generatePayroll("2026-06", MAKER);
    await approveRun(run!.id, CHECKER);
    await payRun(run!.id, CHECKER);
    await expect(cancelRun(run!.id, { ...MAKER, enforceCashReturnEvidence: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("financial integrity — advances", () => {
  it("يرفض تحميل سلفة موظف على فرع آخر", async () => {
    const employee = await createEmployee({
      firstName: "مريم",
      lastName: "فاضل",
      payType: "monthly",
      salary: "300000",
      branchId: 1,
    });
    await expect(
      grantAdvance(
        { employeeId: employee!.id, branchId: 2, amount: "1000", clientRequestId: "wrong-branch" },
        MAKER,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("طلبان متزامنان بنفس المفتاح لا ينشئان أكثر من رجل نقد واحد", async () => {
    const employee = await createEmployee({
      firstName: "حسن",
      lastName: "جواد",
      payType: "monthly",
      salary: "300000",
      branchId: 1,
    });
    const input = {
      employeeId: employee!.id,
      branchId: 1,
      amount: "1000",
      clientRequestId: "same-advance-request",
    };
    const results = await Promise.allSettled([grantAdvance(input, CHECKER), grantAdvance(input, CHECKER)]);
    if (!results.some((r) => r.status === "fulfilled")) {
      throw new Error(
        results
          .map((r) => (r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : "fulfilled"))
          .join(" | "),
      );
    }

    const advances = await db().select().from(s.employeeAdvances);
    const receipts = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(advances).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].amount)).toBe(1000);
  });
});

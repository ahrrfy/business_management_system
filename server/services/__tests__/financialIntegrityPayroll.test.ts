import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { grantAdvance } from "../advances";
import { createEmployee } from "../employeeService";
import { approveRun, cancelRun, generatePayroll, payRun, updateItem } from "../payrollService";
import { approveVoucher } from "../voucher/approval";

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 2, branchId: 1, role: "manager" };
const OWNER = { userId: 3, branchId: 1, role: "manager" };

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
    { id: 2, openId: "pay-checker", name: "مدقق", role: "manager", branchId: 1, isOwner: true, isActive: true },
    { id: 3, openId: "pay-owner", name: "مالك مستقل", role: "manager", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "100000000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 2,
  });
  await d.insert(s.shifts).values({ id: 901, branchId: 1, userId: 2, openingBalance: "100000000.00", status: "OPEN", shiftType: "RETAIL", openGuard: "1:2:RETAIL" });
});

describe("financial integrity — payroll", () => {
  it("لا تعطل عقوبة موظف خارج نطاق التوليد اعتماد رواتب بقية الموظفين", async () => {
    const included = await createEmployee({
      firstName: "موظف",
      lastName: "ضمن المسيّر",
      payType: "monthly",
      salary: "300000",
      hireDate: "2020-01-01",
      branchId: 1,
    });
    const excluded = await createEmployee({
      firstName: "موظف",
      lastName: "منتهية خدمته قبل الفترة",
      payType: "monthly",
      salary: "100000",
      hireDate: "2020-01-01",
      branchId: 1,
    });
    await db().update(s.employees).set({
      employmentStatus: "terminated",
      terminationDate: "2026-05-31",
      isActive: false,
    }).where(eq(s.employees.id, excluded!.id));
    await db().insert(s.employeePenalties).values({
      employeeId: excluded!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "OUTSIDE-PAYROLL-SCOPE",
      decisionDate: "2026-06-15",
      reason: "عقوبة معتمدة لموظف خارج نطاق مسيّر الفترة",
      deductionAmount: "5000.00",
      status: "APPROVED",
      createdById: MAKER.userId,
      approvedById: CHECKER.userId,
    });
    const run = await generatePayroll("2026-06", MAKER);
    if (run?.id == null || run.items == null) throw new Error("Expected a generated draft payroll");
    expect(run.items.map(item => Number(item.employeeId))).toEqual([included!.id]);
    await expect(approveRun(run.id, CHECKER)).resolves.toMatchObject({ status: "approved" });
    const [penalty] = await db().select().from(s.employeePenalties);
    expect(penalty).toMatchObject({ status: "APPROVED", payrollRunId: null });
  });

  it("يبقي حظر اعتماد عقوبة جديدة غير ملتقطة لموظف داخل المسيّر", async () => {
    const employee = await createEmployee({
      firstName: "موظف",
      lastName: "بعقوبة لاحقة للتوليد",
      payType: "monthly",
      salary: "300000",
      hireDate: "2020-01-01",
      branchId: 1,
    });
    const run = await generatePayroll("2026-06", MAKER);
    if (run?.id == null) throw new Error("Expected a generated draft payroll");
    await db().insert(s.employeePenalties).values({
      employeeId: employee!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "UNCAPTURED-IN-PAYROLL",
      decisionDate: "2026-06-15",
      reason: "عقوبة اعتمدت بعد توليد مسودة الراتب",
      deductionAmount: "5000.00",
      status: "APPROVED",
      createdById: MAKER.userId,
      approvedById: CHECKER.userId,
    });
    await expect(approveRun(run.id, CHECKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

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

  it("آخر معدّل مالي مالكٌ نشط يعتمد تعديله بنفسه (قرار المالك ٣/٩/٢٦)", async () => {
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
    const firstApproval = await approveRun(run!.id, CHECKER);
    expect(firstApproval).toMatchObject({ status: "approved", replayed: false });
    const replay = await approveRun(run!.id, OWNER);
    expect(replay).toMatchObject({ status: "approved", replayed: true });
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
    await expect(cancelRun(run!.id, { ...OWNER, enforceCashReturnEvidence: true })).rejects.toMatchObject({
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
    const results = await Promise.allSettled([grantAdvance(input, MAKER), grantAdvance(input, MAKER)]);
    if (!results.some((r) => r.status === "fulfilled")) {
      throw new Error(
        results
          .map((r) => (r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : "fulfilled"))
          .join(" | "),
      );
    }

    const fulfilled = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof grantAdvance>>> => r.status === "fulfilled");
    expect(fulfilled?.value.status).toBe("PENDING_APPROVAL");
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
    let receipts = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].amount)).toBe(1000);
    expect(receipts[0]).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null });

    await approveVoucher(Number(fulfilled!.value.receiptId), CHECKER);

    const advances = await db().select().from(s.employeeAdvances);
    receipts = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(advances).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED", cashBucket: "DRAWER" });
  });
});

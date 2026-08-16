// اعتراف مصروف الرواتب بالأجر المكتسَب لا بالصافي — سلفة الموظف كانت تختفي من قائمة الدخل.
//
// الخلل: سندُ منح السلفة يُخرج النقد بقيد PAYMENT_OUT بمفتاحٍ خارج نطاق PAYROLL% فلا يدخل
// قائمة الدخل، ودفعُ الراتب كان يقيّد **الصافي** فقط. فموظفٌ بأجر ١م أخذ سلفة ٣٠٠ألف
// يُسجَّل مصروفُه ٧٠٠ألف — والربحُ مضخَّمٌ بالفارق دائماً.
//
// الثوابت المحروسة:
//   م١) دفع المسيّر يقيّد مصروفاً = الصافي + استرداد السلفة (أي الأجر المكتسَب).
//   م٢) قيد الاسترداد **بلا إيصال** ⇒ لا يُنقص الخزينة مرّتين (النقد خرج عند المنح).
//   م٣) عكس الدفع يعكس القيدين معاً ⇒ صافي أثر الدفتر صفر.
//   م٤) بلا سلفة: قيدٌ واحدٌ فقط كما كان (صفر انحدار).
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { approveRun, cancelRun, generatePayroll, payRun } from "../payrollService";
import { grantAdvance } from "../advancesService";
import { approveVoucher } from "../voucher/approval";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 9, branchId: 1, role: "admin" };
const PERIOD = "2026-06";

/** مصروف الرواتب يُثبت عند الاعتماد بقيد استحقاق ADJUST، لا عند التسوية النقدية. */
async function payrollExpense(): Promise<number> {
  const [r] = await db()
    .select({ total: sql<string>`COALESCE(SUM(${s.accountingEntries.amount}), 0)` })
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, "ADJUST"), like(s.accountingEntries.dedupeKey, "PAYROLL:ACCRUAL%")));
  return Number(r?.total ?? 0);
}

/** صافي أثر الخزينة من إيصالات الرواتب (OUT سالب، IN موجب). */
async function treasuryDelta(): Promise<number> {
  const rows = await db().select().from(s.receipts).where(eq(s.receipts.cashBucket, "TREASURY"));
  return rows
    .filter((r) => r.referenceNumber !== "TEST-TREASURY-FUND")
    .reduce((sum, r) => sum + (r.direction === "OUT" ? -Number(r.amount) : Number(r.amount)), 0);
}

async function grantAndApproveAdvance(input: Parameters<typeof grantAdvance>[0]) {
  const pending = await grantAdvance(input, MAKER as never);
  await approveVoucher(Number(pending.receiptId), CHECKER as never);
  return pending;
}

beforeEach(async () => {
  await truncateTables([
    "accountingEntries",
    "payrollItems",
    "payrollRuns",
    "advanceSettlements",
    "employeeAdvances",
    "idempotencyKeys",
    "receipts",
    "leaveRequests",
    "attendance",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "مُولِّد", role: "admin", loginMethod: "local" },
    { id: 9, openId: "b", name: "معتمِد", role: "admin", loginMethod: "local", isOwner: true },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1, direction: "IN", amount: "100000000", paymentMethod: "CASH",
    cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND", createdBy: 9,
  });
  await d.insert(s.employees).values({
    id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "1000000", allowances: "0",
    employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
  });
});

describe("مصروف الرواتب مع السلف", () => {
  it("م١+م٢) المصروف = الصافي + استرداد السلفة، والخزينة تنقص بالصافي فقط", async () => {
    await grantAndApproveAdvance(
      { employeeId: 1, branchId: 1, amount: "200000", monthlyDeduction: "200000", clientRequestId: "adv-x" },
    );
    const treasuryAfterGrant = await treasuryDelta();
    expect(treasuryAfterGrant).toBe(-200000); // خرج نقد السلفة

    const run = await generatePayroll(PERIOD, MAKER as never);
    await approveRun(Number(run.id), CHECKER as never);
    await payRun(Number(run.id), CHECKER as never);

    const [item] = await db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, Number(run.id)));
    expect(Number(item.gross)).toBe(1000000);
    expect(Number(item.advanceDeduction)).toBe(200000);
    expect(Number(item.net)).toBe(800000);

    // المصروف المُعترَف به = الأجر المكتسَب كاملاً (كان ٨٠٠ألف فقط).
    expect(await payrollExpense()).toBe(1000000);
    // والخزينة نقصت ٢٠٠ألف (السلفة) + ٨٠٠ألف (الصافي) = ١م — لا ١٫٢م.
    expect(await treasuryDelta()).toBe(-1000000);
  });

  it("م٣) إعادة فتح المسيّر المعتمد تعكس قيد الاستحقاق ⇒ صافي المصروف صفر", async () => {
    await grantAndApproveAdvance(
      { employeeId: 1, branchId: 1, amount: "200000", monthlyDeduction: "200000", clientRequestId: "adv-y" },
    );
    const run = await generatePayroll(PERIOD, MAKER as never);
    await approveRun(Number(run.id), CHECKER as never);
    expect(await payrollExpense()).toBe(1000000);

    await cancelRun(Number(run.id), CHECKER as never);
    expect(await payrollExpense()).toBe(0);
  });

  it("م٤) بلا سلفة: قيد استحقاق واحد والمصروف لا يتكرر عند الدفع", async () => {
    const run = await generatePayroll(PERIOD, MAKER as never);
    await approveRun(Number(run.id), CHECKER as never);
    expect(await payrollExpense()).toBe(1000000);
    await payRun(Number(run.id), CHECKER as never);

    expect(await payrollExpense()).toBe(1000000);
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(like(s.accountingEntries.dedupeKey, "PAYROLL:ACCRUAL%"));
    expect(entries).toHaveLength(1);
  });
});

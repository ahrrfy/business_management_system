// دقّة مسيّر الرواتب — خصم الإجازة بلا راتب والحارس المستقبليّ.
//
// الثوابت المحروسة:
//   ك١) `countDaysWithin` تقصّ أيام الإجازة عند نافذة عمل الموظف وتوحّد التداخل.
//   ك٢) شهر الفصل/التعيين: الأيام خارج نافذة العمل لا تُخصم مرّتين (تناسبٌ ثم إجازة).
//   ك٣) الشهر القصير: إجازة تستغرق نافذة العمل كلّها ⇒ الأجر صفر، لا ٧٪ باقية من
//       تناقض المقامين (تناسب ÷أيام الشهر مقابل معدّل يوميّ ÷٣٠).
//   ك٤) لا يُولَّد مسيّر لشهر لم يبدأ — كان يُقدّم ترقياتٍ مؤجَّلة بأثرٍ دائم لا يتراجع بحذف المسودّة.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { countDaysWithin, generatePayroll } from "../payrollService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" };

describe("countDaysWithin (ك١)", () => {
  it("يقصّ عند حدّي النافذة", () => {
    expect(countDaysWithin([{ from: "2026-07-01", to: "2026-07-31" }], "2026-07-10", "2026-07-20")).toBe(11);
  });
  it("فترة خارج النافذة كلياً = صفر", () => {
    expect(countDaysWithin([{ from: "2026-07-21", to: "2026-07-31" }], "2026-07-01", "2026-07-20")).toBe(0);
  });
  it("يوحّد الفترات المتداخلة فلا يُحتسب اليوم مرّتين", () => {
    const spans = [
      { from: "2026-07-05", to: "2026-07-10" },
      { from: "2026-07-08", to: "2026-07-12" },
    ];
    expect(countDaysWithin(spans, "2026-07-01", "2026-07-31")).toBe(8); // 5..12
  });
  it("فترتان منفصلتان تُجمعان", () => {
    const spans = [
      { from: "2026-07-05", to: "2026-07-06" },
      { from: "2026-07-20", to: "2026-07-22" },
    ];
    expect(countDaysWithin(spans, "2026-07-01", "2026-07-31")).toBe(5);
  });
  it("نافذة مقلوبة (فصلٌ قبل بداية الشهر) = صفر", () => {
    expect(countDaysWithin([{ from: "2026-07-01", to: "2026-07-31" }], "2026-07-20", "2026-07-10")).toBe(0);
  });
});

describe("خصم الإجازة بلا راتب في المسيّر", () => {
  beforeEach(async () => {
    await truncateTables([
      "payrollItems",
      "payrollRuns",
      "leaveRequests",
      "employeeAdvances",
      "attendance",
      "employees",
      "branches",
      "users",
    ]);
    const d = db();
    await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
    await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  });

  it("ك٢) شهر الفصل: أيام الإجازة بعد آخر يوم عمل لا تُخصم ثانيةً", async () => {
    await db().insert(s.employees).values({
      id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "terminated", isActive: false, branchId: 1, hireDate: "2026-01-01", terminationDate: "2026-07-20",
    });
    // إجازة بلا راتب ٢١–٣١ تموز — كلّها بعد آخر يوم عمل ⇒ التناسب استبعدها أصلاً.
    await db().insert(s.leaveRequests).values({
      employeeId: 1, leaveType: "unpaid", fromDate: "2026-07-21", toDate: "2026-07-31",
      days: 11, paid: false, status: "approved", reason: "بلا راتب",
    });

    const run = await generatePayroll("2026-07", ADMIN as never);
    const [item] = await db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, Number(run.id)));

    // gross = 900000 × 20/31 = 580,645.16 ⇒ لا خصم إجازة فوقه.
    expect(Number(item.gross)).toBeCloseTo(580645.16, 1);
    expect(Number(item.deductions)).toBe(0);
    expect(Number(item.net)).toBeCloseTo(580645.16, 1);
  });

  it("ك٣) شباط كاملاً بإجازة بلا راتب ⇒ صافي صفر لا ٧٪ متبقّية", async () => {
    await db().insert(s.employees).values({
      id: 2, firstName: "زينب", lastName: "الربيعي", payType: "monthly", salary: "1200000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
    });
    await db().insert(s.leaveRequests).values({
      employeeId: 2, leaveType: "unpaid", fromDate: "2026-02-01", toDate: "2026-02-28",
      days: 28, paid: false, status: "approved", reason: "بلا راتب",
    });

    const run = await generatePayroll("2026-02", ADMIN as never);
    const [item] = await db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, Number(run.id)));

    expect(Number(item.gross)).toBe(1200000);
    expect(Number(item.deductions)).toBe(1200000); // كان 1,120,000 فيبقى 80,000
    expect(Number(item.net)).toBe(0);
    expect(String(item.note ?? "")).toContain("كامل فترة العمل");
  });

  it("إجازة جزئية عادية تبقى على المعدّل اليوميّ ÷٣٠ (صفر انحدار)", async () => {
    await db().insert(s.employees).values({
      id: 3, firstName: "علي", lastName: "الكناني", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
    });
    await db().insert(s.leaveRequests).values({
      employeeId: 3, leaveType: "unpaid", fromDate: "2026-07-10", toDate: "2026-07-14",
      days: 5, paid: false, status: "approved", reason: "بلا راتب",
    });

    const run = await generatePayroll("2026-07", ADMIN as never);
    const [item] = await db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, Number(run.id)));

    expect(Number(item.gross)).toBe(900000);
    expect(Number(item.deductions)).toBe(150000); // 5 × 30,000
    expect(Number(item.net)).toBe(750000);
  });
});

describe("حارس الشهر المستقبليّ (ك٤)", () => {
  beforeEach(async () => {
    await truncateTables(["payrollItems", "payrollRuns", "employees", "branches", "users"]);
    const d = db();
    await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
    await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  });

  it("يرفض توليد مسيّر لشهرٍ لم يبدأ بعد", async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    await expect(generatePayroll(`${nextYear}-08`, ADMIN as never)).rejects.toThrow(/لم يبدأ بعد/);
    const runs = await db().select().from(s.payrollRuns);
    expect(runs).toHaveLength(0);
  });
});

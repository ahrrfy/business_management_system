// صدق سعر الساعة في سجلّ الحضور (١/٨) — «الجدول مضلِّل ولا يسحب المعلومات الصحيحة من الموظف».
//
// الواقعة: موظف شهريّ راتبه ٤٠٠٬٠٠٠ وجدولُه ٧ ساعات بسعر ١٬٩٠٥ ظهر في السجلّ بـ**٦٬٠٠٠**
// للساعة و**٤٢٬٠٠٠** أجرَ يوم — رقمٌ لن يُصرف أبداً. سببان مركَّبان:
//   ١) آخر درجةٍ في سلّم السعر كانت `DAY_RATES_DEFAULT` المكتوب في المصدر (السبت=٦٠٠٠).
//   ٢) اللقطة تُكتب مرّةً ولا يُعيد أحدٌ اشتقاقها — فضبطُ جدول الموظف لاحقاً لا يُصلح صفّاً.
//
// الثوابت المحروسة:
//   ص١) السعر من جدول الموظف الصريح — لا من ثابتٍ في الكود.
//   ص٢) بلا جدول: يُشتقّ من الراتب بنفس مقام المسيّر (لا رقمَ مُختلَق).
//   ص٣) بلا راتبٍ ولا سعر: **صفرٌ موسوم** `none` — لا اختلاق.
//   ص٤) السجلّ يعرض المُشتقّ الحيّ ويَسِم اللقطة المخالفة `rateStale`.
//   ص٥) إعادة الاحتساب تُطابق المخزَّن مع ملفّ الموظف (وعاء أجر الساعيّ في المسيّر).
//   ص٦) شهرٌ مسيّرُه معتمد لا يُعاد احتسابه (لا يُفسد مسيّراً مُلتزَماً مالياً).
//   ص٧) خيارات النموذج تشمل الشهريّ — كانت مقصورةً على الساعيّ فتظهر فارغةً.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  formOptions,
  listAttendance,
  rateForDayDetailed,
  recomputeMonthRates,
  recordAttendance,
} from "../attendanceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

/** ٢٠٢٦-٠٨-٠١ سبتٌ — وهو اليوم الذي كان `DAY_RATES_DEFAULT` يعطيه ٦٠٠٠ بالضبط. */
const SAT = "2026-08-01";
const SCHED_7H_1905 = Object.fromEntries(
  ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"].map((d) => [d, { hours: 7, rate: 1905 }]),
);

beforeEach(async () => {
  await truncateTables(["payrollItems", "payrollRuns", "attendance", "employees", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values({
    id: 1, firstName: "محمد", lastName: "المرسومي", payType: "monthly", salary: "400000", allowances: "0",
    employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01", workSchedule: SCHED_7H_1905,
  });
});

describe("سعر الساعة يُشتقّ من ملفّ الموظف لا من ثابتٍ في الكود", () => {
  it("ص١) جدولٌ صريح ⇒ سعرُه هو، لا ٦٠٠٠ الافتراضيّ", () => {
    const r = rateForDayDetailed({ payType: "monthly", salary: "400000", workSchedule: SCHED_7H_1905 }, SAT);
    expect(r.rate).toBe(1905);
    expect(r.basis).toBe("schedule");
  });

  it("ص٢) بلا جدول ⇒ الراتب ÷ ساعات ٣٠ يوماً (مقام المسيّر) لا رقمٌ مُختلَق", () => {
    // الجدول الاحتياطيّ: ٦ أيام × ٨ ساعات، والجمعة راحة ⇒ ٢٦ يوم دوامٍ في أوّل ٣٠ يوماً من آب = ٢٠٨.
    const r = rateForDayDetailed({ payType: "monthly", salary: "400000", workSchedule: null }, SAT);
    expect(r.basis).toBe("fallbackSchedule");
    expect(r.rate).toBeCloseTo(400000 / 208, 4);
    expect(r.rate).not.toBe(6000);
  });

  it("ص٣) بلا راتبٍ ولا سعر ⇒ صفرٌ موسوم «none» — لا اختلاق", () => {
    expect(rateForDayDetailed({ payType: "monthly", salary: null, workSchedule: null }, SAT)).toEqual({ rate: 0, basis: "none" });
    expect(rateForDayDetailed({ payType: "hourly", dayRates: null }, SAT)).toEqual({ rate: 0, basis: "none" });
  });

  it("ص٤) لقطةٌ قديمة: السجلّ يعرض الحيّ ويَسِمها stale بدل أن يُصدّقها", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: SAT, hours: 7, source: "manual" });
    // نُحاكي ما حدث فعلاً: صفٌّ كُتب قبل ضبط الجدول ⇒ لقطةُ ٦٠٠٠ و٤٢٬٠٠٠.
    await db().update(s.attendance).set({ hourlyRate: "6000.00", amount: "42000.00" }).where(eq(s.attendance.employeeId, 1));

    const list = await listAttendance({ period: "2026-08" });
    const row = list.rows[0];
    expect(Number(row.hourlyRate)).toBe(1905); // المعروض = ملفّ الموظف الآن
    expect(Number(row.amount)).toBe(13335); // ٧ × ١٬٩٠٥ — لا ٤٢٬٠٠٠
    expect(Number(row.storedHourlyRate)).toBe(6000); // ولا تُخفى اللقطة
    expect(row.rateStale).toBe(true);
    expect(list.staleCount).toBe(1);
  });

  it("ص٥) إعادة الاحتساب تُطابق المخزَّن مع الملفّ (وعاء أجر الساعيّ في المسيّر)", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: SAT, hours: 7, source: "manual" });
    await db().update(s.attendance).set({ hourlyRate: "6000.00", amount: "42000.00" }).where(eq(s.attendance.employeeId, 1));

    const res = await recomputeMonthRates({ period: "2026-08" });
    expect(res.updated).toBe(1);

    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(Number(row.hourlyRate)).toBe(1905);
    expect(Number(row.amount)).toBe(13335);
    const list = await listAttendance({ period: "2026-08" });
    expect(list.staleCount).toBe(0); // المجاميع والأعمدة تتطابق بعدها
  });

  it("ص٥+) إعادة الاحتساب لا تُولّد أجراً ليوم غياب/إجازة", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: SAT, hours: 7, status: "ABSENT", source: "manual" });
    await db().update(s.attendance).set({ hourlyRate: "6000.00", amount: "42000.00" }).where(eq(s.attendance.employeeId, 1));

    await recomputeMonthRates({ period: "2026-08" });
    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(Number(row.amount)).toBe(0);
  });

  it("ص٦) شهرٌ مسيّرُه معتمد لا يُعاد احتسابه", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: SAT, hours: 7, source: "manual" });
    await db().insert(s.payrollRuns).values({
      period: "2026-08", branchId: 1, status: "approved", employeeCount: 1,
      totalGross: "0", totalOvertime: "0", totalDeductions: "0", totalNet: "0", createdBy: 1,
    });
    await expect(recomputeMonthRates({ period: "2026-08" })).rejects.toThrow(/معتمَد/);
  });

  it("ص٣+) الطيّ لا يخترع أجراً لموظفٍ ساعيٍّ بلا أسعارٍ في ملفّه", async () => {
    await db().insert(s.employees).values({
      id: 2, firstName: "سعديّ", lastName: "الساعيّ", payType: "hourly", salary: null, dayRates: null,
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
    });
    await recordAttendance({ employeeId: 2, attendanceDate: SAT, hours: 8, source: "manual" });
    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 2));
    expect(Number(row.hourlyRate)).toBe(0); // كان ٦٠٠٠ مُختلَقاً ⇒ ٤٨٬٠٠٠ أجرَ يومٍ بلا مصدر
    expect(Number(row.amount)).toBe(0);
  });

  it("ص٧) خيارات النموذج تشمل الشهريّ (كانت فارغةً في منشأةٍ كلُّها شهريّون)", async () => {
    const opts = await formOptions();
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts[0].payType).toBe("monthly");
  });
});

/* ───────────────── حصاد مراجعة Codex على #446 (أربع P1 وP2) ───────────────── */
describe("صدق العدّاد والقفل والفصل", () => {
  /** يزرع يوماً بلقطةٍ قديمة (٦٠٠٠) لموظف ١. */
  async function seedStaleDay(date: string) {
    await recordAttendance({ employeeId: 1, attendanceDate: date, hours: 7, source: "manual" });
    await db().update(s.attendance).set({ hourlyRate: "6000.00", amount: "42000.00" })
      .where(eq(s.attendance.attendanceDate, date));
  }

  it("ص٨) العدّاد يمسح كل المطابق لا الصفحة — لقطةٌ في صفحةٍ أقدم لا تختفي", async () => {
    await seedStaleDay("2026-08-03"); // قديمة
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-08-20", hours: 7, source: "manual" }); // سليمة وأحدث

    // صفحةٌ واحدة تُظهر الأحدث فقط (السليمة) — وكان العدّاد يقول صفراً فيختفي الزرّ.
    const page = await listAttendance({ period: "2026-08", limit: 1, offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].rateStale).toBe(false);
    expect(page.staleCount).toBe(1); // مسحٌ كاملٌ يراها
    expect(page.staleScanCapped).toBe(false);
  });

  it("ص٩) شهرٌ مسيّرُه مُقفَل: تبقى اللقطة هي المعروضة — لا يُعاد كتابة التاريخ", async () => {
    await seedStaleDay("2026-08-03");
    await db().insert(s.payrollRuns).values({
      period: "2026-08", branchId: 1, status: "paid", employeeCount: 1,
      totalGross: "0", totalOvertime: "0", totalDeductions: "0", totalNet: "0", createdBy: 1,
    });

    const list = await listAttendance({ period: "2026-08" });
    const row = list.rows[0];
    expect(row.periodLocked).toBe(true);
    expect(Number(row.hourlyRate)).toBe(6000); // ما صُرف فعلاً هو المعروض
    expect(Number(row.amount)).toBe(42000);
    expect(row.rateStale).toBe(false); // ولا وسمَ إصلاحٍ لا يمكن تنفيذه
    expect(list.staleCount).toBe(0);
  });

  it("ص١٠) مسيّر مسودّة يمنع إعادة الاحتساب (بنودُه بُنيت على المبالغ القديمة)", async () => {
    await seedStaleDay("2026-08-03");
    await db().insert(s.payrollRuns).values({
      period: "2026-08", branchId: 1, status: "draft", employeeCount: 1,
      totalGross: "0", totalOvertime: "0", totalDeductions: "0", totalNet: "0", createdBy: 1,
    });
    await expect(recomputeMonthRates({ period: "2026-08" })).rejects.toThrow(/مسودّة/);
  });

  it("ص١١) فصل مهام: لا يُعيد أحدٌ احتساب أجر نفسه (وadmin مُستثنى)", async () => {
    await db().update(s.employees).set({ userId: 1 }).where(eq(s.employees.id, 1));
    await seedStaleDay("2026-08-03");

    await expect(
      recomputeMonthRates({ period: "2026-08", actor: { userId: 1, role: "manager" } }),
    ).rejects.toThrow(/أجر نفسك/);
    // ولا شيء تغيّر — الرفض قبل أيّ كتابة.
    const [before] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(Number(before.hourlyRate)).toBe(6000);

    const res = await recomputeMonthRates({ period: "2026-08", actor: { userId: 1, role: "admin" } });
    expect(res.updated).toBe(1);
  });

  it("ص١٢) يومُ غياب بساعاتٍ موجبة يُعرَض بلا أجر ويُوسَم (لا كسبَ وهميّ)", async () => {
    await db().insert(s.attendance).values({
      employeeId: 1, attendanceDate: "2026-08-03", status: "ABSENT",
      hours: "7.00", hourlyRate: "1905.00", amount: "13335.00", source: "manual",
    });
    const list = await listAttendance({ period: "2026-08" });
    expect(Number(list.rows[0].amount)).toBe(0); // المسيّر يستبعده ⇒ فليقُل العرضُ ذلك
    expect(list.rows[0].rateStale).toBe(true); // ومبلغُه المخزَّن يحتاج تصفيراً
  });

  it("ص١٣) الأجر يُضرب بالسعر الخام لا المُقرَّب — مطابقةً لما يُخزَّن (فرق الدينار)", async () => {
    await db().insert(s.employees).values({
      id: 3, firstName: "حدّيّ", lastName: "التقريب", payType: "monthly", salary: "100001",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01", workSchedule: null,
    });
    await recordAttendance({ employeeId: 3, attendanceDate: "2026-08-03", hours: 7.1, source: "manual" });

    const [stored] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 3));
    const list = await listAttendance({ period: "2026-08", employeeId: 3 });
    expect(Number(list.rows[0].amount)).toBe(Number(stored.amount)); // ٣٤١٤ لا ٣٤١٣
    expect(list.rows[0].rateStale).toBe(false); // ولا وسمَ زائفاً من فرق تقريب
  });
});

/**
 * اليوم المفتوح (دخولٌ بلا انصراف) في مسيّر الرواتب — قرار المالك ١٧/٨/٢٦.
 *
 * السياق: كان التوليد **يرمي** عند أوّل يومٍ مفتوح ⇒ بصمةٌ منسيّة لموظفٍ واحد تُجمّد مسيّر
 * الشركة كلّها. ثمّ بدا «استبعاد الموظف وحده» تنفيذاً حرفياً للقرار، لكنّ فحص الشيفرة أسقطه:
 * المسيّر واحدٌ لكل شهر بقيدٍ فريد، ولا واجهة لإضافة بندٍ إلى مسيّرٍ قائم ⇒ المستبعَد لا سبيل
 * لصرف أجر شهره أبداً بعد الاعتماد. فاستقرّ القرار على **البقاء موسوماً**.
 *
 * الثوابت المحروسة هنا (الاتجاهان: العطب لم يعد يقع، والسليم لم ينكسر):
 *   ي١) يومٌ مفتوح ⇒ المسيّر **يُولَّد** ولا يُرمى، وصاحبه **له بند** بساعاته المؤكَّدة.
 *   ي٢) ساعات اليوم المفتوح وحدها غير محتسَبة — لا يومَ سليمٍ يُمسّ.
 *   ي٣) الزميل السليم في المسيّر نفسه يُصرف كاملاً (لا تجميد للشركة).
 *   ي٤) `attendanceFlagged` يرافق نتيجة التوليد باسم الموظف وعدد أيامه وتواريخها كاملةً.
 *   ي٥) ملاحظة البند تحمل وسمَ الانتباه المشترك (`PAYROLL_ITEM_ATTENTION_PREFIX`) أوّلاً —
 *       فهو عقد الشاشة، وتقديمُه يُنجيه من قصّ الـ٢٥٥ محرفاً.
 *   ي٦) قائمة تواريخ طويلة ⇒ تُقصّ **بإفصاح** (`+N أخرى`) لا صامتةً، والكاملةُ في النتيجة.
 *   ي٧) بلا أيامٍ مفتوحة ⇒ لا وسم ولا قائمة (صفر انحدار).
 *   ي٨) عمولةُ الموسوم **تُصرف مع بنده** — لو استُبعد لضاعت بلا رجعة (سبب رفض الاستبعاد).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { PAYROLL_ITEM_ATTENTION_PREFIX } from "@shared/hr";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { generatePayroll } from "../payrollService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" };
const PERIOD = "2026-06"; // حزيران ٢٠٢٦: ٢٦ يوم دوام (الجمعة راحة) × ٨ = ٢٠٨ ساعة
const SCHED: Record<string, { hours: number }> = {
  الأحد: { hours: 8 }, الاثنين: { hours: 8 }, الثلاثاء: { hours: 8 },
  الأربعاء: { hours: 8 }, الخميس: { hours: 8 }, الجمعة: { hours: 0 }, السبت: { hours: 8 },
};
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

async function enableAttendancePay() {
  // الجدول العامّ أُلغي (0140): لكل موظف جدولُه، ومن لم يُضبط يقع على `DEFAULT_WORK_SCHEDULE`
  // — وهو نفسه SCHED أعلاه (٨ ساعات، الجمعة راحة). فلا شيء يُضبط هنا غير التفعيل والسريان.
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-06-01" })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: "2026-06-01" } });
}

/** حضور ٨ ساعات لكل أيام دوام حزيران؛ التواريخ في `openOn` تُترك **مفتوحة** (دخولٌ بلا انصراف). */
async function seedJune(employeeId: number, openOn: string[] = []) {
  const rows: Array<typeof s.attendance.$inferInsert> = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    if (DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] === "الجمعة") continue;
    const open = openOn.includes(date);
    rows.push({
      employeeId, attendanceDate: date, status: "PRESENT",
      // اليوم المفتوح = دخولٌ مسجَّل وانصرافٌ معدوم — وهو بالضبط ما يكتشفه التوليد.
      checkIn: new Date(`${date}T08:00:00Z`),
      checkOut: open ? null : new Date(`${date}T16:00:00Z`),
      hours: open ? "0.00" : "8.00", hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
    });
  }
  await db().insert(s.attendance).values(rows);
}

async function itemsOf(runId: number) {
  return db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, runId));
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "commissionRunLines", "commissionRuns",
    "commissionPlanTiers", "commissionPlans", "leaveRequests", "attendance",
    "hrAttendanceSettings", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    // ٩٠٠٬٠٠٠ ÷ ٢٠٨ ساعة = 4326.923… د.ع/ساعة — يُبقي الأرقام أدناه قابلة للتحقّق يدوياً.
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01" },
    { id: 2, firstName: "سارة", lastName: "العبيدي", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01" },
  ]);
  await enableAttendancePay();
});

describe("اليوم المفتوح لا يُجمّد المسيّر ولا يُستبعَد صاحبه (قرار المالك ١٧/٨)", () => {
  it("ي١+ي٢+ي٣) يومان مفتوحان لموظف ⇒ المسيّر يُولَّد، وله بندٌ بساعاته المؤكَّدة، وزميله كاملٌ", async () => {
    await seedJune(1, ["2026-06-08", "2026-06-09"]);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run.id));
    expect(items).toHaveLength(2);

    const flagged = items.find((i) => Number(i.employeeId) === 1)!;
    const clean = items.find((i) => Number(i.employeeId) === 2)!;

    // ي١) بندٌ موجودٌ فعلاً — لا استبعاد.
    expect(flagged).toBeDefined();
    // ي٢) يومان مفتوحان = ١٦ ساعة غير محتسَبة، وبقيّة أيامه محتسَبة كاملةً.
    expect(Number(flagged.hours)).toBe(192); // 208 − 16
    expect(Number(flagged.gross)).toBeCloseTo(830769, 0); // 900000 ÷ 208 × 192
    // ي٣) الزميل السليم لم يُمسّ — لا تجميد للشركة كلّها.
    expect(Number(clean.hours)).toBe(208);
    expect(Number(clean.gross)).toBeCloseTo(900000, 0);
  });

  it("ي٤+ي٥) نتيجة التوليد تحمل الموسومين بأسمائهم وتواريخهم، وملاحظةُ البند تبدأ بالوسم", async () => {
    await seedJune(1, ["2026-06-08", "2026-06-09"]);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    // ي٤) قائمةٌ مبنيّة (لا نصٌّ يُفسَّر) — الشاشة تعدّها والتنبيه يقرأ طولها.
    expect(run.attendanceFlagged).toHaveLength(1);
    expect(run.attendanceFlagged[0]).toMatchObject({
      employeeId: 1,
      openDays: 2,
      openDates: ["2026-06-08", "2026-06-09"],
    });
    expect(run.attendanceFlagged[0].employeeName).toContain("أحمد");

    // ي٥) الوسم **أوّل** الملاحظة: عقدُ الشاشة `payrollItemNeedsAttention` يفحص البداية،
    // وقصُّ الـ٢٥٥ محرفاً يقصّ من الآخِر ⇒ الوسم ينجو دائماً.
    const items = await itemsOf(Number(run.id));
    const note = String(items.find((i) => Number(i.employeeId) === 1)!.note);
    expect(note.startsWith(PAYROLL_ITEM_ATTENTION_PREFIX)).toBe(true);
    expect(note).toContain("2 يوم بلا انصراف");
    expect(note).toContain("2026-06-08");
    expect(note.length).toBeLessThanOrEqual(255);
  });

  it("المالك لا يعتمد تلقائيا تشغيلةً فيها أيام مفتوحة", async () => {
    await db().update(s.users).set({ isOwner: true }).where(eq(s.users.id, ADMIN.userId));
    await seedJune(1, ["2026-06-08"]);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    expect(run.attendanceFlagged).toHaveLength(1);
    expect(run.status).toBe("draft");
  });

  it("ي٦) تواريخ كثيرة ⇒ الملاحظة تُفصح عن القصّ، والقائمة الكاملة في نتيجة التوليد", async () => {
    const open = ["06", "07", "08", "09", "10", "11", "13", "14", "15"].map((d) => `2026-06-${d}`);
    await seedJune(1, open);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    // القائمة الكاملة تصل الشاشة عبر النتيجة — لا شيء يضيع لأن النصّ ضاق.
    expect(run.attendanceFlagged[0].openDates).toEqual(open);
    expect(run.attendanceFlagged[0].openDays).toBe(open.length);

    const items = await itemsOf(Number(run.id));
    const note = String(items.find((i) => Number(i.employeeId) === 1)!.note);
    expect(note).toContain(`+${open.length - 6} أخرى`); // إفصاحٌ لا قصٌّ صامت
    expect(note.length).toBeLessThanOrEqual(255);
  });

  it("ي٧) بلا أيام مفتوحة ⇒ لا وسم ولا قائمة (صفر انحدار)", async () => {
    await seedJune(1);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    expect(run.attendanceFlagged).toEqual([]);
    const items = await itemsOf(Number(run.id));
    for (const it of items) {
      expect(String(it.note ?? "").startsWith(PAYROLL_ITEM_ATTENTION_PREFIX)).toBe(false);
      expect(Number(it.hours)).toBe(208);
    }
  });

  it("ي٨) عمولة الموسوم تُصرف مع بنده — الاستبعاد كان سيُضيعها بلا رجعة", async () => {
    await seedJune(1, ["2026-06-08"]);
    await seedJune(2);
    const d = db();
    await d.insert(s.commissionPlans).values({ id: 1, name: "خطة", basis: "NET_SALES", tierMode: "TARGET_PCT" });
    await d.insert(s.commissionRuns).values({
      id: 1, period: PERIOD, status: "approved", employeeCount: 1, totalCommission: "104000.00",
    });
    await d.insert(s.commissionRunLines).values({
      runId: 1, employeeId: 1, userId: 1, branchId: 1, planId: 1, commissionAmount: "104000.00",
    });

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const flagged = (await itemsOf(Number(run.id))).find((i) => Number(i.employeeId) === 1)!;
    expect(Number(flagged.commission)).toBe(104000);
    // الصافي يشملها: عمولةٌ لموظفٍ موسوم ما زالت تُصرف كاملةً.
    expect(Number(flagged.net)).toBeCloseTo(Number(flagged.gross) + 104000, 0);
    expect(run.attendanceFlagged).toHaveLength(1);
  });
});

/**
 * حوكمة الحضور داخل توليد المسيّر (تدقيق ١٧/٨/٢٦) — قرارات المالك في هذه الموجة:
 *
 *   ح١) **البصمة الشاردة تستبعد صاحبها وحده**: يومٌ بدخولٍ بلا انصراف كان يرمي فيوقف توليد
 *       مسيّر الشركة كلِّها؛ صار الموظف وحده يُستبعَد، والباقون يُصرفون، وتُجمَع أسماؤهم
 *       وتواريخهم في نتيجة التوليد ليصحّحها المدير.
 *   ح٢) **بصمة انصرافٍ منسيّة وسط اليوم**: عددُ بصماتٍ فرديّ يُحتسب بأزواجه المكتملة وحدها
 *       ⇒ نصفُ يومٍ مدفوعٌ بصمت، وله انصرافٌ مسجَّل فلا يمسكه فحصُ «دخولٌ بلا انصراف».
 *   ح٣) **الجدول الصفريّ** ({} أو كلُّ أيامه صفر) غيابٌ ظاهرٌ مسمّى في ملاحظة البند، لا
 *       صفرٌ صامت ولا تجميدٌ للمسيّر.
 *   ح٤) **حارس «صفر بصمات شهراً كاملاً» يعمل في شباط**: تعويض الشهر القصير كان يُضاف إلى
 *       الساعات المستحقّة قبل الفحص فيُبطله ⇒ أجرٌ لموظفٍ بلا بصمةٍ واحدة.
 *
 * وكلُّ حالةٍ هنا محروسةٌ بالاتجاهين: أن العطب لم يعد يقع، **وأن السليم السابق لم ينكسر**.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
const PERIOD = "2026-06"; // حزيران ٢٠٢٦: ٣٠ يوماً، ٤ جُمَع ⇒ ٢٦ يوم دوام × ٨ = ٢٠٨ ساعة

const SCHED: Record<string, { hours: number }> = {
  الأحد: { hours: 8 }, الاثنين: { hours: 8 }, الثلاثاء: { hours: 8 },
  الأربعاء: { hours: 8 }, الخميس: { hours: 8 }, الجمعة: { hours: 0 }, السبت: { hours: 8 },
};

const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** يُفعّل نموذج الأجر بالحضور بتاريخ سريان. (الجدول العامّ أُلغي 0140 ⇒ لكل موظفٍ جدولُه.) */
async function enableAttendancePay(from: string) {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: from })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: from } });
}

/** يسجّل ٨ ساعات لكل يوم دوامٍ في الشهر (عدا الجمعة والمستثناة) — بصمات جهازٍ مكتملة. */
async function seedFullAttendance(employeeId: number, period = PERIOD, skip: string[] = []) {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows: (typeof s.attendance.$inferInsert)[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const date = `${period}-${String(d).padStart(2, "0")}`;
    if (DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] === "الجمعة") continue;
    if (skip.includes(date)) continue;
    rows.push({
      employeeId, attendanceDate: date, status: "PRESENT", hours: "8.00",
      hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
      checkIn: new Date(`${date}T08:00:00Z`), checkOut: new Date(`${date}T16:00:00Z`),
    });
  }
  if (rows.length) await db().insert(s.attendance).values(rows);
  return rows.length;
}

async function itemsOf(runId: number) {
  return db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, runId));
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "leaveRequests", "attendance",
    "hrAttendanceSettings", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    {
      id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01", workSchedule: SCHED,
    },
    {
      id: 2, firstName: "ليلى", lastName: "العبيدي", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01", workSchedule: SCHED,
    },
  ]);
});

describe("ح١) اليوم المفتوح يستبعد صاحبه وحده — لا يجمّد مسيّر الشركة", () => {
  it("صاحبُ البصمة الناقصة يخرج من المسيّر باسمه وتاريخه، والباقي يُصرف كاملاً", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, PERIOD, ["2026-06-08"]);
    await db().insert(s.attendance).values({
      employeeId: 1, attendanceDate: "2026-06-08", status: "PRESENT", hours: "0.00",
      hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
      checkIn: new Date("2026-06-08T08:00:00Z"), checkOut: null,
      needsReview: true, reviewReason: "بصمة واحدة فقط — ينقص تسجيل الخروج",
    });
    await seedFullAttendance(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run!.id));

    // الباقون يُصرفون طبيعياً — لا تجميد للشركة كلِّها.
    expect(items).toHaveLength(1);
    expect(Number(items[0].employeeId)).toBe(2);
    expect(Number(items[0].gross)).toBeCloseTo(900000, 0);

    const excluded = (run as unknown as { attendanceExcluded: Array<Record<string, unknown>> }).attendanceExcluded;
    expect(excluded).toHaveLength(1);
    expect(excluded[0].employeeId).toBe(1);
    expect(excluded[0].openDates).toEqual(["2026-06-08"]);
    expect(String(excluded[0].employeeName)).toContain("أحمد");
  });

  it("صفر انحدار: بلا أيامٍ مفتوحة يُصرف الجميع ولا مستبعَد", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1);
    await seedFullAttendance(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run!.id));

    expect(items).toHaveLength(2);
    expect((run as unknown as { attendanceExcluded: unknown[] }).attendanceExcluded).toEqual([]);
  });

  it("استبعادُ الجميع رفضٌ ذرّيّ — لا مسيّرَ فارغاً يسدّ الشهر", async () => {
    await enableAttendancePay("2026-06-01");
    await db().delete(s.employees).where(eq(s.employees.id, 2));
    await seedFullAttendance(1, PERIOD, ["2026-06-08"]);
    await db().insert(s.attendance).values({
      employeeId: 1, attendanceDate: "2026-06-08", status: "PRESENT", hours: "0.00",
      hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
      checkIn: new Date("2026-06-08T08:00:00Z"), checkOut: null,
    });

    await expect(generatePayroll(PERIOD, ADMIN as never)).rejects.toThrow(/استُبعد كلُّ الموظفين/);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
  });
});

describe("ح٢) بصمة انصرافٍ منسيّة وسط اليوم — لا نصفَ يومٍ مدفوعاً بصمت", () => {
  it("يومٌ بعدد بصماتٍ فرديّ (له انصرافٌ مسجَّل) يستبعد صاحبه بدل أن يُدفع نصفه", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, PERIOD, ["2026-06-08"]);
    // دخول 08:00 · خروج 12:00 · دخول 13:00 بلا خروج ⇒ الطيّ يحتسب الزوج المكتمل وحده (٤ ساعات).
    await db().insert(s.attendance).values({
      employeeId: 1, attendanceDate: "2026-06-08", status: "PRESENT", hours: "4.00",
      hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
      checkIn: new Date("2026-06-08T08:00:00Z"), checkOut: new Date("2026-06-08T12:00:00Z"),
      needsReview: true, reviewReason: "عدد البصمات فرديّ — ينقص تسجيل خروج",
    });
    await seedFullAttendance(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run!.id));
    const excluded = (run as unknown as { attendanceExcluded: Array<Record<string, unknown>> }).attendanceExcluded;

    expect(items.map((i) => Number(i.employeeId))).toEqual([2]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].openDates).toEqual(["2026-06-08"]);
  });

  it("صفر انحدار: يومٌ يدويٌّ بدخولٍ بلا انصراف وبساعاتٍ موجبة يبقى مدفوعاً", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, PERIOD, ["2026-06-08"]);
    // إدخالٌ يدويّ حسمه المدير: ساعاته معلومة (٨) والوسم مُطفأ ⇒ ليس يوماً مفتوحاً.
    await db().insert(s.attendance).values({
      employeeId: 1, attendanceDate: "2026-06-08", status: "PRESENT", hours: "8.00",
      hourlyRate: "0.00", amount: "0.00", source: "manual",
      checkIn: new Date("2026-06-08T08:00:00Z"), checkOut: null, needsReview: false,
    });
    await seedFullAttendance(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run!.id));

    expect(items).toHaveLength(2);
    expect((run as unknown as { attendanceExcluded: unknown[] }).attendanceExcluded).toEqual([]);
    const mine = items.find((i) => Number(i.employeeId) === 1)!;
    expect(Number(mine.hours)).toBe(208); // يومُه محسوبٌ كاملاً كما كان
  });
});

describe("ح٣) الجدول الصفريّ — غيابٌ مسمّى لا صفرٌ صامت", () => {
  it("جدولٌ فارغ ⇒ بندٌ بملاحظةٍ تسمّي السبب، والمسيّر يمرّ لبقيّة الموظفين", async () => {
    await enableAttendancePay("2026-06-01");
    await db().update(s.employees).set({ workSchedule: {} }).where(eq(s.employees.id, 1));
    await seedFullAttendance(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run!.id));
    const mine = items.find((i) => Number(i.employeeId) === 1)!;

    expect(items).toHaveLength(2); // لم يُجمَّد المسيّر ولم يُرفَض الموظف
    expect(String(mine.note)).toContain("لا جدول دوام مضبوط");
    expect(String(mine.note)).toContain("غياب 30 يوم"); // كلُّ أيام الشهر غيابٌ ظاهر
    expect(Number(mine.gross)).toBe(0);
  });
});

describe("ح٤) حارس «صفر بصمات شهراً كاملاً» يعمل في الشهر القصير", () => {
  it("شباط بلا بصمةٍ واحدة يُرفض — كان تعويضُ الشهر القصير يُمرّره بأجرٍ جزئيّ", async () => {
    await enableAttendancePay("2026-02-01");
    await db().delete(s.employees).where(eq(s.employees.id, 2));

    await expect(generatePayroll("2026-02", ADMIN as never)).rejects.toThrow(/ربطٌ ناقص بجهاز البصمة/);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
  });

  it("صفر انحدار: شباط بحضورٍ كامل يُولَّد بالراتب كاملاً (التعويض في محلّه)", async () => {
    await enableAttendancePay("2026-02-01");
    await db().delete(s.employees).where(eq(s.employees.id, 2));
    await seedFullAttendance(1, "2026-02");

    const run = await generatePayroll("2026-02", ADMIN as never);
    const items = await itemsOf(Number(run!.id));

    expect(items).toHaveLength(1);
    expect(Number(items[0].hours)).toBe(208); // ١٩٢ فعليّة + ١٦ تعويضاً حتى ٣٠ يوماً
    expect(Number(items[0].gross)).toBeCloseTo(900000, 0);
  });
});

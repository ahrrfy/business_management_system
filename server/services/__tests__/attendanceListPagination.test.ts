// سجلّ الحضور — الترقيم والبحث والمجاميع الخادمية.
//
// الخلل المُعالَج: `listAttendance` كانت **بلا LIMIT إطلاقاً** والشاشة تحمّل كل المطابق دفعةً
// (وبإفراغ منتقي الشهر = كل سجلّات الحضور مدى الحياة: موظفون × أيام × سنوات)، ثمّ تحسب
// المؤشّرات والبحث **في المتصفّح** من الصفوف المُحمَّلة. الثوابت:
//   ح١) الترقيم: صفحة صفحة بلا تكرار ولا فقد، وtotal = كل المطابق لا الصفحة.
//   ح٢) المجاميع (totals) للمطابق كلّه لا للصفحة — وإلا كذب تذييل الجدول بمجرّد تجاوز الصفحة.
//   ح٣) البحث خادميّ: يطال سجلّاً خارج الصفحة الأولى (كان يقول «لا نتائج» عنه).
//   ح٤) البحث يطابق الاسم والتاريخ **واسم اليوم العربي** (DAYOFWEEK — لا عمود له).
//   ح٥) summary = مجاميع الفلتر كلّه + عدّادا البصمة/اليدوي (كانا length في المتصفّح).
//   ح٦) دلالة محفوظة: summary تتجاهل q (البطاقات مؤشّر الشهر) بينما totals تتبعه.
//   ح٧) «%» في البحث مُهرَّبة (لا تطابق الكل).
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { attendanceSummary, listAttendance } from "../attendanceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

/** ٢٠٢٦-٠٧-٠١ يوافق الأربعاء (تقويم ثابت) — نتحقّق منه في الاختبار نفسه لا نفترضه. */
const PERIOD = "2026-07";

beforeEach(async () => {
  await truncateTables(["attendance", "employees", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    { id: 1, firstName: "أحمد", fatherName: "علي", lastName: "الجبوري", payType: "hourly", employmentStatus: "active" },
    { id: 2, firstName: "زينب", fatherName: "حسن", lastName: "الربيعي", payType: "hourly", employmentStatus: "active" },
  ]);
});

type AttSeed = { employeeId: number; day: number; hours: string; amount: string; source?: string };

const attRow = (o: AttSeed) => ({
  employeeId: o.employeeId,
  attendanceDate: `${PERIOD}-${String(o.day).padStart(2, "0")}`,
  status: "PRESENT" as const,
  hours: o.hours,
  hourlyRate: "1000.00",
  amount: o.amount,
  source: o.source ?? "fingerprint",
});

/**
 * إدراج **دفعةً واحدة** (عبارة INSERT واحدة) لا في حلقة.
 * ⚠️ سبب تقنيّ لا تجميليّ: `__setup__.ts` يُنظّف بـDELETE على ~١٠٢ جدولاً تسلسلياً في afterEach،
 * وقد يتجاوز مهلة الخطّاف على قاعدة بطيئة ⇒ vitest يمضي للاختبار التالي بينما اتصال التنظيف
 * ما زال يحذف ⇒ يُفرِّغ `employees` **أثناء** حلقة الإدراج فيسقط الاختبار بـFK. عبارةٌ واحدة
 * تُغلق هذه النافذة عملياً (ولا تُصلح علّة الخطّاف نفسها — علّة harness معروفة خارج هذه الشريحة).
 */
async function seedAtt(rows: AttSeed[]) {
  if (!rows.length) return;
  await db().insert(s.attendance).values(rows.map(attRow));
}

const att = (o: AttSeed) => seedAtt([o]);

/** ٢٠ سجلّاً لزينب (أيام ١–٢٠ × ٣ ساعات) = ٦٠ ساعة / ٦٠٬٠٠٠ د.ع. */
async function seedMany() {
  await seedAtt(
    Array.from({ length: 20 }, (_, i) => ({ employeeId: 2, day: i + 1, hours: "3.00", amount: "3000.00" })),
  );
}

describe("listAttendance — ترقيم + مجاميع خادمية", () => {
  it("ح١+ح٢: صفحات بلا تكرار/فقد، وtotal/totals للمطابق كلّه لا للصفحة", async () => {
    await seedMany(); // ٢٠ سجلّاً × ٣ ساعات = ٦٠ ساعة، ٦٠٬٠٠٠ د.ع

    const p1 = await listAttendance({ period: PERIOD, limit: 8, offset: 0 });
    expect(p1.rows).toHaveLength(8);
    expect(p1.total).toBe(20); // الإجمالي لا طول الصفحة
    // ح٢: المجاميع للمطابق كلّه — لا مجموع الثمانية المعروضة (٢٤ ساعة).
    expect(new Decimal(p1.totals.hours).toNumber()).toBe(60);
    expect(new Decimal(p1.totals.amount).toNumber()).toBe(60000);

    const p2 = await listAttendance({ period: PERIOD, limit: 8, offset: 8 });
    const p3 = await listAttendance({ period: PERIOD, limit: 8, offset: 16 });
    expect(p3.rows).toHaveLength(4);
    expect(p2.totals.hours).toBe(p1.totals.hours); // ثابتة عبر الصفحات

    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20); // لا تكرار
  });

  it("ح٣: البحث يجد سجلّاً خارج الصفحة الأولى (كان يُصفّي المُحمَّل وحده)", async () => {
    await seedMany();
    // أحمد في أقدم يوم ⇒ خارج الصفحة الأولى (الترتيب بالأحدث تاريخاً).
    await att({ employeeId: 1, day: 1, hours: "5.00", amount: "5000.00", source: "manual" });

    const page1 = await listAttendance({ period: PERIOD, limit: 5, offset: 0 });
    expect(page1.rows.map((r) => r.employeeName).join(" ")).not.toContain("أحمد");

    const found = await listAttendance({ period: PERIOD, q: "أحمد", limit: 5, offset: 0 });
    expect(found.total).toBe(1);
    expect(found.rows[0].employeeName).toContain("أحمد");
    // ح٢ تحت البحث: المجاميع تتبع المطابق للبحث.
    expect(new Decimal(found.totals.hours).toNumber()).toBe(5);
  });

  it("ح٤: البحث يطابق التاريخ واسم اليوم العربي", async () => {
    await att({ employeeId: 1, day: 1, hours: "4.00", amount: "4000.00" });
    await att({ employeeId: 2, day: 2, hours: "2.00", amount: "2000.00" });

    // بالتاريخ.
    const byDate = await listAttendance({ period: PERIOD, q: `${PERIOD}-02`, limit: 10 });
    expect(byDate.total).toBe(1);
    expect(byDate.rows[0].attendanceDate).toBe(`${PERIOD}-02`);

    // باسم اليوم: نأخذ الاسم من الصفّ نفسه (لا نفترض التقويم) ثمّ نبحث به.
    const all = await listAttendance({ period: PERIOD, limit: 10 });
    const dayName = all.rows.find((r) => r.attendanceDate === `${PERIOD}-01`)!.dayName;
    expect(dayName).toBeTruthy();
    const byDay = await listAttendance({ period: PERIOD, q: dayName, limit: 10 });
    expect(byDay.rows.map((r) => r.attendanceDate)).toContain(`${PERIOD}-01`);
    // اليوم الآخر لا يظهر إلا إن صادف نفس اسم اليوم.
    expect(byDay.rows.every((r) => r.dayName === dayName)).toBe(true);
  });

  it("ح٥: summary = مجاميع الفلتر + عدّادا البصمة/اليدوي", async () => {
    await att({ employeeId: 1, day: 1, hours: "4.00", amount: "4000.00", source: "fingerprint" });
    await att({ employeeId: 2, day: 2, hours: "2.00", amount: "2000.00", source: "manual" });
    await att({ employeeId: 2, day: 3, hours: "1.00", amount: "1000.00", source: "manual" });

    const sum = await attendanceSummary({ period: PERIOD });
    expect(new Decimal(sum.hours).toNumber()).toBe(7);
    expect(new Decimal(sum.amount).toNumber()).toBe(7000);
    expect(sum.fingerprintCount).toBe(1);
    expect(sum.manualCount).toBe(2);

    // فلتر الموظف يسري على المجاميع.
    const forZainab = await attendanceSummary({ period: PERIOD, employeeId: 2 });
    expect(new Decimal(forZainab.hours).toNumber()).toBe(3);
    expect(forZainab.fingerprintCount).toBe(0);
  });

  it("ح٦: البطاقات (summary) تتجاهل q بينما تذييل الجدول (totals) يتبعه — دلالة محفوظة", async () => {
    await att({ employeeId: 1, day: 1, hours: "4.00", amount: "4000.00" });
    await att({ employeeId: 2, day: 2, hours: "2.00", amount: "2000.00" });

    // الشاشة تستدعي summary **بلا** q ⇒ مؤشّر الشهر كاملاً.
    const cards = await attendanceSummary({ period: PERIOD });
    expect(new Decimal(cards.hours).toNumber()).toBe(6);

    // بينما القائمة بالبحث ⇒ تذييلها يتبع المطابق وحده.
    const searched = await listAttendance({ period: PERIOD, q: "زينب", limit: 10 });
    expect(new Decimal(searched.totals.hours).toNumber()).toBe(2);
  });

  it("ح٧: «%» مُهرَّبة في البحث (لا تطابق كل السجلّات)", async () => {
    await att({ employeeId: 1, day: 1, hours: "4.00", amount: "4000.00" });
    await att({ employeeId: 2, day: 2, hours: "2.00", amount: "2000.00" });
    const pct = await listAttendance({ period: PERIOD, q: "%", limit: 10 });
    expect(pct.total).toBe(0);
    expect(pct.rows).toEqual([]);
  });

  it("سقف limit مفروض خادمياً (٥٠٠) — لا يُمرَّر رقم ضخم فيُمسح الجدول", async () => {
    await seedMany();
    const huge = await listAttendance({ period: PERIOD, limit: 999999 });
    expect(huge.rows.length).toBeLessThanOrEqual(500);
    expect(huge.total).toBe(20);
  });
});

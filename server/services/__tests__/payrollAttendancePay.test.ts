// الأجر بالحضور داخل مسيّر الرواتب (0138) — تكامل من الإعداد إلى بند المسيّر.
//
// الثوابت المحروسة:
//   ع١) معطَّل افتراضياً ⇒ المسيّر كما كان بالضبط (صفر انحدار).
//   ع٢) مُفعَّلاً: الأجر = ساعات الحضور × سعر ساعته (راتبه ÷ ساعات دوامه)، والغياب بلا أجر.
//   ع٣) أيام راحة الموظف لا تُطالَب بحضور ولا تُخصَم — ولكلٍّ جدولُه.
//   ع٤) الإجازة المدفوعة يوم دوامٍ كامل، وبلا راتب لا تُحتسب — **بلا خصمٍ مزدوج**
//       (الخصم القديم بالراتب÷٣٠ يُعطَّل في هذا النموذج).
//   ع٥) ما قبل تاريخ السريان مدفوعٌ كاملاً — أشهرٌ سبقت تشغيل الجهاز لا تُصفَّر.
//   ع٦) ملاحظة البند تشرح النقص بالساعات والأيام (شفافية للموظف).
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

/** يُفعّل النموذج بتاريخ سريان. */
async function enableAttendancePay(from: string, restDays: string[] = ["الجمعة"]) {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: from, standardDailyHours: "8.00", defaultRestDays: restDays })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: from, defaultRestDays: restDays } });
}

/** يسجّل حضوراً ٨ ساعات لكل أيام الدوام في حزيران عدا المستثناة. */
async function seedFullAttendance(employeeId: number, skip: string[] = [], restDays = ["الجمعة"]) {
  const names = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const rows: any[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    const dow = names[new Date(`${date}T00:00:00Z`).getUTCDay()];
    if (restDays.includes(dow) || skip.includes(date)) continue;
    rows.push({ employeeId, attendanceDate: date, status: "PRESENT", hours: "8.00", hourlyRate: "0.00", amount: "0.00", source: "fingerprint" });
  }
  if (rows.length) await db().insert(s.attendance).values(rows);
  return rows.length;
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "leaveRequests", "attendance",
    "hrAttendanceSettings", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values({
    id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
    employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
  });
});

async function itemOf(runId: number) {
  const [it] = await db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, runId));
  return it;
}

describe("الأجر بالحضور في المسيّر", () => {
  it("ع١) معطَّل افتراضياً ⇒ الراتب كاملاً رغم انعدام الحضور (صفر انحدار)", async () => {
    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.gross)).toBe(900000);
    expect(it.hours).toBeNull();
  });

  it("ع٢) مُفعَّلاً بحضورٍ كامل ⇒ الراتب كاملاً وسعر ساعة صحيح", async () => {
    await enableAttendancePay("2026-06-01");
    const days = await seedFullAttendance(1);
    expect(days).toBe(26);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBe(208);
    expect(Number(it.gross)).toBeCloseTo(900000, 0);
    expect(String(it.note)).toContain("208.00 من 208.00 ساعة");
  });

  it("ع٢+ع٦) غياب يومين ويومٌ ناقص ٣ ساعات ⇒ خصم ١٩ ساعة وملاحظة شارحة", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, ["2026-06-08", "2026-06-09"]);
    await db().update(s.attendance).set({ hours: "5.00" }).where(eq(s.attendance.attendanceDate, "2026-06-10"));

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBe(189); // 208 − 19
    // 900000 ÷ 208 × 189 ≈ 817,788
    expect(Number(it.gross)).toBeCloseTo(817788, 0);
    expect(String(it.note)).toContain("غياب 2 يوم");
    expect(String(it.note)).toContain("نقص 3.00 ساعة");
  });

  it("ع٣) أيام راحة مختلفة للموظف نفسه (الجمعة والسبت) تُغيّر المقام ولا تُخصَم", async () => {
    await enableAttendancePay("2026-06-01");
    await db().update(s.employees).set({ restDays: ["الجمعة", "السبت"] }).where(eq(s.employees.id, 1));
    await seedFullAttendance(1, [], ["الجمعة", "السبت"]);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBe(176); // 22 يوماً × 8
    expect(Number(it.gross)).toBeCloseTo(900000, 0); // حضر كل أيام دوامه
  });

  it("ع٤) إجازة مدفوعة = يوم دوامٍ كامل بلا بصمة", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, ["2026-06-08", "2026-06-09"]);
    await db().insert(s.leaveRequests).values({
      employeeId: 1, leaveType: "سنوية", paid: true, fromDate: "2026-06-08", toDate: "2026-06-09", days: 2, status: "approved",
    });

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBe(208);
    expect(Number(it.gross)).toBeCloseTo(900000, 0);
  });

  it("ع٤) إجازة بلا راتب تُخصَم مرّةً واحدةً فقط (لا ازدواج مع الخصم القديم)", async () => {
    await enableAttendancePay("2026-06-01");
    await seedFullAttendance(1, ["2026-06-08", "2026-06-09"]);
    await db().insert(s.leaveRequests).values({
      employeeId: 1, leaveType: "بدون راتب", paid: false, fromDate: "2026-06-08", toDate: "2026-06-09", days: 2, status: "approved",
    });

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBe(192); // 208 − 16
    // الخصم داخل الأجر لا في deductions ⇒ لا خصم ثانٍ بالراتب÷٣٠.
    expect(Number(it.deductions)).toBe(0);
    expect(Number(it.gross)).toBeCloseTo(830769, 0); // 900000 ÷ 208 × 192
    expect(String(it.note)).toContain("إجازة بلا راتب 2 يوم");
  });

  it("ع٥) ما قبل تاريخ السريان مدفوعٌ كاملاً رغم انعدام الحضور", async () => {
    // السريان من ٢٠ حزيران، ولا بصمات إطلاقاً ⇒ ما قبله مدفوع وما بعده غياب.
    await enableAttendancePay("2026-06-20");
    const run = await generatePayroll(PERIOD, ADMIN as never);
    const it = await itemOf(Number(run.id));
    expect(Number(it.hours)).toBeGreaterThan(0);
    expect(Number(it.hours)).toBeLessThan(208);
    expect(Number(it.gross)).toBeGreaterThan(0);
  });
});

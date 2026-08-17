/**
 * تجميد الشهر المصروف في كشف الحضور والتقرير الشهريّ — قرار المالك ق٣ (١٧/٨/٢٦).
 *
 * العطب: `getEmployeeStatement` كان يشتقّ رقم المستحقّ من الراتب والجدول والإعدادات
 * **الحاليّة** مهما قدُم الشهر. فترقيةُ راتبٍ في أيلول تُغيّر رقم آب **المصروف** أثراً
 * رجعياً — وهذا الكشف يُطبَع ويُصدَّر ويُرسَل للموظف على واتساب ⇒ رقمٌ يخالف ما قبضه بيده،
 * ورقمان مختلفان لشهرٍ واحد بحسب متى فُتحت الشاشة.
 *
 * القرار: متى صار للشهر مسيّرٌ **معتمدٌ أو مدفوع**، يُقرأ الرقم من **لقطة بند المسيّر**.
 *
 * الثوابت المحروسة (الاتجاهان: العطب لم يعد يقع، والسليم لم ينكسر):
 *   ج١) بلا مسيّر ⇒ الاشتقاق الحيّ كما كان بالضبط (صفر انحدار).
 *   ج٢) مسيّرٌ **مسوّدة** ⇒ **لا تجميد** — ما زالت تُحذف وتُعدَّل، وتجميدُها يُخفي أثر
 *       تصحيح البصمة قبل الاعتماد وهو عين ما نريد أن يُرى.
 *   ج٣) مسيّرٌ معتمد ⇒ تجميد، والرقم = `gross + overtime` من اللقطة بنفس معنى الحقل الحيّ.
 *   ج٤) **جوهر ق٣**: ترقيةُ الراتب بعد الاعتماد **لا تُغيّر** رقم الشهر المصروف، ويظهر
 *       الاشتقاق الحيّ منفصلاً (`liveAmountDue`) فيُقرأ الفرق أثراً للتغيير لا خطأً.
 *   ج٥) مسيّرٌ **ملغى** ⇒ لا تجميد (لم يُصرف).
 *   ج٦) موظفٌ لا بند له في المسيّر (عُيّن بعد اعتماده) ⇒ لا تجميد، اشتقاقٌ حيّ.
 *   ج٧) المراجعة: بندُ مراجعة الرأس الحالية هو المقروء لا بند المراجعة القديمة.
 *   ج٨) التقرير الشهريّ يرث التجميد نفسه — مصدرُ الرقم واحدٌ للشاشة والتقرير.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { getEmployeeStatement } from "../hr/employeeStatement";
import { getMonthlyAttendanceReport } from "../hr/monthlyAttendanceReport";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const PERIOD = "2026-06"; // ٢٦ يوم دوام (الجمعة راحة) × ٨ = ٢٠٨ ساعة
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** حضور ٨ ساعات لكل أيام دوام حزيران — يجعل الاشتقاق الحيّ = الراتب كاملاً. */
async function seedJune(employeeId: number) {
  const rows: Array<typeof s.attendance.$inferInsert> = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    if (DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] === "الجمعة") continue;
    rows.push({
      employeeId, attendanceDate: date, status: "PRESENT",
      checkIn: new Date(`${date}T08:00:00Z`), checkOut: new Date(`${date}T16:00:00Z`),
      hours: "8.00", hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
    });
  }
  await db().insert(s.attendance).values(rows);
}

/**
 * مسيّرٌ ببندٍ واحد بأرقامٍ **مختلفة عمداً** عن أيّ اشتقاقٍ حيّ ممكن (٧٧٧٬٧٧٧ لا ٩٠٠٬٠٠٠):
 * تطابقُ الرقمين كان سيُخفي ما إذا كان الكشف يقرأ اللقطة فعلاً أم يشتقّ ويُصادف.
 */
async function seedRun(over: Partial<typeof s.payrollRuns.$inferInsert> = {}, itemOver: Partial<typeof s.payrollItems.$inferInsert> = {}) {
  const res = await db().insert(s.payrollRuns).values({
    period: PERIOD, status: "approved", revisionNo: 0, employeeCount: 1,
    totalGross: "777777.00", totalNet: "700000.00", createdBy: 1,
    approvedAt: new Date("2026-07-01T10:00:00Z"), approvedBy: 1,
    ...over,
  });
  const runId = extractInsertId(res);
  await db().insert(s.payrollItems).values({
    runId, employeeId: 1, revisionNo: 0, payType: "monthly", hours: "208.00",
    gross: "777777.00", allowances: "50000.00", overtime: "12345.00",
    commission: "9000.00", deductions: "31122.00", net: "768000.00",
    note: "بند لقطة الاختبار",
    ...itemOver,
  });
  return runId;
}

async function enableAttendancePay() {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-06-01" })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: "2026-06-01" } });
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
  await enableAttendancePay();
  await seedJune(1);
});

const statement = () => getEmployeeStatement({ employeeId: 1, period: PERIOD });

describe("الشهر المصروف مجمَّد — الرقم المعروض = الرقم المدفوع (ق٣)", () => {
  it("ج١) بلا مسيّر ⇒ الاشتقاق الحيّ كما كان (صفر انحدار)", async () => {
    const st = (await statement())!;
    expect(st.payrollSnapshot).toBeNull();
    expect(st.dueBasis).toBe("attendance");
    expect(Number(st.amountDue)).toBeCloseTo(900000, 0); // حضورٌ كامل ⇒ الراتب كاملاً
    expect(st.amountDue).toBe(st.liveAmountDue); // بلا تجميد الاثنان واحد
  });

  it("ج٢) مسيّرٌ مسوّدة ⇒ لا تجميد (ما زال يُعدَّل ويُحذف)", async () => {
    await seedRun({ status: "draft", approvedAt: null, approvedBy: null });
    const st = (await statement())!;
    expect(st.payrollSnapshot).toBeNull();
    expect(st.dueBasis).toBe("attendance");
    expect(Number(st.amountDue)).toBeCloseTo(900000, 0);
  });

  it("ج٣) مسيّرٌ معتمد ⇒ الرقم من اللقطة، وكلُّ مكوّناته معروضة", async () => {
    await seedRun();
    const st = (await statement())!;

    expect(st.dueBasis).toBe("payrollSnapshot");
    // gross + overtime — نفس معنى `amountDue` الحيّ (قبل العمولة وقبل الاستقطاع).
    expect(st.amountDue).toBe("790122.00"); // 777777 + 12345
    expect(st.payrollSnapshot).toMatchObject({
      status: "approved", net: "768000.00", commission: "9000.00", deductions: "31122.00",
    });
    // التفصيل معروضٌ لا مخفيّ: تجميد الرقم ليس إخفاءَ مكوّناته.
    expect(st.payrollSnapshot!.allowances).toBe("50000.00");
    expect(st.payrollSnapshot!.note).toBe("بند لقطة الاختبار");
  });

  it("ج٣+) المسيّر المدفوع يُجمَّد كذلك ويُسمّى بحاله", async () => {
    await seedRun({ status: "paid", paidAt: new Date("2026-07-05T10:00:00Z"), paidBy: 1 });
    const st = (await statement())!;
    expect(st.dueBasis).toBe("payrollSnapshot");
    expect(st.payrollSnapshot!.status).toBe("paid");
  });

  it("ج٤) **جوهر ق٣**: ترقية الراتب بعد الاعتماد لا تُغيّر رقم الشهر المصروف", async () => {
    await seedRun();
    const before = (await statement())!;

    // ترقية بعد الصرف — وهي بالضبط ما كان يُعيد كتابة تاريخٍ مُقفل.
    await db().update(s.employees).set({ salary: "1500000" }).where(eq(s.employees.id, 1));
    const after = (await statement())!;

    expect(after.amountDue).toBe(before.amountDue); // ← الثابت الحاكم
    expect(after.payrollSnapshot).toEqual(before.payrollSnapshot);
    // والاشتقاق الحيّ تحرّك فعلاً ⇒ الاختبار يُثبت أن التجميد هو ما ثبّت الرقم لا الجمود.
    expect(Number(after.liveAmountDue)).toBeCloseTo(1500000, 0);
    expect(Number(before.liveAmountDue)).toBeCloseTo(900000, 0);
  });

  it("ج٤+) تبديل جدول الدوام بعد الاعتماد لا يُغيّره أيضاً", async () => {
    await seedRun();
    const before = (await statement())!;
    await db()
      .update(s.employees)
      .set({ workSchedule: { الأحد: { hours: 4 }, الاثنين: { hours: 4 }, الثلاثاء: { hours: 4 }, الأربعاء: { hours: 4 }, الخميس: { hours: 4 }, الجمعة: { hours: 0 }, السبت: { hours: 4 } } })
      .where(eq(s.employees.id, 1));
    const after = (await statement())!;

    expect(after.amountDue).toBe(before.amountDue);
    expect(after.totals.scheduledHours).toBe("104.00"); // الجدول تغيّر فعلاً في التفصيل
  });

  it("ج٥) مسيّرٌ ملغى ⇒ لا تجميد (لم يُصرف)", async () => {
    await seedRun({ status: "cancelled", approvedAt: null, approvedBy: null });
    const st = (await statement())!;
    expect(st.payrollSnapshot).toBeNull();
    expect(st.dueBasis).toBe("attendance");
  });

  it("ج٦) موظفٌ لا بند له في المسيّر ⇒ اشتقاقٌ حيّ لا تجميد", async () => {
    await db().insert(s.employees).values({
      id: 2, firstName: "سارة", lastName: "العبيدي", payType: "monthly", salary: "600000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
    });
    await seedRun(); // بندُه للموظف ١ وحده
    const st = (await getEmployeeStatement({ employeeId: 2, period: PERIOD }))!;
    expect(st.payrollSnapshot).toBeNull();
    expect(st.dueBasis).toBe("attendance");
  });

  it("ج٧) بندُ مراجعة الرأس الحالية هو المقروء لا القديمة", async () => {
    const runId = await seedRun({ revisionNo: 1 });
    // بند المراجعة ١ (الحالية) بأرقامٍ أخرى — بند المراجعة ٠ أعلاه صار تاريخاً.
    await db().insert(s.payrollItems).values({
      runId, employeeId: 1, revisionNo: 1, payType: "monthly", hours: "208.00",
      gross: "800000.00", allowances: "0.00", overtime: "0.00",
      commission: "0.00", deductions: "0.00", net: "800000.00",
    });
    const st = (await statement())!;
    expect(st.payrollSnapshot!.revisionNo).toBe(1);
    expect(st.amountDue).toBe("800000.00");
  });

  it("ج٨) التقرير الشهريّ يرث التجميد — مصدرُ الرقم واحدٌ للشاشة والتقرير", async () => {
    await seedRun();
    await db().update(s.employees).set({ salary: "1500000" }).where(eq(s.employees.id, 1));

    const report = await getMonthlyAttendanceReport({ period: PERIOD });
    const row = report.rows.find((r) => r.employeeId === 1)!;
    expect(row.frozen).toBe(true);
    expect(row.dueBasis).toBe("payrollSnapshot");
    expect(row.totalDue).toBe("790122.00"); // لا ١٬٥٠٠٬٠٠٠ الجديدة
  });
});

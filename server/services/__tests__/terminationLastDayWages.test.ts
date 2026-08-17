/**
 * دورة حياة الموظف عند الإنهاء — يومُ العمل الأخير وسندُ أجر شهر الفصل (تدقيق ١٧/٨).
 *
 * الثوابت المحروسة هنا (كلٌّ باتجاهيه: العطب لا يقع، والسليم السابق لم ينكسر):
 *   ع١) إنهاءٌ في يوم العمل الأخير نفسه **لا يقطع** ربط جهاز البصمة لحظته — فبصماتُ بقيّة
 *       ذلك اليوم (وانصرافُه خصوصاً) تبقى منسوبةً لصاحبها بدل أن تصل بـemployeeId=NULL
 *       فلا يلتقطها الطيّ أصلاً.
 *   ع٢) إنهاءٌ **بعد** انتهاء يوم العمل الأخير يقطع الربط فوراً — السلوك السابق حرفياً
 *       (صفر انحدار على SEC-03).
 *   ع٣) الكنسة تقطع الربط المؤجَّل حالما ينتهي يومُه ⇒ التأجيل ليس تسريباً دائماً.
 *   ع٤) أجرُ شهر الفصل يُشتقّ من نواة المسيّر (`computeAttendancePay`) ويُطابَق بالمُدخَل:
 *       المطابق بلا ملاحظة، والمنحرف بملاحظةٍ تسمّي الرقمين وتُثبَّت في القيد المحاسبيّ.
 *   ع٥) الانحراف **يُحذِّر ولا يحجب** (والمسار غير الخاضع للحضور يُقاس بالراتب الثابت
 *       بالتناسب) ⇒ لا تسوية تُحبَس بسبب سجلّ حضورٍ ناقص.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import { createEmployee } from "../employeeService";
import {
  completeTermination,
  createTermination as createTerminationRaw,
  releaseDueTerminationDeviceLinks,
} from "../promotionService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const CREATOR = { userId: 1, branchId: 1, role: "admin" };
/** المُثبِّت مالكٌ نشط ومختلف عن المُنشئ (فصل المهام على إثبات الاستحقاق). */
const RECOGNIZER = { userId: 2, branchId: 1, role: "manager" };

const TABLES = [
  "terminationAdvanceAllocations",
  "payrollObligationAllocations",
  "payrollAccountingEvents",
  "payrollObligations",
  "payrollItems",
  "payrollRuns",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "idempotencyKeys",
  "receipts",
  "attendance",
  "leaveRequests",
  "hrAttendanceSettings",
  "hrAttendancePunches",
  "hrDeviceUsers",
  "hrFingerprintDevices",
  "employeeTerminations",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

/** إزاحة يومٍ بتقويم UTC ثابت — نفس حساب الخدمة (توقيت حائط لا لحظة عالمية). */
function shiftDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const createTermination = (
  input: Omit<
    Parameters<typeof createTerminationRaw>[0],
    "settlementEvidenceNote" | "zeroAmountsAttested"
  >,
  actor: Parameters<typeof createTerminationRaw>[1] = CREATOR,
) =>
  createTerminationRaw(
    {
      ...input,
      settlementEvidenceNote: "ورقة عمل المحاسب مراجعة يدوياً للاختبار",
      zeroAmountsAttested: true,
    },
    actor,
  );

beforeEach(async () => {
  await truncateTables(TABLES);
  const connection = db();
  await connection
    .insert(s.branches)
    .values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await connection.insert(s.users).values([
    {
      id: 1,
      openId: "term-lastday-creator",
      name: "منشئ",
      role: "admin",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 2,
      openId: "term-lastday-recognizer",
      name: "مثبّت",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
  ]);
  await connection.insert(s.hrFingerprintDevices).values({
    id: 10,
    name: "جهاز الرئيسي",
    serialNumber: "TERM-LASTDAY",
    protocol: "AIFACE_WS",
    enabled: true,
    branchId: 1,
  });
});

/** موظف شهريّ في الفرع الأول مربوطٌ بجهاز البصمة (enrollId فريد لكل حالة). */
async function seedLinkedEmployee(opts: {
  salary: string;
  allowances?: string;
  enrollId: number;
  workSchedule?: Record<string, { hours: number; rate?: number | null }>;
}) {
  const employee = await createEmployee({
    firstName: "موظف",
    lastName: "الاختبار",
    payType: "monthly",
    salary: opts.salary,
    allowances: opts.allowances ?? "0",
    branchId: 1,
    workSchedule: opts.workSchedule ?? null,
  });
  await db().insert(s.hrDeviceUsers).values({
    deviceId: 10,
    enrollId: opts.enrollId,
    employeeId: employee!.id,
    effectiveFrom: "2026-01-01",
  });
  return employee!;
}

async function deviceLinkOf(enrollId: number) {
  const [row] = await db()
    .select()
    .from(s.hrDeviceUsers)
    .where(
      and(eq(s.hrDeviceUsers.deviceId, 10), eq(s.hrDeviceUsers.enrollId, enrollId)),
    );
  return row;
}

describe("إنهاء الخدمة — يوم العمل الأخير", () => {
  it("ع١) الإنهاء في يوم العمل الأخير نفسه لا يقطع ربط الجهاز — يبقى إلى ما بعد نهاية اليوم", async () => {
    const employee = await seedLinkedEmployee({ salary: "900000", enrollId: 7 });
    const today = baghdadToday();
    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "استقالة",
      lastDay: today,
      breakdown: {},
    });

    const result = await completeTermination(Number(termination!.id), RECOGNIZER);

    // القطع مؤجَّل: لا ربط قُطع الآن، والسريان من غد يوم الإنهاء.
    expect(result.deviceLinksReleased).toBe(0);
    expect(result.deviceLinkReleaseDeferredTo).toBe(shiftDays(today, 1));
    const link = await deviceLinkOf(7);
    expect(Number(link.employeeId)).toBe(Number(employee.id));
    expect(link.effectiveFrom).toBe("2026-01-01");
    // بقيّة الإنهاء وقعت كاملةً — التأجيل يخصّ الربط وحده لا الحالة الوظيفية.
    const [employeeAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, employee.id));
    expect(employeeAfter.employmentStatus).toBe("terminated");
    expect(employeeAfter.isActive).toBe(false);
  });

  it("ع٢) الإنهاء بعد انتهاء يوم العمل الأخير يقطع الربط فوراً (صفر انحدار)", async () => {
    const employee = await seedLinkedEmployee({ salary: "900000", enrollId: 8 });
    const lastDay = shiftDays(baghdadToday(), -3);
    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "فصل",
      lastDay,
      breakdown: {},
    });

    const result = await completeTermination(Number(termination!.id), RECOGNIZER);

    expect(result.deviceLinksReleased).toBe(1);
    expect(result.deviceLinkReleaseDeferredTo).toBeNull();
    const link = await deviceLinkOf(8);
    expect(link.employeeId).toBeNull();
    expect(link.effectiveFrom).toBeNull();
  });

  it("ع٣) الكنسة تقطع الربط المؤجَّل حالما ينتهي يوم الإنهاء", async () => {
    const employee = await seedLinkedEmployee({ salary: "900000", enrollId: 9 });
    const today = baghdadToday();
    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "استقالة",
      lastDay: today,
      breakdown: {},
    });
    await completeTermination(Number(termination!.id), RECOGNIZER);
    expect(Number((await deviceLinkOf(9)).employeeId)).toBe(Number(employee.id));

    // كنسةٌ بمنظور اليوم نفسه لا تقطع شيئاً (يومُه لم ينتهِ بعد)...
    const sameDay = await withTx((tx) =>
      releaseDueTerminationDeviceLinks(tx, today),
    );
    expect(sameDay).toEqual([]);
    expect(Number((await deviceLinkOf(9)).employeeId)).toBe(Number(employee.id));

    // ...وكنسةُ الغد تقطعه.
    const nextDay = await withTx((tx) =>
      releaseDueTerminationDeviceLinks(tx, shiftDays(today, 1)),
    );
    expect(nextDay).toEqual([Number(employee.id)]);
    const link = await deviceLinkOf(9);
    expect(link.employeeId).toBeNull();
    expect(link.effectiveFrom).toBeNull();
  });
});

/*
 * حزيران ٢٠٢٦ (٣٠ يوماً) بجدولٍ كلُّ أيامه ٨ ساعات ⇒ الشهر المعياريّ ٢٤٠ ساعة، وراتب
 * ٢٤٠٬٠٠٠ ⇒ سعر الساعة ١٠٠٠ بالضبط. نافذة ١–١٠ حزيران = ١٠ أيام × ٨ = ٨٠ ساعة ⇒ ٨٠٬٠٠٠.
 * (كلُّ الأيام أيامُ دوام عمداً كي لا يتدخّل ترتيب أيام الأسبوع في الرقم المتوقَّع.)
 */
const EVERY_DAY_8H = {
  الأحد: { hours: 8 },
  الاثنين: { hours: 8 },
  الثلاثاء: { hours: 8 },
  الأربعاء: { hours: 8 },
  الخميس: { hours: 8 },
  الجمعة: { hours: 8 },
  السبت: { hours: 8 },
};
const LAST_DAY = "2026-06-10";

async function seedJuneAttendance(employeeId: number, days = 10) {
  const rows: (typeof s.attendance.$inferInsert)[] = [];
  for (let day = 1; day <= days; day++) {
    rows.push({
      employeeId,
      attendanceDate: `2026-06-${String(day).padStart(2, "0")}`,
      status: "PRESENT",
      hours: "8.00",
      hourlyRate: "0.00",
      amount: "0.00",
      source: "fingerprint",
    });
  }
  await db().insert(s.attendance).values(rows);
}

async function enableAttendancePay(from: string) {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: from })
    .onDuplicateKeyUpdate({
      set: { attendancePayEnabled: true, attendancePayFrom: from },
    });
}

describe("إنهاء الخدمة — سند أجر شهر الفصل", () => {
  it("ع٤) المُدخَل المطابق لسجلّ الحضور يمرّ بلا ملاحظة انحراف", async () => {
    const employee = await seedLinkedEmployee({
      salary: "240000",
      enrollId: 11,
      workSchedule: EVERY_DAY_8H,
    });
    await enableAttendancePay("2026-06-01");
    await seedJuneAttendance(employee.id);

    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "استقالة",
      lastDay: LAST_DAY,
      breakdown: { earnedGrossWages: "80000.00" },
    });
    const result = await completeTermination(Number(termination!.id), RECOGNIZER);

    expect(result.recognition.wageAudit).toMatchObject({
      basis: "ATTENDANCE",
      window: { from: "2026-06-01", to: LAST_DAY },
      computedGrossWages: "80000.00",
      enteredGrossWages: "80000.00",
      deviation: "0.00",
      matches: true,
      openDays: 0,
      note: null,
    });
    expect(result.recognition.wageAudit.components).toMatchObject({
      basePay: "80000.00",
      payableHours: "80.00",
    });
  });

  it("ع٤) المُدخَل المخالف يُسمّي الرقمين في الملاحظة ويُثبَّت في القيد المحاسبيّ", async () => {
    const employee = await seedLinkedEmployee({
      salary: "240000",
      enrollId: 12,
      workSchedule: EVERY_DAY_8H,
    });
    await enableAttendancePay("2026-06-01");
    await seedJuneAttendance(employee.id);

    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "فصل",
      lastDay: LAST_DAY,
      breakdown: { earnedGrossWages: "95000.00" },
    });
    const result = await completeTermination(Number(termination!.id), RECOGNIZER);

    const audit = result.recognition.wageAudit;
    expect(audit.matches).toBe(false);
    expect(audit.computedGrossWages).toBe("80000.00");
    expect(audit.deviation).toBe("15000.00");
    expect(audit.note).toContain("95000.00");
    expect(audit.note).toContain("80000.00");

    // الملاحظة تعيش في القيد نفسه لا في سجلّ التطبيق وحده.
    const [entry] = await db()
      .select({ notes: s.accountingEntries.notes })
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.dedupeKey,
          `TERMINATION:ACCRUAL:${Number(termination!.id)}`,
        ),
      );
    expect(String(entry?.notes)).toContain("يخالف المحسوب");
  });

  it("ع٥) الانحراف يُحذِّر ولا يحجب — والمسار غير الخاضع للحضور يُقاس بالراتب الثابت بالتناسب", async () => {
    // بلا صفّ إعدادات ⇒ الأجر بالحضور معطَّل (الافتراضي) ⇒ الأساس راتبٌ ثابت بالتناسب:
    // (٢٤٠٬٠٠٠ + ٣٠٬٠٠٠ بدلات) × ١٠/٣٠ = ٩٠٬٠٠٠.
    const employee = await seedLinkedEmployee({
      salary: "240000",
      allowances: "30000",
      enrollId: 13,
      workSchedule: EVERY_DAY_8H,
    });

    const termination = await createTermination({
      employeeId: employee.id,
      terminationType: "فصل",
      lastDay: LAST_DAY,
      breakdown: { earnedGrossWages: "500.00" },
    });
    // لا يُرمى: التسوية تكتمل ويُصدَر سندُها رغم الانحراف.
    const result = await completeTermination(Number(termination!.id), RECOGNIZER);

    expect(result.settlementVoucher).not.toBeNull();
    expect(result.recognition.wageAudit).toMatchObject({
      basis: "FIXED_SALARY",
      computedGrossWages: "90000.00",
      enteredGrossWages: "500.00",
      deviation: "-89500.00",
      matches: false,
    });
    const [terminationAfter] = await db()
      .select()
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, Number(termination!.id)));
    expect(terminationAfter.status).toBe("completed");
  });
});

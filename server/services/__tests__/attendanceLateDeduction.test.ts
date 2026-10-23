/**
 * اختبارات إلغاء خصم التأخير التلقائي المزدوج من الساعات (قرار المالك ٢٢/١٠: «١- نعم الغاء خصم التاخير»).
 *
 * يتحقق هذا الاختبار من:
 * 1. عدم افتراض وردية 09:00 وهمية لموظف بلا start/startTime في جدوله (حماية موظفي الشفت المسائي):
 *    - بقاء الحالة PRESENT والساعات كاملة (checkOut - checkIn) دون أي اقتطاع.
 * 2. عند تحديد موعد بدء الوردية صراحةً في جدول الدوام (مثلاً start: "09:00" أو "10:00"):
 *    - رصد الحالة LATE واحتساب lateMinutes بعد فترة السماح (15 دقيقة)
 *    - عدم خصم دقائق التأخير تلقائياً من الساعات المدفوعة (منع الخصم المزدوج: الساعات = الساعات الفعلية المؤداة)
 * 3. تمرير lateDeductionMinutes صراحةً للتجاوز الإداري المقصود:
 *    - تطبيق الخصم المحدد إدارياً وتوثيقه في الملاحظات.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { healAndRefoldMonthAttendance, recomputeMonthRates, recordAttendance } from "../attendanceService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "accountingEntries",
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

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 }]);
}

async function createTestEmployee(opts: {
  salary?: string;
  payType?: "monthly" | "hourly";
  workSchedule?: Record<string, any>;
} = {}) {
  const e = await createEmployee({
    firstName: "كرار",
    lastName: "الحسيني",
    payType: opts.payType ?? "monthly",
    salary: opts.salary ?? "900000",
    allowances: "0",
    branchId: 1,
    workSchedule: opts.workSchedule ?? null,
  });
  return e!;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe.sequential("قرار المالك (٢٢/١٠): إلغاء خصم التأخير التلقائي المزدوج من ساعات الحضور", () => {
  it("لا يفترض وردية 09:00 ولا يخصم من الساعات لموظف بلا وقت بدء وردية مخصص (حماية الشفت المسائي)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // حضور الساعة 14:15 وانصراف 22:15 (8 ساعات فعلية كاملة) دون تحديد start في الجدول
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // يوم اثنين
      hours: "8",
      checkIn: "14:15",
      checkOut: "22:15",
      status: "PRESENT",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(res.lateDeductionMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.effectiveHours).toBe(8);

    const hourlyRate = Number(res.hourlyRate);
    expect(hourlyRate).toBeGreaterThan(0);
    expect(Number(res.amount)).toBe(Math.round(8 * hourlyRate));
    expect(res.notes).toBeNull();
  });

  it("يمنح الأجر كاملاً دون أي خصم عند تسجيل الحضور في الموعد (08:55)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "08:55",
      checkOut: "17:00",
      status: "PRESENT",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(res.lateDeductionMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.effectiveHours).toBe(8);

    const hourlyRate = Number(res.hourlyRate);
    expect(Number(res.amount)).toBe(Math.round(8 * hourlyRate));
    expect(res.notes).toBeNull();
  });

  it("لا يحتسب تأخيراً إذا كان الحضور ضمن فترة السماح (09:10 مع وردية 09:00 وفترة سماح 15 دقيقة)", async () => {
    const emp = await createTestEmployee({
      salary: "900000",
      workSchedule: { الاثنين: { hours: 8, start: "09:00" } },
    });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:10",
      checkOut: "17:15",
      status: "PRESENT",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.notes).toBeNull();
  });

  it("يرصد حالة التأخير مع وردية مخصصة في جدول الدوام (start: 10:00) دون خصم تلقائي مزدوج من الساعات", async () => {
    const customSchedule = {
      الاثنين: { hours: 8, start: "10:00" },
    };
    const emp = await createTestEmployee({ salary: "900000", workSchedule: customSchedule });

    // حضور الساعة 10:10 (ضمن فترة السماح 15 دقيقة للوردية 10:00) -> غير متأخر
    const onTimeRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // الاثنين
      hours: "8",
      checkIn: "10:10",
      checkOut: "18:15",
    });
    expect(onTimeRes.status).toBe("PRESENT");
    expect(Number(onTimeRes.hours)).toBe(8);

    // حضور الساعة 10:40 وانصراف 18:45 (تأخر 40 دقيقة عن 10:00 لكنه أتمّ 8 ساعات عمل فعلية)
    // -> يُرصد LATE دون اقتطاع تلقائي من ساعاته الفعلية المؤداة
    const lateRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-10", // الاثنين التالي
      hours: "8",
      checkIn: "10:40",
      checkOut: "18:45",
    });
    expect(lateRes.status).toBe("LATE");
    expect(lateRes.lateMinutes).toBe(40);
    expect(lateRes.lateDeductionMinutes).toBeNull();
    expect(Number(lateRes.hours)).toBe(8);
    expect(lateRes.effectiveHours).toBe(8);
    expect(lateRes.notes).toBeNull();
  });

  it("يدعم التجاوز الإداري الصريح لدقائق الاستقطاع عبر lateDeductionMinutes عند طلبه", async () => {
    const emp = await createTestEmployee({
      salary: "900000",
      workSchedule: { الاثنين: { hours: 8, start: "09:00" } },
    });

    // الموظف تأخر 60 دقيقة (حضر 10:00 بدلاً من 09:00)، والإدارة مرّرت خصماً صريحاً 20 دقيقة
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "10:00",
      checkOut: "18:00",
      lateDeductionMinutes: 20,
    });

    expect(res.status).toBe("LATE");
    expect(res.lateMinutes).toBe(60);
    expect(res.lateDeductionMinutes).toBe(20);

    // الخصم المحسوب يكون 20 دقيقة فقط: 8 - (20 / 60) = 7.67 ساعة
    expect(Number(res.hours)).toBeCloseTo(7.67, 2);
    expect(res.notes).toContain("[تأخير: 60 دقيقة - خصم 20 دقيقة]");
  });

  it("يُصلح السجلات القديمة المتضررة من خصم التأخير المزدوج تلقائياً عبر healAndRefoldMonthAttendance", async () => {
    const emp = await createTestEmployee({ salary: "940000" });
    const d = db();
    await d.insert(s.attendance).values([
      {
        employeeId: emp.id,
        branchId: 1,
        attendanceDate: "2026-10-01",
        status: "LATE",
        checkIn: new Date("2026-10-01T14:15:00Z"),
        checkOut: new Date("2026-10-01T22:12:00Z"),
        hours: "2.70", // كانت مقصوصة خطأً بسبب خصم التأخير المزدوج (7.95 - 5.25 = 2.70)
        hourlyRate: "4519.23",
        amount: "12201.92",
        source: "fingerprint",
        notes: "[تأخير: 315 دقيقة - خصم 315 دقيقة]",
      },
      {
        employeeId: emp.id,
        branchId: 1,
        attendanceDate: "2026-10-05",
        status: "LATE",
        checkIn: new Date("2026-10-05T15:07:00Z"),
        checkOut: new Date("2026-10-05T23:07:00Z"),
        hours: "1.88", // تصحيح يدوي قديم خُرِّب بخصم التأخير المزدوج (8.00 - 6.12 = 1.88)
        hourlyRate: "4519.23",
        amount: "8496.00",
        source: "manual",
        notes: "[تأخير: 367 دقيقة - خصم 367 دقيقة]",
      },
    ]);

    await healAndRefoldMonthAttendance("2026-10");

    const healedRows = await d.select().from(s.attendance);
    const oct1 = healedRows.find((r) => String(r.attendanceDate) === "2026-10-01")!;
    expect(oct1.status).toBe("PRESENT");
    expect(Number(oct1.hours)).toBeCloseTo(7.95, 2); // استعادة الساعات الفعلية الكاملة (14:15 -> 22:12)
    expect(oct1.notes).toBeNull();

    const oct5 = healedRows.find((r) => String(r.attendanceDate) === "2026-10-05")!;
    expect(oct5.status).toBe("PRESENT");
    expect(Number(oct5.hours)).toBeCloseTo(8.0, 2); // استعادة الساعات المصحّحة يدوياً (15:07 -> 23:07)
    expect(oct5.notes).toBeNull();
  });

  it("يحفظ التعديلات اليدوية المقصودة للمدير (ساعات مخصّصة أو خصم تأخير يدوي) ولا يطمسها عند إعادة الاحتساب والطيّ", async () => {
    const emp = await createTestEmployee({
      salary: "940000",
      workSchedule: { الاثنين: { hours: 8, start: "09:00" }, الثلاثاء: { hours: 8 } },
    });
    const d = db();

    // ١) يوم بتصحيح يدوي لساعات مخصّصة (طرح استراحة ساعة يدوياً: 14:00 -> 22:00 = 8 ساعات، والمدير ثبّتها 7 ساعات)
    await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-10-06", // الثلاثاء
      hours: "7",
      checkIn: "14:00",
      checkOut: "22:00",
      status: "PRESENT",
      source: "manual",
      notes: "طرح ساعة استراحة خارجية",
    });

    // ٢) يوم بخصم تأخير يدوي مقصود (حضر 10:00 بدلاً من 09:00، والمدير طبّق خصم 30 دقيقة صراحةً)
    await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-10-05", // الاثنين
      hours: "8",
      checkIn: "10:00",
      checkOut: "18:00",
      lateDeductionMinutes: 30,
      source: "manual",
      notes: "خصم تأخير إداري معتمد",
    });

    // نشغّل كلاً من الشفاء التلقائي وزرّ إعادة الاحتساب والطيّ اليدوي
    await healAndRefoldMonthAttendance("2026-10", { employeeId: emp.id });
    await recomputeMonthRates({ period: "2026-10", employeeId: emp.id });

    const rows = await d.select().from(s.attendance);
    const oct6 = rows.find((r) => String(r.attendanceDate) === "2026-10-06")!;
    expect(oct6.source).toBe("manual");
    expect(Number(oct6.hours)).toBeCloseTo(7.0, 2); // لم تُستبدل بـ 8.00
    expect(oct6.notes).toBe("طرح ساعة استراحة خارجية");

    const oct5 = rows.find((r) => String(r.attendanceDate) === "2026-10-05")!;
    expect(oct5.source).toBe("manual");
    expect(oct5.status).toBe("LATE");
    expect(Number(oct5.hours)).toBeCloseTo(7.5, 2); // 8 - 0.5 = 7.5 ساعة محفوظة دون طمس
    expect(oct5.reviewReason).toBe("manual_late_override");
    expect(oct5.notes).toContain("خصم 30 دقيقة");
    expect(oct5.notes).toContain("خصم تأخير إداري معتمد");
  });

  it("يدعم تسجيل الدوام المجزّأ (فترتين أو أكثر) والاستراحة/الزمنية ويعرض تفاصيلها في الكشف الفردي وسجل الحضور", async () => {
    const { listAttendance } = await import("../attendanceService");
    const { getEmployeeStatement } = await import("../hr/employeeStatement");
    const emp = await createTestEmployee({ salary: "900000" });

    // ١) دوام مجزّأ: 08:00→12:00 (4 ساعات) + استراحة/زمنية 4 ساعات + 16:00→20:00 (4 ساعات) = 8 ساعات صافية
    await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-10-07",
      hours: 8,
      sessions: [
        { checkIn: "08:00", checkOut: "12:00" },
        { checkIn: "16:00", checkOut: "20:00" },
      ],
      notes: "دوام صباحي ومسائي",
      source: "manual",
    });

    // ٢) فترة واحدة مع استراحة/زمنية (08:00→17:00 مع استراحة 60 دقيقة = 8 ساعات صافية)
    await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-10-08",
      hours: 8,
      checkIn: "08:00",
      checkOut: "17:00",
      breakMinutes: 60,
      notes: "زمنية ساعة واحدة ظهراً",
      source: "manual",
    });

    const listRes = await listAttendance({ employeeId: emp.id, period: "2026-10" });
    const rowSplit = listRes.rows.find((r) => r.attendanceDate === "2026-10-07")!;
    expect(Number(rowSplit.hours)).toBe(8);
    expect(rowSplit.hasMultipleSessions).toBe(true);
    expect(rowSplit.sessions).toHaveLength(2);
    expect(rowSplit.breakMinutes).toBe(240);
    expect(rowSplit.breakHours).toBe("4.00");
    expect(rowSplit.cleanNotes).toBe("دوام صباحي ومسائي");

    const rowBreak = listRes.rows.find((r) => r.attendanceDate === "2026-10-08")!;
    expect(Number(rowBreak.hours)).toBe(8);
    expect(rowBreak.hasMultipleSessions).toBe(false);
    expect(rowBreak.breakMinutes).toBe(60);
    expect(rowBreak.breakHours).toBe("1.00");
    expect(rowBreak.cleanNotes).toBe("زمنية ساعة واحدة ظهراً");

    const stmt = await getEmployeeStatement({ employeeId: emp.id, period: "2026-10" });
    const stmtSplit = stmt.days.find((d) => d.date === "2026-10-07")!;
    expect(stmtSplit.hasMultipleSessions).toBe(true);
    expect(stmtSplit.sessions).toEqual([
      { checkIn: "08:00", checkOut: "12:00", hours: "4.00" },
      { checkIn: "16:00", checkOut: "20:00", hours: "4.00" },
    ]);
    expect(stmtSplit.breakMinutes).toBe(240);
    expect(stmtSplit.cleanNotes).toBe("دوام صباحي ومسائي");
  });

  it("لا يطمس استراحة الدوام المجزّأ عند شفاء خصم التأخير التلقائي القديم (يستعيد 8 ساعات لا 12 ساعة)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });
    const d = db();
    // موظف دوامه المجزّأ 08:00→12:00 و 16:00→20:00 (صافي 8 ساعات، والمدى الكلي 12 ساعة)
    // خُصم منه سابقاً 60 دقيقة تأخير تلقائي فخُزِّنت ساعاته 7.00
    await d.insert(s.attendance).values([
      {
        employeeId: emp.id,
        branchId: 1,
        attendanceDate: "2026-10-10",
        status: "LATE",
        checkIn: new Date("2026-10-10T10:00:00Z"),
        checkOut: new Date("2026-10-10T22:00:00Z"), // مدى 12 ساعة، لكن صافي العمل قبل الخصم كان 8 ساعات (4 ساعات استراحة)
        hours: "7.00",
        hourlyRate: "3750.00",
        amount: "26250.00",
        source: "fingerprint",
        notes: "[فترات الدوام: 10:00→14:00، 18:00→22:00 | استراحة/زمنية: 240 دقيقة] [تأخير: 60 دقيقة - خصم 60 دقيقة]",
      },
    ]);

    await recomputeMonthRates({ period: "2026-10", employeeId: emp.id });
    const [healed] = await d.select().from(s.attendance);
    expect(healed.status).toBe("PRESENT");
    // يجب أن يستعيد 7.00 + (60/60) = 8.00 ساعات، وليس المدى الكلي 12.00 ساعة!
    expect(Number(healed.hours)).toBeCloseTo(8.0, 2);
    expect(healed.notes).toContain("[فترات الدوام: 10:00→14:00، 18:00→22:00 | استراحة/زمنية: 240 دقيقة]");
    expect(healed.notes).not.toContain("[تأخير:");
  });
});


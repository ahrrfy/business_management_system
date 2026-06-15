/* ============================================================================
 * خدمة الحضور والانصراف — وحدة الموارد البشرية (server/services/attendanceService.ts)
 * نظام الساعات: أجر اليوم = ساعات الحضور × سعر ساعة ذلك اليوم (من جدول أيام الموظف
 * أو الجدول الافتراضي للشركة). كل تسجيل/تعديل ذرّي (withTx) بصيغة UPSERT على
 * (employeeId, attendanceDate). المبالغ عبر money.ts (toDbMoney) — لا parseFloat.
 * القراءة hr/READ والكتابة hr/FULL (تُفرض في الموجّه).
 * ========================================================================== */
import { and, desc, eq, getTableColumns, like, sql } from "drizzle-orm";
import { DAY_RATES_DEFAULT, WEEK_DAYS, fullEmployeeName } from "@shared/hr";
import { attendance, employees } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { money, round2, toDbMoney } from "./money";

/** اسم اليوم العربي من تاريخ "YYYY-MM-DD" (الأحد=0). يُحسب بتقويم UTC ثابت من مكوّنات السلسلة
 *  حتى لا تنزلق التسمية (ومعها سعر الساعة) بمنطقة الخادم الزمنية — تكامل مالي مستقلّ عن TZ. */
export function arabicDayName(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WEEK_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** عمود attendanceDate نوعه date بلا mode:"string" ⇒ قد يعود كـ Date من السائق؛ نوحّده لـ"YYYY-MM-DD". */
function toDateStr(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d ?? "");
}

/** سعر ساعة الموظف لتاريخ معيّن: جدول الموظف الخاص ثمّ الجدول الافتراضي للشركة. */
function rateForDay(emp: { dayRates?: unknown }, dateStr: string): number {
  const day = arabicDayName(dateStr);
  const rates = (emp.dayRates && typeof emp.dayRates === "object" ? emp.dayRates : {}) as Record<string, number>;
  const r = rates[day];
  if (typeof r === "number" && Number.isFinite(r) && r >= 0) return r;
  return DAY_RATES_DEFAULT[day] ?? 0;
}

export interface AttendanceFilters {
  /** معرّف موظف بعينه. */
  employeeId?: number;
  /** الشهر بصيغة "YYYY-MM" — يُطابَق على attendanceDate بـ LIKE 'YYYY-MM%'. */
  period?: string;
  /** مصدر التسجيل: fingerprint | manual. */
  source?: string;
}

/** سجلّ الحضور المدمج مع اسم الموظف واسم اليوم المحسوب — مرتّب بالأحدث تاريخاً. */
export async function listAttendance(filters?: AttendanceFilters) {
  const db = requireDb();
  const conds = [];
  if (filters?.employeeId) conds.push(eq(attendance.employeeId, filters.employeeId));
  if (filters?.period) conds.push(like(attendance.attendanceDate, `${filters.period}%`));
  if (filters?.source) conds.push(eq(attendance.source, filters.source));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      ...getTableColumns(attendance),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
    })
    .from(attendance)
    .leftJoin(employees, eq(attendance.employeeId, employees.id))
    .where(where)
    .orderBy(desc(attendance.attendanceDate), desc(attendance.id));

  return rows.map((r) => {
    const dateStr = toDateStr(r.attendanceDate);
    return {
      ...r,
      attendanceDate: dateStr,
      employeeName: fullEmployeeName(r),
      dayName: dateStr ? arabicDayName(dateStr) : "",
    };
  });
}

/** خيارات نموذج التسجيل اليدوي: الموظفون بالساعة على رأس العمل فقط. */
export async function formOptions() {
  const db = requireDb();
  const rows = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employees)
    .where(and(eq(employees.employmentStatus, "active"), eq(employees.payType, "hourly")))
    .orderBy(employees.firstName);
  return rows.map((e) => ({ id: e.id, name: fullEmployeeName(e) }));
}

export interface RecordAttendanceInput {
  employeeId: number;
  attendanceDate: string; // YYYY-MM-DD
  hours: string | number;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
  source?: string;
  notes?: string | null;
}

/** يُحوّل وقت "HH:MM" في يوم الحضور إلى Date لعمود timestamp (أو null).
 *  يُفسَّر بـUTC صراحةً (لاحقة Z) ⇒ تُخزَّن ساعة الحائط كما أُدخلت بصرف النظر عن منطقة الخادم،
 *  وتُعرَض بنفس المنطق في الواجهة (toISOString) فلا تنزلق الساعة عند اختلاف توقيت الخادم/المتصفح. */
function timeToTimestamp(dateStr: string, time?: string | null): Date | null {
  if (!time) return null;
  const t = time.trim();
  if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
  const d = new Date(`${dateStr}T${t.padStart(5, "0")}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * تسجيل/تعديل حضور يوم لموظف (UPSERT على employeeId+attendanceDate) ذرّياً.
 * سعر الساعة لقطةٌ وقت التسجيل من جدول الموظف/الشركة، والأجر = round(ساعات × سعر) بالدينار الصحيح.
 */
export async function recordAttendance(input: RecordAttendanceInput) {
  return withTx(async (tx) => {
    const [emp] = await tx.select().from(employees).where(eq(employees.id, input.employeeId)).limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    // لا يُسجَّل حضور لموظف منتهي الخدمة (الحضور بعد الإنهاء يولّد أجراً وهمياً عند توليد المسيّر).
    if (emp.employmentStatus === "terminated") {
      throw new Error("لا يمكن تسجيل حضور لموظف منتهي الخدمة");
    }

    const hoursDec = money(input.hours);
    if (hoursDec.isNegative()) throw new Error("الساعات لا يمكن أن تكون سالبة");

    const status = input.status ?? "PRESENT";
    // ABSENT/LEAVE لا يولّدان أجراً مهما كانت الساعات. التصفير المزدوج (هنا + WHERE في تجميع المسيّر)
    // يحمي حتى عند تعديل صفّ موجود أو إدخال مباشر بـAPI يضع status=ABSENT مع ساعات (سهو/استيراد بصمة).
    const isPaidStatus = status === "PRESENT" || status === "LATE";
    const effectiveHours = isPaidStatus ? hoursDec : money(0);
    const rate = rateForDay(emp, input.attendanceDate);
    // الأجر بالدينار الصحيح (لا فئات أصغر من الدينار في المتجر): تقريب الناتج إلى عدد صحيح.
    // toDecimalPlaces(0) يستعمل سياسة التقريب العامّة المثبّتة في money.ts (HALF_UP).
    const amount = round2(effectiveHours.times(rate)).toDecimalPlaces(0);

    const values = {
      employeeId: input.employeeId,
      attendanceDate: input.attendanceDate,
      checkIn: timeToTimestamp(input.attendanceDate, input.checkIn),
      checkOut: timeToTimestamp(input.attendanceDate, input.checkOut),
      status,
      notes: input.notes?.trim() || null,
      hours: toDbMoney(effectiveHours),
      hourlyRate: toDbMoney(rate),
      amount: toDbMoney(amount),
      source: input.source ?? "manual",
    } as const;

    const [existing] = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(and(eq(attendance.employeeId, input.employeeId), eq(attendance.attendanceDate, input.attendanceDate)))
      .limit(1);

    let savedId: number;
    if (existing) {
      await tx.update(attendance).set(values).where(eq(attendance.id, existing.id));
      savedId = existing.id;
    } else {
      const [res] = await tx.insert(attendance).values(values);
      savedId = extractInsertId(res);
    }

    const [saved] = await tx.select().from(attendance).where(eq(attendance.id, savedId)).limit(1);
    return { ...saved, attendanceDate: toDateStr(saved.attendanceDate), dayName: arabicDayName(input.attendanceDate) };
  });
}

/** ملخّص الشهر: لكل موظف بالساعة على رأس العمل، إجمالي ساعاته ومبلغه في الفترة. */
export async function monthSummary(period: string) {
  const db = requireDb();
  const emps = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employees)
    .where(and(eq(employees.employmentStatus, "active"), eq(employees.payType, "hourly")))
    .orderBy(employees.firstName);

  const agg = await db
    .select({
      employeeId: attendance.employeeId,
      totalHours: sql<string>`COALESCE(SUM(${attendance.hours}), 0)`,
      totalAmount: sql<string>`COALESCE(SUM(${attendance.amount}), 0)`,
    })
    .from(attendance)
    // أيام PRESENT/LATE فقط تدخل المجموع المدفوع — متّسق مع تجميع المسيّر في payrollService.
    .where(and(like(attendance.attendanceDate, `${period}%`), sql`${attendance.status} IN ('PRESENT', 'LATE')`))
    .groupBy(attendance.employeeId);

  const byEmp = new Map(agg.map((a) => [a.employeeId, a]));
  return emps.map((e) => {
    const a = byEmp.get(e.id);
    return {
      employeeId: e.id,
      name: fullEmployeeName(e),
      totalHours: a ? round2(a.totalHours).toNumber() : 0,
      totalAmount: a ? toDbMoney(a.totalAmount) : toDbMoney(0),
    };
  });
}

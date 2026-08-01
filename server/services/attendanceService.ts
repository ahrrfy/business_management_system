/* ============================================================================
 * خدمة الحضور والانصراف — وحدة الموارد البشرية (server/services/attendanceService.ts)
 * نظام الساعات: أجر اليوم = ساعات الحضور × سعر ساعة ذلك اليوم (من جدول أيام الموظف
 * أو الجدول الافتراضي للشركة). كل تسجيل/تعديل ذرّي (withTx) بصيغة UPSERT على
 * (employeeId, attendanceDate). المبالغ عبر money.ts (toDbMoney) — لا parseFloat.
 * القراءة hr/READ والكتابة hr/FULL (تُفرض في الموجّه).
 * ========================================================================== */
import { and, desc, eq, getTableColumns, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { WEEK_DAYS, fullEmployeeName } from "@shared/hr";
import { attendance, employees, hrAttendanceSettings, payrollRuns } from "../../drizzle/schema";
import { escLike } from "../lib/sqlLike";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { money, round2, toDbMoney } from "./money";
import { DEFAULT_WORK_SCHEDULE, standardMonthlyHours, type WorkSchedule } from "./hr/attendancePay";

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

/** مصدر سعر الساعة المعروض — يُعرَض للمالك فلا يُظنّ رقمٌ مُشتقٌّ رقماً أدخله بنفسه. */
export type RateBasis = "schedule" | "derived" | "fallbackSchedule" | "dayRates" | "none";

/**
 * سعر ساعة الموظف لتاريخ معيّن — **من ملفّه هو، لا من ثابتٍ في الكود**.
 *
 * ⚠️ الفخّ الذي أوقع سجلّ الحضور في أرقامٍ وهمية (١/٨): كانت آخرُ درجةٍ في السلّم
 * `DAY_RATES_DEFAULT` — جدولٌ **مكتوبٌ في المصدر** (٥٠٠٠/٥٥٠٠/٧٥٠٠/٦٠٠٠) لم يُدخله أحد.
 * فموظفٌ شهريٌّ راتبه ٤٠٠٬٠٠٠ وسعرُ ساعته الحقيقيّ ١٬٩٠٥ ظهر بـ**٦٬٠٠٠/ساعة** و٤٢٬٠٠٠
 * أجرَ يومٍ لن يُصرف أبداً. وهو يخالف قاعدة المالك: «اجعل كلّ شيء أنا أضعه وأختاره».
 *
 * السلّم الآن — كلُّ درجةٍ من بيانات الموظف، وآخرُها **صفرٌ ظاهرٌ** لا رقمٌ مُختلَق:
 *   ١) الساعيّ: سعرُ اليوم في `dayRates` (نموذجُه المرئيّ) — وإلا صفرٌ موسوم.
 *   ٢) الشهريّ: سعر اليوم الصريح في `workSchedule` (هو الأصل بقرار المالك ٣١/٧).
 *   ٣) الشهريّ: الراتب ÷ ساعات الشهر المعياريّ (٣٠ يوماً) وفق جدوله.
 *   ٤) الشهريّ بلا جدول: نفس الاشتقاق على الجدول الاحتياطيّ — **مطابقةً للمسيّر حرفياً**
 *      (`payrollService` يستعمل `DEFAULT_WORK_SCHEDULE` نفسه) فلا يعرض السجلّ رقماً غيره.
 *   ٥) لا شيء ⇒ صفرٌ بأساس `none` تُظهره الشاشة تحذيراً.
 */
export function rateForDayDetailed(
  emp: { dayRates?: unknown; workSchedule?: unknown; salary?: unknown; payType?: string | null },
  dateStr: string,
): { rate: number; basis: RateBasis } {
  const day = arabicDayName(dateStr);
  /*
   * أسبقيةٌ بحسب نموذج الأجر (Codex P1): الموظف **الساعيّ** يُدخل أسعاره في `dayRates`
   * من نموذجه، وهو مصدرُ الحقيقة الظاهر له — فتقديمُ `workSchedule` عليه قد يُطبّق سعراً
   * قديماً من إعدادٍ شهريٍّ سابق رغم تحديثه الحقلَ المرئيّ. الجدول يتقدّم للشهريّ فقط.
   */
  const rates = (emp.dayRates && typeof emp.dayRates === "object" ? emp.dayRates : {}) as Record<string, number>;
  const fromDayRates = rates[day];
  if (emp.payType === "hourly") {
    if (typeof fromDayRates === "number" && Number.isFinite(fromDayRates) && fromDayRates > 0) {
      return { rate: fromDayRates, basis: "dayRates" };
    }
    return { rate: 0, basis: "none" };
  }
  const sched = (emp.workSchedule && typeof emp.workSchedule === "object" ? emp.workSchedule : null) as WorkSchedule | null;
  const salary = Number(emp.salary ?? 0);
  const monthStart = `${dateStr.slice(0, 7)}-01`;
  if (sched) {
    const explicit = Number((sched[day] as { rate?: number } | undefined)?.rate ?? NaN);
    if (Number.isFinite(explicit) && explicit > 0) return { rate: explicit, basis: "schedule" };
    // مُشتقّ: الراتب ÷ ساعات ٣٠ يوماً وفق جدوله (نفس مقام المسيّر ⇒ لا انحراف).
    const std = standardMonthlyHours(sched, monthStart);
    if (salary > 0 && std.gt(0)) return { rate: salary / std.toNumber(), basis: "derived" };
  } else if (salary > 0) {
    const std = standardMonthlyHours(DEFAULT_WORK_SCHEDULE, monthStart);
    if (std.gt(0)) return { rate: salary / std.toNumber(), basis: "fallbackSchedule" };
  }
  if (typeof fromDayRates === "number" && Number.isFinite(fromDayRates) && fromDayRates > 0) {
    return { rate: fromDayRates, basis: "dayRates" };
  }
  return { rate: 0, basis: "none" };
}

function rateForDay(
  emp: { dayRates?: unknown; workSchedule?: unknown; salary?: unknown; payType?: string | null },
  dateStr: string,
): number {
  return rateForDayDetailed(emp, dateStr).rate;
}

export interface AttendanceFilters {
  /** معرّف موظف بعينه. */
  employeeId?: number;
  /** الشهر بصيغة "YYYY-MM" — يُطابَق على attendanceDate بـ LIKE 'YYYY-MM%'. */
  period?: string;
  /** مصدر التسجيل: fingerprint | manual. */
  source?: string;
  /** بحث نصّي: اسم الموظف (رباعيّ) أو التاريخ أو اسم اليوم العربي. */
  q?: string;
  /** أيام ينقصها إغلاق فقط — طابور التصحيح قبل إغلاق الشهر (0137). */
  needsReviewOnly?: boolean;
}

/**
 * شروط WHERE لسجلّ الحضور — يتقاسمها listAttendance وattendanceSummary ⇒ المجاميع المعروضة
 * تطابق الصفوف حتماً (لا مجموعٌ لمجموعةٍ وصفوفٌ لأخرى).
 * ⚠️ يُشير لأعمدة employees عند البحث بالاسم ⇒ كل مستهلك يلزمه join على employees.
 */
function buildAttendanceConds(filters?: AttendanceFilters): SQL[] {
  const conds: SQL[] = [];
  if (filters?.employeeId) conds.push(eq(attendance.employeeId, filters.employeeId));
  if (filters?.period) conds.push(like(attendance.attendanceDate, `${filters.period}%`));
  if (filters?.source) conds.push(eq(attendance.source, filters.source));
  if (filters?.needsReviewOnly) conds.push(eq(attendance.needsReview, true));
  const q = filters?.q?.trim();
  if (q) {
    const pat = `%${escLike(q)}%`;
    // الاسم: مطابقة خام على الأجزاء الأربعة (لا searchNorm على employees ⇒ لا تطبيع عربي هنا؛
    // تطبيعُ الاستعلام وحده دون العمود كان سيكسر المطابقة بدل أن يوسّعها).
    const parts: SQL[] = [
      sql`${employees.firstName} LIKE ${pat} ESCAPE '!'`,
      sql`${employees.fatherName} LIKE ${pat} ESCAPE '!'`,
      sql`${employees.grandfatherName} LIKE ${pat} ESCAPE '!'`,
      sql`${employees.lastName} LIKE ${pat} ESCAPE '!'`,
      // التاريخ كنصّ (يسمح بـ«2026-07» أو يوم بعينه).
      sql`CAST(${attendance.attendanceDate} AS CHAR) LIKE ${pat} ESCAPE '!'`,
    ];
    // اسم اليوم العربي محسوب في JS (لا عمود له) ⇒ نُترجم الاستعلام إلى رقم يوم الأسبوع.
    // WEEK_DAYS: الأحد=0، وMySQL DAYOFWEEK: الأحد=1 ⇒ الفهرس+1. attendanceDate من نوع date
    // ⇒ لا انزياح منطقة زمنية (مطابقٌ لحساب arabicDayName بتقويم UTC ثابت).
    const dayIdx = WEEK_DAYS.findIndex((d) => d === q);
    if (dayIdx >= 0) parts.push(sql`DAYOFWEEK(${attendance.attendanceDate}) = ${dayIdx + 1}`);
    conds.push(or(...parts)!);
  }
  return conds;
}

/** سجلّ الحضور المدمج مع اسم الموظف واسم اليوم المحسوب — مرتّب بالأحدث تاريخاً، **مُرقَّم**.
 *  يُعيد صفوف الصفحة + إجمالي المطابق (للترقيم) + مجاميع المطابق (لتذييل الجدول). */
export async function listAttendance(filters?: AttendanceFilters & { limit?: number; offset?: number }) {
  const db = requireDb();
  const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 500);
  const offset = Math.max(filters?.offset ?? 0, 0);
  const conds = buildAttendanceConds(filters);
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
      // بيانات الأجر الحيّة — لاشتقاق سعر اليوم من ملفّ الموظف **الآن** لا من لقطةٍ قديمة.
      payType: employees.payType,
      salary: employees.salary,
      workSchedule: employees.workSchedule,
      dayRates: employees.dayRates,
    })
    .from(attendance)
    .leftJoin(employees, eq(attendance.employeeId, employees.id))
    .where(where)
    .orderBy(desc(attendance.attendanceDate), desc(attendance.id))
    .limit(limit)
    .offset(offset);

  // الإجمالي + مجاميع المطابق كلّه (لا الصفحة) — بنفس الشروط ونفس الـjoin.
  // المبالغ نصّية كما يعيدها mysql2 (SUM على decimal) — لا parseFloat (§٥).
  const agg = (
    await db
      .select({
        count: sql<number>`COUNT(*)`,
        hours: sql<string>`COALESCE(SUM(${attendance.hours}), 0)`,
        amount: sql<string>`COALESCE(SUM(${attendance.amount}), 0)`,
      })
      .from(attendance)
      .leftJoin(employees, eq(attendance.employeeId, employees.id))
      .where(where)
  )[0];

  /*
   * السعر والأجر **يُشتقّان حيّاً من ملفّ الموظف** لا من اللقطة المخزَّنة (١/٨).
   *
   * اللقطة تُكتب لحظةَ طيّ البصمة أو الإدخال — أي **قبل** أن يضبط المالك جدولَ الموظف
   * غالباً — ولا يُعيد أحدٌ اشتقاقها بعدُ: عدَّل بطاقةَ الموظف كما شئتَ، يبقى الصفّ على
   * رقمه القديم إلى الأبد. وللشهريّ اللقطةُ **ليست ما يُدفع أصلاً**: المسيّر يعيد الحساب
   * من `computeAttendancePay`، فكان العمود يعرض رقماً لن يُصرف ويناقض كشفَ الموظف نفسه.
   * نُبقي `storedHourlyRate/storedAmount` ونَسِم المختلف بـ`rateStale` ليُعاد احتسابه —
   * فاللقطة تبقى أساسَ صرف **الساعيّ** في المسيّر، ولا يجوز أن تنحرف صامتةً.
   */
  const mapped = rows.map((r) => {
    const dateStr = toDateStr(r.attendanceDate);
    const { rate, basis } = rateForDayDetailed(r, dateStr);
    const hours = money(r.hours ?? 0);
    const liveRate = round2(money(rate));
    const liveAmount = round2(hours.times(liveRate)).toDecimalPlaces(0);
    const stored = money(r.hourlyRate ?? 0);
    return {
      ...r,
      attendanceDate: dateStr,
      employeeName: fullEmployeeName(r),
      dayName: dateStr ? arabicDayName(dateStr) : "",
      storedHourlyRate: toDbMoney(stored),
      storedAmount: toDbMoney(money(r.amount ?? 0)),
      hourlyRate: toDbMoney(liveRate),
      amount: toDbMoney(liveAmount),
      rateBasis: basis,
      rateStale: !stored.eq(liveRate),
    };
  });

  return {
    rows: mapped,
    total: Number(agg?.count ?? 0),
    // المجاميع من المخزَّن (SUM على كل المطابق لا الصفحة). قد تختلف عن مجموع الأعمدة
    // المعروضة إن كانت لقطاتٌ قديمة ⇒ الشاشة تُنبّه وتعرض زرّ إعادة الاحتساب.
    totals: { hours: String(agg?.hours ?? "0"), amount: String(agg?.amount ?? "0") },
    staleCount: mapped.filter((r) => r.rateStale).length,
  };
}

/**
 * إعادة احتساب أسعار الساعة وأجور الأيام لشهرٍ كامل من **ملفّات الموظفين الحالية**.
 *
 * تُصلح اللقطات القديمة (سعرٌ كُتب قبل ضبط جدول الموظف، أو بعد تعديل راتبه)، وهي
 * ضروريةٌ لا تجميلية: لقطة **الساعيّ** هي وعاءُ أجره في المسيّر فعلاً.
 *
 * محروسة: شهرٌ مسيّرُه معتمد/مدفوع لا يُمَسّ (نفس حارس `recordAttendance` — تغييرُ الأساس
 * بعد الاعتماد يُفسد مسيّراً مُلتزَماً مالياً). وأيام ABSENT/LEAVE تبقى بأجرٍ صفريّ.
 */
export async function recomputeMonthRates(input: { period: string; employeeId?: number }) {
  const period = String(input.period).slice(0, 7);
  return withTx(async (tx) => {
    const [lockedRun] = await tx
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["approved", "paid"])))
      .limit(1);
    if (lockedRun) {
      throw new Error(
        `لا يمكن إعادة الاحتساب: مسيّر رواتب شهر ${period} ${lockedRun.status === "paid" ? "مدفوع" : "معتمَد"} — ألغِ اعتماد المسيّر أولاً`,
      );
    }

    const conds: SQL[] = [like(attendance.attendanceDate, `${period}%`)];
    if (input.employeeId) conds.push(eq(attendance.employeeId, input.employeeId));
    const rows = await tx
      .select({
        id: attendance.id,
        attendanceDate: attendance.attendanceDate,
        hours: attendance.hours,
        hourlyRate: attendance.hourlyRate,
        amount: attendance.amount,
        status: attendance.status,
        payType: employees.payType,
        salary: employees.salary,
        workSchedule: employees.workSchedule,
        dayRates: employees.dayRates,
      })
      .from(attendance)
      .leftJoin(employees, eq(attendance.employeeId, employees.id))
      .where(and(...conds));

    let updated = 0;
    for (const r of rows) {
      const dateStr = toDateStr(r.attendanceDate);
      const rate = round2(money(rateForDay(r, dateStr)));
      // ABSENT/LEAVE بلا أجرٍ مهما كان السعر (نفس قاعدة recordAttendance).
      const paid = r.status === "PRESENT" || r.status === "LATE";
      const amount = paid ? round2(money(r.hours ?? 0).times(rate)).toDecimalPlaces(0) : money(0);
      if (money(r.hourlyRate ?? 0).eq(rate) && money(r.amount ?? 0).eq(amount)) continue;
      await tx
        .update(attendance)
        .set({ hourlyRate: toDbMoney(rate), amount: toDbMoney(amount) })
        .where(eq(attendance.id, r.id));
      updated += 1;
    }
    return { period, scanned: rows.length, updated };
  });
}

/**
 * مؤشّرات شاشة الحضور (بطاقات الأعلى) — مجاميع **كل** المطابق للفلتر لا الصفحة المعروضة.
 * كانت تُحسب في المتصفّح من الصفوف المُحمَّلة (سقف ٣٠٠) ⇒ تكذب بمجرّد تجاوز السقف.
 * ملاحظة دلالة (سلوك محفوظ كما كان): الشاشة تستدعيها **بلا q** — البطاقات مؤشّرُ الشهر/الفلتر،
 * والبحث النصّي يُصفّي الجدول وتذييله فقط (listAttendance.totals).
 */
export async function attendanceSummary(filters?: AttendanceFilters) {
  const db = requireDb();
  const conds = buildAttendanceConds(filters);
  const where = conds.length ? and(...conds) : undefined;
  const row = (
    await db
      .select({
        hours: sql<string>`COALESCE(SUM(${attendance.hours}), 0)`,
        amount: sql<string>`COALESCE(SUM(${attendance.amount}), 0)`,
        fingerprintCount: sql<number>`COALESCE(SUM(CASE WHEN ${attendance.source} = 'fingerprint' THEN 1 ELSE 0 END), 0)`,
        manualCount: sql<number>`COALESCE(SUM(CASE WHEN ${attendance.source} <> 'fingerprint' THEN 1 ELSE 0 END), 0)`,
      })
      .from(attendance)
      .leftJoin(employees, eq(attendance.employeeId, employees.id))
      .where(where)
  )[0];
  return {
    hours: String(row?.hours ?? "0"),
    amount: String(row?.amount ?? "0"),
    fingerprintCount: Number(row?.fingerprintCount ?? 0),
    manualCount: Number(row?.manualCount ?? 0),
  };
}

/**
 * خيارات نموذج التسجيل اليدوي وفلتر السجلّ: **كل** من على رأس العمل.
 *
 * كانت مقصورةً على الساعيّ من عهدٍ كان الحضور فيه يخصّه وحده. بعد «الأجر بالحضور» (0138+)
 * صار حضورُ **الشهريّ** أساسَ راتبه أيضاً — وفي منشأةٍ كلُّ موظفيها شهريّون كانت القائمة
 * تظهر **فارغة**: لا إدخال يدويّ ليومٍ فات، ولا فلترة بموظف. المُعفى يبقى مُدرَجاً (قد
 * يُسجَّل حضورُه للاطّلاع) وأجرُه ثابتٌ لا يتأثّر.
 */
export async function formOptions() {
  const db = requireDb();
  const rows = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      payType: employees.payType,
    })
    .from(employees)
    .where(eq(employees.employmentStatus, "active"))
    .orderBy(employees.firstName);
  return rows.map((e) => ({ id: e.id, name: fullEmployeeName(e), payType: e.payType }));
}

/* ─────────────────── إعدادات احتساب الحضور (صفّ مفرد) ─────────────────── */

/** يقرأ الإعدادات ويُنشئ الصفّ المفرد بقيمه الافتراضية عند غيابه (لا حالة ضمنية). */
export async function getAttendanceSettings() {
  const db = requireDb();
  const [row] = await db.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
  if (row) return row;
  // الافتراضي يطابق شكل الصفّ حرفياً (لا اتحاد أنواع في الواجهة) — الوحدة معطَّلة بالكامل.
  return {
    id: 1,
    attendancePayEnabled: false,
    attendancePayFrom: null as string | null,
    maxDailyHours: "12.00",
    updatedBy: null as number | null,
    updatedAt: new Date(),
  };
}

/**
 * تحديث إعدادات الاحتساب. تغيير الوردية الليلية **لا يعيد حساب الماضي** — الأيام
 * المطويّة تبقى كما هي؛ ما يصل بعد التغيير يُحتسب بالسياسة الجديدة (وأيّ يوم يُعاد
 * طيّه بوصول بصمة متأخرة يُعاد حسابه كاملاً بها). عدم إعادة الحساب مقصود: مسيّرات
 * سابقة قد تكون بُنيت على الأرقام القديمة.
 */
export async function updateAttendanceSettings(
  input: {
    attendancePayEnabled?: boolean;
    attendancePayFrom?: string | null;
    maxDailyHours?: number;
  },
  actorUserId: number,
) {
  // تاريخ السريان شرطُ تفعيل: بدونه يُحتسب الغياب بأثرٍ رجعيّ على أشهرٍ بلا بيانات حضور
  // أصلاً (ما قبل تشغيل الجهاز) فتُصفَّر رواتبها. الحارس بنيويّ لا تذكيرٌ في الواجهة.
  if (input.attendancePayEnabled && !input.attendancePayFrom) {
    throw new Error("حدّد «يسري من تاريخ» قبل تفعيل الأجر بالحضور — بدونه تُحتسب أشهرٌ سابقة بلا بيانات حضور غياباً كاملاً.");
  }
  const patch = {
    ...(input.attendancePayEnabled !== undefined ? { attendancePayEnabled: input.attendancePayEnabled } : {}),
    ...(input.attendancePayFrom !== undefined ? { attendancePayFrom: input.attendancePayFrom || null } : {}),
    ...(input.maxDailyHours !== undefined ? { maxDailyHours: String(input.maxDailyHours) } : {}),
    updatedBy: actorUserId,
  };
  return withTx(async (tx) => {
    await tx
      .insert(hrAttendanceSettings)
      .values({ id: 1, ...patch })
      .onDuplicateKeyUpdate({ set: patch });
    const [row] = await tx.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
    return row!;
  });
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
  /** يومٌ ينقصه إغلاق — يضعه الطيّ التلقائي. الإدخال/التصحيح اليدوي يُطفئه دائماً. */
  needsReview?: boolean;
  reviewReason?: string | null;
  /** فاعل الإدخال اليدوي — لفرض «لا يسجّل أحدٌ ساعات نفسه». الطيّ التلقائي يمرّره null. */
  actor?: { userId: number; role: string } | null;
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
    /*
     * فصل مهام على الإدخال اليدوي: ساعاتُ الموظف الساعيّ تتحوّل أجراً مباشرةً
     * (amount = hours × سعر الساعة)، فتسجيلُ المرء ساعاتِ نفسه مسارُ زيادةِ أجرٍ بفاعلٍ واحد.
     * الطيّ التلقائي من الجهاز لا يمرّر actor (لا فاعل بشريّ) فلا يتأثّر. admin مُستثنى للتصحيح الإداري.
     */
    if (input.actor && input.actor.role !== "admin" && emp.userId != null && Number(emp.userId) === Number(input.actor.userId)) {
      throw new Error("لا تسجّل حضور نفسك — يلزم أن يُدخِله مستخدمٌ آخر (فصل المهام).");
    }
    // حارس المسيّر المُقفَل (تدقيق ١٧/٧): لا تسجيل/تعديل حضور لشهرٍ مسيّرُه معتمد/مدفوع — الحضور
    // أساسُ حساب المسيّر (ساعات/غياب/إجازة)، وتغييره بعد الاعتماد يُفسد مسيّراً مُلتزَماً مالياً
    // (المدفوع قُيّد PAYMENT_OUT فعلاً). التصحيح يمرّ بإلغاء اعتماد المسيّر أولاً (revertRun).
    const period = String(input.attendanceDate).slice(0, 7); // YYYY-MM
    const [lockedRun] = await tx
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["approved", "paid"])))
      .limit(1);
    if (lockedRun) {
      throw new Error(
        `لا يمكن تسجيل الحضور: مسيّر رواتب شهر ${period} ${lockedRun.status === "paid" ? "مدفوع" : "معتمَد"} — ألغِ اعتماد المسيّر أولاً للتعديل`,
      );
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
      // التصحيح اليدوي هو الحسم: مديرٌ أدخل اليوم صراحةً ⇒ لم يعد ناقصاً مهما قال الطيّ.
      needsReview: (input.source ?? "manual") === "manual" ? false : !!input.needsReview,
      reviewReason: (input.source ?? "manual") === "manual" ? null : input.reviewReason?.slice(0, 120) ?? null,
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

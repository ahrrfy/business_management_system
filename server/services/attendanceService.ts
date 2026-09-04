/* ============================================================================
 * خدمة الحضور والانصراف — وحدة الموارد البشرية (server/services/attendanceService.ts)
 * نظام الساعات: أجر اليوم = ساعات الحضور × سعر ساعة ذلك اليوم (من جدول أيام الموظف
 * أو الجدول الافتراضي للشركة). كل تسجيل/تعديل ذرّي (withTx) بصيغة UPSERT على
 * (employeeId, attendanceDate). المبالغ عبر money.ts (toDbMoney) — لا parseFloat.
 * القراءة hr/READ والكتابة hr/FULL (تُفرض في الموجّه).
 * ========================================================================== */
import { and, desc, eq, getTableColumns, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";
import { WEEK_DAYS, fullEmployeeName } from "@shared/hr";
import { attendanceHoursViolation } from "@shared/attendanceHours";
import { attendance, employees, hrAttendanceSettings, payrollRuns } from "../../drizzle/schema";
import { escLike } from "../lib/sqlLike";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { money, round2, toDbMoney } from "./money";
import { assertPeriodOpen } from "./periodLockService";
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
  /**
   * عزل الفرع (قرار المالك ١٢/٨): `null` = يعبُر كلَّ الفروع (أدمن/مالك)، ورقمٌ = مقيَّدٌ
   * بفرعه المُسنَد. يُحقَن من `ctx.scopedBranchId` في الموجّه، ولا تشتقّه الخدمة من `ctx`.
   *
   * كانت الوحدة كلُّها بلا أيّ حاجز فرعٍ — لا قراءةً ولا كتابةً (صفر إشارة إلى `branchId` في
   * هذا الملف) — فمدير فرعٍ يقرأ رواتب موظفي الفرع الآخر ويكتب لهم حضوراً (تدقيق ١٧/٨).
   */
  scopedBranchId?: number | null;
  /** معرّف موظف بعينه. */
  employeeId?: number;
  /** الشهر بصيغة "YYYY-MM" — يُطابَق على attendanceDate بـ LIKE 'YYYY-MM%'. */
  period?: string;
  /**
   * مدى تواريخ "YYYY-MM-DD" (شاملُ الطرفين) — يتقدّم على `period` حين يُرسَل.
   * الشاشة تفتح على **اليوم** (from = to = اليوم) بقرار المالك: سجلّ اليوم هو ما يُراجَع
   * صباحاً، وفتحُ الشهر كاملاً كان يُغرق الصفحة بصفوفٍ لا تخصّ اللحظة.
   */
  dateFrom?: string;
  dateTo?: string;
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
  // عزل الفرع أوّلاً: كل استعلامات هذا الملف تصل الحضورَ بالموظف، وفرعُ الموظف هو الحاجز.
  if (filters?.scopedBranchId != null) conds.push(eq(employees.branchId, filters.scopedBranchId));
  if (filters?.employeeId) conds.push(eq(attendance.employeeId, filters.employeeId));
  // المدى يتقدّم على الشهر (وقد يُرسَلان معاً من شاشةٍ قديمة) — ولا يُجمَعان فيتضاربا.
  if (filters?.dateFrom || filters?.dateTo) {
    if (filters.dateFrom) conds.push(gte(attendance.attendanceDate, filters.dateFrom));
    if (filters.dateTo) conds.push(lte(attendance.attendanceDate, filters.dateTo));
  } else if (filters?.period) {
    conds.push(like(attendance.attendanceDate, `${filters.period}%`));
  }
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

/** الأشهر التي أُقفلت مسيّراتها (معتمَد/مدفوع) — لقطتُها المخزَّنة هي حقيقةُ الصرف. */
async function lockedPeriods(db: ReturnType<typeof requireDb>): Promise<Set<string>> {
  const rows = await db
    .select({ period: payrollRuns.period })
    .from(payrollRuns)
    .where(inArray(payrollRuns.status, ["approved", "paid"]));
  return new Set(rows.map((r) => String(r.period).slice(0, 7)));
}

type RateRow = {
  attendanceDate: unknown;
  hours?: string | null;
  hourlyRate?: string | null;
  amount?: string | null;
  status?: string | null;
  payType?: string | null;
  salary?: unknown;
  workSchedule?: unknown;
  dayRates?: unknown;
};

/**
 * قيم الصفّ المعروضة — **مُشتقّةً من ملفّ الموظف الآن** لا من اللقطة المخزَّنة (١/٨).
 *
 * اللقطة تُكتب لحظةَ طيّ البصمة أو الإدخال — أي **قبل** أن يضبط المالك جدولَ الموظف غالباً —
 * ولا يُعيد أحدٌ اشتقاقها: عدَّل بطاقةَ الموظف كما شئتَ، يبقى الصفّ على رقمه القديم أبداً.
 * وللشهريّ اللقطةُ **ليست ما يُدفع أصلاً** (المسيّر يعيد الحساب من `computeAttendancePay`).
 * نُبقي `storedHourlyRate/storedAmount` ونَسِم المختلف بـ`rateStale` ليُعاد احتسابه.
 *
 * ⚠️ استثناءان يحفظان الصدق:
 *  • **شهرٌ مسيّرُه مُقفَل** (Codex P1): لقطتُه هي ما صُرف فعلاً ⇒ تبقى هي المعروضة. عرضُ
 *    سعر اليوم على شهرٍ مضى ودُفع إعادةُ كتابةٍ للتاريخ، وزرُّ الإصلاح مرفوضٌ عليه أصلاً.
 *  • **ABSENT/LEAVE بلا أجر** (Codex P2): صفٌّ بساعاتٍ موجبة وحالةِ غياب لا يُعرَض كاسبَ
 *    أجرٍ — المسيّر يستبعده وإعادةُ الاحتساب تُصفّره، فليقُل العرضُ ما يقوله الدفع.
 */
function deriveRow(r: RateRow, locked: Set<string>) {
  const dateStr = toDateStr(r.attendanceDate);
  const { rate, basis } = rateForDayDetailed(r, dateStr);
  const hours = money(r.hours ?? 0);
  const stored = money(r.hourlyRate ?? 0);
  const storedAmount = money(r.amount ?? 0);
  const periodLocked = locked.has(dateStr.slice(0, 7));
  // السعر الخام (بلا تقريب) هو ما يضربه `recordAttendance` في الساعات — تقريبُه قبل الضرب
  // كان يُنتج فرقَ دينارٍ عند الحدود فيبدو الصفّ سليماً ورقمُه مخالفاً (Codex P2).
  const liveRate = round2(money(rate));
  const paid = r.status === "PRESENT" || r.status === "LATE";
  const liveAmount = paid ? round2(hours.times(money(rate))).toDecimalPlaces(0) : money(0);
  const showRate = periodLocked ? stored : liveRate;
  const showAmount = periodLocked ? storedAmount : liveAmount;
  return {
    attendanceDate: dateStr,
    dayName: dateStr ? arabicDayName(dateStr) : "",
    storedHourlyRate: toDbMoney(stored),
    storedAmount: toDbMoney(storedAmount),
    hourlyRate: toDbMoney(showRate),
    amount: toDbMoney(showAmount),
    rateBasis: basis,
    /** لقطةٌ تخالف ملفّ الموظف ⇒ تحتاج إعادة احتساب. مقفولُ الشهر لا يُوسَم (لا يُصلَح). */
    rateStale: !periodLocked && (!stored.eq(liveRate) || !storedAmount.eq(liveAmount)),
    periodLocked,
  };
}

/** سقف مسح الاشتقاق الحيّ — يُعلَن حين يُبلَغ فلا يُزعَم رقمٌ ناقصٌ رقماً كاملاً. */
const SCAN_CAP = 20_000;

/** أعمدة الاشتقاق الحيّ (خفيفة) — يتقاسمها مسحُ المجاميع ومسحُ اللقطات القديمة. */
const scanCols = {
  attendanceDate: attendance.attendanceDate,
  hours: attendance.hours,
  hourlyRate: attendance.hourlyRate,
  amount: attendance.amount,
  status: attendance.status,
  source: attendance.source,
  payType: employees.payType,
  salary: employees.salary,
  workSchedule: employees.workSchedule,
  dayRates: employees.dayRates,
} as const;

/** الأشهر التي يغطّيها المدى (سقف ٢٤ شهراً) — نطاقُ زرّ الإصلاح قد يتعدّد بتعدّدها. */
function monthsInRange(from?: string, to?: string): string[] {
  const a = String(from ?? to ?? "").slice(0, 7);
  const b = String(to ?? from ?? "").slice(0, 7);
  if (!a || !b) return [];
  const out: string[] = [];
  let [y, m] = a.split("-").map(Number);
  for (let i = 0; i < 24; i++) {
    const cur = `${y}-${String(m).padStart(2, "0")}`;
    out.push(cur);
    if (cur >= b) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * مجاميع **حيّة** لنطاقٍ من الفلتر — لا `SUM(amount)` المخزَّن.
 *
 * ذيلُ الجدول وبطاقةُ «المبلغ المستحقّ» كانا يجمعان اللقطات بينما الصفوف تعرض المُشتقّ من
 * ملفّ الموظف ⇒ صفٌّ واحدٌ بـ١٣٬٣٣٥ تحته إجماليٌّ ٤٢٬٠٠٠. وهو عينُ ما اشتكى منه المالك:
 * «الجدول مضلِّل». فليقُل كلُّ رقمٍ على الشاشة ما سيُدفع فعلاً.
 */
async function liveTotals(db: ReturnType<typeof requireDb>, where: SQL | undefined, locked: Set<string>) {
  const rows = await db
    .select(scanCols)
    .from(attendance)
    .leftJoin(employees, eq(attendance.employeeId, employees.id))
    .where(where)
    .limit(SCAN_CAP);
  let hours = money(0);
  let amount = money(0);
  let fingerprintCount = 0;
  let manualCount = 0;
  for (const r of rows) {
    hours = hours.plus(money(r.hours ?? 0));
    amount = amount.plus(money(deriveRow(r, locked).amount));
    if (r.source === "fingerprint") fingerprintCount += 1;
    else manualCount += 1;
  }
  // العدّادان من **نفس** المسح لا من استعلامٍ ثانٍ (Codex P2): كانا لقطتين زمنيتين مختلفتين
  // أثناء مزامنة البصمات، فتُعرَض عدّاداتُ مجموعةٍ فوق مبالغِ مجموعةٍ أخرى.
  return {
    hours: toDbMoney(hours),
    amount: toDbMoney(amount),
    fingerprintCount,
    manualCount,
    capped: rows.length >= SCAN_CAP,
  };
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

  // الإجمالي (للترقيم) بـCOUNT خادميّ؛ والمجاميع المعروضة **حيّة** لا مجموعَ اللقطات.
  const agg = (
    await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(attendance)
      .leftJoin(employees, eq(attendance.employeeId, employees.id))
      .where(where)
  )[0];

  const locked = await lockedPeriods(db);
  const totals = await liveTotals(db, where, locked);
  const mapped = rows.map((r) => ({
    ...r,
    ...deriveRow(r, locked),
    employeeName: fullEmployeeName(r),
  }));

  /*
   * عدّ اللقطات القديمة على **نطاق زرّ الإصلاح** لا على الصفحة ولا على المدى المعروض:
   *  • على الصفحة (Codex P1): صفحةٌ حديثةٌ نظيفة ⇒ صفرٌ ⇒ يختفي الزرّ وتبقى صفحاتٌ أقدم منحرفة.
   *  • على المدى المعروض: الشاشة تفتح على **اليوم**، والزرُّ يُصلح **الشهر** ⇒ يخفى عن المالك
   *    أنّ في شهره صفوفاً تحتاج إصلاحاً لمجرّد أنه ينظر إلى يومٍ نظيف.
   * فالمسح على الشهر المستهدَف (وموظفِه إن فُلتِر) — تماماً ما ستفعله `recomputeMonthRates`.
   */
  const periods = filters?.dateFrom || filters?.dateTo
    ? monthsInRange(filters.dateFrom, filters.dateTo)
    : filters?.period
      ? [filters.period]
      : [];
  const scanConds: SQL[] = [];
  // عزل الفرع هنا أيضاً: هذا مسارُ شروطٍ **ثانٍ** يبني نفسه ولا يمرّ بـbuildAttendanceConds،
  // فبدونه كان عدّاد «اللقطات القديمة» وأشهرُها يعدّان صفوف الشركة كلّها لمدير فرعٍ واحد.
  if (filters?.scopedBranchId != null) scanConds.push(eq(employees.branchId, filters.scopedBranchId));
  if (periods.length) {
    // **كلّ** شهرٍ يمثّله المدى لا شهرَ نهايته وحده (Codex P2): «آخر ٧ أيام» في مطلع الشهر
    // يعبر شهرين، فقصرُ المسح على الأخير كان يُظهر صفوفاً مشطوبةً وعدّاداً صفراً ⇒ يختفي الزرّ.
    scanConds.push(or(...periods.map((p) => like(attendance.attendanceDate, `${p}%`)))!);
  }
  if (filters?.employeeId) scanConds.push(eq(attendance.employeeId, filters.employeeId));
  const scan = await db
    .select(scanCols)
    .from(attendance)
    .leftJoin(employees, eq(attendance.employeeId, employees.id))
    .where(scanConds.length ? and(...scanConds) : where)
    .limit(SCAN_CAP);
  const staleRows = scan.filter((r) => deriveRow(r, locked).rateStale);

  return {
    rows: mapped,
    total: Number(agg?.count ?? 0),
    // مجاميع **كل المطابق** (لا الصفحة) بالقيم الحيّة ⇒ الذيل يطابق الأعمدة دائماً.
    // `capped` تُعلَن في الشاشة: مجاميعُ جزئية تُعرَض جزئيةً لا رقماً نهائياً كاذباً.
    totals: { hours: totals.hours, amount: totals.amount, capped: totals.capped },
    staleCount: staleRows.length,
    /** الأشهر التي تحتاج إعادة احتساب فعلاً — الزرّ يمرّ عليها جميعاً. */
    stalePeriods: Array.from(new Set(staleRows.map((r) => toDateStr(r.attendanceDate).slice(0, 7)))).sort(),
    /** بلغ المسحُ سقفَه ⇒ قد تكون هناك لقطاتٌ قديمة غير معدودة (لا نزعم صفراً كاذباً). */
    staleScanCapped: scan.length >= SCAN_CAP,
  };
}

/**
 * إعادة احتساب أسعار الساعة وأجور الأيام لشهرٍ كامل من **ملفّات الموظفين الحالية**.
 *
 * تُصلح اللقطات القديمة (سعرٌ كُتب قبل ضبط جدول الموظف، أو بعد تعديل راتبه)، وهي
 * ضروريةٌ لا تجميلية: لقطة **الساعيّ** هي وعاءُ أجره في المسيّر فعلاً.
 *
 * محروسة بثلاثة (Codex P1):
 *  ١) **أيّ مسيّر** للشهر يمنعها — لا المعتمَد/المدفوع وحده. بنودُ المسودّة بُنيت من المبالغ
 *     القديمة و`approveRun` يعتمدها كما هي لا يعيد توليدها، فإصلاحُ الحضور تحتها كان
 *     يُنتج «نجاحاً» ظاهرياً ثمّ يُصرف بالسعر القديم. تُحذف المسودّة ويُعاد توليدها.
 *  ٢) **فصل مهام**: لا يُعيد أحدٌ احتساب أجر نفسه. سعرُ الساعة/الجدول قابلٌ للتعديل من
 *     بطاقة الموظف (حارس الأجر يحرس الراتب والبدلات لا هذين)، فكان المسارُ المركَّب
 *     «ارفع سعر ساعتك ثمّ أعد الاحتساب» زيادةَ أجرٍ بفاعلٍ واحد. admin مُستثنى للتصحيح.
 *  ٣) ABSENT/LEAVE تبقى بأجرٍ صفريّ مهما كان السعر.
 */
export async function recomputeMonthRates(input: {
  period: string;
  employeeId?: number;
  actor?: { userId: number; role: string };
  /** عزل الفرع: إعادة التسعير تمسّ صفوفاً ومبالغ ⇒ تُقصَر على فرع الفاعل المُسنَد. */
  scopedBranchId?: number | null;
}) {
  const period = String(input.period).slice(0, 7);
  return withTx(async (tx) => {
    const [run] = await tx
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(eq(payrollRuns.period, period))
      .limit(1);
    if (run) {
      const label = run.status === "paid" ? "مدفوع" : run.status === "approved" ? "معتمَد" : "مسودّة";
      throw new Error(
        run.status === "draft"
          ? `لا يمكن إعادة الاحتساب: يوجد مسيّر رواتب (مسودّة) لشهر ${period} بُنيت بنوده على المبالغ الحالية — احذف المسودّة، أعد الاحتساب، ثمّ ولّد المسيّر من جديد`
          : `لا يمكن إعادة الاحتساب: مسيّر رواتب شهر ${period} ${label} — ألغِ اعتماد المسيّر أولاً`,
      );
    }
    // حارس إقفال الفترة المالية العامّة — راجع الشرح المطابق في recordAttendance أعلاه.
    await assertPeriodOpen(tx, new Date(`${period}-01`));

    const conds: SQL[] = [like(attendance.attendanceDate, `${period}%`)];
    // عزل الفرع: إعادة تسعير شهرٍ كامل تُعيد كتابة `hourlyRate`/`amount` لكل صفٍّ مطابق —
    // بلا هذا الحاجز كان مديرُ فرعٍ يُعيد تسعير موظفي الشركة كلِّها بضغطة (تدقيق ١٧/٨).
    if (input.scopedBranchId != null) conds.push(eq(employees.branchId, input.scopedBranchId));
    if (input.employeeId) conds.push(eq(attendance.employeeId, input.employeeId));
    const rows = await tx
      .select({
        id: attendance.id,
        attendanceDate: attendance.attendanceDate,
        hours: attendance.hours,
        hourlyRate: attendance.hourlyRate,
        amount: attendance.amount,
        status: attendance.status,
        employeeUserId: employees.userId,
        payType: employees.payType,
        salary: employees.salary,
        workSchedule: employees.workSchedule,
        dayRates: employees.dayRates,
      })
      .from(attendance)
      .leftJoin(employees, eq(attendance.employeeId, employees.id))
      .where(and(...conds));

    // فصل المهام: صفٌّ واحدٌ يخصّ الفاعل نفسه يُبطل العملية كلَّها (لا تصفيةٌ صامتة).
    if (input.actor && input.actor.role !== "admin") {
      const own = rows.some((r) => r.employeeUserId != null && Number(r.employeeUserId) === Number(input.actor!.userId));
      if (own) {
        throw new Error("لا تُعِد احتساب أجر نفسك — يلزم أن يُنفّذها مستخدمٌ آخر (فصل المهام).");
      }
    }

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
  // «المبلغ المستحقّ» بالقيم الحيّة كالجدول تماماً — مجموعُ اللقطات كان يعرض ٤٢٬٠٠٠ فوق
  // صفوفٍ مجموعُها ١٣٬٣٣٥، وهو عينُ «الجدول مضلِّل» الذي شكاه المالك.
  // ومسحٌ **واحد** يُخرج المبالغ والعدّادات معاً ⇒ لقطةٌ زمنية واحدة لا اثنتان.
  const totals = await liveTotals(db, where, await lockedPeriods(db));
  return {
    hours: totals.hours,
    amount: totals.amount,
    capped: totals.capped,
    fingerprintCount: totals.fingerprintCount,
    manualCount: totals.manualCount,
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
export async function formOptions(scopedBranchId?: number | null) {
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
    // عزل الفرع: القائمة تغذّي فلتر السجلّ **ونموذج التسجيل اليدوي** ⇒ تسريبُها هنا
    // يمنح مديرَ فرعٍ معرّفاتِ موظفي غيره فيكتب لهم حضوراً (قرار المالك ١٢/٨).
    .where(
      and(
        eq(employees.employmentStatus, "active"),
        scopedBranchId != null ? eq(employees.branchId, scopedBranchId) : undefined,
      ),
    )
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
    nightShiftEnabled: false,
    nightShiftCutoffHour: 8,
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
    nightShiftEnabled?: boolean;
    nightShiftCutoffHour?: number;
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
    ...(input.nightShiftEnabled !== undefined ? { nightShiftEnabled: input.nightShiftEnabled } : {}),
    ...(input.nightShiftCutoffHour !== undefined ? { nightShiftCutoffHour: input.nightShiftCutoffHour } : {}),
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
  /** عزل الفرع: رقمٌ = يُرفَض موظفُ فرعٍ آخر؛ null/غياب = عبورٌ (أدمن/مالك أو الطيّ التلقائي). */
  scopedBranchId?: number | null;
  /**
   * تاريخ **الانصراف** حين يخالف تاريخ الوردية (وردية ليلية عابرة منتصف الليل).
   * غيابه = تاريخ الحضور نفسه (السلوك السابق حرفياً). يمرّره الطيّ وحده؛ الإدخال اليدوي لا
   * يمرّره ⇒ يبقى حارسُ «الانصراف بعد الدخول» صارماً على البشر ولا يفتح باب خطأٍ صامت.
   */
  checkOutDate?: string | null;
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
    /*
     * عزل الفرع على **الكتابة** (قرار المالك ١٢/٨، تدقيق ١٧/٨): ساعات الحضور تتحوّل أجراً
     * مباشرةً، فتسجيلُ مدير فرعٍ حضوراً لموظف فرعٍ آخر كتابةُ مالٍ خارج سلطته. كانت الوحدة
     * بلا أيّ حاجز فرع، فيكفي معرّفُ موظفٍ من الفرع الآخر (تُسرّبه formOptions) لكتابة أجره.
     * الطيّ التلقائي من الجهاز لا يمرّر scopedBranchId (لا فاعل بشريّ) فلا يتأثّر.
     */
    if (input.scopedBranchId != null && Number(emp.branchId) !== Number(input.scopedBranchId)) {
      throw new Error("لا يمكن تسجيل حضور لموظف من فرعٍ آخر");
    }
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
    /*
     * حارس إقفال الفترة المالية العامّة (تدقيق ٤/٩، مطابقةً لنمط inventoryService.ts/H5):
     * الحارس أعلاه يمنع فقط حين يوجد مسيّر رواتب معتمد/مدفوع لنفس الشهر — لا يستشير
     * financialPeriods إطلاقاً. فترةٌ أُقفلت محاسبياً بلا أن يُولَّد لها مسيّر رواتب قطّ (موظّفٌ
     * أُضيف متأخراً، مسيّرٌ أُعيد للمسودّة ولم يُعَد توليده…) تبقى قابلةً للتعديل/التأريخ الرجعيّ
     * إلى الأبد رغم أنّ بقيّة الدفتر تعاملها مُقفلة نهائياً — يُفسد أساس تقاريرَ سابقة بصمت.
     */
    await assertPeriodOpen(tx, new Date(input.attendanceDate));

    const hoursDec = money(input.hours);
    if (hoursDec.isNegative()) throw new Error("الساعات لا يمكن أن تكون سالبة");

    const status = input.status ?? "PRESENT";
    // ABSENT/LEAVE لا يولّدان أجراً مهما كانت الساعات. التصفير المزدوج (هنا + WHERE في تجميع المسيّر)
    // يحمي حتى عند تعديل صفّ موجود أو إدخال مباشر بـAPI يضع status=ABSENT مع ساعات (سهو/استيراد بصمة).
    const isPaidStatus = status === "PRESENT" || status === "LATE";

    /*
     * حارس اتّساق الساعات مع الأوقات (تدقيق ١٧/٨) — النواة النقيّة في `shared/attendanceHours.ts`
     * ليُنفّذها الخادم وتُرشد بها الواجهة بالنصّ نفسه.
     *
     * الطيّ التلقائي يمرّ بلا مساس: مجموع فتراته المزاوَجة ≤ المدى حتماً (فالحارس لا يفرض
     * المساواة)، وlastPairedOut لا يُضبط إلا باكتمال زوجٍ ⇒ ساعاته > 0، وpunchTimesOf يجلب
     * بصمات اليوم نفسه فقط ⇒ الانصراف بعد الدخول دائماً.
     */
    const hoursViolation = attendanceHoursViolation({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      hours: hoursDec.toNumber(),
      isPaidStatus,
    });
    if (hoursViolation) throw new Error(hoursViolation);

    const checkInAt = timeToTimestamp(input.attendanceDate, input.checkIn);
    const checkOutAt = timeToTimestamp(input.checkOutDate || input.attendanceDate, input.checkOut);
    const effectiveHours = isPaidStatus ? hoursDec : money(0);
    const rate = rateForDay(emp, input.attendanceDate);
    // الأجر بالدينار الصحيح (لا فئات أصغر من الدينار في المتجر): تقريب الناتج إلى عدد صحيح.
    // toDecimalPlaces(0) يستعمل سياسة التقريب العامّة المثبّتة في money.ts (HALF_UP).
    const amount = round2(effectiveHours.times(rate)).toDecimalPlaces(0);

    const values = {
      employeeId: input.employeeId,
      attendanceDate: input.attendanceDate,
      checkIn: checkInAt,
      checkOut: checkOutAt,
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
export async function monthSummary(period: string, scopedBranchId?: number | null) {
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
    .where(
      and(
        eq(employees.employmentStatus, "active"),
        eq(employees.payType, "hourly"),
        scopedBranchId != null ? eq(employees.branchId, scopedBranchId) : undefined,
      ),
    )
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

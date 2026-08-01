/* ============================================================================
 * الأجر بالحضور — نواة نقيّة (server/services/hr/attendancePay.ts)
 *
 * قرار المالك (٣١ يوليو ٢٠٢٦): «الموظف الذي يحضر هو الذي له احتساب راتب، والذي غاب
 * يوماً فلا راتب له في هذا الغياب»، و**الاحتساب بالساعات**:
 *
 *     سعر ساعة الموظف الشهريّ = راتبه ÷ ساعات دوامه في الشهر
 *     أجرُه                    = ساعات حضوره الفعلية × ذلك السعر
 *
 * وساعات دوامه في الشهر = **مجموع ساعات كل يومٍ وفق جدوله الأسبوعيّ**، لا (عدد الأيام ×
 * رقم ثابت). الجدول يُعطي لكل يومٍ ساعاته و**صفرُ الساعات راحة** — فالمفهومان واحد:
 *   {"الأحد":8,…,"الخميس":8,"الجمعة":4,"السبت":0}
 * وهذا ما تطلّبه واقع المالك: «الجمعة لدينا دوام لساعات نحن نحدّدها» — يومُ دوامٍ قصير
 * لا راحةٌ ولا يومٌ كامل. والجداول **تختلف بين الموظفين** ⇒ لكلٍّ جدولُه، وبدون ذلك كان
 * التفعيل يخصم أيام العطل من الجميع.
 *
 * الإجازة ثلاثة أنواع: **مدفوعة** (تُحتسب ساعات دوامٍ كاملة)، **بلا راتب** (لا تُحتسب)،
 * و**من الرصيد** (مدفوعة تستهلك رصيداً — يخصّها leaveService).
 *
 * ⚠️ تاريخ السريان حاسم: قبل تشغيل جهاز الحضور لا توجد بيانات أصلاً، فأيّ يومٍ قبل
 * `payFrom` يُعامَل **مدفوعاً كاملاً** لا غياباً — وإلا صُفّرت رواتب أشهرٍ ماضية.
 *
 * النواة نقيّة (بلا قاعدة بيانات ولا تواريخ نظام) ⇒ قابلة للاختبار وحدها وحتميّة.
 * ========================================================================== */
import Decimal from "decimal.js";
import { round2 } from "../money";

/** أسماء الأيام العربية بترتيب getUTCDay (الأحد=0) — مطابقة لـWEEK_DAYS في @shared/hr. */
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;

/** اسم اليوم العربي من "YYYY-MM-DD" بتقويم UTC ثابت (مستقلّ عن منطقة الخادم). */
export function dayNameOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** كل الأيام بين تاريخين شاملةً الطرفين. يُعيد [] إن كان المدى مقلوباً. */
export function daysBetween(from: string, to: string): string[] {
  if (to < from) return [];
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** جدول الدوام الأسبوعيّ: ساعات كل يوم بالاسم العربيّ. صفر (أو غياب المفتاح) = راحة. */
export type WorkSchedule = Record<string, number>;

/** الجدول الافتراضي حين لا يُضبط شيء: خمسة أيام بثمانٍ، والجمعة والسبت راحة. */
export const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
  الأحد: 8, الاثنين: 8, الثلاثاء: 8, الأربعاء: 8, الخميس: 8, الجمعة: 0, السبت: 8,
};

/** ساعات يومٍ بعينه وفق الجدول (صفر = راحة، وغير الرقم الموجب يُعامَل صفراً). */
export function hoursForDay(schedule: WorkSchedule, ymd: string): Decimal {
  const v = schedule[dayNameOf(ymd)];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Decimal(v) : new Decimal(0);
}

export interface AttendancePayInput {
  /** الراتب الأساس الشهريّ. */
  salary: Decimal;
  /** نافذة عمل الموظف داخل الشهر (تُقصّ بالتعيين/الفصل قبل الاستدعاء). */
  employmentStart: string;
  employmentEnd: string;
  /**
   * جدول الدوام الأسبوعيّ لهذا الموظف — ساعات كل يوم، وصفرٌ = راحة.
   * حلّ محلّ (أيام الراحة + ساعة يومية واحدة): الجمعة قد تكون **يوم دوامٍ بساعاتٍ أقلّ**
   * لا راحةً ولا يوماً كاملاً، وهو ما لم يستطع النموذج السابق تمثيله.
   */
  schedule: WorkSchedule;
  /** ساعات الحضور الفعلية لكل يوم (من سجل الحضور). الأيام الغائبة ببساطة غير موجودة. */
  attendedHoursByDate: Map<string, Decimal>;
  /** أيام إجازة **مدفوعة** معتمدة (تُحتسب ساعات دوامٍ كاملة). */
  paidLeaveDates: Set<string>;
  /** أيام إجازة **بلا راتب** معتمدة (لا تُحتسب — وهي الخصم المقصود). */
  unpaidLeaveDates: Set<string>;
  /** تاريخ سريان الأجر بالحضور — ما قبله يُعامَل مدفوعاً كاملاً. null = بلا سريان (الكل مدفوع). */
  payFrom: string | null;
}

export interface AttendancePayResult {
  /** ساعات الدوام المقرَّرة في نافذة العمل = مجموع ساعات كل يومٍ وفق الجدول (مقام سعر الساعة). */
  scheduledHours: string;
  /** الساعات المستحقّة الأجر (حضورٌ فعليّ + إجازة مدفوعة + ما قبل السريان). */
  payableHours: string;
  /** ساعات غير مستحقّة (غياب + إجازة بلا راتب) — الفارق الذي يُخصَم فعلياً. */
  unpaidHours: string;
  /** سعر ساعة هذا الموظف = الراتب ÷ ساعات الدوام المقرَّرة. */
  hourlyRate: string;
  /** الأجر الأساس المستحقّ = سعر الساعة × الساعات المستحقّة. */
  basePay: string;
  /** تفصيل للشفافية في ملاحظة البند. */
  absentDays: number;
  unpaidLeaveDays: number;
  shortHours: string;
}

/**
 * يحسب أجر الشهريّ على أساس الحضور بالساعات.
 *
 * حدُّ يوم العمل: الساعات المحتسَبة في اليوم **لا تتجاوز** الساعات القياسية — الزيادة
 * عمل إضافيّ يُقرَّر في بند `overtime` المستقل، فلا تتضخّم الأجرة الأساس صامتةً ولا
 * يُحتسب الإضافيّ مرّتين.
 */
export function computeAttendancePay(input: AttendancePayInput): AttendancePayResult {
  // أيام الدوام = ما له ساعاتٌ موجبة في الجدول؛ وصفرُ الساعات راحةٌ لا تُطالَب ولا تُخصَم.
  const allDays = daysBetween(input.employmentStart, input.employmentEnd);
  const workDays = allDays.filter((d) => hoursForDay(input.schedule, d).gt(0));

  // المقام = مجموع ساعات الأيام لا (عددها × رقم ثابت) — فالجمعة القصيرة تُسهم بساعاتها هي.
  let scheduled = new Decimal(0);
  for (const d of workDays) scheduled = scheduled.plus(hoursForDay(input.schedule, d));

  let payable = new Decimal(0);
  let absentDays = 0;
  let unpaidLeaveDays = 0;
  let shortHours = new Decimal(0);

  for (const d of workDays) {
    const daily = hoursForDay(input.schedule, d);
    // ما قبل تاريخ السريان: لا بيانات حضور موثوقة ⇒ يُعامَل يوم دوامٍ كاملاً لا غياباً.
    if (input.payFrom == null || d < input.payFrom) {
      payable = payable.plus(daily);
      continue;
    }
    if (input.unpaidLeaveDates.has(d)) {
      unpaidLeaveDays += 1;
      continue; // لا أجر — وهو المقصود من «بلا راتب»
    }
    if (input.paidLeaveDates.has(d)) {
      payable = payable.plus(daily); // إجازة مدفوعة (أو من الرصيد) = يوم دوامٍ كامل
      continue;
    }
    const attended = input.attendedHoursByDate.get(d);
    if (attended == null || attended.lte(0)) {
      absentDays += 1;
      continue; // غياب — لا راتب لهذا اليوم
    }
    const counted = Decimal.min(attended, daily); // الزيادة عملٌ إضافيّ ببندٍ مستقلّ
    payable = payable.plus(counted);
    if (counted.lt(daily)) shortHours = shortHours.plus(daily.minus(counted));
  }

  const hourlyRate = scheduled.gt(0) ? input.salary.div(scheduled) : new Decimal(0);
  const basePay = round2(hourlyRate.times(payable));

  return {
    scheduledHours: scheduled.toFixed(2),
    payableHours: payable.toFixed(2),
    unpaidHours: scheduled.minus(payable).toFixed(2),
    hourlyRate: round2(hourlyRate).toFixed(2),
    basePay: basePay.toFixed(2),
    absentDays,
    unpaidLeaveDays,
    shortHours: shortHours.toFixed(2),
  };
}

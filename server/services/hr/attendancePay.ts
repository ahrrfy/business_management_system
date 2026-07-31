/* ============================================================================
 * الأجر بالحضور — نواة نقيّة (server/services/hr/attendancePay.ts)
 *
 * قرار المالك (٣١ يوليو ٢٠٢٦): «الموظف الذي يحضر هو الذي له احتساب راتب، والذي غاب
 * يوماً فلا راتب له في هذا الغياب»، و**الاحتساب بالساعات**:
 *
 *     سعر ساعة الموظف الشهريّ = راتبه ÷ ساعات دوامه في الشهر
 *     أجرُه                    = ساعات حضوره الفعلية × ذلك السعر
 *
 * وساعات دوامه في الشهر = (أيام الدوام، أي أيام الشهر عدا أيام راحته) × ساعات دوامه اليومية.
 * أيام الراحة **تختلف بين الموظفين** (قرار مالك) ⇒ لكلٍّ جدولُه؛ ويوم الراحة لا يُطالَب
 * بحضورٍ فيه ولا يُخصَم — وبدون ذلك كان التفعيل يخصم أربعة أيام شهرياً من الجميع.
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

export interface AttendancePayInput {
  /** الراتب الأساس الشهريّ. */
  salary: Decimal;
  /** نافذة عمل الموظف داخل الشهر (تُقصّ بالتعيين/الفصل قبل الاستدعاء). */
  employmentStart: string;
  employmentEnd: string;
  /** أيام الراحة الأسبوعية لهذا الموظف (أسماء عربية). */
  restDays: string[];
  /** ساعات الدوام القياسية اليومية. */
  dailyHours: Decimal;
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
  /** ساعات الدوام المقرَّرة في نافذة العمل = أيام الدوام × الساعات اليومية (مقام سعر الساعة). */
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
  const rest = new Set(input.restDays);
  const workDays = daysBetween(input.employmentStart, input.employmentEnd).filter((d) => !rest.has(dayNameOf(d)));

  const daily = input.dailyHours;
  const scheduled = daily.times(workDays.length);

  let payable = new Decimal(0);
  let absentDays = 0;
  let unpaidLeaveDays = 0;
  let shortHours = new Decimal(0);

  for (const d of workDays) {
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

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

/**
 * يومٌ في الجدول الأسبوعيّ: ساعاته المقرَّرة وسعر ساعته.
 * - `hours` صفر = **يوم راحة** (لا يُطالَب بحضور ولا يُخصَم).
 * - `rate` **سعر الساعة لهذا اليوم** — هو الأصل في الحساب (قرار المالك ٣١/٧):
 *   «سعر الساعة يختلف من موظف لآخر، والمجموع التراكميّ لأيام الشهر هو الراتب المستحقّ،
 *   وليس الشرط الموجود في حقل الراتب». تركه فارغاً ⇒ يُشتقّ من الراتب ÷ ساعات الشهر.
 */
export interface DaySchedule {
  hours: number;
  rate?: number | null;
}

/** جدول الدوام الأسبوعيّ: لكل يومٍ عربيٍّ ساعاتُه وسعرُ ساعته. */
export type WorkSchedule = Record<string, DaySchedule>;

/** الجدول الافتراضي: خمسة أيام بثمانٍ + السبت، والجمعة راحة، والسعر مُشتقّ من الراتب. */
export const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
  الأحد: { hours: 8 }, الاثنين: { hours: 8 }, الثلاثاء: { hours: 8 },
  الأربعاء: { hours: 8 }, الخميس: { hours: 8 }, الجمعة: { hours: 0 }, السبت: { hours: 8 },
};

/** قراءة متسامحة: تقبل الشكل القديم (رقمٌ = ساعات) والجديد ({hours,rate}). */
function dayOf(schedule: WorkSchedule, ymd: string): DaySchedule {
  const v = schedule[dayNameOf(ymd)] as DaySchedule | number | undefined;
  if (typeof v === "number") return { hours: Number.isFinite(v) && v > 0 ? v : 0 };
  if (v && typeof v === "object") return { hours: Number(v.hours) > 0 ? Number(v.hours) : 0, rate: v.rate };
  return { hours: 0 };
}

/** ساعات يومٍ بعينه وفق الجدول (صفر = راحة). */
export function hoursForDay(schedule: WorkSchedule, ymd: string): Decimal {
  return new Decimal(dayOf(schedule, ymd).hours);
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
  /** الأجر الأساس المستحقّ = مجموع (ساعات اليوم المحتسَبة × سعر ساعة ذلك اليوم). */
  basePay: string;
  /** ساعات تجاوزت المقرَّر اليوميّ ⇒ **أوفر تايم** ببندٍ مستقلّ (قرار المالك). */
  overtimeHours: string;
  /** أجر الأوفر تايم = مجموع (الساعات الزائدة × سعر ساعة يومها). */
  overtimePay: string;
  /** تفصيل للشفافية في ملاحظة البند. */
  absentDays: number;
  unpaidLeaveDays: number;
  shortHours: string;
  /** صفٌّ لكل يوم دوام — يغذّي كشف الحضور المطبوع (من ← إلى، الساعات، السعر، الأجر). */
  days: Array<{
    date: string;
    dayName: string;
    scheduledHours: string;
    attendedHours: string;
    countedHours: string;
    overtimeHours: string;
    rate: string;
    amount: string;
    state: "present" | "absent" | "paidLeave" | "unpaidLeave" | "beforeStart";
  }>;
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
  const workDays = daysBetween(input.employmentStart, input.employmentEnd).filter((d) =>
    hoursForDay(input.schedule, d).gt(0),
  );

  // مجموع ساعات الشهر المقرَّرة — مقامُ السعر المُشتقّ حين لا يُحدَّد سعرٌ صريح لليوم.
  let scheduled = new Decimal(0);
  for (const d of workDays) scheduled = scheduled.plus(hoursForDay(input.schedule, d));
  const derivedRate = scheduled.gt(0) ? input.salary.div(scheduled) : new Decimal(0);

  let payable = new Decimal(0);
  let basePay = new Decimal(0);
  let otHours = new Decimal(0);
  let otPay = new Decimal(0);
  let absentDays = 0;
  let unpaidLeaveDays = 0;
  let shortHours = new Decimal(0);
  const days: AttendancePayResult["days"] = [];

  for (const d of workDays) {
    const day = dayOf(input.schedule, d);
    const daily = new Decimal(day.hours);
    // سعر ساعة اليوم: الصريح أوّلاً (هو الأصل)، وإلا المُشتقّ من الراتب.
    const rate = day.rate != null && Number.isFinite(day.rate) && Number(day.rate) > 0 ? new Decimal(Number(day.rate)) : derivedRate;

    const push = (
      state: AttendancePayResult["days"][number]["state"],
      attended: Decimal,
      counted: Decimal,
      ot: Decimal,
      amount: Decimal,
    ) => {
      days.push({
        date: d,
        dayName: dayNameOf(d),
        scheduledHours: daily.toFixed(2),
        attendedHours: attended.toFixed(2),
        countedHours: counted.toFixed(2),
        overtimeHours: ot.toFixed(2),
        rate: round2(rate).toFixed(2),
        amount: round2(amount).toFixed(2),
        state,
      });
    };

    // ما قبل تاريخ السريان: لا بيانات حضور موثوقة ⇒ يُعامَل يوم دوامٍ كاملاً لا غياباً.
    if (input.payFrom == null || d < input.payFrom) {
      payable = payable.plus(daily);
      basePay = basePay.plus(rate.times(daily));
      push("beforeStart", daily, daily, new Decimal(0), rate.times(daily));
      continue;
    }
    if (input.unpaidLeaveDates.has(d)) {
      unpaidLeaveDays += 1;
      push("unpaidLeave", new Decimal(0), new Decimal(0), new Decimal(0), new Decimal(0));
      continue; // لا أجر — وهو المقصود من «بلا راتب»
    }
    if (input.paidLeaveDates.has(d)) {
      payable = payable.plus(daily);
      basePay = basePay.plus(rate.times(daily));
      push("paidLeave", new Decimal(0), daily, new Decimal(0), rate.times(daily));
      continue; // إجازة مدفوعة (أو من الرصيد) = يوم دوامٍ كامل
    }
    const attended = input.attendedHoursByDate.get(d) ?? new Decimal(0);
    if (attended.lte(0)) {
      absentDays += 1;
      push("absent", new Decimal(0), new Decimal(0), new Decimal(0), new Decimal(0));
      continue; // غياب — لا راتب لهذا اليوم
    }
    // الزائد عن المقرَّر أوفر تايم ببندٍ مستقلّ (قرار المالك) — لا يتضخّم به الأساس.
    const counted = Decimal.min(attended, daily);
    const ot = Decimal.max(0, attended.minus(daily));
    payable = payable.plus(counted);
    basePay = basePay.plus(rate.times(counted));
    otHours = otHours.plus(ot);
    otPay = otPay.plus(rate.times(ot));
    if (counted.lt(daily)) shortHours = shortHours.plus(daily.minus(counted));
    push("present", attended, counted, ot, rate.times(counted));
  }

  return {
    scheduledHours: scheduled.toFixed(2),
    payableHours: payable.toFixed(2),
    unpaidHours: scheduled.minus(payable).toFixed(2),
    hourlyRate: round2(derivedRate).toFixed(2),
    basePay: round2(basePay).toFixed(2),
    overtimeHours: otHours.toFixed(2),
    overtimePay: round2(otPay).toFixed(2),
    absentDays,
    unpaidLeaveDays,
    shortHours: shortHours.toFixed(2),
    days,
  };
}

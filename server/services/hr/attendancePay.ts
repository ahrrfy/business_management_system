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

/** مجموع ساعات الأسبوع في الجدول. */
export function weeklyHours(schedule: WorkSchedule): Decimal {
  return DAY_NAMES.reduce((t, d) => {
    const v = schedule[d] as DaySchedule | number | undefined;
    const h = typeof v === "number" ? v : Number(v?.hours ?? 0);
    return t.plus(Number.isFinite(h) && h > 0 ? h : 0);
  }, new Decimal(0));
}

/**
 * ساعات «الشهر المعياريّ» — مقام سعر الساعة (قرار المالك ٣١/٧):
 *
 *   «مبلغ الراتب هو الرقم المرجعيّ الذي تُقسَم عليه المعادلة **على ٣٠ يوماً**… فراتبه
 *    ٣٥٠ ألفاً لِـ٣٠ يوماً، واليوم ٣١ إضافيٌّ ومكمِّل للشهر وإضافيٌّ فوق الراتب».
 *
 * فالمقام = **ساعات أول ثلاثين يوماً من الشهر وفق جدوله** (لا طول الشهر الفعليّ).
 * أثرُه بالضبط ما وصفه المالك:
 *   • شهرُ ٣٠ يوماً بحضورٍ كامل ⇒ الراتب حرفياً دون نقصان دينار.
 *   • شهرُ ٣١ يوماً ⇒ الراتب + أجر اليوم الحادي والثلاثين (إن كان يوم دوام لا راحة).
 *   • شهرٌ أقصر (٢٨/٢٩) ⇒ يُكمَّل بتعويضٍ إلى ٣٠ (انظر shortMonthHours).
 *
 * وحسابُه من التقويم الفعليّ لا بمتوسّطٍ أسبوعيّ يجعله دقيقاً لذوي أيام الراحة أيضاً:
 * مَن يرتاح الجمعة يُقاس بأيام دوامه الواقعة في تلك الثلاثين، لا بتقديرٍ كسريّ.
 */
export function standardMonthlyHours(schedule: WorkSchedule, monthStart: string): Decimal {
  const first30 = daysBetween(monthStart, addDays(monthStart, 29));
  return first30.reduce((t, d) => t.plus(hoursForDay(schedule, d)), new Decimal(0));
}

/** تاريخٌ بعد n يوماً (تقويم UTC ثابت). */
function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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
  /** سقف ساعات اليوم الواحد — يقصّ أيضاً العملَ في يوم الراحة. */
  maxDailyHours?: number;
  /**
   * حدّا الشهر التقويميّ. يُستعملان لتمييز «الشهر كاملاً» عن نافذة عملٍ جزئية (تعيين/فصل
   * في منتصفه) — فتعويض الشهر القصير لا يُمنح إلا لمن عمل الشهر كلَّه. غيابهما ⇒ يُفترض كاملاً.
   */
  monthStart?: string;
  monthEnd?: string;
}

export interface AttendancePayResult {
  /** ساعات الدوام المقرَّرة في نافذة العمل فعلياً (تتبع طول الشهر). */
  scheduledHours: string;
  /** ساعات الشهر المعياريّ (٣٠ يوماً) — **مقام سعر الساعة**، ثابتٌ لا يتبع طول الشهر. */
  standardHours: string;
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
  /**
   * ساعاتٌ تعويضية عن الشهر الأقصر من ٣٠ يوماً (قرار المالك: «الشهر ٢٩ يُهمَل ويُقسَم
   * على ٣٠ كافتراضي») — تُضاف للمستحقّ فيقبض الموظف راتبه كاملاً في شباط.
   */
  shortMonthHours: string;
  /** ساعات عُملت في أيام الراحة — تُدفع بالسعر العاديّ (قرار المالك ٣١/٧). */
  restWorkedHours: string;
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
    state: "present" | "absent" | "paidLeave" | "unpaidLeave" | "beforeStart" | "restWorked";
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

  // ساعات هذا الشهر فعلياً (للعرض والمقارنة) — قد تفوق المعيار في شهرٍ ٣١ يوماً.
  let scheduled = new Decimal(0);
  for (const d of workDays) scheduled = scheduled.plus(hoursForDay(input.schedule, d));

  // مقام السعر **ثابتٌ على ٣٠ يوماً** لا على طول الشهر (قرار المالك) ⇒ اليوم ٣١ إضافيّ.
  const stdHours = standardMonthlyHours(input.schedule, input.monthStart ?? input.employmentStart);
  const derivedRate = stdHours.gt(0) ? input.salary.div(stdHours) : new Decimal(0);

  let payable = new Decimal(0);
  let basePay = new Decimal(0);
  let otHours = new Decimal(0);
  let otPay = new Decimal(0);
  let absentDays = 0;
  let unpaidLeaveDays = 0;
  let shortHours = new Decimal(0);
  let restWorked = new Decimal(0);
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

  /*
   * تعويض الشهر القصير (قرار المالك ٣١/٧): «في حالة الشهر ٢٩ يُهمَل ويُقسَم على ٣٠
   * كافتراضي، وتُحسب الزيادة ٣١ للموظف في حالة الشهر ٣١». فالقاعدة غيرُ متماثلة عمداً
   * ولمصلحة الموظف: الشهر الأقصر يُكمَّل إلى ٣٠، والأطول يُدفع بزيادته.
   *
   * يُمنح **لمن عمل الشهر كلَّه فقط** — المعيَّن/المفصول في منتصفه يُحاسَب على فترته
   * بلا تعويض، وإلا قبض أيامَ ما قبل تعيينه.
   * ولا يُلغي الغياب: التعويض يجبر نقصَ التقويم لا نقصَ الحضور.
   */
  // متحفّظ عمداً: التعويض منفعةٌ للموظف، فلا يُمنح إلا بإثباتٍ صريح أنه عمل الشهر كلَّه.
  // غيابُ حدود الشهر ⇒ لا تعويض (لا نُفرِط في الدفع بافتراضٍ ضمنيّ).
  const wholeMonth =
    input.monthStart != null &&
    input.monthEnd != null &&
    input.employmentStart <= input.monthStart &&
    input.employmentEnd >= input.monthEnd;
  const shortMonth = wholeMonth ? Decimal.max(0, stdHours.minus(scheduled)) : new Decimal(0);
  const paidHours = payable.plus(shortMonth);
  basePay = basePay.plus(derivedRate.times(shortMonth));

  /*
   * العمل في يوم الراحة (قرار المالك ٣١/٧: «سعر عادي»). كان اليوم صفرُ الساعات يُستبعَد
   * من الحساب كلياً، فمَن حضر يوم راحته وبصم ثماني ساعات **لا يتقاضى عنها شيئاً** —
   * ثغرةٌ صامتة. الآن تُدفع ساعاته الفعلية بالسعر المُشتقّ (لا مضاعف، بقراره).
   * ولا تدخل مقام السعر: هي عملٌ فوق الجدول لا جزءٌ منه.
   */
  for (const d of daysBetween(input.employmentStart, input.employmentEnd)) {
    if (hoursForDay(input.schedule, d).gt(0)) continue; // يوم دوام — عولج أعلاه
    if (input.payFrom != null && d < input.payFrom) continue;
    const att = input.attendedHoursByDate.get(d);
    if (att == null || att.lte(0)) continue;
    const counted = Decimal.min(att, new Decimal(input.maxDailyHours ?? 12));
    restWorked = restWorked.plus(counted);
    basePay = basePay.plus(derivedRate.times(counted));
    days.push({
      date: d,
      dayName: dayNameOf(d),
      scheduledHours: "0.00",
      attendedHours: att.toFixed(2),
      countedHours: counted.toFixed(2),
      overtimeHours: "0.00",
      rate: round2(derivedRate).toFixed(2),
      amount: round2(derivedRate.times(counted)).toFixed(2),
      state: "restWorked",
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    scheduledHours: scheduled.toFixed(2),
    restWorkedHours: restWorked.toFixed(2),
    standardHours: stdHours.toFixed(2),
    payableHours: paidHours.toFixed(2),
    shortMonthHours: shortMonth.toFixed(2),
    unpaidHours: Decimal.max(scheduled, stdHours).minus(paidHours).toFixed(2),
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

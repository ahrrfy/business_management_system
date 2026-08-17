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
  /**
   * أيامٌ **مفتوحة**: دخولٌ مسجَّل بلا انصراف (بصمة ناقصة أو دوامٌ جارٍ). ساعاتها صفرٌ لأنها
   * لا تُخمَّن — لكنها **ليست غياباً**، وخلطُها بالغياب كان يدفعها صفراً بلا أن يميّزها أحد:
   * «ما زال في الدوام» و«نسي البصم» و«غاب فعلاً» ثلاثتها تُعرَض بالشكل نفسه (تدقيق ١٧/٨).
   */
  openDates?: Set<string>;
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
  /**
   * الساعات المستحقّة **قبل** تعويض الشهر القصير — أي ما كسبه الموظف فعلاً (حضورٌ + إجازة
   * مدفوعة + ما قبل السريان). فصلُها عن `payableHours` ضرورةٌ لا زينة: حارس «صفر بصمات
   * شهراً كاملاً» في المسيّر كان يفحص `payableHours` وهي تشمل التعويض ⇒ في شباط تصير
   * موجبةً (١٤ ساعة) فلا يُطلَق الحارس ويُصرف أجرٌ لموظفٍ بلا بصمةٍ واحدة (تدقيق ١٧/٨).
   */
  earnedHours: string;
  /**
   * جدولٌ صفريّ: كلُّ أيامه صفر أو `{}` ⇒ **جدولٌ غير مضبوط** لا «كلُّ الأيام راحة».
   * يستعمله المسيّر ليُسمّي سبب الصفر في ملاحظة البند بدل أن يمرّ بلا تفسير.
   */
  scheduleMissing: boolean;
  /** تفصيل للشفافية في ملاحظة البند. */
  absentDays: number;
  unpaidLeaveDays: number;
  /** أيامٌ بدخولٍ بلا انصراف — تحتاج حسماً قبل المسيّر، ولا تُحتسب غياباً. */
  openDays: number;
  /** تواريخ تلك الأيام — يسمّيها المسيّر في رسالته ليعرف المدير ما يُصحّح بالضبط. */
  openDates: string[];
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
    /** الأجر الأساس لليوم = السعر × المحتسَب (الشقّ الذي يدخل وعاء الضمان/الضريبة/نهاية الخدمة). */
    amount: string;
    /** أجر الأوفر تايم لليوم = السعر × الإضافي — يُحسب هنا لا في الواجهة (المال بـdecimal.js). */
    overtimeAmount: string;
    /** إجمالي أجر اليوم = الأساس + الإضافي. ما كان عمود «أجر اليوم» يعرضه هو `amount` وحده. */
    totalAmount: string;
    /**
     * `shortMonth` = يومُ **تعويض الشهر القصير** (شباط ⇒ الأول والثاني من آذار): كان التعويض
     * يدخل المستحقّ بلا صفٍّ ولا مسمّى، فيظهر في الكشف فرقاً غامضاً بين مجموع الأيام والأجر.
     */
    state:
      | "present"
      | "absent"
      | "open"
      | "paidLeave"
      | "unpaidLeave"
      | "beforeStart"
      | "restWorked"
      | "shortMonth";
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
  /*
   * **الجدول الصفريّ** (كلُّ أيامه صفر أو `{}`) ليس «كلَّ الأيام راحة» بل جدولٌ غير مضبوط —
   * قرار المالك ١٧/٨/٢٦: «يعني غياب الموظف عن أيام العمل». كان يُنتج `workDays` فارغة ⇒
   * ساعاتٍ معياريةً صفراً ⇒ سعرَ ساعةٍ صفراً ⇒ **راتباً صفراً صامتاً**، وكلَّ ساعات الشهر
   * المبصومة مصنَّفةً «عمل يوم راحة». الآن كلُّ أيامه أيامُ عملٍ ظاهرة: ما لا بصمة له غيابٌ
   * يُعدّ في `absentDays` ويظهر في ملاحظة البند بدل أن يمرّ بلا تفسير.
   */
  const scheduleMissing = weeklyHours(input.schedule).lte(0);
  // أيام الدوام = ما له ساعاتٌ موجبة في الجدول؛ وصفرُ الساعات راحةٌ لا تُطالَب ولا تُخصَم.
  const workDays = daysBetween(input.employmentStart, input.employmentEnd).filter(
    (d) => scheduleMissing || hoursForDay(input.schedule, d).gt(0),
  );

  // ساعات هذا الشهر فعلياً (للعرض والمقارنة) — قد تفوق المعيار في شهرٍ ٣١ يوماً.
  let scheduled = new Decimal(0);
  for (const d of workDays) scheduled = scheduled.plus(hoursForDay(input.schedule, d));

  // مقام السعر **ثابتٌ على ٣٠ يوماً** لا على طول الشهر (قرار المالك) ⇒ اليوم ٣١ إضافيّ.
  const stdHours = standardMonthlyHours(input.schedule, input.monthStart ?? input.employmentStart);
  const derivedRate = stdHours.gt(0) ? input.salary.div(stdHours) : new Decimal(0);
  /**
   * سعر ساعة يومٍ بعينه: **الصريح في الجدول أوّلاً** (هو الأصل بقرار المالك ٣١/٧)، وإلا
   * المُشتقّ من الراتب. مُستخرَجة في دالّة لأن ثلاثة مسارات تحتاجها — يوم الدوام، والعمل
   * في يوم الراحة، وتعويض الشهر القصير — وكان الأخيران يستعملان المُشتقّ وحده فيتجاهلان
   * السعر الصريح: موظفٌ سعرُه المتّفق عليه ٤٥٠٠ يُدفع له بسعرٍ آخر في هذين المسارين.
   */
  const rateOf = (day: DaySchedule): Decimal =>
    day.rate != null && Number.isFinite(day.rate) && Number(day.rate) > 0
      ? new Decimal(Number(day.rate))
      : derivedRate;

  let payable = new Decimal(0);
  let basePay = new Decimal(0);
  let otHours = new Decimal(0);
  let otPay = new Decimal(0);
  let absentDays = 0;
  let unpaidLeaveDays = 0;
  const openDates: string[] = [];
  let shortHours = new Decimal(0);
  let restWorked = new Decimal(0);
  const days: AttendancePayResult["days"] = [];

  for (const d of workDays) {
    const day = dayOf(input.schedule, d);
    const daily = new Decimal(day.hours);
    const rate = rateOf(day);

    const push = (
      state: AttendancePayResult["days"][number]["state"],
      attended: Decimal,
      counted: Decimal,
      ot: Decimal,
      amount: Decimal,
    ) => {
      const otAmount = round2(rate.times(ot));
      days.push({
        date: d,
        dayName: dayNameOf(d),
        scheduledHours: daily.toFixed(2),
        attendedHours: attended.toFixed(2),
        countedHours: counted.toFixed(2),
        overtimeHours: ot.toFixed(2),
        rate: round2(rate).toFixed(2),
        amount: round2(amount).toFixed(2),
        overtimeAmount: otAmount.toFixed(2),
        totalAmount: round2(round2(amount).plus(otAmount)).toFixed(2),
        state,
      });
    };

    const attended = input.attendedHoursByDate.get(d) ?? new Decimal(0);
    /*
     * يومٌ **مفتوح** = ساعاتُه معلومةُ النقص: إمّا دخولٌ بلا انصراف (صفر ساعات)، وإمّا عددُ
     * بصماتٍ فرديّ يُحتسب بأزواجه المكتملة وحدها (نصفُ يومٍ مدفوع). يبنيه المسيّر ويمرّره هنا.
     */
    const isOpen = !!input.openDates?.has(d);
    /*
     * «الحضور الفعليّ يتقدّم» (قرار المالك ١٧/٨): يومٌ فيه بصماتٌ **عملٌ لا إجازة**. بدونه
     * كانت الإجازة بلا راتب تبتلع يوماً حضره الموظف وبصم فيه ثماني ساعات فتدفعه صفراً.
     */
    const hasPunches = attended.gt(0) || isOpen;

    /*
     * الإجازة بلا راتب تُفحص **قبل** ما-قبل-السريان: كانت بعده، فإجازةٌ بلا راتبٍ معتمدةٌ
     * واقعةٌ قبل `payFrom` تُدفع كاملةً — والمقصود منها ألّا تُدفع أصلاً. وسريانُ الأجر
     * بالحضور لا يخلق استحقاقاً لم يوجد: هو يقول «لا بيانات حضور هنا»، لا «كل يومٍ مدفوع
     * مهما كان مستنده».
     */
    if (input.unpaidLeaveDates.has(d) && !hasPunches) {
      unpaidLeaveDays += 1;
      push("unpaidLeave", new Decimal(0), new Decimal(0), new Decimal(0), new Decimal(0));
      continue; // لا أجر — وهو المقصود من «بلا راتب»
    }
    // ما قبل تاريخ السريان: لا بيانات حضور موثوقة ⇒ يُعامَل يوم دوامٍ كاملاً لا غياباً.
    if (input.payFrom == null || d < input.payFrom) {
      payable = payable.plus(daily);
      basePay = basePay.plus(rate.times(daily));
      push("beforeStart", daily, daily, new Decimal(0), rate.times(daily));
      continue;
    }
    if (input.paidLeaveDates.has(d)) {
      payable = payable.plus(daily);
      basePay = basePay.plus(rate.times(daily));
      push("paidLeave", new Decimal(0), daily, new Decimal(0), rate.times(daily));
      continue; // إجازة مدفوعة (أو من الرصيد) = يوم دوامٍ كامل
    }
    /*
     * اليوم المفتوح لا غائب: ساعاته **مجهولة أو ناقصة** لا صفر ⇒ لا تُخمَّن ولا تُدفع
     * جزئياً. يُفحص قبل الساعات لا بعدها: يومٌ ببصماتٍ فرديّة له ساعاتٌ موجبة (أزواجه
     * المكتملة) فكان يمرّ «حاضراً» بنصف يومٍ مدفوعٍ صامت — ودفعُ النصف تخمينٌ كدفع الصفر.
     * المسيّر يستبعد صاحبه من مسيّر الشهر ويسمّي تواريخه ليصحّحها المدير ثم يُعيد التوليد.
     */
    if (isOpen) {
      openDates.push(d);
      // الساعات الخام تبقى ظاهرةً في الصفّ للشفافية، ولا تدخل المستحقّ.
      push("open", attended, new Decimal(0), new Decimal(0), new Decimal(0));
      continue;
    }
    if (attended.lte(0)) {
      absentDays += 1;
      push("absent", new Decimal(0), new Decimal(0), new Decimal(0), new Decimal(0));
      continue; // غياب — لا راتب لهذا اليوم
    }
    /*
     * سقف اليوم الواحد يُطبَّق هنا أيضاً لا في الطيّ وحده (تدقيق ١٧/٨): كان مسار يوم الدوام
     * يستهلك الساعات خامّاً، فيمرّ يومٌ مُدخَلٌ يدوياً بعشرين ساعة بلا قصّ — والحارس المبنيّ
     * لمنع «بصمة منسيّة تُنتج يوماً وهمياً مدفوعاً» كان معطَّلاً على المسار الأكثر استعمالاً.
     * لبيانات الطيّ هذا لا-عمل (قُصّت سلفاً عند السقف نفسه) ⇒ صفر انحدار.
     */
    const capped = Decimal.min(attended, new Decimal(input.maxDailyHours ?? 12));
    // الزائد عن المقرَّر أوفر تايم ببندٍ مستقلّ (قرار المالك) — لا يتضخّم به الأساس.
    // وبالجدول الصفريّ لا «مقرَّر» يُقاس عليه، فساعاتُه أساسٌ كاملٌ لا إضافيّ: تصنيفُها
    // إضافياً كان يُفرغ الأساس من كل ساعاته ويُبقي الحارس أعمى (payableHours صفر).
    const counted = daily.gt(0) ? Decimal.min(capped, daily) : capped;
    const ot = daily.gt(0) ? Decimal.max(0, capped.minus(daily)) : new Decimal(0);
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
  /*
   * ⚠️ التعويض مشروطٌ بمستحقٍّ فعليّ (تدقيق ١٧/٨): كان يُمنح ولو لم يبصم الموظف يوماً
   * واحداً، فيُنتج في شباط `payableHours = 14` موجبةً **تُعطّل حارس «صفر بصمات شهراً
   * كاملاً»** في المسيّر (شرطه أن تكون صفراً) ⇒ يُصرف أجرٌ لموظفٍ بلا بصمةٍ واحدة.
   * الشرط `payable > 0` يفصل الفحص عن التعويض من جذره: يُكمَّل الشهرُ لمن كسب فيه شيئاً
   * (حضورٌ أو إجازةٌ مدفوعة أو ما قبل السريان)، لا لمن لم يكسب شيئاً أصلاً.
   *
   * وأيامُه **مسمّاةٌ بتواريخها** لا فرقاً مجرَّداً: ما تبقّى من نافذة الثلاثين بعد آخر يوم
   * في الشهر (شباط ⇒ ١-٢ آذار). فيُدفع كلُّ يومٍ **بسعر ساعته الصريح** إن وُجد (كان
   * المُشتقّ وحده يُستعمل هنا فيتجاهل السعر المتّفق عليه)، ويظهر صفّاً مفسَّراً في الكشف.
   */
  const compensationDays =
    wholeMonth && payable.gt(0)
      ? daysBetween(addDays(input.monthEnd as string, 1), addDays(input.monthStart as string, 29)).filter((d) =>
          hoursForDay(input.schedule, d).gt(0),
        )
      : [];
  let shortMonth = new Decimal(0);
  for (const d of compensationDays) {
    const day = dayOf(input.schedule, d);
    const hrs = new Decimal(day.hours);
    const rate = rateOf(day);
    const amount = rate.times(hrs);
    shortMonth = shortMonth.plus(hrs);
    basePay = basePay.plus(amount);
    days.push({
      date: d,
      dayName: dayNameOf(d),
      scheduledHours: hrs.toFixed(2),
      attendedHours: "0.00",
      countedHours: hrs.toFixed(2),
      overtimeHours: "0.00",
      rate: round2(rate).toFixed(2),
      amount: round2(amount).toFixed(2),
      overtimeAmount: "0.00",
      totalAmount: round2(amount).toFixed(2),
      state: "shortMonth",
    });
  }
  const paidHours = payable.plus(shortMonth);

  /*
   * العمل في يوم الراحة (قرار المالك ٣١/٧: «سعر عادي»). كان اليوم صفرُ الساعات يُستبعَد
   * من الحساب كلياً، فمَن حضر يوم راحته وبصم ثماني ساعات **لا يتقاضى عنها شيئاً** —
   * ثغرةٌ صامتة. الآن تُدفع ساعاته الفعلية بسعر ساعة ذلك اليوم (لا مضاعف، بقراره).
   * ولا تدخل مقام السعر: هي عملٌ فوق الجدول لا جزءٌ منه.
   *
   * ولا يمرّ هنا شيءٌ من الجدول الصفريّ: أيامُه كلُّها عولجت أيامَ عملٍ أعلاه، ولولا هذا
   * الشرط لعُدّت مرّتين — ولَعاد تصنيفُها «عمل يوم راحة» الذي نقضه المالك (١٧/٨).
   */
  for (const d of scheduleMissing ? [] : daysBetween(input.employmentStart, input.employmentEnd)) {
    if (hoursForDay(input.schedule, d).gt(0)) continue; // يوم دوام — عولج أعلاه
    if (input.payFrom != null && d < input.payFrom) continue;
    const att = input.attendedHoursByDate.get(d);
    if (att == null || att.lte(0)) continue;
    const counted = Decimal.min(att, new Decimal(input.maxDailyHours ?? 12));
    // السعر الصريح ليوم الراحة إن ضُبط في الجدول، وإلا المُشتقّ.
    const rate = rateOf(dayOf(input.schedule, d));
    restWorked = restWorked.plus(counted);
    basePay = basePay.plus(rate.times(counted));
    days.push({
      date: d,
      dayName: dayNameOf(d),
      scheduledHours: "0.00",
      attendedHours: att.toFixed(2),
      countedHours: counted.toFixed(2),
      overtimeHours: "0.00",
      rate: round2(rate).toFixed(2),
      amount: round2(rate.times(counted)).toFixed(2),
      // عمل يوم الراحة يُدفع بالسعر العاديّ كاملاً في الأساس ⇒ لا شقّ إضافيّ له.
      overtimeAmount: "0.00",
      totalAmount: round2(rate.times(counted)).toFixed(2),
      state: "restWorked",
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    scheduledHours: scheduled.toFixed(2),
    restWorkedHours: restWorked.toFixed(2),
    standardHours: stdHours.toFixed(2),
    payableHours: paidHours.toFixed(2),
    earnedHours: payable.toFixed(2),
    scheduleMissing,
    shortMonthHours: shortMonth.toFixed(2),
    /*
     * غير المستحقّ = ما نقص من **التزام نافذة عمله هو** (ساعاتُ أيامه + تعويض التقويم)،
     * لا من الشهر المعياريّ: كان المقام `max(scheduled, stdHours)` وهو ساعاتُ الشهر كلِّه،
     * فيُحمَّل المعيَّن في منتصف الشهر (والمفصول فيه) ساعاتِ ما قبل تعيينه/بعد فصله
     * «غيرَ مستحقّة» — دَينُ وقتٍ لم يكن موظفاً فيه أصلاً. و`max(0,…)` يمنع سالباً بلا
     * معنى (الجدول الصفريّ: مقرَّرٌ صفرٌ وساعاتٌ مبصومة).
     */
    unpaidHours: Decimal.max(0, scheduled.plus(shortMonth).minus(paidHours)).toFixed(2),
    hourlyRate: round2(derivedRate).toFixed(2),
    basePay: round2(basePay).toFixed(2),
    overtimeHours: otHours.toFixed(2),
    overtimePay: round2(otPay).toFixed(2),
    absentDays,
    unpaidLeaveDays,
    openDays: openDates.length,
    openDates,
    shortHours: shortHours.toFixed(2),
    days,
  };
}

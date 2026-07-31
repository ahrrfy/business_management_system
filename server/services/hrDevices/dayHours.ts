/* ============================================================================
 * احتساب ساعات اليوم من البصمات الخام (server/services/hrDevices/dayHours.ts)
 *
 * نواة **نقيّة** بلا قاعدة بيانات ⇒ قابلة للاختبار وحدها، ومصدر حقيقة واحد يستعمله
 * الطيّ التلقائي. القرارات المطبَّقة هنا قرارات مالك صريحة (٣١ يوليو ٢٠٢٦):
 *
 * ١) **مزاوجة البصمات** لا (أول ← آخر): البصمات تُقرأ أزواجاً (دخول←خروج) وتُجمع
 *    الفترات، فتُطرح الاستراحات. كان (آخر − أول) يدفع استراحة الغداء أجرَ عمل:
 *    08:00 دخول، 12:00 خروج، 16:00 عودة، 20:00 خروج ⇒ ١٢ ساعة بدل ٨.
 *
 * ٢) **بصمة خروج ناقصة لا تُخمَّن**: يومٌ بعدد بصمات فرديّ يُحتسب بأزواجه المكتملة
 *    فقط ويُوسَم «يحتاج تصحيح» ليصحّحه المدير يدوياً قبل إغلاق الشهر. لا أجر يُدفع
 *    على افتراض، ولا يوم يمرّ صامتاً بصفر ساعات كما كان.
 *
 * ٣) **الوردية الليلية العابرة منتصف الليل** مدعومة لكنها **معطَّلة افتراضياً**
 *    (تحدث نادراً في المطبعة): عند تفعيلها، بصمةُ الصباح الباكر (قبل ساعة الفصل)
 *    تُغلق وردية اليوم السابق بدل أن تفتح يوماً جديداً بصفر ساعات.
 *    الإسناد حتميّ وبلا حالة مخزَّنة: يوم D يسأل عن D−1 وD+1 فيصل للنتيجة نفسها
 *    مهما تكرّر الطيّ (وصول بصمة متأخرة يعيد حساب اليوم كاملاً — لا تراكم).
 * ========================================================================== */

/** "YYYY-MM-DD HH:MM:SS" ⇒ ميلي ثانية. لاحقة Z ثابتة: فرق توقيتَي حائط لا يتأثر بالمنطقة. */
export function wallMs(s: string): number {
  return new Date(`${s.replace(" ", "T")}Z`).getTime();
}

/** ساعة اليوم (0-23) من توقيت الحائط النصّي — بلا تحويل مناطق. */
export function hourOf(s: string): number {
  return Number(s.slice(11, 13));
}

export interface NightShiftOptions {
  /** هل تُغلق بصمةُ الصباح الباكر وردية اليوم السابق؟ (قرار مالك — معطَّل افتراضياً) */
  enabled: boolean;
  /** ساعة الفصل: بصمة قبلها في يومٍ تالٍ تُعدّ إغلاقاً لوردية أمس (افتراضياً 08:00). */
  cutoffHour: number;
}

export const DEFAULT_NIGHT_SHIFT: NightShiftOptions = { enabled: false, cutoffHour: 8 };

export interface DayHoursResult {
  /** مجموع الفترات المكتملة بالساعات (منزلتان). */
  hours: string;
  /** "HH:MM" لأول دخول، وnull إن لم يبقَ للـيوم بصمة. */
  checkIn: string | null;
  /** "HH:MM" لآخر خروج مُزاوَج، وnull إن لم يكتمل زوج. */
  checkOut: string | null;
  /** يومٌ ينقصه إغلاق ⇒ يُعرَض للمدير ولا يُخمَّن أجره. */
  needsReview: boolean;
  reviewReason: string | null;
  /** عدد البصمات التي دخلت الحساب فعلاً (تشخيص). */
  usedCount: number;
}

function round2Str(n: number): string {
  // تقريب نصف-لأعلى على منزلتين ثم تنسيق ثابت — يطابق سياسة money.ts في العرض النصّي.
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/**
 * يحسب ساعات يومٍ واحد من بصماته.
 *
 * @param dayPunches   بصمات اليوم نفسه ("YYYY-MM-DD HH:MM:SS")، أيّ ترتيب.
 * @param prevDayPunches بصمات اليوم السابق (تُستعمل فقط للوردية الليلية لمعرفة إن كانت
 *                       أولى بصمات اليوم مملوكةً لأمس). مرّر [] إذا كانت معطَّلة.
 * @param nextDayPunches بصمات اليوم التالي (للبحث عن بصمة الإغلاق الليلي). مرّر [].
 */
export function computeDayHours(
  dayPunches: string[],
  prevDayPunches: string[] = [],
  nextDayPunches: string[] = [],
  night: NightShiftOptions = DEFAULT_NIGHT_SHIFT,
): DayHoursResult {
  const times = [...dayPunches].sort();

  // (أ) هل أولى بصمات اليوم في الحقيقة إغلاقٌ لوردية أمس؟ نسأل أمس لا نُخزّن حالة.
  //     الشرط: أمس عددها فرديّ (وردية مفتوحة) وبصمتنا قبل ساعة الفصل.
  let working = times;
  if (night.enabled && times.length > 0 && prevDayPunches.length % 2 === 1 && hourOf(times[0]) < night.cutoffHour) {
    working = times.slice(1);
  }

  // (ب) هل ينقص يومَنا إغلاقٌ يقع فجر الغد؟
  let borrowed: string | null = null;
  if (night.enabled && working.length % 2 === 1 && nextDayPunches.length > 0) {
    const nextFirst = [...nextDayPunches].sort()[0];
    if (hourOf(nextFirst) < night.cutoffHour) borrowed = nextFirst;
  }
  const seq = borrowed ? [...working, borrowed] : working;

  if (seq.length === 0) {
    return { hours: "0.00", checkIn: null, checkOut: null, needsReview: false, reviewReason: null, usedCount: 0 };
  }

  // (ج) المزاوجة: (دخول←خروج) لكل زوج متتالٍ، وتُجمع الفترات ⇒ الاستراحات مطروحة ضمناً.
  let totalMs = 0;
  let lastPairedOut: string | null = null;
  for (let i = 0; i + 1 < seq.length; i += 2) {
    const span = wallMs(seq[i + 1]) - wallMs(seq[i]);
    if (span > 0) totalMs += span;
    lastPairedOut = seq[i + 1];
  }

  const dangling = seq.length % 2 === 1;
  return {
    hours: round2Str(totalMs / 3_600_000),
    checkIn: seq[0].slice(11, 16),
    checkOut: lastPairedOut ? lastPairedOut.slice(11, 16) : null,
    needsReview: dangling,
    reviewReason: dangling
      ? seq.length === 1
        ? "بصمة واحدة فقط — ينقص تسجيل الخروج"
        : "عدد البصمات فرديّ — ينقص تسجيل خروج"
      : null,
    usedCount: seq.length,
  };
}

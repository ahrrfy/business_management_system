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
 * ========================================================================== */

/** "YYYY-MM-DD HH:MM:SS" ⇒ ميلي ثانية. لاحقة Z ثابتة: فرق توقيتَي حائط لا يتأثر بالمنطقة. */
export function wallMs(s: string): number {
  return new Date(`${s.replace(" ", "T")}Z`).getTime();
}

/** ساعة اليوم (0-23) من توقيت الحائط النصّي — بلا تحويل مناطق. */
export function hourOf(s: string): number {
  return Number(s.slice(11, 13));
}

/**
 * سقف الساعات المعقولة لليوم الواحد (قرار المالك ٣١/٧): «لا توجد ساعات عمل ٢٠ ولا ١٨ ولا
 * حتى ١٦ — فالحارس يمسكها». يوم يتجاوز السقف يُقصّ عنده ويُوسَم «يحتاج تصحيح» ليراجعه
 * المدير: بصمةٌ منسيّة أو خللٌ في ساعة الجهاز تُنتج فترةً وهمية تُدفَع أجرَ عملٍ لم يقع.
 * القصّ لا التصفير: اليوم غالباً حقيقيّ وطويلٌ خطأً، فلا نُضيّع أجرَه كلَّه بانتظار المراجعة.
 */
export const DEFAULT_MAX_DAILY_HOURS = 12;

/**
 * أقصر فترة تُحتسب (دقائق). مسحُ البطاقة مرّتين بثوانٍ يُنتج فترةً بلا معنى تمرّ صامتة —
 * تُهمَل ويُوسَم اليوم ليراه المدير بدل أن تدخل الأجر كسراً وهمياً (قرار المالك ٣١/٧).
 */
export const MIN_SPAN_MINUTES = 5;

/**
 * الوردية الليلية العابرة منتصف الليل — **معطَّلة افتراضياً** (قرار المالك: نادرة في المطبعة).
 *
 * بلا تفعيلها تُسجَّل وردية 22:00→06:00 يومين ببصمةٍ واحدة لكلٍّ ⇒ **صفر ساعات وصفر أجر
 * لليلة عملٍ كاملة**، ويومان موسومان «ينقص انصراف». ومع تفعيلها تُغلق بصمةُ الفجر وردية أمس.
 *
 * **قاعدة الإسناد (حتميّة، بلا حالةٍ مخزَّنة):** بصمةٌ ساعتُها < `cutoffHour` تخصّ وردية اليوم
 * السابق. فوردية يوم D = بصمات D التي ساعتها ≥ الفصل + بصمات D+1 التي ساعتها < الفصل.
 * ولأنها تُشتقّ من الجيران لا من حالةٍ محفوظة، يعطي إعادةُ الطيّ النتيجةَ نفسها مهما تكرّرت.
 */
export interface NightShiftOptions {
  enabled: boolean;
  /** ساعةُ الفصل (0-23): ما قبلها من اليوم التالي يُغلق وردية اليوم. الافتراضي ٨. */
  cutoffHour: number;
  /** بصمات اليوم التالي — منها تُلتقط بصمةُ الفجر وحدها (ما قبل الفصل). */
  nextDayPunches?: string[];
  /** بصمات اليوم السابق — لاكتشاف ما إذا كانت بصمة فجر اليوم قد استُهلكت لإغلاق وردية أمس المفتوحة. */
  prevDayPunches?: string[];
  /**
   * الإسناد الذكي لبصمات الفجر/ما بعد منتصف الليل (00:00–06:00) لإغلاق بصمة اليوم السابق المفتوحة تلقائياً
   * حتى عند تعطيل الوردية الليلية الشاملة (قرار المالك ٢٢/١٠).
   */
  smartCrossMidnight?: boolean;
}

export const DEFAULT_NIGHT_CUTOFF_HOUR = 8;
export const SMART_DAWN_CUTOFF_HOUR = 6;

export interface DaySession {
  /** وقت دخول الفترة ("HH:MM"). */
  checkIn: string;
  /** وقت انصراف الفترة ("HH:MM")، أو null إن كانت الفترة مفتوحة بلا انصراف. */
  checkOut: string | null;
  /** هل انصراف هذه الفترة وقع في اليوم التالي (بعد منتصف الليل)؟ */
  checkOutNextDay: boolean;
  /** ساعات هذه الفترة (منزلتان). */
  hours: string;
}

export interface DayBreak {
  /** بداية الاستراحة/الزمنية ("HH:MM" — انصراف الفترة السابقة). */
  from: string;
  /** نهاية الاستراحة/الزمنية ("HH:MM" — دخول الفترة التالية). */
  to: string;
  /** مدّة الاستراحة/الزمنية بالدقائق. */
  minutes: number;
  /** مدّة الاستراحة/الزمنية بالساعات (منزلتان). */
  hours: string;
}

export interface DayHoursResult {
  /** مجموع الفترات المكتملة بالساعات (منزلتان). */
  hours: string;
  /** "HH:MM" لأول دخول، وnull إن لم يبقَ للـيوم بصمة. */
  checkIn: string | null;
  /** "HH:MM" لآخر خروج مُزاوَج، وnull إن لم يكتمل زوج. */
  checkOut: string | null;
  /**
   * الخروج وقع في **اليوم التالي** (وردية ليلية). يستعمله الطيّ ليخزّن طابع الانصراف على
   * تاريخه الصحيح — وإلّا بُني على تاريخ الوردية فصار الانصراف قبل الدخول في العمود نفسه.
   */
  checkOutNextDay: boolean;
  /** يومٌ ينقصه إغلاق ⇒ يُعرَض للمدير ولا يُخمَّن أجره. */
  needsReview: boolean;
  reviewReason: string | null;
  /** عدد البصمات التي دخلت الحساب فعلاً (تشخيص). */
  usedCount: number;
  /** قائمة فترات الدوام في اليوم (فترة واحدة أو أكثر عند الخروج للاستراحة/الزمنية والعودة). */
  sessions: DaySession[];
  /** فترات الاستراحة / الزمنية الفاصلة بين فترات الدوام. */
  breaks: DayBreak[];
  /** مجموع دقائق الاستراحة / الزمنية بين الفترات. */
  breakMinutes: number;
  /** مجموع ساعات الاستراحة / الزمنية (منزلتان). */
  breakHours: string;
}

function round2Str(n: number): string {
  // تقريب نصف-لأعلى على منزلتين ثم تنسيق ثابت — يطابق سياسة money.ts في العرض النصّي.
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** تنقية التسلسل المرتّب من البصمات المكرّرة المتقاربة (< MIN_SPAN_MINUTES). */
function dedupSortedPunches(sortedTimes: string[]): { seq: string[]; tinySpans: number } {
  const seq: string[] = [];
  let tinySpans = 0;
  for (const t of sortedTimes) {
    const prev = seq[seq.length - 1];
    if (prev && wallMs(t) - wallMs(prev) < MIN_SPAN_MINUTES * 60_000) {
      tinySpans += 1;
      continue;
    }
    seq.push(t);
  }
  return { seq, tinySpans };
}

/**
 * يحسب ساعات يومٍ واحد من بصماته.
 *
 * @param dayPunches   بصمات اليوم نفسه ("YYYY-MM-DD HH:MM:SS")، أيّ ترتيب.
 */
export function computeDayHours(
  dayPunches: string[],
  maxDailyHours: number = DEFAULT_MAX_DAILY_HOURS,
  /** ساعات اليوم المقرَّرة في جدول الموظف — تُفعّل حارس «أقلّ من النصف». */
  scheduledHours?: number,
  /** الوردية الليلية — غيابها/تعطيلها = السلوك السابق حرفياً (صفر انحدار). */
  night?: NightShiftOptions,
): DayHoursResult {
  const cap = Number.isFinite(maxDailyHours) && maxDailyHours > 0 ? maxDailyHours : DEFAULT_MAX_DAILY_HOURS;
  const capMs = cap * 3_600_000;

  /*
   * (أ) إسناد الوردية الليلية — **قبل** كل شيء، فما يليه يعمل على بصمات الوردية لا اليوم.
   * بصمات هذا اليوم التي ساعتها < الفصل تخصّ وردية أمس ⇒ تُستبعَد هنا وتُحتسب هناك.
   * وبصمات الفجر من اليوم التالي تُضمّ **بشرط أن يكون لهذا اليوم افتتاحٌ فعليّ** — وإلا
   * لَجرَّ يومٌ بلا دوامٍ انصرافَ غيره إليه.
   */
  if (night?.enabled) {
    const cutoff = Number.isFinite(night.cutoffHour) ? night.cutoffHour : DEFAULT_NIGHT_CUTOFF_HOUR;
    const own = dayPunches.filter((t) => hourOf(t) >= cutoff);
    const dawn = own.length > 0 ? (night.nextDayPunches ?? []).filter((t) => hourOf(t) < cutoff) : [];
    dayPunches = [...own, ...dawn];
  } else if (night?.smartCrossMidnight) {
    /*
     * (أ-٢) الإسناد الذكي لبصمات الفجر/ما بعد منتصف الليل (00:00–06:00) لإغلاق وردية اليوم السابق المفتوحة:
     * حتى حين تكون الوردية الليلية الشاملة معطَّلة (حفاظاً على دوام الصباح المبكّر)، فإن الموظف المسائي
     * الذي يدخل عصراً (مثلاً 15:07) وينصرف بعد منتصف الليل بدقائق (00:02) يترك بصمةً فردية في يوم D
     * وبصمة فجرٍ في يوم D+1.
     * ١) إذا كان ليوم D-1 بصمة دخول مفتوحة (عدد فردي لبصماته غير الفجرية) وتغلقها أول بصمة فجرٍ في D
     *    ضمن سقف الساعات اليومية (<= maxDailyHours)، فتلك البصمة استُهلكت لإغلاق D-1 وتُستبعد من D.
     * ٢) إذا بقي يوم D بعد ذلك ببصمة دخول مفتوحة (عدد فردي) وتوجد في D+1 بصمة فجر تغلقها ضمن السقف،
     *    تُضمّ بصمة الفجر إلى D لإغلاق ورديته تلقائياً.
     */
    const dawnCutoff = SMART_DAWN_CUTOFF_HOUR;
    let working = [...dayPunches];

    if (night.prevDayPunches && night.prevDayPunches.length > 0) {
      let prevEffective = dedupSortedPunches([...night.prevDayPunches].sort()).seq;
      if (prevEffective.length >= 2 && hourOf(prevEffective[0]) < dawnCutoff) {
        const firstPrev = prevEffective[0];
        const secondPrev = prevEffective[1];
        const prevDawnWasPriorCheckout =
          prevEffective.length % 2 === 1 ||
          wallMs(secondPrev) - wallMs(firstPrev) > capMs ||
          (hourOf(firstPrev) < 4 && hourOf(secondPrev) >= 12);
        if (prevDawnWasPriorCheckout) {
          prevEffective = prevEffective.slice(1);
        }
      } else if (prevEffective.length === 1 && hourOf(prevEffective[0]) < dawnCutoff) {
        prevEffective = [];
      }
      if (prevEffective.length % 2 === 1) {
        const lastPrevOpen = prevEffective[prevEffective.length - 1];
        const sortedOwn = [...working].sort();
        const firstOwn = sortedOwn[0];
        if (firstOwn && hourOf(firstOwn) < dawnCutoff) {
          const spanFromPrevMs = wallMs(firstOwn) - wallMs(lastPrevOpen);
          if (spanFromPrevMs > 0 && spanFromPrevMs <= capMs) {
            const consumedMs = wallMs(firstOwn);
            working = working.filter(
              (t) => !(hourOf(t) < dawnCutoff && Math.abs(wallMs(t) - consumedMs) < MIN_SPAN_MINUTES * 60_000),
            );
          }
        }
      }
    }

    const cleanedWorking = dedupSortedPunches([...working].sort()).seq;
    if (cleanedWorking.length % 2 === 1 && night.nextDayPunches && night.nextDayPunches.length > 0) {
      const lastOpen = cleanedWorking[cleanedWorking.length - 1];
      if (hourOf(lastOpen) >= dawnCutoff) {
        const nextDawn = dedupSortedPunches(
          night.nextDayPunches.filter((t) => hourOf(t) < dawnCutoff).sort(),
        ).seq;
        if (nextDawn.length > 0) {
          const firstNextDawn = nextDawn[0];
          const spanToNextMs = wallMs(firstNextDawn) - wallMs(lastOpen);
          if (spanToNextMs > 0 && spanToNextMs <= capMs) {
            working = [...working, firstNextDawn];
          }
        }
      }
    }

    dayPunches = working;
  }
  /*
   * اضطرابُ ترتيبٍ في الوارد (Codex P2): الفرز يُخفيه، فيُكتشف **قبله**. مصدرُه قفزةُ
   * ساعةٍ في الجهاز أو دفعةٌ مختلطة — والفرز يحوّل الخروج المبكّر إلى «دخول» ظاهريّ
   * فيُسجَّل وقتٌ مدفوع بلا مراجعة. نوسمه ولا نمنع.
   */
  const outOfOrder = dayPunches.some((t, i) => i > 0 && t < dayPunches[i - 1]);
  const times = [...dayPunches].sort();

  /*
   * إزالة المكرّر **قبل** المزاوجة (Codex P1): بصمتان بثوانٍ (مسحٌ مزدوج) كانتا تُزاوَجان
   * معاً ثم تُهمَلان، فينكسر تكافؤ التسلسل ويصير الخروجُ الحقيقيّ معلَّقاً ⇒ اليوم بصفر
   * ساعات بدل تسع. الحلّ أن تُطرح المكرّرة من التسلسل أصلاً فلا تُغيّر الأزواج.
   */
  const { seq, tinySpans } = dedupSortedPunches(times);

  if (seq.length === 0) {
    return {
      hours: "0.00",
      checkIn: null,
      checkOut: null,
      checkOutNextDay: false,
      needsReview: false,
      reviewReason: null,
      usedCount: 0,
      sessions: [],
      breaks: [],
      breakMinutes: 0,
      breakHours: "0.00",
    };
  }

  // (ج) المزاوجة: (دخول←خروج) لكل زوج متتالٍ، وتُجمع الفترات ⇒ الاستراحات مطروحة ضمناً.
  let totalMs = 0;
  let lastPairedOut: string | null = null;
  const sessions: DaySession[] = [];
  const breaks: DayBreak[] = [];
  let totalBreakMinutes = 0;
  const firstDateStr = seq[0].slice(0, 10);

  for (let i = 0; i + 1 < seq.length; i += 2) {
    const inStamp = seq[i];
    const outStamp = seq[i + 1];
    const spanMs = wallMs(outStamp) - wallMs(inStamp); // موجبٌ حتماً (التسلسل مرتَّب ومنقّى)
    totalMs += spanMs;
    lastPairedOut = outStamp;

    if (i >= 2) {
      const prevOutStamp = seq[i - 1];
      const breakMs = wallMs(inStamp) - wallMs(prevOutStamp);
      if (breakMs > 0) {
        const breakMins = Math.round(breakMs / 60_000);
        totalBreakMinutes += breakMins;
        breaks.push({
          from: prevOutStamp.slice(11, 16),
          to: inStamp.slice(11, 16),
          minutes: breakMins,
          hours: round2Str(breakMs / 3_600_000),
        });
      }
    }

    sessions.push({
      checkIn: inStamp.slice(11, 16),
      checkOut: outStamp.slice(11, 16),
      checkOutNextDay: outStamp.slice(0, 10) !== firstDateStr,
      hours: round2Str(spanMs / 3_600_000),
    });
  }

  const dangling = seq.length % 2 === 1;
  if (dangling) {
    const openInStamp = seq[seq.length - 1];
    if (seq.length >= 3) {
      const prevOutStamp = seq[seq.length - 2];
      const breakMs = wallMs(openInStamp) - wallMs(prevOutStamp);
      if (breakMs > 0) {
        const breakMins = Math.round(breakMs / 60_000);
        totalBreakMinutes += breakMins;
        breaks.push({
          from: prevOutStamp.slice(11, 16),
          to: openInStamp.slice(11, 16),
          minutes: breakMins,
          hours: round2Str(breakMs / 3_600_000),
        });
      }
    }
    sessions.push({
      checkIn: openInStamp.slice(11, 16),
      checkOut: null,
      checkOutNextDay: false,
      hours: "0.00",
    });
  }

  const rawHours = totalMs / 3_600_000;

  // (د) حارس المعقولية: يومٌ يتجاوز السقف يُقصّ ويُوسَم — لا يُدفَع أجرُ ساعاتٍ لم تقع.
  const implausible = rawHours > cap;
  const hours = implausible ? cap : rawHours;

  const reasons: string[] = [];
  if (dangling) {
    const openTime = seq[seq.length - 1].slice(11, 16);
    reasons.push(
      seq.length === 1
        ? "بصمة واحدة فقط — ينقص تسجيل الخروج"
        : `عدد البصمات فرديّ — ينقص تسجيل خروج (بصمة دخول ${openTime} بلا انصراف)`,
    );
  }
  if (implausible) {
    reasons.push(`ساعات غير معقولة (${round2Str(rawHours)} ساعة) — قُصّت عند سقف ${cap}؛ راجع أوقات البصمات`);
  }
  if (outOfOrder) reasons.push("بصمات وصلت بترتيبٍ مضطرب — تحقّق من ساعة الجهاز");
  if (tinySpans > 0) reasons.push(`${tinySpans} بصمة مكرّرة بأقلّ من ${MIN_SPAN_MINUTES} دقائق — أُهملت`);
  // حدّ أدنى: يومٌ أقلّ من نصف المقرَّر غالباً بصمةٌ ناقصة لا دوامٌ قصير.
  if (scheduledHours != null && scheduledHours > 0 && hours > 0 && hours < scheduledHours / 2) {
    reasons.push(`ساعات أقلّ من نصف المقرَّر (${round2Str(hours)} من ${round2Str(scheduledHours)}) — تحقّق من البصمات`);
  }

  return {
    hours: round2Str(hours),
    checkIn: seq[0].slice(11, 16),
    checkOut: lastPairedOut ? lastPairedOut.slice(11, 16) : null,
    // الانصراف على تاريخٍ يخالف تاريخ الدخول ⇒ عبَرَ منتصف الليل.
    checkOutNextDay: !!lastPairedOut && lastPairedOut.slice(0, 10) !== firstDateStr,
    needsReview: reasons.length > 0,
    reviewReason: reasons.length ? reasons.join(" · ") : null,
    usedCount: seq.length,
    sessions,
    breaks,
    breakMinutes: totalBreakMinutes,
    breakHours: round2Str(totalBreakMinutes / 60),
  };
}


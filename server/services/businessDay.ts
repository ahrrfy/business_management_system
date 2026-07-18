/**
 * businessDay.ts — مصدر الحقيقة الواحد لحدود «اليوم التجاريّ» (تدقيق ١٧/٧، مخاطرة جهازية #٧).
 *
 * القرار: النظام يفرض **TZ=UTC** (dev/start/test/pm2 عبر cross-env)، واتصال القاعدة `timezone:"Z"`،
 * وكل الطوابع تُخزَّن UTC ⇒ **«اليوم التجاريّ» = يوم UTC**. لكن الحسابات القديمة بنَت الحدود بمكوّنات
 * محلية — `new Date(y, m-1, d)` أو `new Date(); d.setHours(0,0,0,0)` — وهي **تابعة لمنطقة عملية Node**،
 * فتنزاح ثلاث ساعات على أي جهاز يعمل بغير TZ=UTC (تشغيل يدويّ بلا cross-env، أو جهاز متجرٍ بمنطقة بغداد).
 *
 * الحلّ هنا: بناء كل الحدود بـ**`Date.UTC`** ⇒ حتميّة ومستقلّة عن منطقة Node تماماً. تحت TZ=UTC المفروض
 * تُطابِق السلوك القائم بايتاً ببايت (`new Date(2026,6,17)` تحت TZ=UTC == `new Date(Date.UTC(2026,6,17))`)،
 * لكنها تبقى صحيحة على أي جهاز — فالمهاجرة إليها بلا أثرٍ سلوكيّ في الإنتاج/الاختبار.
 *
 * الاصطلاح: نطاق نصف مفتوح `[dayStart(from), nextDayStart(to))` لأعمدة timestamp؛ و`dayStart` وحده
 * كحدّ شامل لأعمدة DATE (بلا وقت).
 *
 * ملاحظة «اليوم بتوقيت بغداد»: منطق «هل هذا العرض/الكوبون فعّالٌ اليوم» يستعمل يوم بغداد (+03:00) عمداً
 * (اليوم الفعليّ للمتجر) لا يوم UTC — تلك دلالةٌ مختلفة مقصودة، لها `baghdadToday()` أدناه صراحةً.
 */
import { TRPCError } from "@trpc/server";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** يتحقّق من صيغة YYYY-MM-DD ومن كون التاريخ حقيقياً (لا 2026-02-31). */
export function parseBusinessYmd(ymd: string): { y: number; m: number; d: number } {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة التاريخ غير صالحة (المتوقَّع YYYY-MM-DD)" });
  }
  const [y, m, d] = ymd.split("-").map(Number);
  // فحص وجود التاريخ عبر Date.UTC (مستقلّ عن المنطقة) ثم مطابقة المكوّنات.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة التاريخ غير صالحة (المتوقَّع YYYY-MM-DD)" });
  }
  return { y, m, d };
}

/** بداية اليوم (منتصف ليل UTC، حتميّ) — حدّ أدنى شامل، وحدّ أعلى شامل لأعمدة DATE. */
export function utcDayStart(ymd: string): Date {
  const { y, m, d } = parseBusinessYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d));
}

/** بداية اليوم التالي (منتصف ليل UTC، حتميّ) — حدّ أعلى **حصريّ** لأعمدة timestamp: ‎[from, to+يوم). */
export function utcNextDayStart(ymd: string): Date {
  const { y, m, d } = parseBusinessYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d + 1)); // Date.UTC يطبّع تجاوز نهاية الشهر/السنة.
}

/** «اليوم» بمنتصف ليل UTC (حتميّ) — لإدراج عمود `date()` بلا انزياح يوم على أي جهاز. */
export function utcTodayStart(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** تاريخ اليوم YYYY-MM-DD بتوقيت UTC (حتميّ). */
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** نطاق نصف مفتوح [from 00:00 UTC, to+يوم 00:00 UTC) لأعمدة timestamp. */
export function utcDayRange(from: string, to: string): { start: Date; endExclusive: Date } {
  return { start: utcDayStart(from), endExclusive: utcNextDayStart(to) };
}

/** تاريخ «اليوم» بتوقيت بغداد (+03:00) YYYY-MM-DD — لمنطق «فعّال اليوم» (اليوم الفعليّ للمتجر)،
 *  دلالةٌ مقصودة تختلف عن يوم UTC قرب منتصف الليل. لا تستعملها لفلترة أعمدة UTC. */
export function baghdadToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

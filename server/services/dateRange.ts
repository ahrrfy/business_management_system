/** حدود فلاتر الفترات (YYYY-MM-DD) بمنتصف ليلٍ **محلي**.
 *
 *  ⚠️ `new Date("YYYY-MM-DD")` يفسَّر منتصف ليل **UTC**، وعند الربط بالقاعدة يُسلسَل
 *  بالتوقيت المحلي (+03:00 في العراق) إلى `03:00:00` ⇒ تنزاح نافذة الفلترة ثلاث ساعات
 *  على أعمدة timestamp، بل يُستبعد يوم `from` كاملاً على أعمدة DATE
 *  (`DATE '2026-01-10'` يُرقَّى إلى `00:00:00` وهو أقل من `03:00:00`).
 *  البناء بالمكوّنات المحلية يلغي الانزياح على أي منطقة زمنية.
 */

import { TRPCError } from "@trpc/server";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYmdStrict(ymd: string): { y: number; m: number; d: number } {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "صيغة التاريخ غير صالحة (المتوقَّع YYYY-MM-DD)",
    });
  }
  const [y, m, d] = ymd.split("-").map(Number);
  const probe = new Date(y, m - 1, d);
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getFullYear() !== y ||
    probe.getMonth() !== m - 1 ||
    probe.getDate() !== d
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "صيغة التاريخ غير صالحة (المتوقَّع YYYY-MM-DD)",
    });
  }
  return { y, m, d };
}

/** بداية اليوم محلياً — حدّ أدنى شامل، وحدّ أعلى شامل لأعمدة DATE (بلا وقت). */
export function localDayStart(ymd: string): Date {
  const { y, m, d } = parseYmdStrict(ymd);
  return new Date(y, m - 1, d);
}

/** بداية اليوم التالي محلياً — حدّ أعلى **حصري** لأعمدة timestamp: ‎[from, to+يوم). */
export function localNextDayStart(ymd: string): Date {
  const { y, m, d } = parseYmdStrict(ymd);
  return new Date(y, m - 1, d + 1); // Date يطبّع تجاوز نهاية الشهر/السنة تلقائياً
}

/**
 * «اليوم» بمنتصف ليل **محلي** — لإدراج عمود `date()` (بلا وقت) دون انزياح يوم.
 *
 * ⚠️ `new Date()` خام يُرجع لحظة UTC الراهنة. الـdrizzle adapter يُسلسلها لـMySQL بـtoISOString()
 * أو ما يشابه ⇒ على عمود DATE تُؤخذ الـY-M-D من UTC، لا من المنطقة المحلية. عند بغداد (+03:00)
 * أي إدراج بعد ٢١:٠٠ محلياً (=١٨:٠٠ UTC، ما زال نفس اليوم) فالتاريخ صحيح؛ لكن أي إدراج
 * من منتصف الليل محلياً إلى ٠٣:٠٠ ص (=٢١:٠٠–٠٠:٠٠ UTC من **اليوم السابق**) يُسجَّل
 * بتاريخ الأمس. خطر يومي على قيود OPENING ومسيّرات بعد منتصف الليل بقليل.
 *
 * الحلّ: بناء Date من مكوّنات اليوم المحلية ⇒ منتصف ليل في المنطقة المحلية ⇒ TIMESTAMP
 * المُسلسَل يحمل نفس الـDATE بغضّ النظر عن المنطقة الزمنية للخادم.
 */
export function localTodayDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

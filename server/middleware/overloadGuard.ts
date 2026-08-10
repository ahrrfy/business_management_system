import type { NextFunction, Request, Response } from "express";

/**
 * حماية الحِمل الزائد (load shedding) — الحاجز الأخير للاعتماديّة تحت الضغط الشديد.
 *
 * يراقب **تأخّر حلقة أحداث Node** (كم تتأخّر المؤقّتات عن موعدها = مؤشّر تشبّع المعالج/الحدث)،
 * وعند تجاوزه عتبةً عاليةً يردّ **503 فوراً** بدل مراكمة الطلبات حتى تنهار العملية كلّها. هذا
 * يكمّل الطبقات الأمامية (Cloudflare + nginx) والعنقود: إن أفلت ضغطٌ شاذّ (استعلامٌ ثقيل، دفعةٌ
 * ضخمة) وأشبع عاملاً، يتنازل العامل عن الطلبات الزائدة رشيقاً بدل أن يعلّق الجميع.
 *
 * **محافظٌ عمداً:** عتبة عالية (افتراضي ٥٠٠ﻡﺛ) + تنعيم EWMA ⇒ لا يحجب حركةً صحيّةً عند ارتفاعٍ
 * لحظيّ (كنس GC، دفعة أصول). ويُعطَّل كلّياً بـ`EVENT_LOOP_MAX_LAG_MS=0`. لكلّ عاملٍ مرقابُه
 * الخاصّ (يراقب حلقة أحداثه هو) ⇒ صحيحٌ في العنقود بلا حالةٍ مشتركة.
 */

/**
 * مرقاب تأخّر حلقة الأحداث — بلا اعتمادية. مؤقّتٌ دوريّ يقيس انزياحه عن الفترة المتوقّعة؛
 * الانزياح الموجب = تأخّرٌ ناجم عن انشغال الحلقة. يُنعَّم بـEWMA كي لا تُطلقه شوكةٌ منفردة.
 * `.unref()` كي لا يمنع المؤقّت إغلاق العملية.
 */
export function startLagMonitor(sampleMs = 500): {
  lagMs: () => number;
  stop: () => void;
} {
  let lag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = Math.max(0, now - last - sampleMs);
    last = now;
    lag = lag * 0.5 + drift * 0.5; // EWMA
  }, sampleMs);
  timer.unref?.();
  return { lagMs: () => lag, stop: () => clearInterval(timer) };
}

/**
 * وسيط الحِمل الزائد — نقيّ وقابل للاختبار بحقن `lagMs`. عند تجاوز التأخّر العتبة يستدعي
 * `onShed` (الردّ يختلف حسب سطح tRPC)، وإلّا يمرّر. `maxLagMs ≤ 0` ⇒ مُعطَّل تماماً.
 */
export function createOverloadGuard(opts: {
  lagMs: () => number;
  maxLagMs: number;
  onShed: (req: Request, res: Response) => void;
  skip?: (req: Request) => boolean;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.maxLagMs <= 0) return next(); // مُعطَّل
    if (opts.skip?.(req)) return next(); // فحص صحّة/أصول/ويبهوكس لا تُحجَب
    if (opts.lagMs() > opts.maxLagMs) {
      opts.onShed(req, res);
      return;
    }
    next();
  };
}

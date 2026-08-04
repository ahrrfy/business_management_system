// استقصاء حالة بوابة العدّ عبر «نبضة» رخيصة بدل جلب الحالة الكاملة كل ٥ ثوانٍ.
//
// المشكلة (مقاسة على الإنتاج ٤/٨/٢٦): `count.state` يُجسّد كل أصناف الجلسة + كل عدّاتها +
// وحدات القياس وباركوداتها في كل نداء (~٨–١٥ ألف صفّ، ١٠٣ﻙﺐ للردّ على جلسةٍ من ٣٣٨٣ صنفاً).
// وباستقصائه كل ٥ ثوانٍ من كل عادّ صار **٩٤٪ من حركة الخادم** (١٤١ﻣﺐ خلال ٦٨ دقيقة) ودفع
// الذاكرة من ٣٠٠م إلى ٦٠٠م خلال دقيقة فضرب سقف PM2 وأعاد تشغيل الخادم ١٥–٢٣ مرّة/ساعة.
//
// الحل: تستقصي الواجهة `count.pulse` (وسمُ نسخةٍ من استعلامَي تجميعٍ مفهرسَين، ~عشرات البايتات)
// ولا تُبطِل `count.state` إلّا عند تبدّل الوسم. السلوك المرئيّ للعادّ لا يتغيّر: أي عدّة جديدة
// أو طلب إعادة عدّ يُبدّل الوسم فوراً فتصل التحديثات بنفس زمن الـ٥ ثوانٍ.
import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

/** فاصل الاستقصاء — نفس الإيقاع السابق كي لا تتأخّر التحديثات عمّا اعتاده العادّون. */
const PULSE_INTERVAL_MS = 5_000;

/**
 * شبكة أمان: تحديثٌ كامل إجباريّ كل دقيقتين مهما قالت النبضة.
 * البصمة لا تغطّي تعديلات الكتالوج (اسم منتج/باركود/وحدة تُحرَّر أثناء الجرد) — نادرة لكنها
 * ممكنة. هذا يجعل أسوأ تقادمٍ ممكن دقيقتين بدل «إلى الأبد»، بكلفة ~٣٠ نداءً كاملاً في الساعة
 * لكل عادّ بدل ٧٢٠. راجع حدود البصمة الموثَّقة في server/services/countPortal/state.ts.
 */
const FULL_REFRESH_MS = 120_000;

/**
 * يعيد استعلام `count.state` نفسه (بديلٌ مباشر) لكن محكوماً بالنبضة لا بمؤقّتٍ ثابت.
 * @param code   رمز الجلسة.
 * @param enabled هل الشاشة في طور العدّ فعلاً.
 */
export function usePulsedCountState(code: string, enabled: boolean) {
  const utils = trpc.useUtils();

  // بلا refetchInterval — لا يُعاد جلبها إلّا بإبطالٍ صريح (من النبضة أو من طفرة محلّية).
  const state = trpc.count.state.useQuery({ sessionCode: code }, { enabled, retry: false });

  const pulse = trpc.count.pulse.useQuery(
    { sessionCode: code },
    { enabled, retry: false, refetchInterval: PULSE_INTERVAL_MS },
  );

  const lastVersion = useRef<string | null>(null);
  const lastFullAt = useRef<number>(0);

  // التبعية `dataUpdatedAt` لا `data`: react-query يُبقي نفس المرجع عند تطابق المحتوى، فلو
  // اعتمدنا على `data` لما عمل المؤثِّر أصلاً حين لا يتغيّر الوسم — وهي الحالة الغالبة، وفيها
  // بالذات نحتاج التحقّق من شبكة الأمان.
  const pulseAt = pulse.dataUpdatedAt;
  const version = pulse.data?.v ?? null;

  useEffect(() => {
    if (!enabled || version == null) return;
    const now = Date.now();

    // أوّل نبضة بعد التحميل: الحالة الكاملة جُلبت للتوّ مع تركيب الشاشة ⇒ نتبنّى الوسم بلا
    // إبطال، وإلّا صار كل فتحِ شاشةٍ جلبتين متتاليتين بلا فائدة.
    if (lastVersion.current === null) {
      lastVersion.current = version;
      lastFullAt.current = now;
      return;
    }

    const changed = version !== lastVersion.current;
    const stale = now - lastFullAt.current >= FULL_REFRESH_MS;
    if (!changed && !stale) return;

    lastVersion.current = version;
    lastFullAt.current = now;
    void utils.count.state.invalidate({ sessionCode: code });
  }, [pulseAt, version, enabled, code, utils]);

  return state;
}

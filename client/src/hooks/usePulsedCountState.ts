// استقصاء حالة بوابة العدّ بنمط ETag + فصل الكتالوج الساكن عن الحالة المتغيّرة.
//
// المشكلة (مقاسة على الإنتاج ٤/٨/٢٦): `count.state` كان يُجسّد كل أصناف الجلسة + كل عدّاتها +
// وحدات القياس وباركوداتها في كل نداء (~٨–١٥ ألف صفّ، ١٠٣ﻙﺐ للردّ على جلسةٍ من ٣٤١٤ صنفاً).
// وباستقصائه كل ٥ ثوانٍ من كل عادّ صار **٩٤٪ من حركة الخادم** (١٤١ﻣﺐ خلال ٦٨ دقيقة) ودفع
// الذاكرة من ٣٠٠م إلى ٦٠٠م خلال دقيقة فضرب سقف PM2 وأعاد تشغيل الخادم ١٥–٢٣ مرّة/ساعة.
//
// طبقتا التوفير:
//   ① وسم النسخة `v`: ~٨٩٪ من الاستقصاءات لا تحمل تغييراً (معدّل الإرسال المقاس ١.٣٤/دقيقة)
//      ⇒ ردٌّ بعشرات البايتات.
//   ② وسم الكتالوج `cv`: حتى عند التغيّر، ٨٣٪ من الحمولة ساكنٌ (أسماء ٤٢٨ﻙﺐ + وحدات ٣٨٨ﻙﺐ
//      مقابل ١٦٤ﻙﺐ عدّات) ⇒ لا يُعاد إرساله، والمتغيّر وحده هو ما يتكرّر.
//
// لماذا استقصاءٌ أمريّ (imperative) لا `useQuery` ثانٍ: الوسمان يتبدّلان مع كل تحديث، ولو
// دخلا مفتاحَ الكاش لأنشآ مدخلاً جديداً في كل دورة ⇒ تضخّم بلا نهاية.
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  mergePortalState,
  type PortalCatalogItem,
  type PortalDynamic,
  type PortalState,
} from "@shared/countPortalMerge";

const POLL_MS = 5_000;

/**
 * شبكة أمان: تجاهل الوسمين كلّ دقيقتين واطلب كل شيء من جديد (بما فيه الكتالوج).
 * الوسم لا يغطّي تحرير الكتالوج نفسه (إعادة تسمية منتج/تبديل باركود أثناء الجرد) — نادر
 * لكنه ممكن. فأسوأ تقادمٍ ممكن دقيقتان بدل «إلى الأبد».
 */
const FULL_REFRESH_MS = 120_000;

/**
 * حالة بوابة العدّ. يعيد كائناً بواجهة استعلامٍ مألوفة (`data`/`isError`/`refetch`…) كي يبقى
 * بديلاً مباشراً لـ`trpc.count.state.useQuery`.
 *
 * @param code رمز الجلسة.
 * @param enabled هل الشاشة في طور العدّ فعلاً.
 * @param identityEpoch عدّادٌ يزيده المستدعي عند **كل تبدّل هوية** (دخول/خروج من البوابة).
 *   إلزاميّ للجهاز المشترك: مفتاح الكاش رمز الجلسة وحده، فبلا تصفيرٍ صريح يرى العادّ الجديد
 *   بيانات سابقه وكمياته (`myCount`) على أنّها له.
 */
export function usePulsedCountState(code: string, enabled: boolean, identityEpoch = 0) {
  const utils = trpc.useUtils();

  // المصدر المخبّأ — بلا وسوم فيردّ كل شيء عند التحميل الأول.
  const q = trpc.count.state.useQuery({ sessionCode: code }, { enabled, retry: false });

  const version = useRef<string | null>(null);
  const catalogVersion = useRef<string | null>(null);
  const catalog = useRef<PortalCatalogItem[] | null>(null);
  const merged = useRef<PortalState | null>(null);
  const lastFullAt = useRef<number>(0);
  const inFlight = useRef(false);
  /** جيل الهوية/الجلسة الحاليّ — ردٌّ من جيلٍ سابق يُرمى بدل أن يلوّث الحالة الجديدة. */
  const generation = useRef(0);

  const [tick, setTick] = useState(0);
  const [probeError, setProbeError] = useState<unknown>(null);
  const [probeErrorAt, setProbeErrorAt] = useState(0);
  const [probeOkAt, setProbeOkAt] = useState(0);

  /** يخزّن حمولةً كاملة (كتالوج + متغيّر) ويعيد تركيب الحالة المعروضة. */
  const absorb = useCallback(
    (v: string, cv: string | null, cat: PortalCatalogItem[] | null, dyn: PortalDynamic) => {
      if (cat) {
        catalog.current = cat;
        catalogVersion.current = cv;
        // ⚠️ الساعة تتقدّم **فقط** عند استلام كتالوجٍ فعليّ. لو تقدّمت مع كل ردٍّ متغيّرٍ
        // بلا كتالوج، لما صار `stale` صحيحاً أبداً في جردٍ نشط (تغيُّرٌ كل أقلّ من دقيقتين)
        // ⇒ تموت شبكة الأمان ويبقى منتجٌ أُعيدت تسميته قديماً **إلى الأبد** لا دقيقتين،
        // لأنّ تحرير الكتالوج غائبٌ عمداً عن الوسمين معاً.
        lastFullAt.current = Date.now();
      }
      const c = catalog.current;
      if (!c) return false;
      merged.current = mergePortalState(c, dyn);
      version.current = v;
      return true;
    },
    [],
  );

  // تبدّل الهوية ⇒ امسح كل أثرٍ للعادّ السابق قبل أن تُعرَض أي بيانات للجديد.
  useEffect(() => {
    generation.current += 1;
    version.current = null;
    catalogVersion.current = null;
    catalog.current = null;
    merged.current = null;
    lastFullAt.current = 0;
    setProbeError(null);
    void utils.count.state.reset();
  }, [identityEpoch, code, utils]);

  // البذرة الأولى من ردّ الاستعلام المخبّأ نفسه ⇒ لا سباق بين «لقطة» و«أول فحص»: الوسم
  // دائماً وسم البيانات المعروضة بالضبط.
  const seededAt = q.dataUpdatedAt;
  useEffect(() => {
    const d = q.data;
    if (!d?.changed || !d.dynamic) return;
    if (absorb(d.v, d.cv, d.catalog, d.dynamic)) setTick((n) => n + 1);
  }, [seededAt, q.data, absorb]);

  const probe = useCallback(async () => {
    if (!enabled || !code || inFlight.current) return;
    inFlight.current = true;
    // الجيل عند الإطلاق: لو تبدّلت الجلسة/الهوية أثناء الطيران، يُرمى الردّ كاملاً. بدونه
    // يكتب ردُّ الجلسة السابقة كتالوجها وحالتها في مراجع الجلسة الجديدة، فتُعرض بيانات
    // جلسةٍ أخرى ويُمكن أن يُتّخذ إجراءٌ عليها.
    const gen = generation.current;
    try {
      const stale = Date.now() - lastFullAt.current >= FULL_REFRESH_MS;
      const res = await utils.client.count.state.query({
        sessionCode: code,
        knownVersion: stale ? undefined : (version.current ?? undefined),
        knownCatalogVersion: stale ? undefined : (catalogVersion.current ?? undefined),
      });
      if (gen !== generation.current) return;
      setProbeError(null);
      setProbeOkAt(Date.now());

      // لا تغيير ⇒ لا عمل (وهي الحالة الغالبة: ~٨٩٪).
      if (!res.changed || !res.dynamic) {
        version.current = res.v;
        return;
      }
      // المؤشّرات لا تتقدّم إلّا بعد تركيبٍ ناجح فعلاً؛ وإن غاب الكتالوج (لم يُرسَل ولا مخزَّن)
      // نُصفّر الوسوم فتُطلَب حمولةٌ كاملة في الدورة التالية بدل عرض حالةٍ ناقصة.
      if (absorb(res.v, res.cv, res.catalog, res.dynamic)) setTick((n) => n + 1);
      else {
        version.current = null;
        catalogVersion.current = null;
      }
    } catch (e) {
      if (gen !== generation.current) return;
      // أخطاء الاستقصاء تُمرَّر للمستهلك: انتهاء صلاحية رمز البوابة يظهر هنا فقط (الاستعلام
      // المخبّأ يبقى «ناجحاً» ببياناتٍ قديمة)، وبدون تمريره لا يعود العادّ لشاشة PIN أبداً.
      setProbeError(e);
      setProbeErrorAt(Date.now());
    } finally {
      inFlight.current = false;
    }
  }, [code, enabled, utils, absorb]);

  useEffect(() => {
    if (!enabled || !code) return;
    const id = setInterval(() => void probe(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, code, probe]);

  void tick; // إعادة الرسم تأتي من setTick؛ القراءة من المرجع المستقرّ.
  const data = merged.current ?? undefined;
  // بعد أوّل تركيبٍ ناجح تسقط أخطاء الاستعلام الأوّليّ من الحساب: لم نعد نكتب نتائج
  // الاستقصاء في كاش الاستعلام، فيبقى `q.isError` عالقاً على فشلٍ عابرٍ قديم. لو أبقيناه
  // لأبلغنا نجاحاً وخطأً معاً، **ولحجب خطأٌ شبكيّ قديم خطأً لاحقاً أهمّ** مثل انتهاء
  // صلاحية الرمز (UNAUTHORIZED) الذي يُعيد العادّ إلى شاشة PIN.
  const settled = merged.current != null;
  const isError = settled ? probeError != null : q.isError || probeError != null;

  return {
    data,
    isLoading: q.isLoading && !settled,
    isSuccess: (q.isSuccess || settled) && !probeError,
    isError,
    error: settled ? probeError : (q.error ?? probeError),
    dataUpdatedAt: Math.max(q.dataUpdatedAt, probeOkAt),
    errorUpdatedAt: Math.max(q.errorUpdatedAt, probeErrorAt),
    refetch: async () => {
      setProbeError(null);
      version.current = null;
      catalogVersion.current = null;
      catalog.current = null;
      merged.current = null;
      lastFullAt.current = 0;
      return q.refetch();
    },
  };
}

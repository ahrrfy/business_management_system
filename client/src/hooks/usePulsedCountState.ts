// استقصاء حالة بوابة العدّ بنمط ETag: يُرسَل وسم النسخة المعروف، فيردّ الخادم «بلا تغيير»
// رخيصاً بدل إعادة إرسال الحالة الكاملة كل ٥ ثوانٍ.
//
// المشكلة (مقاسة على الإنتاج ٤/٨/٢٦): `count.state` يُجسّد كل أصناف الجلسة + كل عدّاتها +
// وحدات القياس وباركوداتها في كل نداء (~٨–١٥ ألف صفّ، ١٠٣ﻙﺐ للردّ على جلسةٍ من ٣٣٨٣ صنفاً).
// وباستقصائه كل ٥ ثوانٍ من كل عادّ صار **٩٤٪ من حركة الخادم** (١٤١ﻣﺐ خلال ٦٨ دقيقة) ودفع
// الذاكرة من ٣٠٠م إلى ٦٠٠م خلال دقيقة فضرب سقف PM2 وأعاد تشغيل الخادم ١٥–٢٣ مرّة/ساعة.
// معدّل الإرسال المقاس ١.٣٤ عدّة/دقيقة ⇒ ~٨٩٪ من الاستقصاءات لا تحمل تغييراً أصلاً.
//
// لماذا استقصاءٌ أمريّ (imperative) لا `useQuery` ثانٍ: `knownVersion` يتبدّل مع كل تحديث،
// ولو دخل مفتاحَ الكاش لأنشأ مدخلاً جديداً في كل دورة. فالمفتاح المخبّأ يبقى `{sessionCode}`
// وحده، ونحن نضخّ فيه النتيجة بـ`setData` عند التغيّر — جولةٌ واحدة، بلا إعادة جلبٍ ثانية.
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type StateResponse = RouterOutputs["count"]["state"];
type PortalState = NonNullable<StateResponse["state"]>;

const POLL_MS = 5_000;

/**
 * شبكة أمان: تجاهل الوسم كلّ دقيقتين واطلب الحالة كاملةً.
 * البصمة لا تغطّي تعديلات الكتالوج (اسم منتج/باركود يُحرَّر أثناء الجرد) — نادرة لكن ممكنة.
 * فأسوأ تقادمٍ ممكن دقيقتان بدل «إلى الأبد».
 */
const FULL_REFRESH_MS = 120_000;

/**
 * حالة بوابة العدّ، محكومةً بوسم النسخة. يعيد كائناً بواجهة استعلامٍ مألوفة
 * (`data`/`isError`/`refetch`…) كي يبقى بديلاً مباشراً لـ`trpc.count.state.useQuery`.
 *
 * @param code رمز الجلسة.
 * @param enabled هل الشاشة في طور العدّ فعلاً.
 * @param identityEpoch عدّادٌ يزيده المستدعي عند **كل تبدّل هوية** (دخول/خروج من البوابة).
 *   إلزاميّ للجهاز المشترك: مفتاح الكاش رمز الجلسة وحده، فبلا تصفيرٍ صريح يرى العادّ الجديد
 *   بيانات سابقه وكمياته (`myCount`) على أنّها له.
 */
export function usePulsedCountState(code: string, enabled: boolean, identityEpoch = 0) {
  const utils = trpc.useUtils();

  // المصدر المخبّأ الوحيد للحالة الكاملة — بلا `knownVersion` فيردّ الحالة كاملةً عند التحميل.
  const q = trpc.count.state.useQuery({ sessionCode: code }, { enabled, retry: false });

  const version = useRef<string | null>(null);
  const lastFullAt = useRef<number>(0);
  const inFlight = useRef(false);
  const [probeError, setProbeError] = useState<unknown>(null);
  const [probeErrorAt, setProbeErrorAt] = useState(0);
  const [probeOkAt, setProbeOkAt] = useState(0);

  // تبدّل الهوية ⇒ امسح كل أثرٍ للعادّ السابق قبل أن تُعرَض أي بيانات للجديد.
  useEffect(() => {
    version.current = null;
    lastFullAt.current = 0;
    setProbeError(null);
    void utils.count.state.reset();
  }, [identityEpoch, code, utils]);

  // وسم النسخة يُلتقط من ردّ الاستعلام المخبّأ نفسه (لا من نداءٍ منفصل) ⇒ لا سباق بين
  // «لقطة الحالة» و«أوّل نبضة»: الوسم دائماً هو وسم البيانات المعروضة بالضبط.
  const cachedVersion = q.data?.v ?? null;
  const cachedChanged = q.data?.changed ?? false;
  useEffect(() => {
    if (cachedVersion && cachedChanged) {
      version.current = cachedVersion;
      lastFullAt.current = Date.now();
    }
  }, [cachedVersion, cachedChanged]);

  const probe = useCallback(async () => {
    if (!enabled || !code || inFlight.current) return;
    inFlight.current = true;
    try {
      const stale = Date.now() - lastFullAt.current >= FULL_REFRESH_MS;
      const known = stale ? undefined : (version.current ?? undefined);
      const res = await utils.client.count.state.query({ sessionCode: code, knownVersion: known });
      setProbeError(null);
      setProbeOkAt(Date.now());
      if (res.changed && res.state) {
        // نضخّ الردّ في الكاش مباشرةً — لا إعادة جلبٍ ثانية، والمؤشّرات لا تتقدّم إلّا بعد
        // نجاحٍ فعليّ (لو فشل النداء بقينا على الوسم القديم فأعدنا المحاولة بعد ٥ ثوانٍ،
        // بدل كتم التحديث دقيقتين على بياناتٍ لم تُحدَّث).
        utils.count.state.setData({ sessionCode: code }, res);
        version.current = res.v;
        lastFullAt.current = Date.now();
      } else {
        version.current = res.v;
      }
    } catch (e) {
      // أخطاء الاستقصاء تُمرَّر للمستهلك: انتهاء صلاحية رمز البوابة يظهر هنا فقط (الاستعلام
      // المخبّأ يبقى «ناجحاً» ببياناتٍ قديمة)، وبدون تمريره لا يعود العادّ لشاشة PIN أبداً.
      setProbeError(e);
      setProbeErrorAt(Date.now());
    } finally {
      inFlight.current = false;
    }
  }, [code, enabled, utils]);

  useEffect(() => {
    if (!enabled || !code) return;
    const id = setInterval(() => void probe(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, code, probe]);

  const data: PortalState | undefined = q.data?.state ?? undefined;
  const isError = q.isError || probeError != null;
  const error = q.error ?? probeError;

  return {
    data,
    isLoading: q.isLoading,
    isSuccess: q.isSuccess && !probeError,
    isError,
    error,
    dataUpdatedAt: Math.max(q.dataUpdatedAt, probeOkAt),
    errorUpdatedAt: Math.max(q.errorUpdatedAt, probeErrorAt),
    refetch: async () => {
      setProbeError(null);
      version.current = null;
      lastFullAt.current = 0;
      return q.refetch();
    },
  };
}

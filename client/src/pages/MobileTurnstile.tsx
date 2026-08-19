import { useCallback, useState } from "react";
import { ShieldCheck, RefreshCw } from "lucide-react";

import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";
import { trpc } from "@/lib/trpc";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/**
 * صفحة عامة ضيقة لتحدي الطلب في التطبيق الأصلي. لا تعرض الكتالوج أو نموذج الطلب أو بيانات
 * العميل؛ وظيفتها الوحيدة هي تشغيل Turnstile على alarabiya.online وإرجاع رمز أحادي الاستعمال.
 */
export default function MobileTurnstile() {
  const settings = trpc.storefront.settings.useQuery(undefined, { staleTime: 60_000, retry: 1 });
  const [resetKey, setResetKey] = useState(0);
  const [complete, setComplete] = useState(false);

  const sendToken = useCallback((token: string | null) => {
    if (!token) {
      setComplete(false);
      return;
    }
    // لا يكتب الرمز في localStorage أو query-string أو console. لا يُرسل إلا لجسر WebView الأصلي.
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token }));
    setComplete(true);
  }, []);

  const siteKey = settings.data?.turnstileSiteKey;
  const enabled = settings.data?.orderingEnabled === true && !!siteKey;

  return (
    <main dir="rtl" className="min-h-screen bg-emerald-50 px-4 py-8 text-slate-900">
      <section className="mx-auto max-w-md rounded-3xl bg-white p-6 shadow-sm ring-1 ring-emerald-100">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-emerald-600 text-white"><ShieldCheck className="size-6" /></span>
          <div>
            <h1 className="text-lg font-extrabold">تحقق أمان الطلب</h1>
            <p className="mt-0.5 text-xs font-medium text-slate-500">مكتبة العربية</p>
          </div>
        </div>
        {settings.isLoading && <p className="text-sm font-medium text-slate-600">جارٍ تجهيز التحقق الآمن…</p>}
        {settings.isError && <p className="rounded-xl bg-rose-50 p-3 text-sm font-bold text-rose-700">تعذر الاتصال بخدمة الأمان. أعد المحاولة بعد التحقق من الإنترنت.</p>}
        {settings.isSuccess && !enabled && <p className="rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800">إرسال الطلبات غير متاح مؤقتاً. يمكن العودة للتطبيق والمحاولة لاحقاً.</p>}
        {enabled && !complete && <TurnstileWidget siteKey={siteKey!} resetKey={resetKey} onTokenChange={sendToken} />}
        {enabled && complete && <div className="rounded-2xl bg-emerald-50 p-4 text-center text-sm font-extrabold text-emerald-800">اكتمل التحقق. يمكنك العودة إلى التطبيق لإرسال الطلب.</div>}
        <button type="button" onClick={() => { setComplete(false); setResetKey((value) => value + 1); }} className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-emerald-700 hover:text-emerald-900"><RefreshCw className="size-3.5" /> إعادة التحقق</button>
      </section>
    </main>
  );
}

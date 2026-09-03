import {
  noteRequestFailure,
  noteRequestSuccess,
} from "@/lib/offline/connectivity";
import { screenAttributionHeaders } from "@/lib/screenAttribution";
import { trpc } from "@/lib/trpc";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";

/** ناقل tRPC الواحد للمتصفح؛ مفصول عن نقطة الرسم كي يُختبر بعقد HTTP حقيقي. */
export function createErpTrpcClient(
  attributionHeaders: () => Record<string, string> = screenAttributionHeaders,
) {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        // الاستعلامات ذات المدخلات الكبيرة (مثل معاينة أسعار 115 بطاقة) لا يجوز وضعها
        // في عنوان GET: حد سطر الطلب أمام Nginx/HTTP2 أقصر من الحمولة. POST يبقي العملية
        // Query خالصة دلالياً وينقل المدخلات إلى الجسم ذي الحد المضبوط في bodyParsers.
        methodOverride: "POST",
        // Helmet يمنع Referer عمداً؛ نرسل pathname وحده (بلا query/أسرار) لربط الحركة
        // بالشاشة. الخادم يعرضه كمسار مُبلّغ عنه، واسم إجراء tRPC يبقى الحقيقة السلطوية.
        headers: () => ({
          "X-ERP-CSRF": "1",
          ...attributionHeaders(),
        }),
        // كل نداء tRPC يغذّي كاشف الاتصال: وصول أي ردّ HTTP (ولو 4xx/5xx) = الشبكة والخادم
        // موصولان؛ رفض fetch نفسه (بلا ردّ) = انقطاع. AbortError إلغاء داخلي لا إشارة شبكة.
        fetch(input, init) {
          return fetch(input, { ...(init ?? {}), credentials: "include" }).then(
            (res) => {
              noteRequestSuccess();
              return res;
            },
            (err: unknown) => {
              if (!(err instanceof DOMException && err.name === "AbortError")) {
                noteRequestFailure();
              }
              throw err;
            },
          );
        },
      }),
    ],
  });
}

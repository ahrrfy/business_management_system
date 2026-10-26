import {
  noteRequestFailure,
  noteRequestSuccess,
} from "@/lib/offline/connectivity";
import { screenAttributionHeaders } from "@/lib/screenAttribution";
import {
  fetchWithStorefrontDeadline,
  shouldRetryStorefrontCreateOrder,
} from "@/lib/storefrontRequestPolicy";
import { trpc } from "@/lib/trpc";
import { httpBatchLink, httpLink, retryLink, splitLink } from "@trpc/client";
import superjson from "superjson";

/**
 * الإجراءات الحساسة لمتجر الواجهة العامة (تطابق server/middleware/publicSensitiveBatch.ts):
 * ترسل عبر httpLink منفرداً بلا تجميع حتى:
 *  ١) يطابق رفع أصول التخصيص `/storefront.uploadCustomizationAsset` في bodyParsers (سقف 3MB) بلا 413.
 *  ٢) لا تتصادم عمليتان حساستان في نفس الـ microtask أمام rejectMixedPublicSensitiveTrpcBatch (400).
 */
const NON_BATCHED_STOREFRONT_PROCEDURES: ReadonlySet<string> = new Set([
  "storefront.createOrder",
  "storefront.createQuoteRequest",
  "storefront.quoteOrder",
  "storefront.quoteOrderPrivate",
  "storefront.trackBanner",
  "storefront.trackConversion",
  "storefront.trackOrder",
  "storefront.trackOrderPrivate",
  "storefront.trackOrderByToken",
  "storefront.trackQuoteRequestPrivate",
  "storefront.trackQuoteRequestByToken",
  "storefront.acceptQuoteRequestPrivate",
  "storefront.acceptQuoteRequestByToken",
  "storefront.requestFirstOrderCoupon",
  "storefront.cancelOrderPrivate",
  "storefront.cancelOrderByToken",
  "storefront.shelfLookup",
  "storefront.claimFirebaseCustomer",
  "storefront.submitPublicProductReview",
  "storefront.createWishlistShare",
  "storefront.createCartShare",
  "storefront.registerPushDevice",
  "storefront.deleteMe",
  "storefront.requestAccountDeletion",
  "storefront.uploadCustomizationAsset",
  "storefront.redeemLoyaltyPoints",
]);

export function isNonBatchedStorefrontProcedure(path: string): boolean {
  return NON_BATCHED_STOREFRONT_PROCEDURES.has(path);
}

/** ناقل tRPC الواحد للمتصفح؛ مفصول عن نقطة الرسم كي يُختبر بعقد HTTP حقيقي. */
export function createErpTrpcClient(
  attributionHeaders: () => Record<string, string> = screenAttributionHeaders,
) {
  // كل نداء tRPC يغذّي كاشف الاتصال: وصول أي ردّ HTTP (ولو 4xx/5xx) = الشبكة والخادم
  // موصولان؛ رفض fetch نفسه (بلا ردّ) = انقطاع. AbortError إلغاء داخلي لا إشارة شبكة.
  const trpcFetch: NonNullable<Parameters<typeof httpLink>[0]["fetch"]> = (
    input,
    init,
  ) =>
    fetchWithStorefrontDeadline(
      (target, requestInit) =>
        globalThis.fetch(target, {
          ...(requestInit ?? {}),
          credentials: "include",
        }),
      input,
      init as RequestInit | undefined,
    ).then(
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

  const sharedHttpOptions = {
    url: "/api/trpc",
    transformer: superjson,
    // الاستعلامات ذات المدخلات الكبيرة (مثل معاينة أسعار 115 بطاقة) لا يجوز وضعها
    // في عنوان GET: حد سطر الطلب أمام Nginx/HTTP2 أقصر من الحمولة. POST يبقي العملية
    // Query خالصة دلالياً وينقل المدخلات إلى الجسم ذي الحد المضبوط في bodyParsers.
    methodOverride: "POST" as const,
    // Helmet يمنع Referer عمداً؛ نرسل pathname وحده (بلا query/أسرار) لربط الحركة
    // بالشاشة. الخادم يعرضه كمسار مُبلّغ عنه، واسم إجراء tRPC يبقى الحقيقة السلطوية.
    headers: () => ({
      "X-ERP-CSRF": "1",
      ...attributionHeaders(),
    }),
    fetch: trpcFetch,
  };

  return trpc.createClient({
    links: [
      retryLink({
        retry({ op, attempts, error }) {
          const httpStatus = (
            error.data as { httpStatus?: number } | null | undefined
          )?.httpStatus;
          return shouldRetryStorefrontCreateOrder({
            path: op.path,
            attempts,
            httpStatus,
          });
        },
        retryDelayMs: () => 600,
      }),
      splitLink({
        condition: (op) => isNonBatchedStorefrontProcedure(op.path),
        true: httpLink(sharedHttpOptions),
        false: httpBatchLink(sharedHttpOptions),
      }),
    ],
  });
}

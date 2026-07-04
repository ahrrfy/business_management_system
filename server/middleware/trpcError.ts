import type { Request, Response } from "express";

/**
 * أرقام أكواد الأخطاء في بروتوكول tRPC (JSON-RPC — آخر خانات HTTP 4xx).
 * منسوخة قصداً بدل الاستيراد من `@trpc/server/unstable-core-do-not-import`
 * (مسار داخلي غير مستقر بين الإصدارات) — القيم نفسها جزء ثابت من بروتوكول tRPC v11.
 */
const TRPC_ERROR_CODES = {
  BAD_REQUEST: -32600,
  FORBIDDEN: -32003,
  PAYLOAD_TOO_LARGE: -32013,
  TOO_MANY_REQUESTS: -32029,
  INTERNAL_SERVER_ERROR: -32603,
} as const;

export type TrpcHttpErrorCode = keyof typeof TRPC_ERROR_CODES;

/**
 * يرسل خطأ HTTP من وسيط Express بالغلاف الذي يفهمه عميل tRPC (httpBatchLink + superjson).
 *
 * لماذا؟ أي وسيط كان يعيد `{"error":"نص"}` عارياً على /api/trpc (حارس CSRF، محدِّدات
 * المعدّل، حارس حشو الدفعات) يجعل عميل tRPC يرمي «Unable to transform response from
 * server» — رسالة إنجليزية غامضة تحجب السبب الحقيقي عن المستخدم (علّة تعذّر الدخول من
 * متصفح اللوحي، ٤/٧/٢٠٢٦). بهذا الغلاف تصل الرسالة العربية نفسها لواجهة المستخدم.
 *
 * الشكل كائن واحد لا مصفوفة: httpBatchLink يطبّق الكائن غير المصفوفي على كل عناصر
 * الدفعة (`Array.isArray(json) ? json : ops.map(() => json)`) ⇒ يصلح للنداء المفرد
 * والدفعات معاً. حقل `json` هو غلاف superjson الذي يفكّه `transformer.output.deserialize`.
 */
export function sendTrpcError(
  res: Response,
  opts: { httpStatus: number; code: TrpcHttpErrorCode; message: string }
): void {
  res.status(opts.httpStatus).json({
    error: {
      json: {
        message: opts.message,
        code: TRPC_ERROR_CODES[opts.code],
        data: { code: opts.code, httpStatus: opts.httpStatus },
      },
    },
  });
}

/** هل الطلب على سطح tRPC؟ (يقرّر شكل الخطأ: غلاف tRPC أم `{error}` العارية) */
export function isTrpcSurface(req: Request): boolean {
  return req.baseUrl.startsWith("/api/trpc") || req.path.startsWith("/api/trpc");
}

/**
 * ردّ 429 موحَّد لمحدِّدات المعدّل (express-rate-limit `handler`): على /api/trpc بغلاف
 * tRPC الذي يفهمه العميل، وعلى بقية الأسطح `{error}` العارية كما كانت. مُستخرَج هنا
 * (لا مُغلَق داخل startServer) ليكون قابلاً للاختبار وحدةً — سدّ فجوة كشفتها المراجعة
 * العدائية: محدِّد جديد مستقبلاً بمعالج عارٍ ما كان ليُكتشَف آلياً.
 */
export function trpcAwareRateLimitHandler(message: string) {
  return (req: Request, res: Response): void => {
    if (isTrpcSurface(req)) {
      sendTrpcError(res, { httpStatus: 429, code: "TOO_MANY_REQUESTS", message });
    } else {
      res.status(429).json({ error: message });
    }
  };
}

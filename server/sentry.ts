// مراقبة أخطاء الخادم عبر Sentry — اختيارية: بلا أثر إطلاقاً ما لم يُضبط SENTRY_DSN_SERVER.
// تُستدعى initSentry() أوّل سطر في index.ts (قبل أي middleware).
import * as Sentry from "@sentry/node";

let enabled = false;

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN_SERVER;
  if (!dsn) return false; // غير مضبوط ⇒ لا تفعيل (تطوير/متجر بلا حساب Sentry).

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0),
    // تجريد PII قبل الإرسال: لا نُرسل أرقام هواتف/أسماء عملاء/أجساد طلبات.
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          delete event.request.headers.cookie;
          delete event.request.headers.authorization;
        }
      }
      return event;
    },
  });
  enabled = true;
  return true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export { Sentry };

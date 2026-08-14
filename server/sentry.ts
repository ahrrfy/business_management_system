// مراقبة أخطاء الخادم عبر Sentry — اختيارية: بلا أثر إطلاقاً ما لم يُضبط SENTRY_DSN_SERVER.
// تُستدعى initSentry() أوّل سطر في index.ts (قبل أي middleware).
import * as Sentry from "@sentry/node";

let enabled = false;

type RedactableSentryEvent = {
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string | undefined>;
  };
};

const PRIVATE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-internal-proxy-secret",
]);

/** Mutates the outgoing event immediately before transport; header names are case-insensitive. */
export function redactSentryEvent<T extends RedactableSentryEvent>(event: T): T {
  if (!event.request) return event;
  delete event.request.cookies;
  delete event.request.data;
  if (event.request.headers) {
    for (const name of Object.keys(event.request.headers)) {
      if (PRIVATE_REQUEST_HEADERS.has(name.toLowerCase())) {
        delete event.request.headers[name];
      }
    }
  }
  return event;
}

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN_SERVER;
  if (!dsn) return false; // غير مضبوط ⇒ لا تفعيل (تطوير/متجر بلا حساب Sentry).

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0),
    // تجريد PII قبل الإرسال: لا نُرسل أرقام هواتف/أسماء عملاء/أجساد طلبات.
    beforeSend: redactSentryEvent,
  });
  enabled = true;
  return true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export { Sentry };

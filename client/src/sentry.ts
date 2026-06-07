// مراقبة أخطاء العميل عبر Sentry — اختيارية وبتحميل ديناميكي:
// لا تُحمَّل المكتبة في الحزمة إطلاقاً ما لم يُضبط VITE_SENTRY_DSN_CLIENT (٠ أثر على الـbundle).
//
// التركيب (تسليم لقائد الدمج): أضف سطراً واحداً أعلى main.tsx:
//   import "./sentry";

const dsn = import.meta.env.VITE_SENTRY_DSN_CLIENT as string | undefined;

if (dsn) {
  // dynamic import ⇒ chunk منفصل يُحمَّل فقط عند وجود DSN.
  import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: import.meta.env.MODE,
        tracesSampleRate: 0,
        // تجريد PII: لا نُرسل قيم الحقول الحسّاسة.
        beforeSend(event) {
          if (event.request) {
            delete event.request.cookies;
            delete event.request.data;
          }
          return event;
        },
      });
    })
    .catch(() => {
      /* فشل تحميل Sentry لا يجب أن يكسر التطبيق */
    });
}

export {};

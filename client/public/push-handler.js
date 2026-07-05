// معالج Web Push — يُحقن في SW المولَّد بواسطة workbox عبر importScripts (vite.config.ts).
// نتَعامل مع حدثَي 'push' (وصول إشعار) و'notificationclick' (نقرة المستخدم).
//
// يعمل داخل ServiceWorkerGlobalScope — لا DOM، لا نوافذ. Console متاح.
// eslint-disable-next-line no-undef -- self هو ServiceWorkerGlobalScope هنا
/* global self, clients */

/** حارس نفس-المصدر: يُعيد مساراً نسبيّاً آمناً حتى لو حاول payload تسرّب javascript:/https://phish/.
 *  آخر خطّ دفاع — يجب أن يُبنى الـURL على الخادم أصلاً بلا مدخلات مستخدم، لكن SW يبقى الحارس الأخير. */
function safePath(u) {
  if (typeof u !== "string" || u.length === 0) return "/dashboard";
  // مسار نسبيّ حصراً: يبدأ بـ/ ولا يبدأ بـ// (شبكة protocol-relative).
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return "/dashboard";
}

self.addEventListener("push", (event) => {
  // بيانات الإشعار — نتوقّع JSON من خدمة pushService.ts في الخادم.
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const title = payload?.title || "الرؤية العربية";
  const body = payload?.body || "لديك متابعة اليوم.";
  const url = safePath(payload?.url);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      dir: "rtl",
      lang: "ar",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // النقر يفتح URL؛ tag يمنع تراكم عدّة إشعارات صباحية بنفس اليوم إن حدث سباق.
      tag: payload?.kind || "brief",
      renotify: false,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // أعِد استعمال نافذة موجودة لتطبيقنا إن أمكن (يفضّل المستخدم عدم تكديس تبويبات).
      for (const w of wins) {
        try {
          const wu = new URL(w.url);
          if (wu.origin === self.location.origin) {
            w.focus();
            if ("navigate" in w) {
              try {
                w.navigate(url);
              } catch {
                // بعض المتصفّحات لا تدعم navigate على العميل — يبقى focus فقط.
              }
            }
            return;
          }
        } catch {
          // تجاهل عناوين غير صالحة (نادرة).
        }
      }
      // لا نافذة مفتوحة ⇒ افتح جديدة على /dashboard.
      if (clients.openWindow) return clients.openWindow(url);
    }),
  );
});

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
  const body = payload?.body || "لديك متابعة جديدة في النظام.";
  const url = safePath(payload?.url);

  // تحديث عداد الشارة على أيقونة التطبيق في الشاشة الرئيسية إن كان متاحاً
  if (typeof self.navigator !== "undefined" && "setAppBadge" in self.navigator) {
    if (typeof payload?.badgeCount === "number" && payload.badgeCount > 0) {
      self.navigator.setAppBadge(payload.badgeCount).catch(() => {});
    }
  }

  const notificationOptions = {
    body,
    dir: "rtl",
    lang: "ar",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // نمط اهتزاز ملموس يعطي الهاتف إحساس التنبيه الأصلي
    vibrate: [150, 80, 150, 80, 250],
    // tag موحّد حسب نوع الإشعار أو فريد؛ يمنع التراكم المزعج
    tag: payload?.tag || payload?.kind || `notif_${Date.now()}`,
    renotify: Boolean(payload?.tag || payload?.kind),
    data: {
      url,
      kind: payload?.kind || "SYSTEM",
      receivedAt: Date.now(),
    },
    sound: "/notification.wav",
    // أزرار إجراءات سريعة على شاشة القفل ومركز الإشعارات
    actions: [
      { action: "open", title: "عرض" },
      { action: "dismiss", title: "تجاهل" },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, notificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // إن كان النقر على زر "تجاهل" نكتفي بالإغلاق دون فتح التطبيق
  if (event.action === "dismiss") return;

  const url = safePath(event.notification.data && event.notification.data.url);

  // تصفير عداد الشارة عند فتح الإشعار
  if (typeof self.navigator !== "undefined" && "clearAppBadge" in self.navigator) {
    self.navigator.clearAppBadge().catch(() => {});
  }

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
                w.postMessage({ type: "PUSH_NAVIGATE", url });
              }
            } else {
              w.postMessage({ type: "PUSH_NAVIGATE", url });
            }
            return;
          }
        } catch {
          // تجاهل عناوين غير صالحة (نادرة).
        }
      }
      // لا نافذة مفتوحة ⇒ افتح جديدة على المسار المطلوب.
      if (clients.openWindow) return clients.openWindow(url);
    }),
  );
});

/**
 * ====================================
 * Service Worker للتطبيق
 * ====================================
 * 
 * يوفر:
 * - العمل بدون إنترنت
 * - تخزين مؤقت للبيانات
 * - تحديثات تلقائية
 * - إشعارات
 */

const CACHE_VERSION = "v1.0.0";
const CACHE_NAME = `erp-system-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192x192.png",
  "/icon-512x512.png",
];

// تثبيت Service Worker
self.addEventListener("install", (event) => {
  console.log("[Service Worker] Installing...");

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching app shell");
      return cache.addAll(URLS_TO_CACHE);
    })
  );

  self.skipWaiting();
});

// تفعيل Service Worker
self.addEventListener("activate", (event) => {
  console.log("[Service Worker] Activating...");

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log("[Service Worker] Deleting old cache:", cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );

  self.clients.claim();
});

// معالجة الطلبات
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // تخطي الطلبات غير GET
  if (request.method !== "GET") {
    return;
  }

  // تخطي الطلبات إلى API
  if (request.url.includes("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // حفظ نسخة من الاستجابة
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // في حالة عدم وجود إنترنت، استخدم النسخة المخزنة
          return caches.match(request);
        })
    );
    return;
  }

  // للملفات الثابتة، استخدم Cache First
  event.respondWith(
    caches.match(request).then((response) => {
      if (response) {
        return response;
      }

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === "error") {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseToCache);
        });

        return response;
      });
    })
  );
});

// معالجة الرسائل من العميل
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data && event.data.type === "CLIENTS_CLAIM") {
    self.clients.claim();
  }
});

// معالجة الإشعارات
self.addEventListener("push", (event) => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body || "إشعار جديد",
      icon: "/icon-192x192.png",
      badge: "/icon-96x96.png",
      tag: data.tag || "notification",
      requireInteraction: data.requireInteraction || false,
    };

    event.waitUntil(
      self.registration.showNotification(data.title || "إشعار", options)
    );
  }
});

// معالجة نقر الإشعارات
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // ابحث عن نافذة مفتوحة بالفعل
      for (let client of clientList) {
        if (client.url === "/" && "focus" in client) {
          return client.focus();
        }
      }
      // إذا لم تكن هناك نافذة مفتوحة، افتح واحدة جديدة
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url || "/");
      }
    })
  );
});

console.log("[Service Worker] Loaded");

// بروتوكول تفعيل تحديث الـPWA. يُحمَّل داخل Service Worker عبر importScripts.
// الإقرار يعني أن العامل المنتظر استلم الطلب وأن skipWaiting قُبل؛ العميل لا
// يعيد فتح الصفحة إلا بعد أن يرى العامل نفسه active فعلياً.
/* global self */
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "PWA_ACTIVATE") return;

  const requestId =
    typeof event.data.requestId === "string"
      ? event.data.requestId.slice(0, 128)
      : "";
  const replyPort = event.ports && event.ports[0];
  const activation = self.skipWaiting();

  event.waitUntil(
    activation
      .then(() => {
        if (replyPort) {
          replyPort.postMessage({
            type: "PWA_ACTIVATION_ACCEPTED",
            requestId,
          });
        }
      })
      .catch(() => {
        if (replyPort) {
          replyPort.postMessage({
            type: "PWA_ACTIVATION_REJECTED",
            requestId,
          });
        }
      }),
  );
});

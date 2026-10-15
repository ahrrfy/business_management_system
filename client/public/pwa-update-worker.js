// بروتوكول تفعيل تحديث الـPWA. يُحمَّل داخل Service Worker عبر importScripts.
// الإقرار يعني أن العامل المنتظر استلم الطلب وأن skipWaiting قُبل؛ العميل لا
// يعيد فتح الصفحة إلا بعد أن يرى العامل نفسه active فعلياً.
/* global self */
let activationRequest = null;

function activateAfterStreamRelease() {
  if (activationRequest) return activationRequest;
  const request = Promise.resolve().then(async () => {
    // العامل القديم قد يحتجز جسماً متدفقاً عبر NetworkOnly. نحرر قناة هذا
    // الحساب عبر العمال قبل التفعيل؛ لا نمس البيانات أو التسجيل أو التخزين.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 2_000);
    try {
      await fetch("/api/realtime/pwa-quiesce", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-erp-csrf": "1",
        },
        body: "{}",
        signal: abort.signal,
      });
    } catch {
      // تحرير الخادم مسرِّع مساعد إلى جانب تعليق العميل المحلي؛ أي فشل عابر
      // أثناء إعادة تشغيل الخادم لا يجوز أن يمنع skipWaiting من التسلّح.
    } finally {
      clearTimeout(timeout);
      if (activationRequest === request) activationRequest = null;
    }
    await self.skipWaiting();
  });
  activationRequest = request;
  return request;
}

self.addEventListener("message", (event) => {
  if (
    !event.data ||
    !["PWA_ACTIVATE", "SKIP_WAITING"].includes(event.data.type)
  )
    return;
  try {
    if (
      event.source?.url &&
      new URL(event.source.url).origin !== self.location.origin
    )
      return;
  } catch {
    return;
  }
  // importScripts يسبق مستمع Workbox المولّد؛ ننسق التحرير قبل skipWaiting.
  event.stopImmediatePropagation();

  const requestId =
    typeof event.data.requestId === "string"
      ? event.data.requestId.slice(0, 128)
      : "";
  const replyPort = event.ports && event.ports[0];
  const activation = activateAfterStreamRelease();

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

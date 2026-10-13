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
      const response = await fetch("/api/realtime/pwa-quiesce", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: abort.signal,
      });
      // 401 يؤكد المتجر المجهول؛ ليس له تدفق مصادق يمكن تحريره بهذه الجلسة.
      if (!response.ok && response.status !== 401)
        throw new Error("PWA_STREAM_RELEASE_FAILED");
    } catch (error) {
      // انقطاع المتصفح نفسه ينهي التدفقات؛ أما فشل الخادم العابر فيبقى قابلاً للإعادة.
      if (self.navigator?.onLine !== false) throw error;
    } finally {
      clearTimeout(timeout);
      // ندمج طلبات التحرير المتزامنة فقط؛ قد يبقى skipWaiting معلقاً،
      // لذلك يجب أن تسمح المحاولة اللاحقة بطلب HTTP جديد بعد تعافي الشبكة.
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
  // importScripts يسبق مستمع Workbox المولّد؛ لا نسمح له بتجاوز حاجز التحرير.
  event.stopImmediatePropagation();
  try {
    if (
      !event.source?.url ||
      new URL(event.source.url).origin !== self.location.origin
    )
      return;
  } catch {
    return;
  }

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

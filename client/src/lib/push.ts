// مساعد Web Push للعميل — فحص الدعم + طلب الإذن + الاشتراك عبر PushManager + التسليم للخادم.
//
// يفترض أنّ VitePWA قد سجّل SW أصلاً (registerType: 'autoUpdate') — نستعمل التسجيل الجاهز.

/** فحص دعم المتصفّح لـPush. Safari يدعم من ١٦.٤+، iOS من ١٦.٤+ (وضع PWA فقط). */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** الحالة الحالية لإذن الإشعارات (بدون طلب — للعرض في الواجهة). */
export function getPermissionState(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

/** تحويل base64url (VAPID public key) إلى Uint8Array — تنسيق pushManager.subscribe المطلوب. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export interface SubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}

/** يطلب الإذن، يشترك في PushManager، ويُرجع بيانات الاشتراك للخادم. يرمي عند رفض المستخدم/الخطأ. */
export async function subscribeToPush(vapidPublicKey: string): Promise<SubscriptionKeys> {
  if (!isPushSupported()) throw new Error("المتصفّح لا يدعم إشعارات الدفع.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("لم يُمنَح إذن الإشعارات.");
  const reg = await navigator.serviceWorker.ready;
  // إن كان اشتراك سابق موجود ⇒ استعمله (idempotent — الخادم يعالج endpoint موجود بالتحديث).
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    // BufferSource: lib.dom.d.ts الحديثة تتشدّد على Uint8Array<ArrayBufferLike> — نمرّر ArrayBuffer نقيّاً.
    const key = urlBase64ToUint8Array(vapidPublicKey);
    const keyBuf = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, // مطلوب — لا إشعارات صامتة.
      applicationServerKey: keyBuf,
    });
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("تعذّر قراءة بيانات الاشتراك من المتصفّح.");
  }
  return {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    userAgent: (navigator.userAgent || "").slice(0, 255),
  };
}

/** إلغاء الاشتراك في المتصفّح (وليس على الخادم — الخادم يُلغيه بمناداة تفصل). */
export async function unsubscribeFromPushBrowser(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

/** هل التطبيق يعمل بوضع التثبيت كـ PWA مستقل (من الشاشة الرئيسية)؟ */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const isStandaloneMedia =
    window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  // @ts-expect-error navigator.standalone خاص بـ iOS Safari Web App
  const isNavigatorStandalone = Boolean(window.navigator?.standalone);
  return isStandaloneMedia || isNavigatorStandalone;
}

/** هل الجهاز يعمل بنظام iOS (آيفون أو آيباد)؟ */
export function isIosDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator?.userAgent || "";
  const isTouchMac =
    window.navigator?.platform === "MacIntel" &&
    (window.navigator?.maxTouchPoints ?? 0) > 1;
  return /iPad|iPhone|iPod/.test(ua) || isTouchMac;
}

/** هل المستخدم على هاتف iOS لكنه داخل متصفح Safari ولم يضف التطبيق للشاشة الرئيسية بعد؟ */
export function isIosSafariBrowser(): boolean {
  return isIosDevice() && !isStandalonePwa();
}

/** ضبط عداد الشارة التنبيهية على أيقونة التطبيق في الشاشة الرئيسية (App Badging API). */
export async function setNotificationBadge(count?: number): Promise<void> {
  if (typeof window === "undefined" || !("setAppBadge" in navigator)) return;
  try {
    if (typeof count === "number" && count > 0) {
      await navigator.setAppBadge(count);
    } else {
      await navigator.clearAppBadge();
    }
  } catch {
    // تجاهل البيئات التي ترفض الشارة بصمت
  }
}

/** مسح عداد الشارة التنبيهية على أيقونة التطبيق. */
export async function clearNotificationBadge(): Promise<void> {
  if (typeof window === "undefined" || !("clearAppBadge" in navigator)) return;
  try {
    await navigator.clearAppBadge();
  } catch {
    // تجاهل
  }
}

/**
 * محاولة اشتراك هادئة بالخلفية إن كان الإذن ممنوحاً مسبقاً (`granted`).
 * لا تُظهر أي نافذة ولا تُلقي خطأ للمستخدم.
 */
export async function autoResubscribeIfPermissionGranted(
  vapidPublicKey: string,
): Promise<SubscriptionKeys | null> {
  if (!isPushSupported() || Notification.permission !== "granted") return null;
  try {
    return await subscribeToPush(vapidPublicKey);
  } catch {
    return null;
  }
}


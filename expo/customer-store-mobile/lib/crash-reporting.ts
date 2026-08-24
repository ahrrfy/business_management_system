/**
 * قناة إبلاغٍ موحَّدة عن الأعطال. تلفّ Firebase Crashlytics إن كان مركَّباً،
 * وإلّا تسجّل محلياً (dev) أو تسقط صامتاً (prod) — بحيث لا يفشل التطبيق إن
 * لم يُدرَج pod Crashlytics بعدُ في بناءٍ ما.
 *
 * لماذا هذه الطبقة؟
 *   ١) الاستدعاء من ErrorBoundary لا يعرف Firebase — يبقى ErrorBoundary مستقلاً
 *   ٢) اختبارات Node لا يمكنها تحميل @react-native-firebase (native module) —
 *      حين نستورد dynamically، الاختبار يستعمل no-op تلقائياً
 *   ٣) تعطيل Crashlytics عبر ضبطٍ واحد (setCrashReportingEnabled) بلا تفكيك
 */

type CrashContext = Record<string, string | number | boolean | null | undefined>;

let enabled = true;

export function setCrashReportingEnabled(next: boolean) {
  enabled = next;
}

export function reportCrash(error: unknown, context: CrashContext = {}) {
  if (!enabled) return;
  const err = error instanceof Error ? error : new Error(String(error));

  // في وضع التطوير نطبع للحصول على الأثر فوراً؛ لا نطبع أيّ توكن/بيانات حسّاسة.
  if (__DEV__) {
    // eslint-disable-next-line no-console -- dev-only trace, gated by __DEV__
    console.warn("[Crash]", err.message, context);
  }

  // Firebase Crashlytics متاحٌ فقط في builds الأصليّة (Expo Go لا يحمّل native modules).
  // النداء dynamic ⇒ لا يحاول Metro تحليل الوحدة على المتصفح، ولا اختبارات Node.
  void tryReportToCrashlytics(err, context);
}

async function tryReportToCrashlytics(err: Error, context: CrashContext) {
  try {
    // require dynamic لتجنّب فشل تحميل الوحدة على Web/Node/Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- gated dynamic native import
    const crashlyticsModule = require("@react-native-firebase/crashlytics");
    const crashlytics = crashlyticsModule.default ?? crashlyticsModule;
    if (!crashlytics) return;
    const instance = typeof crashlytics === "function" ? crashlytics() : crashlytics;
    // نلحق السياق كسماتٍ قابلة للفهرسة في لوحة Crashlytics.
    for (const [key, value] of Object.entries(context)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "boolean") await instance.setAttribute?.(key, String(value));
      else if (typeof value === "number") await instance.setAttribute?.(key, String(value));
      else await instance.setAttribute?.(key, value);
    }
    instance.recordError?.(err);
  } catch {
    // الوحدة غير متوفّرة (Expo Go/web/node) — تجاهل بصمت. لا نريد ضجيجاً في السجلات.
  }
}

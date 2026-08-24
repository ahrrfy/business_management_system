/**
 * تفعيل Firebase App Check قبل أوّل استدعاءٍ لخدمات Firebase (Auth/FCM/Firestore).
 * الهدف: أن تقبل خوادم Google طلبات هذا التطبيق فقط، لا أيّ عميلٍ يملك مفاتيح Firebase.
 *   - Android → Play Integrity API (يستلزم SHA-256 مسجَّلاً في Firebase Console)
 *   - iOS → DeviceCheck (App Attest متاح لكن يتطلّب iOS 14+ ⇒ نستعمل DeviceCheck الأوسع دعماً)
 *   - Debug (بناء تطوير): DebugProviderFactory يُنتج توكن debug يمكن تسجيله في Firebase Console
 *
 * التفعيل النهائيّ (enforcement) يتمّ من Firebase Console → App Check → لكل خدمة.
 * هذا الملف يهيّئ العميل فقط — لن يمنع أيّ استدعاءٍ حتى يُفعَّل الإنفاذ خادمياً.
 *
 * لماذا dynamic require؟ نفس السبب في crash-reporting: Native module يفشل على
 * Expo Go/web/node ⇒ نغلّفه بحيث لا يمنع تحميل بقية التطبيق حين لا يتوفّر.
 */

// نسمح بإعادة المحاولة إن فشل أوّل نداء (شبكة/تهيئة Firebase Auth غير جاهزة بعد)،
// ولا نُقفل الحالة بـ`initialized = true` قبل نجاح init فعلياً. راجع مراجعة Codex P1.
let initialized = false;

export async function initFirebaseAppCheck() {
  if (initialized) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- gated dynamic native import
    const appCheckModule = require("@react-native-firebase/app-check");
    const appCheck = appCheckModule.default ?? appCheckModule;
    if (!appCheck) return;

    // ⚠️ P1 من مراجعة Codex: `newReactNativeFirebaseAppCheckProvider()` مُتاح على
    // **instance** الذي يُعيده `appCheck()` — لا على الوحدة المُصدَّرة `appCheck`
    // مباشرةً. استدعاؤها على الوحدة يرمي، وcatch الواسع يبتلع الخطأ، وinitialized=true
    // كان يُبقي App Check معطَّلاً دائماً بلا إعادة محاولة.
    const instance = typeof appCheck === "function" ? appCheck() : appCheck;
    if (!instance?.newReactNativeFirebaseAppCheckProvider || !instance.initializeAppCheck) return;

    const providerFactory = instance.newReactNativeFirebaseAppCheckProvider();
    // اختيار المزوّد حسب المنصّة يُبنى داخل @react-native-firebase/app-check:
    //   Android → PlayIntegrity + AppAttestFactory (fallback) في Release
    //   Android debug → SafetyNet DebugProvider (SDK يعرضه)
    //   iOS → DeviceCheck في Release، AppAttest إن اعتُمِد فتفعيله على Firebase Console
    providerFactory.configure({
      android: { provider: __DEV__ ? "debug" : "playIntegrity", debugToken: undefined },
      apple: { provider: __DEV__ ? "debug" : "deviceCheck", debugToken: undefined },
    });

    await instance.initializeAppCheck({ provider: providerFactory, isTokenAutoRefreshEnabled: true });
    initialized = true;
  } catch {
    // Native module غير متوفّر (Expo Go/web/node) أو تهيئة Firebase لم تكتمل — نُبقي
    // `initialized = false` حتى تُتاح إعادة المحاولة من useEffect لاحق (تركيب/إعادة تركيب).
  }
}

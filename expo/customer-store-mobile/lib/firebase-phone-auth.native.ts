type PhoneConfirmation = {
  confirm: (code: string) => Promise<{
    user: {
      phoneNumber: string | null;
      getIdToken: (forceRefresh?: boolean) => Promise<string>;
    };
  }>;
};

type NativeFirebaseAuth = {
  getAuth: () => unknown;
  signInWithPhoneNumber: (auth: unknown, phone: string) => Promise<PhoneConfirmation>;
};

let activeConfirmation: PhoneConfirmation | null = null;

/**
 * Expo Go لا يتضمن وحدات React Native Firebase الأصلية. نحملها عند طلب OTP
 * فقط لكي يبقى استعراض المتجر والاختبارات العادية متاحين في Expo Go، بينما
 * تستعمل نسخة التطوير أو الإنتاج الوحدة الأصلية كما هو مطلوب للإطلاق.
 */
function nativeFirebaseAuth(): NativeFirebaseAuth {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@react-native-firebase/auth") as NativeFirebaseAuth;
}

export function firebasePhoneErrorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("NativeRNFB") || message.includes("not registered")) {
    return "هذه النسخة لا تحتوي مكتبة Firebase الأصلية. ثبّت أحدث بناء للتطبيق، لا Expo Go، ثم حاول مرة واحدة.";
  }
  if (code.includes("invalid-phone-number")) return "اكتب رقم هاتف عراقي صحيحاً بصيغة 07xxxxxxxxx.";
  if (code.includes("too-many-requests")) return "تم تجاوز حد المحاولات المؤقت. انتظر قليلاً ثم أعد المحاولة.";
  if (code.includes("quota-exceeded") || code.includes("billing-not-enabled")) return "بلغت حصة رسائل التحقق الحد المتاح حالياً. حاول لاحقاً أو استخدم رقم اختبار مُعداً في Firebase.";
  if (code.includes("invalid-app-credential") || code.includes("app-not-authorized") || code.includes("missing-activity-for-recaptcha")) return "تعذر التحقق من هوية نسخة التطبيق لدى Firebase. لا تكرر الإرسال؛ نراجع بصمة توقيع Google Play وإعداد التحقق.";
  if (code.includes("captcha-check-failed")) return "لم يكتمل تحقق Google الآلي للهاتف. تأكد من تحديث Google Play services ثم حاول مرة واحدة لاحقاً.";
  if (code.includes("network-request-failed")) return "تعذر الوصول إلى خدمة التحقق. تأكد من اتصال الإنترنت ثم حاول مرة واحدة.";
  if (code.includes("invalid-verification-code")) return "رمز التحقق غير صحيح أو منتهٍ.";
  if (code.includes("unknown") || code.includes("internal-error")) return "رفضت خدمة الهاتف طلب التحقق من هذه النسخة أو وصلت الحصة المؤقتة. لا تكرر الإرسال؛ راجع استخدام Firebase أو جرّب رقم اختبار مضبوطاً.";
  return "تعذر إكمال تحقق الهاتف حالياً. لا تكرر الإرسال الآن؛ راجع اتصال الإنترنت واستخدام Firebase ثم حاول مرة واحدة لاحقاً.";
}

export async function sendStorefrontPhoneOtp(rawPhone: string) {
  const phone = normalizeIraqiPhone(rawPhone);
  if (!phone) throw new Error("اكتب رقم هاتف عراقي صحيحاً بصيغة 07xxxxxxxxx.");
  try {
    const { getAuth, signInWithPhoneNumber } = nativeFirebaseAuth();
    activeConfirmation = await signInWithPhoneNumber(getAuth(), phone);
    return phone;
  } catch (error) {
    throw new Error(firebasePhoneErrorMessage(error));
  }
}

export async function confirmStorefrontPhoneOtp(code: string) {
  if (!activeConfirmation) throw new Error("اطلب رمز تحقق جديداً أولاً.");
  if (!/^\d{6}$/.test(code)) throw new Error("اكتب رمز التحقق المؤلف من 6 أرقام.");
  try {
    const result = await activeConfirmation.confirm(code);
    activeConfirmation = null;
    const phone = result.user.phoneNumber;
    if (!phone) throw new Error("لم يُرجع التحقق رقم هاتف صالحاً.");
    return { firebaseIdToken: await result.user.getIdToken(true), phone };
  } catch (error) {
    if (error instanceof Error && error.message !== "") throw error;
    throw new Error(firebasePhoneErrorMessage(error));
  }
}
import { normalizeIraqiPhone } from "./iraqi-phone";
